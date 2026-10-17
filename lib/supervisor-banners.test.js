'use strict';
/*
 * supervisor-banners.test.js -- the crash supervisor (sidecar/Supervisor.cs) puts Windows' own notification
 * banners back on EVERY death of Mantle's main, before it starts anything, never fights a live Mantle,
 * and survives a process-tree kill of main (lane mantle-notif-safety, 2026-10-17).
 *
 * WHY: Mantle turns Windows' banner off per app (ShowBanner=0) while it draws its own. Owen's rule: a
 * Windows surface Mantle replaces comes back when Mantle crashes or closes. A tree kill of main (Task
 * Manager "End process tree", taskkill /F /T) used to take main, the sidecar AND the supervisor, so
 * nothing was left to put the banners back.
 *
 * Pure node + the BUILT exe (never Electron, never the live shell). The registry it touches is a SCRATCH
 * key only: HKCU\Software\MantleTest\notif-safety-<random>\Settings\<app id>, made with reg.exe and
 * deleted in finally; never Notifications\Settings, never a real app id, never Owen's notif-banners.json
 * (every record lives in a temp folder). Every process it starts is stopped by PID (never by image name).
 *
 * Lane mantle-notif-safety2 (2026-10-17) adds: (g) a tree kill of main WITH its sidecar child is a deliberate
 * stop (banners back, no restart, the supervisor exits); (h) main killed ALONE with a sidecar is still a crash;
 * (i) one supervisor per --supervise-dir (a second copy exits, a --supervise-detach launcher names the holder,
 * supervisor.lock is held); (j) a copy for a newer main waits for the holder; (k) a relaunch that loses the
 * single-instance lock to another live Mantle is not a crash; (l) the put-back mark
 * notif-banners-back.supervisor.json lists only the apps put back, with the record's taken stamp; (m) a test
 * supervisor whose folder is gone never starts main again. The fake sidecar is node.exe hard-linked (or
 * copied) as <TMP>\fakesc\Mantle.Sidecar.exe, a child of the fake main with stdin 'pipe'.
 *
 *   node lib/supervisor-banners.test.js [--exe=<Mantle.Sidecar.exe>] [--supervisor-js=<lib/supervisor.js>]
 *   (or env MANTLE_SIDECAR_EXE / MANTLE_SUPERVISOR_JS; default sidecar/bin/Mantle.Sidecar.exe + lib/supervisor.js)
 *   -> "SUPERVISOR BANNERS TEST: n passed, m failed"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const argOf = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const EXE = path.resolve(argOf('exe') || process.env.MANTLE_SIDECAR_EXE || path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe'));
const SUP_JS = path.resolve(argOf('supervisor-js') || process.env.MANTLE_SUPERVISOR_JS || path.join(ROOT, 'lib', 'supervisor.js'));
const PROFILE = 'nsbanners';
const RAND = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
const KEY_BASE = `Software\\MantleTest\\notif-safety-${RAND}`;
const KEY = `${KEY_BASE}\\Settings`;          // what the supervisor is pointed at (HKCU-relative)
const AUMID = (x) => `Mantle.ToastTest.ns${RAND}-${x}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `mantle-supbanners-${RAND}-`));

// Below Normal: every process this starts inherits the class (CreateProcess's rule for a below-normal parent).
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* best effort */ }

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(`${name}${detail !== undefined ? ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

const started = new Set();     // every pid this test started or learned of (stopped by pid in finally)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(step);
  }
}
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function stop(pid) { if (!pid) return; try { process.kill(pid); } catch (_) { /* gone */ } }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } }
function writeJson(f, v) { fs.writeFileSync(f, JSON.stringify(v)); }

// ---- the scratch registry key ----
function reg(args) { return cp.execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
function regSet(aumid, value) {
  const k = `HKCU\\${KEY}\\${aumid}`;
  reg(['add', k, '/f']);
  if (value === null) { try { reg(['delete', k, '/v', 'ShowBanner', '/f']); } catch (_) { /* absent */ } }
  else reg(['add', k, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', String(value), '/f']);
}
function regGet(aumid) {
  try {
    const m = /ShowBanner\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(reg(['query', `HKCU\\${KEY}\\${aumid}`, '/v', 'ShowBanner']));
    return m ? parseInt(m[1], 16) : 'odd';
  } catch (_) { return null; }
}

// ---- the fake main: a node script the supervisor can start again from supervisor-main.json ----
// plain: writes supervisor-main.json like main does and idles. real: runs lib/supervisor.js makeSupervisor
// (so the supervisor is spawned exactly the way main spawns it) and writes its status() every 200 ms.
// Both first append {pid, at, seen} to fake-out.jsonl: seen = the watched ShowBanner AT ITS START.
const FAKE = path.join(TMP, 'fake-main.js');
fs.writeFileSync(FAKE, String.raw`'use strict';
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const dir = arg('dir'); const key = arg('key'); const watch = arg('watch');
function readVal() {
  try {
    const t = cp.execFileSync('reg.exe', ['query', 'HKCU\\' + key + '\\' + watch, '/v', 'ShowBanner'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /ShowBanner\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(t); return m ? parseInt(m[1], 16) : 'odd';
  } catch (_) { return null; }
}
const seen = readVal();
const outFile = arg('out') || path.join(dir, 'fake-out.jsonl');
// --fake-sc=<exe>: a fake sidecar child (node.exe named Mantle.Sidecar.exe), stdin 'pipe': exits 0 at its end
let sc = null;
if (arg('fake-sc')) {
  const SC = "process.stdin.on('end', () => process.exit(0)); process.stdin.on('error', () => process.exit(0)); process.stdin.resume(); setInterval(() => {}, 60000);";
  sc = cp.spawn(arg('fake-sc'), ['-e', SC], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }).pid;
}
// --lose-lock-to=<file>: that file names a live pid other than this one = this start "lost the single-instance
// lock" to it: the line, then exit 0 WITHOUT writing supervisor-main.json (what a losing Electron main does)
let lost = 0;
if (arg('lose-lock-to')) {
  try { lost = Number(fs.readFileSync(arg('lose-lock-to'), 'utf8').trim()) || 0; } catch (_) { lost = 0; }
  if (lost === process.pid) lost = 0;
  if (lost) { try { process.kill(lost, 0); } catch (e) { if (e.code !== 'EPERM') lost = 0; } }
}
fs.appendFileSync(outFile, JSON.stringify({ pid: process.pid, at: Date.now(), seen: seen, sup: process.env.MANTLE_SUPERVISOR_PID || null, sc: sc, lost: lost || null }) + '\n');
if (lost) process.exit(0);
if (arg('mode') === 'real') {
  const S = require(arg('sup'));
  const logFile = path.join(dir, 'fake-main.log');
  const sup = S.makeSupervisor({
    fs: fs, path: path, spawn: cp.spawn,
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    kill: (pid) => process.kill(pid), now: Date.now, log: (l) => fs.appendFileSync(logFile, l + '\n'),
    setInterval: setInterval, clearInterval: clearInterval,
    pid: process.pid, execPath: process.execPath, argv: process.argv.slice(1), cwd: process.cwd(), root: process.cwd(),
    userData: dir, exePath: arg('exe'), flags: { test: true, supervise: true, profileName: arg('profile') }, env: process.env,
    testBannersKey: key,
  });
  sup.start();
  const put = () => { try { fs.writeFileSync(path.join(dir, 'status-' + process.pid + '.json'), JSON.stringify(sup.status())); } catch (_) {} };
  put(); setInterval(put, 200);
} else {
  const rec = { v: 1, pid: process.pid, at: Date.now(), exe: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), root: process.cwd(), standDown: null, crashNote: null, told: 0 };
  fs.writeFileSync(path.join(dir, 'supervisor-main.json'), JSON.stringify(rec));
  setInterval(() => {}, 60000);
}
`);

function caseDir(name) { const d = path.join(TMP, name); fs.mkdirSync(d); return d; }
function outFileLines(f) { return readText(f).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }
function outLines(dir) { return outFileLines(path.join(dir, 'fake-out.jsonl')); }
/** every fake main (and fake sidecar) pid seen in these lines joins `started` (stopped by pid in finally) */
function learn(lines) { for (const l of lines) { if (l.pid) started.add(l.pid); if (l.sc) started.add(l.sc); } return lines; }
function supLog(dir) { return readText(path.join(dir, 'supervisor.log')); }
function state(dir) { return readJson(path.join(dir, 'supervisor-state.json')) || {}; }

/** Starts a fake main and waits for its first line. -> its pid. */
/** The fake sidecar program: node.exe hard-linked (same volume) or copied as <TMP>\fakesc\Mantle.Sidecar.exe,
 *  the image name the supervisor's TrackSidecars looks for among main's children. */
let FAKE_SC = null;
let FAKE_SC_HOW = null;
function fakeSidecarExe() {
  if (FAKE_SC) return FAKE_SC;
  const d = path.join(TMP, 'fakesc');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'Mantle.Sidecar.exe');
  try { fs.linkSync(process.execPath, f); FAKE_SC_HOW = 'hard link'; } catch (_) { fs.copyFileSync(process.execPath, f); FAKE_SC_HOW = 'copy'; }
  FAKE_SC = f;
  console.log(`supervisor-banners: fake sidecar Mantle.Sidecar.exe made by ${FAKE_SC_HOW} of node.exe`);
  return f;
}

/** Starts a fake main and waits for its first line. -> its pid.
 *  opts: sc (a fake sidecar child), loseTo (the --lose-lock-to file), out (its line file), cwd. */
async function fakeMain(dir, watch, mode, opts = {}) {
  const args = [FAKE, `--dir=${dir}`, `--key=${KEY}`, `--watch=${watch}`, `--profile-name=${PROFILE}`];
  if (mode === 'real') args.push('--mode=real', `--sup=${SUP_JS}`, `--exe=${EXE}`, `--profile=${PROFILE}`);
  if (opts.sc) args.push(`--fake-sc=${fakeSidecarExe()}`);
  if (opts.loseTo) args.push(`--lose-lock-to=${opts.loseTo}`);
  if (opts.out) args.push(`--out=${opts.out}`);
  const c = cp.spawn(process.execPath, args, { cwd: opts.cwd || dir, stdio: 'ignore', windowsHide: true, detached: true });
  c.unref();
  started.add(c.pid);
  const outF = opts.out || path.join(dir, 'fake-out.jsonl');
  const ok = await waitFor(() => outFileLines(outF).some((l) => l.pid === c.pid), 10000);
  learn(outFileLines(outF));
  if (!ok) throw new Error('the fake main did not start');
  if (mode !== 'real') await waitFor(() => (readJson(path.join(dir, 'supervisor-main.json')) || {}).pid === c.pid, 5000);
  return c.pid;
}
/** main's banner record: owned {aumid: original}, saved by `pid` at `at`; taken {aumid: stamp} when given. */
function record(dir, owned, pid, at, taken) {
  const rec = { v: 1, owned, released: [], pid, at: at || Date.now() };
  if (taken) rec.taken = taken;
  writeJson(path.join(dir, 'notif-banners.json'), rec);
}
const SUP_ARGS = (dir, mainPid) => [`--supervise=${mainPid}`, `--supervise-dir=${dir}`, '--supervise-test', `--profile-name=${PROFILE}`, `--supervise-banners-key=${KEY}`];
/** A supervisor started directly, NOT waited for. -> { pid, exited: Promise<code | 'still running after N ms'> } */
function spawnSup(dir, mainPid, ms = 15000) {
  const c = cp.spawn(EXE, SUP_ARGS(dir, mainPid), { stdio: 'ignore', windowsHide: true, detached: true });
  started.add(c.pid);
  const exited = new Promise((res) => { const t = setTimeout(() => res(`still running after ${ms} ms`), ms); c.once('exit', (x) => { clearTimeout(t); res(x); }); });
  c.unref();
  return { pid: c.pid, exited };
}
/** A supervisor started directly (cases a-e), pointed at the scratch key. -> its pid, once it watches. */
async function supervise(dir, mainPid) {
  const c = cp.spawn(EXE, SUP_ARGS(dir, mainPid), { stdio: 'ignore', windowsHide: true, detached: true });
  c.unref();
  started.add(c.pid);
  await waitFor(() => supLog(dir).includes(`watching Mantle's main process ${mainPid}`), 10000);
  return c.pid;
}
/** An idle node process (a stand-in for another live Mantle main). -> its pid. */
function idleHost() {
  const h = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', '--', `--profile-name=${PROFILE}`], { stdio: 'ignore', windowsHide: true });
  started.add(h.pid);
  return h.pid;
}
/** The fake main started the real way (lib/supervisor.js): its detached supervisor's pid, once it says so. */
async function realSupervisor(dir, main, tag) {
  const st = await waitFor(() => { const s = readJson(path.join(dir, `status-${main}.json`)); return s && s.via === 'detached' ? s : null; }, 9000);
  const sNow = readJson(path.join(dir, `status-${main}.json`)) || {};
  const pid = (st || sNow).pid;
  if (pid) started.add(pid);
  check(`${tag} lib/supervisor.js spawned it detached`, !!st, { status: sNow, log: readText(path.join(dir, 'fake-main.log')) });
  return pid;
}
function canOpen(f) { try { fs.closeSync(fs.openSync(f, 'r')); return true; } catch (e) { return e.code || String(e); } }
const count = (text, needle) => text.split(needle).length - 1;
function standDown(dir, why) {
  const f = path.join(dir, 'supervisor-main.json');
  const rec = readJson(f);
  rec.standDown = { why, at: Date.now() };
  writeJson(f, rec);
}
const noPaths = (text) => !text.includes(TMP) && !/[A-Za-z]:\\/.test(text);

