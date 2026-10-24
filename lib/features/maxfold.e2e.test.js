'use strict';
/*
 * maxfold.e2e.test.js - the maximize unfold END TO END (lane unfold-max, 2026-10-23): ONE hidden
 * --test Mantle of this checkout (lib/features/maxfold.js + a PASSIVE sidecar with sidecar/MaxFold.cs)
 * runs lib/features/_maxfold-selftest.js on one invisible test window of its own
 * (sidecar/maxfold-testwin.js), then quits so the feature's stop() runs.
 *
 *   node lib/features/maxfold.e2e.test.js     -> "MAXFOLD E2E TEST: n passed, m failed"
 *
 * env: MANTLE_SIDECAR_EXE (default sidecar\bin-next\Mantle.Sidecar.exe of this checkout).
 *      MAXFOLD_E2E_LOCK_HELD=1: the runner already holds the machine-wide browser lock
 *      (%TEMP%\claude-headless-browser.lock), so the Electron child runs with LOWCPU=0 (it would wait on
 *      that lock forever); this process is still pinned and Below Normal by lowcpu, and the child inherits it.
 * Never --live. Never on screen (lib/test-quiet.js; the test window and the overlay are alpha 0).
 * Leftovers are stopped with tools/kill-test.ps1 -Match unfold-max (by its own profile flag only).
 */
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'unfold-max';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const LOG = path.join(USER_DATA, 'mantle.log');
const OUT = path.join(os.tmpdir(), 'mantle-maxfold', 'selftest.json');
const EXE = process.env.MANTLE_SIDECAR_EXE || path.join(ROOT, 'sidecar', 'bin-next', 'Mantle.Sidecar.exe');

let passed = 0; const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)})` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch (_) { return ''; } };

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
function envFor(extra) {
  const env = Object.assign({}, process.env, extra || {});
  delete env.MANTLE_TEST_VISIBLE;     // a test copy never shows (lib/test-quiet.js)
  delete env.MAXFOLD_TEST_VISIBLE;    // the test window stays alpha 0
  return env;
}
function killTest() {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

let skipped = null;
let selftest = null;
async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session for real windows'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  if (!check('the sidecar exe is there', fs.existsSync(EXE), EXE.replace(os.homedir(), '~'))) return;

  let testwin = null;
  try { testwin = require('../../sidecar/maxfold-testwin').build(); } catch (e) { check('the test window helper builds', false, e.message); return; }
  check('the test window helper builds', !!testwin && fs.existsSync(testwin), 'no exe');

  try { fs.unlinkSync(OUT); } catch (_) { /* none */ }
  try { fs.unlinkSync(LOG); } catch (_) { /* none */ }
  const held = process.env.MAXFOLD_E2E_LOCK_HELD === '1';
  const env = envFor(Object.assign({ MANTLE_SIDECAR_EXE: EXE, MANTLE_MAXFOLD_SELFTEST: '1', MANTLE_MAXFOLD_TESTWIN: testwin }, held ? { LOWCPU: '0' } : {}));
  const run = { out: '', exited: null };
  const t0 = Date.now();
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, `--log=${LOG}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  run.proc.stdout.on('data', (c) => { run.out = (run.out + c.toString('utf8')).slice(-20000); });
  run.proc.stderr.on('data', (c) => { run.out = (run.out + c.toString('utf8')).slice(-20000); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  console.log(`info: launched --test --profile-name=${PROFILE} (pid ${run.proc.pid})${held ? ', browser lock held by the runner' : ''}`);
  try {
    const got = await until(() => run.exited || fs.existsSync(OUT), 150000, 500);
    if (!check('the selftest wrote its result', got && fs.existsSync(OUT), run.exited ? `the instance exited first (${JSON.stringify(run.exited)}): ${run.out.slice(-600)}` : 'none in 150 s')) return;
    await sleep(300);
    try { selftest = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { check('selftest.json parses', false, e.message); return; }
    console.log(`info: selftest took ${Math.round((Date.now() - t0) / 1000)} s`);
    if (selftest.skipped) skipped = selftest.skipped;
    for (const c of selftest.checks || []) check(`selftest: ${c.name}`, c.ok, c.detail);
    check('mantle.log has the SELFTEST line', /maxfold: SELFTEST \d+ passed, \d+ failed/.test(readLog()), 'not in the log');
    const n = selftest.numbers || {};
    console.log(`info: winAnim=${n.winAnim} reduced=${n.reduced} cancelled-and-retried=${n.cancelledRetries}`);
    for (const p of n.plays || []) {
      console.log(`info: play ${p.action}: firstFrameMs=${p.firstFrameMs} queueMs=${p.queueMs} frames=${p.frames} gapMedMs=${p.gapMedMs} gapMaxMs=${p.gapMaxMs}` +
        ` over20=${p.over20} missedDelta=${p.missedDelta} totalMs=${p.totalMs} mode=${p.mode} endedSharp=${p.endedSharp} cancelled=${p.cancelled}`);
    }
    if (n.restoreUnflagged) console.log(`info: ${n.restoreUnflagged}`);
    if (n.counts) console.log(`info: feature counts ${JSON.stringify(n.counts)}`);

    // a clean quit through a second instance (the messenger runs LOWCPU=0: the browser lock is the first one's)
    const q = spawnSync(process.execPath, [cli, '.', '--quit', '--test', `--profile-name=${PROFILE}`],
      { cwd: ROOT, env: envFor({ LOWCPU: '0' }), encoding: 'utf8', timeout: 45000, windowsHide: true });
    const exited = await until(() => run.exited, 30000, 250);
    check('--quit: the instance exits by itself', !!exited, { quit: String((q.stdout || '') + (q.stderr || '')).slice(-300), tail: run.out.slice(-400) });
    const log = readLog();
    const offLine = /maxfold: config off \((stopped|resting)\): armed=false/.exec(log);
    check('stop() switched it off: "config off (stopped): armed=false" in mantle.log', !!offLine,
      (log.match(/maxfold: config [^\n]*/g) || []).slice(-3).join(' | ') || 'no maxfold config line');
  } finally {
    if (!run.exited) {
      console.log(`info: kill-test: ${killTest().slice(0, 300)}`);
      await until(() => run.exited, 15000, 200);
    }
    const left = killTest();
    if (left) console.log(`info: kill-test (leftovers): ${left.slice(0, 300)}`);
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  if (skipped) console.log(`MAXFOLD E2E: skipped: ${skipped}`);
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`MAXFOLD E2E TEST: ${passed} passed, ${failures.length} failed${skipped ? ' (skipped: ' + skipped + ')' : ''}`);
  process.exit(failures.length ? 1 : 0);
});
