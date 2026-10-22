'use strict';
/*
 * lib/open-arg.e2e.test.js - `--open=wallpapers` from a second start, in REAL --test instances
 * (lane looksync-open, 2026-10-10). Quartz and Helm's "Open Mantle Wallpapers" button runs exactly
 * this against the live instance; here it is proven against an invisible --test one instead.
 *
 *   (a) a second process with the same --test --profile-name=<p> plus --open=wallpapers exits promptly
 *       (exit 0) and says it asked;
 *   (b) the running instance logs "opened Wallpapers for a second start" and a ui/wallpapers page
 *       target appears over CDP; asking again keeps it ONE window;
 *   (c) --open=../../evil and --open=settings are refused in one log line each (the second process
 *       exits 4) and open nothing: no new page target of any kind appears;
 *   (d) with NO instance on a profile, --open=wallpapers exits 3 quickly with
 *       "Mantle is not running, so its Wallpapers could not be opened", never boots (no shell lines),
 *       and leaves no electron.exe behind.
 *
 *   node lib/open-arg.e2e.test.js      -> "OPEN ARG E2E: n passed, m failed" (exit 1 on any failure)
 * Refuses while a game runs. Never sets MANTLE_TEST_VISIBLE. Every test instance is stopped with
 * tools/kill-test.ps1 -Match <profile> whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'open-arg';
const NOBODY = 'open-arg-none';   // a profile nothing ever runs on: case (d)
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 150);
  }
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)

function launch(extra) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'].concat(extra || []),
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}

/** A second start: same argv shape as the instance it knocks on, plus the extra flags. Resolves when it exits. */
function second(profile, extra, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = { out: '', err: '', code: null, ms: null, timedOut: false };
    const p = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${profile}`].concat(extra),
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (c) => { r.out += c.toString('utf8'); });
    p.stderr.on('data', (c) => { r.err += c.toString('utf8'); });
    const timer = setTimeout(() => { r.timedOut = true; try { p.kill(); } catch (_) { /* gone */ } }, ms || 30000);
    p.on('exit', (code) => { clearTimeout(timer); r.code = code; r.ms = Date.now() - t0; resolve(r); });
  });
}

async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
const pageName = (u) => ((/\/ui\/([^?#]+)/.exec(u) || [])[1] || u).replace(/\/index\.html$/, '');

/** electron.exe processes whose command line carries --profile-name=<p> (READ only). */
function electronsFor(profile) {
  const ps = `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--profile-name=${profile}') -and -not $_.CommandLine.Contains('--profile-name=${profile}-') }).Count`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 });
  return parseInt((r.stdout || '').trim(), 10);
}
function killTest(profile) {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', profile], { encoding: 'utf8', timeout: 30000 });
}