async function caseCrash() {
  // (a) owned 0 -> original, BEFORE the restart; (b) original null -> deleted; (c) Owen's values untouched;
  // plus: a non-test app id is never written by a --supervise-test supervisor.
  const dir = caseDir('crash');
  const A = AUMID('a'), B = AUMID('b'), C = AUMID('c'), D = AUMID('d');
  const REAL = `Real.App.ns${RAND}-e`;
  regSet(A, 0); regSet(B, 0); regSet(C, 1); regSet(D, 0); regSet(REAL, 0);
  const main1 = await fakeMain(dir, A, 'plain');
  // (l) taken stamps: A and C (and REAL) have one, B has none
  const TOOK_A = 1760000000123, TOOK_C = 1760000000456, TOOK_REAL = 1760000000789;
  record(dir, { [A]: 1, [B]: null, [C]: null, [REAL]: 1 }, main1, undefined, { [A]: TOOK_A, [C]: TOOK_C, [REAL]: TOOK_REAL });
  const sup = await supervise(dir, main1);
  stop(main1);   // TerminateProcess: a crash (exit code 1)
  const st = await waitFor(() => { const s = state(dir); return s.last && s.last.oldPid === main1 && s.last.restarted ? s : (!alive(sup) ? s : null); }, 45000);
  const newPid = st && st.last && st.last.newPid;
  if (newPid) started.add(newPid);
  const line = await waitFor(() => outLines(dir).find((l) => l.pid === newPid), 10000);
  check('(a) crash: owned 0 -> its original 1', regGet(A) === 1, regGet(A));
  check('(a) crash: the RESTARTED main already saw the original at its start (put back before the restart)', !!line && line.seen === 1, { line, last: st && st.last });
  check('(a) crash: the put-back is recorded before the restart (state banners.at <= the new main start)', !!(st && st.banners && line && st.banners.at <= line.at && st.banners.skipped === false && /2 put back/.test(st.banners.result)), st && st.banners);
  check('(b) original null -> ShowBanner deleted (Windows default)', regGet(B) === null, regGet(B));
  check('(c) a value Owen set (1, owned) is untouched', regGet(C) === 1, regGet(C));
  check('(c) a 0 that is not in the record is untouched', regGet(D) === 0, regGet(D));
  check('test supervisor: a non-test app id is never written', regGet(REAL) === 0, regGet(REAL));
  const log = supLog(dir);
  check('crash: one line says it, with no paths', /is gone; Windows' own notification banners: 2 put back to Windows, 2 left as they were \(test instance: test app ids only\)/.test(log) && noPaths(log), log.split('\n').filter((l) => /banners/.test(l)));
  // (l) the put-back mark: ONLY the apps put back (A, B), each with the record's taken stamp (or null)
  const mark = readJson(path.join(dir, 'notif-banners-back.supervisor.json'));
  const back = (mark && mark.back) || {};
  check('(l) mark: notif-banners-back.supervisor.json is {"v":1,"back":{...}}', !!mark && mark.v === 1 && typeof mark.back === 'object', mark);
  check('(l) mark: A (put back) is listed with took === the record\'s stamp and an at', !!back[A] && back[A].took === TOOK_A && typeof back[A].at === 'number' && back[A].at >= (line ? line.at - 60000 : 0), back[A]);
  check('(l) mark: B (put back, no stamp) is listed with took === null', !!back[B] && back[B].took === null, back[B]);
  check('(l) mark: C (Owen\'s own 1, left) is NOT listed', !(C in back), back);
  check('(l) mark: the non-test app (left) is NOT listed', !(REAL in back), back);
  check('(l) mark: nothing else is listed', Object.keys(back).length === 2, Object.keys(back));
  stop(sup); stop(newPid);
}

async function caseStandDown() {
  // (d) a deliberate quit with no other Mantle: put back, nothing started
  const dir = caseDir('standdown');
  const A = AUMID('sd');
  regSet(A, 0);
  const main1 = await fakeMain(dir, A, 'plain');
  record(dir, { [A]: 1 }, main1);
  const sup = await supervise(dir, main1);
  standDown(dir, 'the tray menu');
  stop(main1);
  const gone = await waitFor(() => !alive(sup), 15000);
  check('(d) standDown: the supervisor exits', !!gone);
  check('(d) standDown, no other owner: put back', regGet(A) === 1, regGet(A));
  check('(d) standDown: nothing was started again', outLines(dir).length === 1, outLines(dir));
  const s = state(dir);
  check('(d) state records the put-back', !!(s.banners && s.banners.skipped === false && /1 put back/.test(s.banners.result)), s.banners);
}

async function caseOtherOwner() {
  // (e) standDown while another LIVE process is the record's pid: NOT put back, the skip said
  const dir = caseDir('owner');
  const A = AUMID('own');
  regSet(A, 0);
  const other = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', '--', `--profile-name=${PROFILE}`], { stdio: 'ignore', windowsHide: true });
  started.add(other.pid);
  await sleep(300);
  const main1 = await fakeMain(dir, A, 'plain');
  record(dir, { [A]: 1 }, other.pid, Date.now());
  const sup = await supervise(dir, main1);
  check('(e) the stand-in owner process is running', alive(other.pid));
  standDown(dir, 'Restart Mantle');
  stop(main1);
  await waitFor(() => !alive(sup), 15000);
  check('(e) another live Mantle named in the record: NOT put back', regGet(A) === 0, regGet(A));
  const log = supLog(dir);
  check('(e) the skip is said in supervisor.log (with the owner pid, no paths)', log.includes(`left to Mantle: the Mantle that saved the banner record (pid ${other.pid}) is still running`) && noPaths(log), log.split('\n').filter((l) => /banners/.test(l)));
  const s = state(dir);
  check('(e) state says skipped', !!(s.banners && s.banners.skipped === true), s.banners);
  stop(other.pid);

  // (e2) supervisor-main.json names a NEWER live main (Restart / golive): NOT put back either
  const dir2 = caseDir('newer');
  const B = AUMID('newer');
  regSet(B, 0);
  const newer = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', '--', `--profile-name=${PROFILE}`], { stdio: 'ignore', windowsHide: true });
  started.add(newer.pid);
  await sleep(300);
  const main2 = await fakeMain(dir2, B, 'plain');
  record(dir2, { [B]: 1 }, main2);
  const sup2 = await supervise(dir2, main2);
  // the newer main's own record (a program that does not exist: the supervisor cannot start anything)
  writeJson(path.join(dir2, 'supervisor-main.json'), { v: 1, pid: newer.pid, at: Date.now(), exe: path.join(dir2, 'nope.exe'), args: [], cwd: dir2, root: dir2, standDown: null });
  check('(e2) the stand-in newer main is running', alive(newer.pid));
  stop(main2);
  await waitFor(() => !alive(sup2), 15000);
  check('(e2) a newer live main in supervisor-main.json: NOT put back', regGet(B) === 0, regGet(B));
  check('(e2) ...and said', supLog(dir2).includes(`left to Mantle: a newer Mantle (pid ${newer.pid}) is running`), supLog(dir2).split('\n').filter((l) => /banners/.test(l)));
  stop(newer.pid);
}

async function caseDetachLine() {
  // the exact --supervise-detach contract: ONE line, {"supervisor":<pid>,"detached":true}, exit 0
  const dir = caseDir('line');
  const host = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', '--', `--profile-name=${PROFILE}`], { stdio: 'ignore', windowsHide: true });
  started.add(host.pid);
  const c = cp.spawn(EXE, [`--supervise=${host.pid}`, `--supervise-dir=${dir}`, '--supervise-test', `--profile-name=${PROFILE}`, `--supervise-banners-key=${KEY}`, '--supervise-detach'],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: true });
  started.add(c.pid);
  let out = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((res) => { const t = setTimeout(() => res('still running after 6 s'), 6000); c.once('exit', (x) => { clearTimeout(t); res(x); }); });
  await sleep(200);
  const m = /^\{"supervisor":(\d+),"detached":true\}\n$/.exec(out);
  const copy = m ? Number(m[1]) : 0;
  if (copy) started.add(copy);
  check('--supervise-detach prints exactly {"supervisor":<pid>,"detached":true} and one line', !!m, { out, code });
  check('...the launcher exits 0 and the copy (another pid) runs on', code === 0 && copy > 0 && copy !== c.pid && alive(copy), { code, copy, launcher: c.pid });
  check('...the copy watches with the same arguments minus --supervise-detach', await waitFor(() => supLog(dir).includes(`watching Mantle's main process ${host.pid} (supervisor pid ${copy})`), 5000) !== null, supLog(dir));
  if (code !== 0 && alive(c.pid)) stop(c.pid);
  stop(copy); stop(host.pid);
}

