'use strict';
/*
 * _taskmgr-elevated.test.js - the client + the real helper binary, un-elevated (lane tm-elevate).
 *
 *   node lib/features/_taskmgr-elevated.test.js
 *
 * Builds nothing; it spawns the already-built sidecar/elevated/bin/mantle.elevated.exe with
 * MANTLE_ELEVATED_TEST=1 (the test seam is honored ONLY when the process is not elevated). It covers
 * what CAN be checked without administrator: install/stale/running state, the named-pipe handshake
 * and auth, JSON-line dispatch, the allowlist refusal, the client-image allowlist decision (through
 * the real binary via test.checkimage), and that every admin op answers needsAdmin cleanly.
 *
 * NOT verified here (needs a real elevated helper): a real ETW capture, a real SRUM read, a real
 * admin action, and the medium-integrity pipe label letting a medium client reach a high-IL pipe.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createElevated } = require('./_taskmgr-elevated');

const EXE = path.join(__dirname, '..', '..', 'sidecar', 'elevated', 'bin', 'mantle.elevated.exe');
const VERSION = fs.readFileSync(path.join(__dirname, '..', '..', 'sidecar', 'elevated', 'VERSION'), 'utf8').trim();

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail ? ' -- ' + detail : '')); }

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-elev-')); }

// A fresh client wired to a temp install dir + temp handshake, spawning the real exe directly.
let spawned = [];
function makeClient(installDir, opts) {
  const runDir = mkTmp();                                   // helper handshake + log live here (test seam)
  const handshakeFile = path.join(runDir, 'handshake.json');
  return createElevated({ log: function () {} }, Object.assign({
    installDir: installDir,
    handshakeFile: handshakeFile,
    startHelper: function () {
      const p = spawn(EXE, ['--pipe'], {
        env: Object.assign({}, process.env, { MANTLE_ELEVATED_TEST: '1', MANTLE_ELEVATED_DIR: runDir }),
        windowsHide: true });
      spawned.push(p);
      return new Promise(function (r) { setTimeout(r, 150); }); // give it a beat to open the pipe
    },
  }, opts || {}));
}

function installFixture(version) {
  const dir = mkTmp();
  fs.copyFileSync(EXE, path.join(dir, 'mantle.elevated.exe'));
  fs.writeFileSync(path.join(dir, 'version.txt'), version);
  return dir;
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('FAIL build the exe first (sidecar/elevated/build.ps1)'); process.exit(1); }

  // ---- status / version / stale ----------------------------------------
  const empty = makeClient(mkTmp());
  const s0 = empty.status();
  check('not installed -> installed:false, running:false, with a reason', s0.installed === false && s0.running === false && /not set up/.test(s0.reason), JSON.stringify(s0));

  const staleDir = installFixture('0');
  const staleClient = makeClient(staleDir);
  const s1 = staleClient.status();
  check('version mismatch -> stale:true with the numbers in the reason', s1.installed === true && s1.stale === true && s1.version === '0' && new RegExp('need ' + VERSION).test(s1.reason), JSON.stringify(s1));

  const okDir = installFixture(VERSION);
  const client = makeClient(okDir);
  const s2 = client.status();
  check('right version -> installed:true, stale:false', s2.installed === true && s2.stale === false && s2.version === VERSION, JSON.stringify(s2));

  // ---- a stale install refuses to connect (no silent fallback) ---------
  const staleRun = await staleClient.run('taskmgr.netsample', { action: 'start' }, { timeoutMs: 4000 });
  check('run on a stale install is refused with the stale reason', staleRun.ok === false && /newer administrator helper/.test(staleRun.reason), JSON.stringify(staleRun));

  // ---- real channel: connect, auth, dispatch ---------------------------
  // A taskmgr.* handler answers in the SAME envelope the main sidecar writes ({ok:true, result}; Host.cs
  // Dispatch), so lib/_taskmgr-admin.js shape() reads both alike; the handler's own {ok, needsAdmin,
  // reason} lives inside result. inner() reads it (test.* replies and refusals stay flat).
  const inner = (r) => (r && r.ok === true && r.result && typeof r.result === 'object') ? r.result : r;
  const net1 = inner(await client.run('taskmgr.netsample', { action: 'start' }, { timeoutMs: 6000 }));
  check('netsample start (un-elevated) -> ok:false, needsAdmin:true, clean reason', net1.ok === false && net1.needsAdmin === true && typeof net1.reason === 'string' && net1.reason.length > 0, JSON.stringify(net1));

  const hist = inner(await client.run('taskmgr.apphistory', {}, { timeoutMs: 8000 }));
  check('apphistory (un-elevated) -> ok:false, needsAdmin:true, source srum', hist.ok === false && hist.needsAdmin === true && hist.source === 'srum', JSON.stringify(hist));

  const start = inner(await client.run('taskmgr.startupimpact', {}, { timeoutMs: 6000 }));
  check('startupimpact (un-elevated) -> ok:false, needsAdmin:true', start.ok === false && start.needsAdmin === true, JSON.stringify(start));

  // partial startup read works un-elevated (HKCU is readable): real rows, admin fields null.
  const startP = inner(await client.run('taskmgr.startupimpact', { partial: true }, { timeoutMs: 6000 }));
  check('startupimpact partial -> ok:true with rows (HKCU readable un-elevated)', startP.ok === true && Array.isArray(startP.rows), JSON.stringify(startP).slice(0, 200));

  // ---- the allowlist: an off-list command is refused -------------------
  const bad = await client.run('taskmgr.formatdisk', {}, { timeoutMs: 6000 });
  check('an off-allowlist command is refused, not run', bad.ok === false && /not an elevated Task Manager command/.test(bad.reason), JSON.stringify(bad));

  const bad2 = await client.run('shell.exec', { cmd: 'calc' }, { timeoutMs: 6000 });
  check('a generic exec is refused (no generic exec exists)', bad2.ok === false && /not an elevated Task Manager command/.test(bad2.reason), JSON.stringify(bad2));

  // ---- the client-image allowlist, through the real binary -------------
  const U = 'C:\\Users\\you';   // synthetic inputs to a pure string check; the real roots are derived at runtime
  const liveSidecar = U + '\\mantle-live\\sidecar\\bin\\Mantle.Sidecar.exe';
  const devElectron = U + '\\mantle\\node_modules\\electron\\dist\\electron.exe';
  const wtElectron = U + '\\mantle-wt\\tm-ui\\node_modules\\electron\\dist\\electron.exe';
  const roots = [U + '\\mantle-live', U + '\\mantle', U + '\\mantle-wt'];
  const ci = async (p) => (await client.run('test.checkimage', { path: p, roots: roots }, { timeoutMs: 5000 }));

  check('live sidecar image is accepted', (await ci(liveSidecar)).ok === true);
  check('dev electron image is accepted', (await ci(devElectron)).ok === true);
  check('worktree electron image is accepted', (await ci(wtElectron)).ok === true);
  const r1 = await ci('C:\\Windows\\System32\\cmd.exe');
  check('cmd.exe under System32 is refused', r1.ok === false && /not a Mantle sidecar or Electron/.test(r1.verdict), JSON.stringify(r1));
  const r2 = await ci(U + '\\Downloads\\evil\\electron.exe');
  check('electron.exe outside a Mantle folder is refused', r2.ok === false && /not under a known Mantle folder/.test(r2.verdict), JSON.stringify(r2));
  const r3 = await ci(U + '\\mantle-live-evil\\electron.exe');
  check('a look-alike sibling folder is refused (prefix must end at a separator)', r3.ok === false, JSON.stringify(r3));
  const r4 = await ci('');
  check('an empty image path is refused', r4.ok === false);

  // ---- echo round-trips (the JSON-line wire) ---------------------------
  const echo = await client.run('test.echo', { text: 'hi there' }, { timeoutMs: 5000 });
  check('test.echo round-trips the wire', echo.ok === true && echo.echo === 'hi there', JSON.stringify(echo));

  // ---- lazy reconnect after the helper exits on disconnect -------------
  // Drop the connection; the helper sees EOF and exits, freeing the single-instance pipe. The next
  // run on the SAME client writes a fresh handshake, starts a new helper and reconnects.
  const before = spawned.length;
  client.disconnect();
  // wait for the just-dropped helper to actually exit (release the pipe name) before reconnecting
  if (spawned[before - 1]) await new Promise((r) => { const p = spawned[before - 1]; if (p.exitCode !== null) return r(); p.once('exit', r); setTimeout(r, 3000); });
  const again = inner(await client.run('taskmgr.netsample', { action: 'start' }, { timeoutMs: 8000 }));
  check('the same client lazily reconnects and dispatches after the helper exited', again.ok === false && again.needsAdmin === true, JSON.stringify(again));
  check('reconnect started a fresh helper', spawned.length === before + 1, 'spawned ' + spawned.length + ' want ' + (before + 1));

  // cleanup any helpers still up
  for (const p of spawned) { try { p.kill(); } catch (_) {} }

  for (const f of failures) console.log('FAIL ' + f);
  console.log('TASKMGR ELEVATED TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('FAIL threw ' + (e && e.stack || e)); process.exit(1); });