async function main() {
  if (gaming()) {
    console.log('SKIPPED: a game is running (no test instances while the user games)');
    console.log('OPEN ARG E2E: 0 passed, 0 failed (skipped)');
    process.exit(0);
  }
  killTest(PROFILE);
  killTest(NOBODY);

  // (d) first, while nothing at all runs on NOBODY.
  {
    const r = await second(NOBODY, ['--open=wallpapers'], 30000);
    check('(d) no instance: --open=wallpapers exits 3', r.code === 3 && !r.timedOut, { code: r.code, timedOut: r.timedOut, err: r.err.slice(0, 300) });
    check('(d) no instance: it exits quickly (< 10 s)', r.ms !== null && r.ms < 10000, `${r.ms} ms`);
    check('(d) no instance: stderr says "Mantle is not running, so its Wallpapers could not be opened"',
      /^Mantle is not running, so its Wallpapers could not be opened$/m.test(r.err), r.err.slice(0, 300));
    // The only line allowed on stdout is lib/test-quiet.js's banner (it runs at line 7 of main.js,
    // before any flag is read); anything else would be the boot getting further than it should.
    const extra = r.out.split(/\r?\n/).filter((s) => s.trim() && !s.startsWith('mantle: test mode: every window is kept off the screen'));
    check('(d) no instance: it printed nothing past the test-quiet banner (never started booting)', extra.length === 0, extra);
    await sleep(800);
    const left = electronsFor(NOBODY);
    check('(d) no instance: no electron.exe is left behind on that profile', left === 0, `count=${left}`);
    const bad = await second(NOBODY, ['--open=settings'], 30000);
    check('(d) no instance + a refused value: exits 3 and says nothing could be opened',
      bad.code === 3 && /Mantle is not running, so nothing could be opened \(and "settings" is not something Mantle opens from outside/.test(bad.err), { code: bad.code, err: bad.err.slice(0, 300) });
    killTest(NOBODY);   // belt and braces, should be a no-op
  }

  const run = launch();
  try {
    const port = await until(() => {
      try { const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0].trim(); return /^\d+$/.test(s) ? s : null; } catch (_) { return null; }
    }, 45000, 250);
    if (!check('the test instance opened a DevTools port', !!port, run.out.slice(-600))) return;
    const booted = await until(async () => ((await targets(port)).length ? true : null), 45000, 300);
    if (!check('the test instance has its pages up', !!booted, run.out.slice(-600))) return;
    await sleep(1500);
    const before = (await targets(port)).map((t) => pageName(t.url)).sort();
    check('no Wallpapers window before anything asks', !before.includes('wallpapers'), before);

    // (c) refusals: one line each in the instance's log, nothing opened.
    for (const v of ['../../evil', 'settings']) {
      const mark = run.out.length;
      const r = await second(PROFILE, [`--open=${v}`], 30000);
      check(`(c) --open=${v}: the second process exits 4 and says it is refused`, r.code === 4
        && r.err.includes(`a second start asked to open ${JSON.stringify(v)}, which is not something Mantle opens from outside (allowed: wallpapers)`), { code: r.code, err: r.err.slice(0, 300) });
      const line = `mantle: a second start asked to open ${JSON.stringify(v)}, which is not something Mantle opens from outside (allowed: wallpapers)`;
      const logged = await until(() => (run.out.slice(mark).includes(line) ? true : null), 8000, 150);
      check(`(c) --open=${v}: the running instance logged the refusal`, !!logged, run.out.slice(mark).slice(0, 400));
      await sleep(1200);
      const since = run.out.slice(mark).split(/\r?\n/).filter((s) => s.trim());
      // The instance may still be logging its own boot; what matters is that the request produced
      // exactly one line (the refusal) and nothing that opened anything.
      const about = since.filter((s) => /second start|--open|opened/i.test(s));
      check(`(c) --open=${v}: the refusal is the only line about the request`, about.length === 1 && about[0] === line, about);
      const now = (await targets(port)).map((t) => pageName(t.url)).sort();
      check(`(c) --open=${v}: no page target appeared (nothing opened)`, JSON.stringify(now) === JSON.stringify(before), { before, now });
    }

    // (a) + (b): the real thing.
    const mark = run.out.length;
    const r = await second(PROFILE, ['--open=wallpapers'], 30000);
    check('(a) --open=wallpapers: the second process exits 0', r.code === 0 && !r.timedOut, { code: r.code, out: r.out.slice(0, 200), err: r.err.slice(0, 200) });
    check('(a) --open=wallpapers: it exits promptly (< 10 s)', r.ms !== null && r.ms < 10000, `${r.ms} ms`);
    check('(a) --open=wallpapers: it says it asked the running Mantle', /asked the running Mantle \(.*mantle-test-open-arg\) to open its Wallpapers\./.test(r.out), r.out.slice(0, 300));
    const opened = await until(() => (run.out.slice(mark).includes('mantle: opened Wallpapers for a second start (--open=wallpapers)') ? true : null), 10000, 150);
    check('(b) the running instance logged "opened Wallpapers for a second start (--open=wallpapers)"', !!opened, run.out.slice(mark).slice(0, 400));
    const wt = await until(async () => (await targets(port)).filter((t) => pageName(t.url) === 'wallpapers').length || null, 15000, 200);
    check('(b) a ui/wallpapers page target appeared over CDP', wt === 1, `count=${wt}`);
    check('(b) the instance is still running (it was asked to open, not to stop)', run.exited === null, run.exited);

    const mark2 = run.out.length;
    const r2 = await second(PROFILE, ['--open=WALLPAPERS'], 30000);
    const again = await until(() => (run.out.slice(mark2).includes('mantle: opened Wallpapers for a second start (--open=wallpapers)') ? true : null), 10000, 150);
    await sleep(800);
    const count2 = (await targets(port)).filter((t) => pageName(t.url) === 'wallpapers').length;
    check('(b) asking again (--open=WALLPAPERS, any case) logs again and keeps ONE Wallpapers window', r2.code === 0 && !!again && count2 === 1, { code: r2.code, again, count2 });

    // Existing second-instance behaviour is untouched: a plain second start still gets the old line.
    const mark3 = run.out.length;
    const r3 = await second(PROFILE, [], 30000);
    const plain = await until(() => (run.out.slice(mark3).includes('mantle: another Mantle tried to start; this one is already running, so that one exited.') ? true : null), 8000, 150);
    check('a plain second start still gets the old "another Mantle tried to start" line', !!plain && r3.code === 0, { code: r3.code, log: run.out.slice(mark3).slice(0, 300) });
  } finally {
    killTest(PROFILE);
    await sleep(500);
  }
  const leftA = electronsFor(PROFILE);
  check('cleanup: no electron.exe left on the test profile', leftA === 0, `count=${leftA}`);
}

main().catch((err) => { check('the run itself did not throw', false, err && err.stack); }).finally(() => {
  killTest(PROFILE);
  killTest(NOBODY);
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`OPEN ARG E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