async function caseTreeKill() {
  // (f) taskkill /F /T on a main with NO sidecar child (so nothing tells a tree kill from a crash): the
  // supervisor (spawned the real way, by lib/supervisor.js) lives on, puts the banners back and starts main
  // again. (g) is the same kill with a sidecar child: a deliberate stop.
  const dir = caseDir('treekill');
  const A = AUMID('tree');
  regSet(A, 0);
  const main1 = await fakeMain(dir, A, 'real');
  const st1 = await waitFor(() => { const s = readJson(path.join(dir, `status-${main1}.json`)); return s && s.via === 'detached' ? s : null; }, 9000);
  const sNow = readJson(path.join(dir, `status-${main1}.json`)) || {};
  const supPid = (st1 || sNow).pid;
  if (supPid) started.add(supPid);
  check('(f) lib/supervisor.js spawned it detached (via detached, a pid that is not the launcher)', !!st1, { status: sNow, log: readText(path.join(dir, 'fake-main.log')) });
  record(dir, { [A]: 1 }, main1);
  await waitFor(() => supLog(dir).includes(`watching Mantle's main process ${main1}`), 10000);
  try { cp.execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(main1)], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* reported below */ }
  await waitFor(() => !alive(main1), 5000);
  const s = await waitFor(() => { const x = state(dir); return x.last && x.last.oldPid === main1 && x.last.restarted ? x : (supPid && !alive(supPid) ? x : null); }, 45000);
  const newPid = s && s.last && s.last.newPid;
  if (newPid) started.add(newPid);
  check('(f) tree kill, no sidecar child: the supervisor is still running', !!supPid && alive(supPid), { supPid });
  check('(f) tree kill, no sidecar child: banners put back', regGet(A) === 1, regGet(A));
  const line = await waitFor(() => outLines(dir).find((l) => l.pid === newPid), 10000);
  check('(f) tree kill, no sidecar child: main started again, and it saw the original already back', !!line && line.seen === 1, { last: s && s.last, line });
  const st2 = await waitFor(() => { const x = readJson(path.join(dir, `status-${newPid}.json`)); return x && x.via === 'adopted' ? x : null; }, 8000);
  check('(f) the new main ADOPTED the same supervisor', !!st2 && st2.pid === supPid, st2);
  stop(supPid); stop(newPid);
}

