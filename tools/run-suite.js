'use strict';
/*
 * run-suite.js - the WHOLE Mantle test suite, serially, in one command (lane mn-suite, 2026-10-12).
 *
 *   node tools/run-suite.js [--only=<substring,...>] [--skip=<substring,...>] [--out=<dir>]
 *                           [--timeout=<seconds per file>] [--status=<file.md>] [--lane=<name>] [--list]
 *
 * Run it from any worktree root (or anywhere: the root is this file's parent folder). It finds:
 *   - every *.test.js (never node_modules, .git, bin, obj),
 *   - every sidecar/test-*.js (the sidecar harnesses; test-lib.js is plumbing, test-search-bench.js a
 *     benchmark with no verdict),
 *   - tools/check.js (every .js parses),
 *   - every lib/features/_<x>-selftest.js, run the way it is meant to run: an Electron --test instance
 *     with MANTLE_<X>_SELFTEST=1 and a PRIVATE TEMP/TMP (the selftest result files under %TEMP% are shared
 *     by every lane, and a concurrent run overwrites them), judged by the "selftest ... N passed, M failed"
 *     line the instance prints; the instance is then stopped by pid.
 * and runs them ONE AT A TIME with a per-file timeout. Whatever a file leaves behind (an Electron tree, a
 * sidecar, a headless Chromium) is stopped BY PID: the runner tracks the process tree each test starts
 * (plus any electron.exe / Mantle.Sidecar.exe started from THIS worktree during the test) and ends only
 * those. Never an image-name kill, never Quartz.exe or Helm.exe.
 *
 * THE VERDICT IS THE PRINTED TOTALS, not the exit code. Each file's summary line(s) are parsed: the house
 * format is "<label>: N passed, M failed" (sidecar/test-lib.js checker, most page tests); a file that prints
 * several labelled summaries (screenshot unit + electron) is the sum of the last line per label. A file
 * with no summary line is "could not start" (it crashed, or its harness never ran). Failures the
 * ENVIRONMENT causes (KNOWN_ENV below: each entry names the file, the failing checks it covers and why) are
 * printed separately and are not counted as code failures; a file whose failures are not ALL covered stays
 * a code failure.
 *
 * Output: one line per file and a total on stdout; <out>/suite.json (every file: status, counts, FAIL lines,
 * seconds, log path), <out>/suite.txt (the printed report) and <out>/logs/<file>.log (full output).
 * Progress goes to --status (default C:\Users\user\mantle-notes\suite-status.md when that folder exists).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ROOT_LC = ROOT.toLowerCase() + path.sep;

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find((x) => x === '--' + name || x.startsWith('--' + name + '='));
  if (!a) return dflt;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const list = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
const ONLY = list(opt('only', ''));
const SKIP = list(opt('skip', ''));
const TIMEOUT_S = Number(opt('timeout', 600)) || 600;
const LANE = String(opt('lane', path.basename(ROOT))).replace(/[^A-Za-z0-9_-]/g, '') || 'suite';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(String(opt('out', path.join(os.tmpdir(), 'mantle-suite-' + LANE, STAMP))));
const NIGHT = 'C:\\Users\\user\\mantle-notes';
const STATUS = opt('status', fs.existsSync(NIGHT) ? path.join(NIGHT, 'suite-status.md') : '');
const LIST_ONLY = !!opt('list', false);

// ------------------------------------------------------------------ known environment failures
// Each: file (relative, forward slashes), fails = regexes that must cover EVERY failing check of that file,
// reason = why it is the environment and not the code. Verified 2026-10-12 (see the lane report).
// evidence (optional) = a regex one of the FAIL lines must ALSO match, so a real regression in the same checks
// is not hidden. Everything not listed here counts as a code failure.
//
// Checked and DROPPED from the old ship-script list (2026-10-12): features 173/1 (the --electron half lacked
// MANTLE_SIDECAR_EXE; the runner now passes this checkout's exe), mainrel 95/3 (a stale test sandbox, fixed in
// lib/main-rel.test.js), windowsu 9/1, layoutsu, mcprobe (all pass on a normal machine).
const SCREEN_OFF = 'the display is off or the session is locked: sidecar/TopbarStats.cs pauses the system sampler then BY DESIGN ' +
  '(saves CPU while nobody can see the bar), so no sample arrives. Re-run with the screen on to judge these checks.';
const KNOWN_ENV = [
  {
    file: 'sidecar/test-topbar.js',
    fails: [/stats: one sample a second/, /stats: evenly spaced/, /stats: CPU total/, /stats: RAM in use/, /stats: GPU is a number/,
      /stats: network rates/, /stats detail: /, /stats: cheap/, /stats off: no more samples/],
    evidence: /stats: one sample a second.*\(\s*[0-3] samples/,
    reason: SCREEN_OFF,
  },
  {
    file: 'selftest:topbar',
    fails: [/a system sample arrived/],
    reason: SCREEN_OFF,
  },
];

// ------------------------------------------------------------------ discovery
const SKIP_DIRS = new Set(['node_modules', '.git', 'obj', 'bin', 'bin-int', 'bin-next', 'out', 'shots']);
function walk(dir, acc) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), acc); }
    else if (e.isFile()) acc.push(path.join(dir, e.name));
  }
  return acc;
}
// test files whose Electron half only runs behind a flag (found by grepping process.argv in every test file;
// the other flags in use are comparisons or verbosity, not extra checks)
const MODES = {
  'lib/features.test.js': ['--electron'],
  'lib/features/idle-unload.test.js': ['--electron'],
  'lib/features/screenshot.test.js': ['--electron', '--electron-text'],
};
// selftests that start from a chord: once the instance is up, a SECOND 'electron . --test --profile-name=<same>
// --test-chord=<chord>' hands it over through 'second-instance' (main.js), the hook's own routing, no keystroke
const SELF_CHORD = { search: 'Win+S' };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function discover() {
  const all = walk(ROOT, []);
  const entries = [];
  entries.push({ id: 'tools/check.js', kind: 'node', file: path.join(ROOT, 'tools', 'check.js'), check: true });
  for (const f of all.filter((p) => p.endsWith('.test.js')).sort()) {
    entries.push({ id: rel(f), kind: 'node', file: f });
    // the same file's END-TO-END half: a separate run with its flag (one Electron --test instance each)
    for (const flag of MODES[rel(f)] || []) entries.push({ id: rel(f) + ' ' + flag, kind: 'node', file: f, args: [flag] });
  }
  const sc = path.join(ROOT, 'sidecar');
  for (const f of all.filter((p) => path.dirname(p) === sc && /^test-.*\.js$/.test(path.basename(p))).sort()) {
    const b = path.basename(f);
    if (b === 'test-lib.js' || b === 'test-search-bench.js') continue;
    entries.push({ id: rel(f), kind: 'node', file: f });
  }
  const feat = path.join(ROOT, 'lib', 'features');
  for (const f of all.filter((p) => path.dirname(p) === feat && /^_.+-selftest\.js$/.test(path.basename(p))).sort()) {
    const x = path.basename(f).replace(/^_/, '').replace(/-selftest\.js$/, '');
    let env = null;
    try { const m = fs.readFileSync(path.join(feat, x + '.js'), 'latin1').match(/MANTLE_[A-Z]+_SELFTEST(?!_)/); env = m && m[0]; } catch (_) { /* no feature file */ }
    entries.push({ id: 'selftest:' + x, kind: 'selftest', file: f, env, name: x });
  }
  return entries.filter((e) => {
    const id = e.id.toLowerCase();
    if (ONLY.length && !ONLY.some((s) => id.includes(s))) return false;
    if (SKIP.some((s) => id.includes(s))) return false;
    return true;
  });
}

