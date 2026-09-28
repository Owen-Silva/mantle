// test-spotifyexit.js (spotdeath lane, 2026-09-27): spotify.mem / spotify.trim report the exit code and time of the watched root
// APPDATA points at a scratch folder, so the only "Spotify.exe" reachable is a cmd.exe copy started here.
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-spotifyexit.js   (the real Spotify is never reached)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');

const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-spexit-'));
const APPDATA = path.join(ROOT, 'AppData');
const EXE = path.join(APPDATA, 'Spotify', 'Spotify.exe');
const started = [];
const exits = {};

function run(cmdline) {
  const p = spawn(EXE, [cmdline], { windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true });
  started.push(p.pid);
  exits[p.pid] = new Promise((res) => p.on('exit', (code) => res(code)));
  return p.pid;
}
function endAll() { for (const pid of started) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
function inList(pid) { const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }); return new RegExp(`\\b${pid}\\b`).test(r.stdout || ''); }

(async () => {
  const t = T.checker('SPEXIT');
  fs.mkdirSync(path.dirname(EXE), { recursive: true });
  fs.copyFileSync(path.join(SYS, 'cmd.exe'), EXE);
  const A = run('/d /c ping -n 4 127.0.0.1 >nul & exit 7');              // quits with 7 after ~3 s
  const B = run('/d /c ping -n 90 127.0.0.1 >nul');                       // ended by taskkill /F (code 1)
  const C = run('/d /c ping -n 12 127.0.0.1 >nul & exit -1073741819');     // "crash" code 0xC0000005
  const D = run('/d /c ping -n 3 127.0.0.1 >nul & exit 5');               // never read: nothing held
  const E = run('/d /c ping -n 6 127.0.0.1 >nul & exit 9');               // held, then a new root asked
  const F = run('/d /c ping -n 90 127.0.0.1 >nul');                       // the new root
  await T.sleep(800);
  const old = process.env.APPDATA;
  process.env.APPDATA = APPDATA;
  let s;
  try { s = await T.startPassive(); } finally { process.env.APPDATA = old; }
  try {
    const a1 = await s.call('spotify.mem', { root: A });
    t.check('A running, no exit fields while running', a1.running && !('exitCode' in a1) && !('exitedAt' in a1), JSON.stringify(a1).slice(0, 200));
    const a1b = await s.call('spotify.mem', { root: A, created: a1.created });
    t.check('A read again (same handle kept)', a1b.running, String(a1b.running));
    const c1 = await s.call('spotify.mem', { root: C });
    t.check('C running', c1.running);
    const e1 = await s.call('spotify.mem', { root: E });
    t.check('E running', e1.running);
    const f1 = await s.call('spotify.mem', { root: F });                  // new root: E's handle closed
    t.check('F running', f1.running);

    // A: held? No - C, E, F were read after it, so the held handle moved on. Re-hold A before it exits.
    const a2 = await s.call('spotify.mem', { root: A, created: a1.created });
    t.check('A re-held before exit', a2.running);
    const codeA = await exits[A]; await T.sleep(300);
    console.log(`  (A exited ${codeA}; still in the process list while held: ${inList(A)})`);
    const a3 = await s.call('spotify.mem', { root: A, created: a1.created });
    t.check('A exited: running false, why says exited', !a3.running && /has exited/.test(a3.why || '') && a3.n === 0, JSON.stringify(a3).slice(0, 300));
    t.check('A exitCode 7', a3.exitCode === 7, String(a3.exitCode));
    t.check('A exitedAt is a FILETIME after created', /^\d+$/.test(a3.exitedAt || '') && BigInt(a3.exitedAt) > BigInt(a1.created), `${a1.created} -> ${a3.exitedAt}`);
    console.log(`  (A after release still in the process list: ${inList(A)})`);
    const a4 = await s.call('spotify.mem', { root: A });
    t.check('A again: exited, no exit fields (handle released)', !a4.running && !('exitCode' in a4), JSON.stringify(a4).slice(0, 200));

    // E: held, then F asked (closed E), E exits -> nothing to say.
    await exits[E]; await T.sleep(300);
    const e2 = await s.call('spotify.mem', { root: E });
    t.check('E (handle closed when another root was asked): exited, no exit fields', !e2.running && !('exitCode' in e2), JSON.stringify(e2).slice(0, 200));

    // D: never read -> nothing held.
    await exits[D]; await T.sleep(200);
    const d1 = await s.call('spotify.mem', { root: D });
    t.check('D never held: exited, no exit fields', !d1.running && /has exited/.test(d1.why || '') && !('exitCode' in d1) && !('exitedAt' in d1), JSON.stringify(d1).slice(0, 200));

    // C: held, "crashes" with 0xC0000005, first seen by spotify.trim -> nothing trimmed, code as uint.
    const c2 = await s.call('spotify.mem', { root: C, created: c1.created });
    t.check('C re-held', c2.running);
    await exits[C]; await T.sleep(300);
    const c3 = await s.call('spotify.trim', { root: C, created: c1.created });
    t.check('trim on exited C: running false, nothing trimmed', !c3.running && c3.trimmed === 0 && (c3.results || []).length === 0 && /has exited/.test(c3.why || ''), JSON.stringify(c3).slice(0, 300));
    t.check('C exitCode 3221225477 (0xC0000005) as a number', c3.exitCode === 3221225477, String(c3.exitCode));
    t.check('C exitedAt present', /^\d+$/.test(c3.exitedAt || ''), c3.exitedAt);

    // B: held, ended with TerminateProcess via taskkill /F -> code 1.
    const b1 = await s.call('spotify.mem', { root: B });
    t.check('B running and held', b1.running);
    spawnSync('taskkill.exe', ['/PID', String(B), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await exits[B]; await T.sleep(300);
    const b2 = await s.call('spotify.mem', { root: B });
    t.check('B killed: exitCode 1', !b2.running && b2.exitCode === 1 && /^\d+$/.test(b2.exitedAt || ''), JSON.stringify(b2).slice(0, 300));
    // F still running and fine after all that (B took the handle from F, F re-held now).
    const f2 = await s.call('spotify.mem', { root: F, created: f1.created });
    t.check('F still reads running', f2.running && !('exitCode' in f2));
  } finally {
    await s.stop();
    endAll();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* a stand-in still exiting */ }
  }
  process.exit(t.summary());
})().catch((e) => { endAll(); console.error('SPEXIT TEST crashed:', e && e.stack || e); process.exit(1); });