async function caseTreeKillSidecar() {
  // (g) taskkill /F /T on a main WITH its sidecar child: both end with code 1 together = Owen stopping
  // Mantle: banners back, no restart, state.last {treeKill, restarted:false, restore dryRun}, the supervisor exits
  const dir = caseDir('treekill-sc');
  const A = AUMID('treesc');
  regSet(A, 0);
  const main1 = await fakeMain(dir, A, 'real', { sc: true });
  const sc1 = (outLines(dir).find((l) => l.pid === main1) || {}).sc;
  const supPid = await realSupervisor(dir, main1, '(g)');
  record(dir, { [A]: 1 }, main1);
  const watched = await waitFor(() => supLog(dir).includes(`watching Mantle's main process ${main1}`), 10000);
  check('(g) setup: the fake sidecar (Mantle.Sidecar.exe, a child of main) runs and the supervisor watches', !!sc1 && alive(sc1) && !!watched, { sc1, how: FAKE_SC_HOW, log: supLog(dir) });
  await sleep(2600);   // the supervisor's 1 s TrackSidecars has seen the sidecar
  const t0 = Date.now();
  try { cp.execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(main1)], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* reported below */ }
  await waitFor(() => !alive(main1), 5000);
  const gone = await waitFor(() => supPid && !alive(supPid), 6000);
  const goneIn = Date.now() - t0;
  await sleep(Math.max(0, 8000 - (Date.now() - t0)));   // a restart would have shown up by now
  const lines = learn(outLines(dir));
  const s = state(dir);
  const log = supLog(dir);
  check('(g) tree kill with sidecar: banners put back', regGet(A) === 1, regGet(A));
  check('(g) tree kill with sidecar: NOT started again (no new fake-out line in 8 s)', lines.length === 1, { lines, last: s.last });
  check('(g) tree kill with sidecar: state.last treeKill true, restarted false, restore.dryRun true',
    !!(s.last && s.last.oldPid === main1 && s.last.treeKill === true && s.last.restarted === false && s.last.restore && s.last.restore.dryRun === true), s.last);
  check('(g) tree kill with sidecar: crashes cleared, no give-up', Array.isArray(s.crashes) && s.crashes.length === 0 && !s.gaveUp, { crashes: s.crashes, gaveUp: s.gaveUp });
  check('(g) tree kill with sidecar: the supervisor exits within ~5 s', !!gone, { supPid, goneIn, alive: alive(supPid) });
  check('(g) tree kill with sidecar: supervisor.log says "ended together"', /ended together/.test(log), log.split('\n').filter((l) => /main process|stopped|ended|crash/.test(l)));
  check('(g) the fake sidecar is gone too', !alive(sc1), { sc1 });
  stop(supPid);
}

