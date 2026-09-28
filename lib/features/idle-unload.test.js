'use strict';
/*
 * lib/features/idle-unload.test.js - lane ramdiet (2026-09-27): a rarely used hidden window goes
 * after IDLE_UNLOAD_MS unused and is made again on its next use (lib/features/_idle-unload.js).
 *
 *   node lib/features/idle-unload.test.js              unit: the timer, busy, unloadAll, stop
 *   node lib/features/idle-unload.test.js --electron   ...then ONE Electron --test instance (needs a
 *        test slot and MANTLE_SIDECAR_EXE) with MANTLE_IDLE_UNLOAD_MS=4000: no screenshot card at
 *        start; Win+Shift+S makes it and a SYNTHETIC capture shows it; it goes after 4 s unused
 *        while the clipboard panel (kept warm) stays and opens; the next capture makes the card
 *        again and shows it; nothing throws.
 *
 * Plain node, no deps. One summary line: "idle-unload tests: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function unit() {
  process.env.MANTLE_IDLE_UNLOAD_MS = '60';
  delete require.cache[require.resolve('./_idle-unload.js')];
  const IDLE = require('./_idle-unload.js');
  check('unit: the live wait is 10 minutes', IDLE.IDLE_UNLOAD_MS === 10 * 60 * 1000);
  check('unit: the env override is --test only', IDLE.idleMs(false) === IDLE.IDLE_UNLOAD_MS && IDLE.idleMs(true) === 60);
  const lines = [];
  let win = { alive: true }, busy = false, unloads = 0;
  const h = IDLE.watchIdle({ what: 'panel A', log: (l) => lines.push(l), test: true, busy: () => busy,
    unload: () => { if (!win) return false; win = null; unloads++; return true; } });
  h.touch();
  await sleep(30);
  h.touch();                                   // a use restarts the wait
  await sleep(45);
  check('unit: a use restarts the wait', unloads === 0);
  await sleep(60);
  check('unit: unused for the wait -> unloaded once', unloads === 1 && win === null, `unloads ${unloads}`);
  check('unit: the unload is logged with why', lines.some((l) => /^panel A: unloaded \(unused for 60 ms\)/.test(l)), lines.join(' / '));
  win = { alive: true }; busy = true;
  h.touch();
  await sleep(150);
  check('unit: busy -> never unloaded (the wait starts again)', unloads === 1 && win);
  check('unit: unloadAll skips a busy window', IDLE.unloadAll('test').length === 0 && win);
  busy = false;
  const went = IDLE.unloadAll('test');
  check('unit: unloadAll unloads an idle one and names it', went.length === 1 && went[0] === 'panel A' && win === null, JSON.stringify(went));
  check('unit: nothing left to unload -> not named', IDLE.unloadAll('test').length === 0);
  win = { alive: true };
  h.touch();
  h.stop();
  await sleep(150);
  check('unit: stop() ends the wait and the registration', win && IDLE.unloadAll('test').length === 0);
}

function gamesRunning() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' });
  return parseInt((r.stdout || '0').trim(), 10) || 0;
}

async function electronCheck() {
  const ROOT = path.join(__dirname, '..', '..');
  const exe = process.env.MANTLE_SIDECAR_EXE;
  if (!exe || !fs.existsSync(exe)) { check('electron: MANTLE_SIDECAR_EXE names a built exe', false, String(exe)); return; }
  if (gamesRunning()) { check('electron: no game running (not launching an instance)', false); return; }
  let slot = null;
  for (const n of [1, 2]) {
    const d = path.join(os.tmpdir(), `mantle-slot-${n}`);
    try { fs.mkdirSync(d); slot = d; break; } catch (_) { /* taken */ }
  }
  if (!slot) { check('electron: a test slot was free (mantle-slot-1/2 both taken; try again later)', false); return; }
  const PROFILE = 'idleunload';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-idle-e2e-'));
  // Two SYNTHETIC captures (never Owen's screen): Full screen, Enter. Saves go to outDir (deleted).
  const steps = [{ synthetic: true, mode: 'full', key: 'Enter' }, { synthetic: true, mode: 'full', key: 'Enter' }];
  const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
  const env = Object.assign({}, process.env, { MANTLE_SIDECAR_EXE: exe, MANTLE_IDLE_UNLOAD_MS: '4000',
    MANTLE_SHOT_TEST: JSON.stringify(steps), MANTLE_SHOT_TEST_DIR: outDir });
  let out = '';
  const proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
  let exited = null;
  proc.on('exit', (code) => { exited = { code, at: Date.now() }; });
  const toback = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'toback.ps1'), '-Match', PROFILE, '-WaitSec', '120'], { stdio: 'ignore' });
  const envMsg = Object.assign({}, env, { LOWCPU: '0' });   // a messenger never waits for the one-browser lock
  const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000 });
  const count = (re) => (out.match(new RegExp(re.source, 'g')) || []).length;
  const waitFor = async (re, ms, n) => { const t = Date.now() + ms; while (Date.now() < t) { if (count(re) >= (n || 1)) return true; if (exited) return false; await sleep(150); } return false; };
  try {
    const up = await waitFor(/features: started .*screenshot/, 9 * 60000);
    check('electron: the features start', up, out.slice(-600));
    if (!up) return;
    await waitFor(/clipboard: started: mode/, 20000);
    second(['--test-memory=start']);
    await waitFor(/state \(start\): Win key/, 10000);
    const startWins = (out.match(/state \(start\): Win key: .*\| windows: (.*)/) || [])[1] || '';
    check('electron: no screenshot card window at start (made on demand)', startWins && !/screenshot card/.test(startWins) && /clipboard/.test(startWins), startWins);

    second(['--test-chord=Win+Shift+S']);
    check('electron: the first capture makes the card', await waitFor(/screenshot: the card window was made in \d+ ms/, 20000), out.slice(-600));
    check('electron: ...and shows it (its page answered cardShown)', await waitFor(/TESTSHOT card shown/, 20000), out.slice(-600));

    check('electron: the card goes after 4 s unused', await waitFor(/screenshot: the screenshot card: unloaded \(unused for 4000 ms\)/, 30000), out.slice(-600));
    await sleep(2000);
    second(['--test-memory=unloaded']);
    await waitFor(/state \(unloaded\): Win key/, 10000);
    const idleWins = (out.match(/state \(unloaded\): Win key: .*\| windows: (.*)/) || [])[1] || '';
    check('electron: the card window is gone once unloaded', idleWins && !/screenshot card/.test(idleWins), idleWins);
    // The clipboard panel STAYS WARM (a cold one opened in 136-246 ms, not ~25 ms): it is never unloaded.
    check('electron: the clipboard panel is still there (kept warm)', /clipboard/.test(idleWins) && !/clipboard panel: unloaded/.test(out), idleWins);
    check('electron: the features still read healthy', /state \(unloaded\): clipboard: healthy/.test(out) && /state \(unloaded\): screenshot: healthy/.test(out));

    second(['--test-chord=Win+V']);
    check('electron: Win+V opens the warm panel', await waitFor(/clipboard: opened by Win\+V in \d+ ms/, 15000), out.slice(-600));
    const opened = (out.match(/clipboard: opened by Win\+V in (\d+) ms/) || [])[1];
    second(['--test-chord=Win+V']);
    await sleep(800);
    second(['--test-unload']);
    check('electron: --test-unload finds nothing left to unload', await waitFor(/test-unload: nothing to unload/, 10000), (out.match(/test-unload: .*/) || [''])[0]);

    second(['--test-chord=Win+Shift+S']);
    check('electron: the next capture makes the card again', await waitFor(/screenshot: the card window was made in \d+ ms/, 20000, 2), out.slice(-600));
    check('electron: ...and shows it again', await waitFor(/TESTSHOT card shown/, 20000, 2), out.slice(-600));
    console.log(`  warm Win+V opened in ${opened} ms; ${(out.match(/the card window was made in \d+ ms/g) || []).join('; ')}`);

    second(['--quit']);
    const t = Date.now() + 30000;
    while (Date.now() < t && !exited) await sleep(150);
    check('electron: --quit ends the instance', !!exited);
    check('electron: no uncaught exception or handler failure', !/uncaught exception|RESTORE INCOMPLETE|handler threw|unhandled promise rejection/.test(out),
      (out.match(/.*(uncaught exception|RESTORE INCOMPLETE|handler threw|unhandled promise rejection).*/) || [''])[0]);
  } finally {
    if (!exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    try { toback.kill(); } catch (_) { /* done */ }
    try { fs.rmdirSync(slot); } catch (_) { /* someone removed it */ }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) { /* temp */ }
    const log = path.join(os.tmpdir(), 'mantle-idle-unload-e2e.log');
    try { fs.writeFileSync(log, out); console.log(`electron output: ${log}`); } catch (_) { /* best effort */ }
  }
}

(async () => {
  await unit();
  if (process.argv.includes('--electron')) await electronCheck();
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`idle-unload tests: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