// ------------------------------------------------------------------ process table (one PowerShell, asked on demand)
const PS_LOOP = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$re = '^(electron|Mantle\\.Sidecar|chrome|chrome-headless-shell|headless_shell|node|powershell|cmd|conhost)\\.exe$'",
  'while ($null -ne ($l = [Console]::In.ReadLine())) {',
  '  $sb = New-Object System.Text.StringBuilder',
  '  foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine)) {',
  '    $ct = 0; if ($p.CreationDate) { $ct = $p.CreationDate.ToFileTimeUtc() }',
  "    $cl = ''; if ($p.Name -match $re -and $p.CommandLine) { $cl = $p.CommandLine -replace '[\\r\\n]', ' ' }",
  "    [void]$sb.Append(\"$($p.ProcessId)|$($p.ParentProcessId)|$($p.Name)|$ct|$cl`n\")",
  '  }',
  "  [void]$sb.Append(\"END`n\")",
  '  [Console]::Out.Write($sb.ToString()); [Console]::Out.Flush()',
  '}',
].join('\n');

let ps = null; let psBuf = ''; let psWait = null;
function psStart() {
  const file = path.join(OUT, 'proc-table.ps1');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, PS_LOOP.replace(/\n/g, '\r\n') + '\r\n');
  ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (d) => {
    psBuf += d;
    const m = psBuf.match(/(^|\n)END\r?\n/);
    if (!m) return;
    const block = psBuf.slice(0, m.index);
    psBuf = psBuf.slice(m.index + m[0].length);
    const w = psWait; psWait = null;
    if (w) w(parseTable(block));
  });
  ps.on('exit', () => { ps = null; const w = psWait; psWait = null; if (w) w([]); });
}
function parseTable(block) {
  const rows = [];
  for (const line of block.split('\n')) {
    const parts = line.replace(/\r$/, '').split('|');
    if (parts.length < 5 || !/^\d+$/.test(parts[0])) continue;
    const ft = Number(parts[3]) || 0;
    rows.push({ pid: Number(parts[0]), ppid: Number(parts[1]), name: parts[2], ct: ft ? ft / 10000 - 11644473600000 : 0, cmd: parts.slice(4).join('|') });
  }
  return rows;
}
function snap() {
  return new Promise((resolve) => {
    if (!ps) psStart();
    const t = setTimeout(() => { if (psWait === done) psWait = null; resolve([]); }, 30000);
    const done = (rows) => { clearTimeout(t); resolve(rows); };
    psWait = done;
    ps.stdin.write('snap\r\n');
  });
}