async function caseMainAloneSidecar() {
  // (h) main ALONE killed (TerminateProcess, code 1) while it has a sidecar: the sidecar ends with 0 (libuv's
  // kill-on-close job / its stdin end), so it is a crash: banners back, restarted, the new main adopts it
  const dir = caseDir('alone-sc');
  const A = AUMID('alonesc');
  regSet(A, 0);
  const main1 = await fakeMain(dir, A, 'real', { sc: true });
  const sc1 = (outLines(dir).find((l) => l.pid === main1) || {}).sc;
  const supPid = await realSupervisor(dir, main1, '(h)');
  record(dir, { [A]: 1 }, main1);
  await waitFor(() => supLog(dir).includes(`watching Mantle's main process ${main1}`), 10000);
  check('(h) setup: the fake sidecar runs', !!sc1 && alive(sc1), { sc1 });
  await sleep(2600);
  stop(main1);
  const s = await waitFor(() => { const x = state(dir); return x.last && x.last.oldPid === main1 && (x.last.restarted || x.last.treeKill) ? x : (supPid && !alive(supPid) ? x : null); }, 45000);
  const newPid = s && s.last && s.last.newPid;
  if (newPid) started.add(newPid);
  const line = await waitFor(() => outLines(dir).find((l) => l.pid === newPid), 10000);
  learn(outLines(dir));
  check('(h) main alone: NOT read as a tree kill, restarted', !!(s && s.last && s.last.restarted === true && !s.last.treeKill), s && s.last);
  check('(h) main alone: banners put back', regGet(A) === 1, regGet(A));
  check('(h) main alone: main started again (a new fake-out line, with its own sidecar)', !!line && !!line.sc, line);
  const st2 = await waitFor(() => { const x = readJson(path.join(dir, `status-${newPid}.json`)); return x && x.via === 'adopted' ? x : null; }, 8000);
  check('(h) main alone: the new main ADOPTED the same supervisor', !!st2 && st2.pid === supPid, st2);
  check('(h) main alone: the old sidecar is gone', !alive(sc1), { sc1 });
  stop(supPid); stop(newPid); if (line && line.sc) stop(line.sc);
}

async function caseDuplicate() {
  // (i) one supervisor per --supervise-dir: a second copy for the same main exits, saying so; the holder's
  // state + supervisor.lock; a --supervise-detach launcher names the holder and starts no copy
  const dir = caseDir('dup');
  const lockFile = path.join(dir, 'supervisor.lock');
  const M = await fakeMain(dir, AUMID('dup'), 'plain');
  const A = await supervise(dir, M);
  const b = spawnSup(dir, M, 3000);
  const bCode = await b.exited;
  await sleep(200);
  const log1 = supLog(dir);
  check('(i) a second supervisor for the same main exits within 3 s', typeof bCode === 'number' && !alive(b.pid), { bCode });
  check('(i) ...saying "already watches"', log1.includes(`supervisor pid ${A} already watches Mantle's main process ${M}, so this copy (pid ${b.pid}) exits`), log1.split('\n').filter(Boolean));
  check('(i) the first supervisor is still running', alive(A), { A });
  const s = state(dir);
  check('(i) state: supervisorPid === A, watching === M, lock === true', s.supervisorPid === A && s.watching === M && s.lock === true, { supervisorPid: s.supervisorPid, watching: s.watching, lock: s.lock, A, M });
  const held = canOpen(lockFile);
  check('(i) supervisor.lock cannot be opened while A runs', held !== true && fs.existsSync(lockFile), { held, exists: fs.existsSync(lockFile) });
  // the launcher
  const c = cp.spawn(EXE, [...SUP_ARGS(dir, M), '--supervise-detach'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: true });
  started.add(c.pid);
  let out = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((res) => { const t = setTimeout(() => res('still running after 6 s'), 6000); c.once('exit', (x) => { clearTimeout(t); res(x); }); });
  await sleep(200);
  const extra = [b.pid];   // any other supervisor here (an exe without the one-per-folder rule) is stopped before M
  for (const m of out.matchAll(/"supervisor":(\d+)/g)) { started.add(Number(m[1])); if (Number(m[1]) !== A) extra.push(Number(m[1])); }
  check('(i) --supervise-detach for M prints exactly {"supervisor":A,"detached":true,"existing":true} and exits 0',
    out === `{"supervisor":${A},"detached":true,"existing":true}\n` && code === 0, { out, code, A });
  await sleep(1500);
  const log2 = supLog(dir);
  check('(i) ...and no second supervisor watches (one "watching" line)', count(log2, `watching Mantle's main process ${M}`) === 1, log2.split('\n').filter(Boolean));
  stop(A);
  await waitFor(() => !alive(A), 5000);
  const freed = await waitFor(() => canOpen(lockFile) === true, 3000);
  check('(i) supervisor.lock opens once A is stopped', !!freed, { now: canOpen(lockFile) });
  for (const p of extra) stop(p);
  await waitFor(() => extra.every((p) => !alive(p)), 3000);
  stop(M);
}