const NEVER = /^(quartz|helm|explorer|code|claude)\.exe$/i;
/** The processes this test started that are still alive: its tree, plus worktree electron/sidecar born during it. */
function leftovers(rows, rootPid, t0) {
  const born = (r) => r.ct >= t0 - 2000;
  const tracked = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!tracked.has(r.pid) && tracked.has(r.ppid) && born(r)) { tracked.add(r.pid); grew = true; }
  }
  const out = [];
  for (const r of rows) {
    if (NEVER.test(r.name)) continue;
    const mine = (tracked.has(r.pid) && r.pid !== rootPid && born(r)) ||
      (born(r) && /^(electron|Mantle\.Sidecar)\.exe$/i.test(r.name) && r.cmd.toLowerCase().includes(ROOT_LC));
    if (mine) out.push(r);
  }
  return out;
}
function killPids(rows) {
  const done = [];
  for (const r of rows) {
    const k = spawnSync('taskkill.exe', ['/PID', String(r.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    done.push(`${r.name}:${r.pid}${k.status === 0 ? '' : '(gone)'}`);
  }
  return done;
}

// ------------------------------------------------------------------ summary parsing
const SUM_RE = /(\d+)\s+passed[,;]?\s+(\d+)\s+failed/i;
const FRAC_RE = /\b(\d+)\s*\/\s*(\d+)\s+(?:passed|ok|checks? passed)\b/i;
const SELF_DONE_RE = /selftest[^\n]*?\d+\s+passed[,;]?\s+\d+\s+failed/i;
const FAIL_RE = /^\s*(?:FAIL(?:ED)?\b[:\s-]*|not ok\b\s*)(.*)$/;
function parseOutput(text, selftest) {
  const byLabel = new Map();
  const fracs = new Map();
  const fails = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    // a selftest's verdict is its own "selftest" lines in mantle.log, never another feature's log line
    if (selftest && !/selftest/i.test(line)) continue;
    let m = line.match(SUM_RE);
    if (m) {
      const label = line.slice(0, m.index).replace(/\d+/g, '#').trim().toLowerCase();
      byLabel.set(label, { passed: Number(m[1]), failed: Number(m[2]), line: line.trim() });
      continue;
    }
    m = line.match(FRAC_RE);   // "N/M passed": only used when the file has no "N passed, M failed" line at all
    if (m) fracs.set(line.slice(0, m.index).replace(/\d+/g, '#').trim().toLowerCase(), { passed: Number(m[1]), failed: Number(m[2]) - Number(m[1]), line: line.trim() });
    if (selftest) { const s = line.match(/selftest FAIL\s*(.*)$/i); if (s) fails.push(('FAIL ' + s[1]).slice(0, 400)); continue; }
    m = line.match(FAIL_RE);
    if (m && !/^FAILURES:?$/i.test(line.trim())) fails.push(line.trim().slice(0, 400));
  }
  if (!byLabel.size) for (const [k, v] of fracs) byLabel.set(k, v);
  if (!byLabel.size) return { found: false, passed: 0, failed: 0, fails, lines: [] };
  let passed = 0, failed = 0; const lines = [];
  for (const v of byLabel.values()) { passed += v.passed; failed += v.failed; lines.push(v.line); }
  return { found: true, passed, failed, fails, lines };
}

function knownEnv(id, res) {
  const ks = KNOWN_ENV.filter((k) => k.file === id);
  if (!ks.length || !res.failed) return null;
  if (!res.fails.length) return null;
  for (const k of ks) {
    if (res.fails.every((f) => k.fails.some((re) => re.test(f))) && (!k.evidence || res.fails.some((f) => k.evidence.test(f)))) return k;
  }
  return null;
}

// ------------------------------------------------------------------ running one entry
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function logName(id) { return id.replace(/[\\/: ]/g, '__') + '.log'; }

async function runOne(e) {
  const t0 = Date.now();
  const logFile = path.join(OUT, 'logs', logName(e.id));
  const env = Object.assign({}, process.env);
  delete env.MANTLE_TEST_VISIBLE;                      // never on Owen's screen from the suite
  env.MANTLE_SUITE = '1';
  // this checkout's own built sidecar, unless the caller names one: several node tests (features, screenshot,
  // idle-unload, switcher, launcher-extras, the e2e files) run their Electron/sidecar half only with it
  const ownExe = path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
  if (!process.env.MANTLE_SIDECAR_EXE && fs.existsSync(ownExe)) env.MANTLE_SIDECAR_EXE = ownExe;
  // page tests write their PNGs here, not to the dead session scratchpads some still default to
  if (!process.env.MANTLE_SHOOT_OUT) env.MANTLE_SHOOT_OUT = path.join(OUT, 'shots', logName(e.id).replace(/\.log$/, ''));
  let args; let exe; let privTemp = null;
  if (e.kind === 'selftest') {
    exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    privTemp = path.join(OUT, 'tmp', e.name);
    fs.mkdirSync(privTemp, { recursive: true });
    env.TEMP = privTemp; env.TMP = privTemp;
    if (e.env) env[e.env] = '1';
    delete env.ELECTRON_RUN_AS_NODE;
    args = ['.', '--test', `--profile-name=${LANE}-st-${e.name}`];
  } else {
    exe = process.execPath;
    args = [e.file].concat(e.args || []);
    if (e.id === 'sidecar/test-files.js') {
      const sb = path.join(os.tmpdir(), 'mantle-suite-' + LANE, 'files', 'sandbox');
      fs.mkdirSync(sb, { recursive: true });
      env.MANTLE_FILES_SANDBOX = env.MANTLE_FILES_SANDBOX || sb;
    }
  }
  if (e.kind === 'selftest' && !e.env) return finish(e, t0, { status: 'could-not-start', note: 'no MANTLE_*_SELFTEST variable found in lib/features/' + e.name + '.js' }, '', logFile);
  if (!fs.existsSync(exe)) return finish(e, t0, { status: 'could-not-start', note: 'no ' + exe }, '', logFile);

  let text = '';
  const child = spawn(exe, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  let exited = false; let code = null;
  const exitP = new Promise((r) => child.on('exit', (c, sig) => { exited = true; code = c === null ? sig : c; r(); }));
  child.on('error', (err) => { text += '\n[run-suite] spawn error: ' + err.message; });

  const limit = (e.kind === 'selftest' ? Math.min(TIMEOUT_S, 300) : TIMEOUT_S) * 1000;
  let timedOut = false; let selfDone = false; let chordSent = false;
  while (!exited) {
    await Promise.race([exitP, sleep(e.kind === 'selftest' ? 2000 : 1000)]);
    if (exited) break;
    if (Date.now() - t0 > limit) { timedOut = true; break; }
    if (e.kind === 'selftest' && SELF_DONE_RE.test(text)) { selfDone = true; await sleep(3000); break; }
    if (e.kind === 'selftest' && SELF_CHORD[e.name] && !chordSent && /features: started/.test(text)) {
      chordSent = true; await sleep(3000);
      const k = spawn(exe, args.concat('--test-chord=' + SELF_CHORD[e.name]), { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {});
      text += '\n[run-suite] sent ' + SELF_CHORD[e.name] + ' to the instance (--test-chord)\n';
    }
  }
  // stop the root (timeout or selftest instance) and anything the test left behind, by pid
  const rows = await snap();
  const left = leftovers(rows, child.pid, t0);
  const stopped = [];
  if (!exited) { const k = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }); stopped.push('root:' + child.pid + (k.status === 0 ? '' : '(gone)')); }
  if (left.length) { await sleep(500); stopped.push(...killPids(left)); }
  await Promise.race([exitP, sleep(3000)]);
  if (stopped.length) text += '\n[run-suite] stopped by pid: ' + stopped.join(', ') + '\n';

  const res = parseOutput(text, e.kind === 'selftest');
  // a selftest that lists its failures inside the summary line ("... 5 failed - a; b") and logs no FAIL lines
  if (e.kind === 'selftest' && res.failed && !res.fails.length) {
    for (const l of res.lines) { const i = l.search(/failed\s*[-(]/); if (i >= 0) res.fails.push(...l.slice(i).replace(/^failed\s*[-(]\s*/, '').split(/;\s+/).map((s) => 'FAIL ' + s.slice(0, 300))); }
  }
  let status;
  if (timedOut && !res.found) status = 'timeout';
  else if (!res.found) status = /\bskipped\b/i.test(text) && code === 0 ? 'skipped' : 'could-not-start';
  else if (res.failed === 0 && res.passed > 0 && !timedOut) status = 'pass';
  else if (res.failed === 0 && timedOut) status = 'timeout';
  else if (res.failed === 0) status = 'could-not-start';
  else status = 'fail';
  let known = null;
  if (status === 'fail') { known = knownEnv(e.id, res); if (known) status = 'known-env'; }
  if (e.check) { status = code === 0 ? 'pass' : 'fail'; res.passed = code === 0 ? 1 : 0; res.failed = code === 0 ? 0 : 1; res.found = true; res.lines = [text.trim().split(/\r?\n/).slice(-1)[0] || '']; }
  return finish(e, t0, {
    status, code, timedOut, selfDone, passed: res.passed, failed: res.failed, summary: res.lines, fails: res.fails.slice(0, 40),
    knownReason: known && known.reason, stopped, tail: status === 'could-not-start' || status === 'timeout' ? tail(text, 12) : undefined,
  }, text, logFile);
}
function tail(text, n) { return text.trim().split(/\r?\n/).slice(-n).map((l) => l.slice(0, 300)); }
function finish(e, t0, r, text, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try { fs.writeFileSync(logFile, text || (r.note || '')); } catch (_) { /* best effort */ }
  return Object.assign({ id: e.id, kind: e.kind, secs: Math.round((Date.now() - t0) / 100) / 10, log: logFile }, r);
}

// ------------------------------------------------------------------ report
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, Math.max(n, String(s).length));
function lineFor(r) {
  const counts = r.status === 'could-not-start' || r.status === 'timeout' || r.status === 'skipped' ? '-' : `${r.passed}/${r.passed + r.failed}`;
  return `${pad(r.status.toUpperCase(), 15)} ${pad(counts, 9)} ${pad(r.secs + 's', 7)} ${r.id}`;
}
function totals(results) {
  const t = { files: results.length, pass: 0, fail: 0, knownEnv: 0, couldNotStart: 0, timeout: 0, skipped: 0, checksPassed: 0, checksFailed: 0, knownEnvChecks: 0 };
  for (const r of results) {
    if (r.status === 'pass') t.pass++;
    else if (r.status === 'fail') t.fail++;
    else if (r.status === 'known-env') t.knownEnv++;
    else if (r.status === 'could-not-start') t.couldNotStart++;
    else if (r.status === 'timeout') t.timeout++;
    else if (r.status === 'skipped') t.skipped++;
    t.checksPassed += r.passed || 0;
    if (r.status === 'known-env') t.knownEnvChecks += r.failed || 0; else t.checksFailed += r.failed || 0;
  }
  return t;
}
function totalLine(t) {
  return `TOTAL: ${t.files} files: ${t.pass} pass, ${t.fail} FAIL, ${t.knownEnv} known-env, ${t.couldNotStart} could-not-start, ${t.timeout} timeout, ${t.skipped} skipped | checks ${t.checksPassed} passed, ${t.checksFailed} failed (+${t.knownEnvChecks} known-env)`;
}
function report(results, wallS) {
  const out = [];
  out.push(`Mantle suite, ${ROOT}, ${new Date().toISOString()}, wall ${Math.round(wallS)}s`);
  for (const r of results) out.push(lineFor(r));
  const bad = results.filter((r) => r.status === 'fail' || r.status === 'could-not-start' || r.status === 'timeout');
  if (bad.length) {
    out.push('', 'CODE FAILURES / COULD NOT START:');
    for (const r of bad) {
      out.push(`  ${r.id} [${r.status}]` + (r.summary && r.summary.length ? ' ' + r.summary.join(' + ') : ''));
      for (const f of (r.fails || []).slice(0, 12)) out.push('      ' + f);
      for (const l of (r.status !== 'fail' ? r.tail || [] : [])) out.push('      | ' + l);
    }
  }
  const env = results.filter((r) => r.status === 'known-env');
  if (env.length) {
    out.push('', 'KNOWN-ENV (environment, not code; not counted as failures):');
    for (const r of env) { out.push(`  ${r.id} ${r.passed}/${r.passed + r.failed}: ${r.knownReason}`); for (const f of (r.fails || []).slice(0, 6)) out.push('      ' + f); }
  }
  out.push('', totalLine(totals(results)));
  return out.join('\n');
}
function writeStatus(text) {
  if (!STATUS) return;
  try { fs.writeFileSync(STATUS, text); } catch (_) { /* the main session reads it if it can */ }
}

// ------------------------------------------------------------------ main
(async () => {
  const entries = discover();
  if (LIST_ONLY) { for (const e of entries) console.log(e.id + (e.env ? '  (' + e.env + ')' : '')); console.log(entries.length + ' entries'); return; }
  fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });
  console.log(`run-suite: ${entries.length} files from ${ROOT}, timeout ${TIMEOUT_S}s each, out ${OUT}`);
  const W0 = Date.now();
  const results = [];
  const head = () => `# Mantle suite status (${LANE})\n\nroot ${ROOT}\nstarted ${new Date(W0).toISOString()}\nout ${OUT}\n\n`;
  for (let i = 0; i < entries.length; i++) {
    writeStatus(head() + `running [${i + 1}/${entries.length}] ${entries[i].id}\n\n` + totalLine(totals(results)) + '\n\n```\n' + results.map(lineFor).join('\n') + '\n```\n');
    const r = await runOne(entries[i]);
    results.push(r);
    console.log(`[${i + 1}/${entries.length}] ` + lineFor(r));
    if (r.status === 'fail' || r.status === 'known-env') for (const f of (r.fails || []).slice(0, 5)) console.log('        ' + f);
  }
  const wall = (Date.now() - W0) / 1000;
  const text = report(results, wall);
  fs.writeFileSync(path.join(OUT, 'suite.txt'), text + '\n');
  fs.writeFileSync(path.join(OUT, 'suite.json'), JSON.stringify({ root: ROOT, at: new Date().toISOString(), wallSecs: Math.round(wall), totals: totals(results), results }, null, 1));
  console.log('\n' + text);
  console.log(`\nwritten: ${path.join(OUT, 'suite.txt')} and suite.json`);
  writeStatus(head() + `DONE in ${Math.round(wall)}s\n\n` + totalLine(totals(results)) + '\n\n```\n' + text + '\n```\n');
  if (ps) { try { ps.stdin.end(); } catch (_) { /* gone */ } }
  const t = totals(results);
  process.exitCode = t.fail || t.couldNotStart || t.timeout ? 1 : 0;
})().catch((err) => { console.log('run-suite crashed: ' + (err && err.stack || err)); if (ps) try { ps.kill(); } catch (_) { /* gone */ } process.exitCode = 2; });