async function caseWaiting() {
  // (j) a copy for ANOTHER (newer) main in the same folder waits for the holder, then takes over
  const dir = caseDir('wait');
  const M1 = await fakeMain(dir, AUMID('w1'), 'plain');
  const A = await supervise(dir, M1);
  const M2 = await fakeMain(dir, AUMID('w2'), 'plain');
  const b = spawnSup(dir, M2, 60000);
  const waits = await waitFor(() => supLog(dir).includes(`it waits for that one to finish before it watches main ${M2}`), 6000);
  await sleep(300);
  check('(j) B (for M2) waits for A (watching M1)', !!waits && alive(b.pid) && !supLog(dir).includes(`watching Mantle's main process ${M2}`), supLog(dir).split('\n').filter(Boolean));
  check('(j) while A runs, the state is still A\'s', state(dir).supervisorPid === A, { supervisorPid: state(dir).supervisorPid, A });
  stop(A);
  const took = await waitFor(() => supLog(dir).includes(`watching Mantle's main process ${M2} (supervisor pid ${b.pid})`), 8000);
  check('(j) once A is stopped, B watches M2', !!took, supLog(dir).split('\n').filter(Boolean));
  const s = await waitFor(() => { const x = state(dir); return x.supervisorPid === b.pid ? x : null; }, 3000);
  check('(j) state.supervisorPid becomes B (watching M2)', !!s && s.watching === M2, s || state(dir));
  stop(b.pid); await waitFor(() => !alive(b.pid), 3000);
  stop(M1); stop(M2);
}

async function caseLostLock() {
  // (k) the supervisor's own relaunch loses Electron's single-instance lock to another live Mantle H: not a
  // crash; said; crashes stay at the first (real) one; no give-up; the supervisor exits
  const dir = caseDir('lostlock');
  const loseTo = path.join(dir, 'lose-lock-to.txt');
  const M1 = await fakeMain(dir, AUMID('lost'), 'plain', { loseTo });   // M1 itself finds no file: it runs
  const S = await supervise(dir, M1);
  const H = idleHost();
  await sleep(300);
  fs.writeFileSync(loseTo, String(H));   // only a relaunch of M1 reads it now
  stop(M1);
  const c1 = await waitFor(() => /crash 1 of 3/.test(supLog(dir)), 10000, 20);
  // the winner's record, as the main that won the lock writes it (same exe/args/cwd fields, pid H, at now)
  const rec = readJson(path.join(dir, 'supervisor-main.json')) || {};
  writeJson(path.join(dir, 'supervisor-main.json'), { ...rec, pid: H, at: Date.now(), standDown: null });
  check('(k) setup: M1\'s death was counted as crash 1 and the record now names H', !!c1 && alive(H), { log: supLog(dir).split('\n').filter(Boolean) });
  const gone = await waitFor(() => !alive(S), 20000);
  await sleep(500);
  const lines = learn(outLines(dir));
  const relaunch = lines.find((l) => l.pid !== M1);
  const log = supLog(dir);
  const s = state(dir);
  check('(k) S started M1 again exactly once', lines.length === 2 && !!relaunch, lines);
  check('(k) the relaunch lost the lock to H and exited (0)', !!relaunch && relaunch.lost === H && !alive(relaunch.pid) &&
    log.includes(`Mantle ${relaunch.pid} stopped (exit code 0x00000000)`), { relaunch, log: log.split('\n').filter((l) => /stopped|another/.test(l)) });
  check('(k) said: "another Mantle (pid H) already runs for this folder" + "lost the single-instance lock"',
    log.includes(`another Mantle (pid ${H}) already runs for this folder`) && log.includes('lost the single-instance lock'), log.split('\n').filter(Boolean));
  check('(k) not counted: state.crashes.length === 1, no gaveUp', Array.isArray(s.crashes) && s.crashes.length === 1 && !s.gaveUp, { crashes: s.crashes, gaveUp: s.gaveUp });
  check('(k) the supervisor exits', !!gone, { S });
  stop(S); stop(H);
}

async function caseDirGone() {
  // (m) a --supervise-test supervisor whose --supervise-dir was removed never starts main again, and exits
  const dir = caseDir('gone');
  const outF = path.join(TMP, 'gone-out.jsonl');
  const M = await fakeMain(dir, AUMID('gone'), 'plain', { out: outF, cwd: TMP });
  const S = await supervise(dir, M);
  let rmErr = null;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { rmErr = e.code || String(e); }
  check('(m) setup: the folder is removed while the supervisor runs', !fs.existsSync(dir), { rmErr, left: fs.existsSync(dir) ? fs.readdirSync(dir) : null });
  stop(M);
  const gone = await waitFor(() => !alive(S), 10000);
  await sleep(1500);
  const lines = learn(outFileLines(outF));
  check('(m) folder gone: main is NOT started again', lines.length === 1, lines);
  check('(m) folder gone: the supervisor exits', !!gone, { S });
  stop(S);
}

function sweep() {
  // anything still running with this run's unique folder or profile on its command line, by PID
  let pids = [];
  try {
    const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('${path.basename(TMP)}') -or $_.CommandLine.Contains('notif-safety-${RAND}')) } | ForEach-Object { $_.ProcessId }) -join ','`],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    pids = out.trim().split(',').filter(Boolean).map(Number).filter((p) => p && p !== process.pid);
  } catch (_) { /* reported by the caller */ }
  return pids;
}

(async () => {
  console.log(`supervisor-banners: exe ${EXE}`);
  console.log(`supervisor-banners: supervisor.js ${SUP_JS}`);
  console.log(`supervisor-banners: scratch key HKCU\\${KEY}`);
  if (!fs.existsSync(EXE)) { console.log('FAIL the exe is missing'); console.log('SUPERVISOR BANNERS TEST: 0 passed, 1 failed'); process.exitCode = 1; return; }
  try {
    for (const c of [caseCrash, caseStandDown, caseOtherOwner, caseDetachLine, caseTreeKill, caseTreeKillSidecar, caseMainAloneSidecar,
      caseDuplicate, caseWaiting, caseLostLock, caseDirGone]) {
      try { await c(); } catch (err) { check(`${c.name} ran to the end`, false, err.stack || String(err)); }
    }
  } finally {
    for (const pid of started) stop(pid);
    await sleep(500);
    let left = sweep();
    for (const pid of left) stop(pid);
    if (left.length) { await sleep(500); left = sweep(); }
    check('every process this test started is gone (stopped by pid)', left.length === 0 && [...started].every((p) => !alive(p)), { left, still: [...started].filter(alive) });
    try { reg(['delete', `HKCU\\${KEY_BASE}`, '/f']); } catch (_) { /* never made */ }
    try {
      const rest = reg(['query', 'HKCU\\Software\\MantleTest']);
      if (!/HKEY_CURRENT_USER\\Software\\MantleTest\\/i.test(rest) && !/REG_/.test(rest)) reg(['delete', 'HKCU\\Software\\MantleTest', '/f']);
    } catch (_) { /* gone */ }
    let keyGone = false;
    try { reg(['query', `HKCU\\${KEY_BASE}`]); } catch (_) { keyGone = true; }
    check('the scratch registry key is deleted', keyGone);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ }
    for (const f of failures) console.log('FAIL ' + f);
    console.log(`SUPERVISOR BANNERS TEST: ${passed} passed, ${failures.length} failed`);
    process.exitCode = failures.length ? 1 : 0;
  }
})();
