'use strict';
/*
 * files-open.e2e.test.js - Mantle Files' OPEN in a REAL invisible `electron . --test` copy (lane
 * mantle-files, 2026-10-15). Measures what the user waits for after Win+E, and proves the last-folder fix.
 *
 *   node lib/features/files-open.e2e.test.js [--opens=10] [--phases=cold,warm]
 *     -> per phase: p50 / p95 / max of "shown" and "painted" (ms from the open request, main's clock)
 *     -> "FILES OPEN E2E: n passed, m failed" (exit 1 on a failure)
 *
 * The profile is seeded with features/files.json lastFolder = a FILE (the live bug). Phase cold
 * (keepReady off, the default): every open builds a new window; phase warm (keepReady on): the hidden
 * spare takes it. Windows show OFF every screen, inactive (MANTLE_FILES_TEST_SHOW=1): never in front of
 * the user. Reads the R7 line ("opened (cold|warm) via ...") and, for an older build, "open #n (cold|warm)".
 * Budgets checked (plan R2): cold p95 <= 400 ms painted, never over 1 s; warm p95 <= 100 ms painted.
 * Refuses while a game runs. Every test instance is stopped with tools/kill-test.ps1 -Match <profile>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE = 'files-open-e2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const SBX = path.join(os.tmpdir(), 'mantle-files-open-e2e', 'sandbox');
const DOCS = path.join(SBX, 'docs');
const NOTE = path.join(DOCS, 'note.txt');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const OPENS = Math.max(1, Number(arg('opens', 10)) || 10);
const PHASES = String(arg('phases', 'cold,warm')).split(',');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 100);
  }
}
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process VALORANT-Win64-Shipping,RiotClientServices,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const env = Object.assign({}, process.env, { MANTLE_FILES_TEST_SHOW: '1' });
delete env.MANTLE_TEST_VISIBLE;
delete env.MANTLE_FILES_SELFTEST;

function seed(keepReady) {
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* kill-test ran first */ }
  fs.mkdirSync(path.join(USER_DATA, 'features'), { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'features', 'files.json'), JSON.stringify({ lastFolder: NOTE, keepReady: !!keepReady }));
  // lib/keep-ready.js's store (lane settingsfast), read instead of the option once that file is merged
  fs.writeFileSync(path.join(USER_DATA, 'keep-ready.json'), JSON.stringify({ 'keepReady.settings': false, 'keepReady.taskmgr': false, 'keepReady.files': !!keepReady }));
  // no welcome tour in a test copy: an existing-profile marker (lib/welcome.js judge)
  fs.writeFileSync(path.join(USER_DATA, 'first-run.json'), JSON.stringify({ state: 'done', why: 'existing-profile' }));
}
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(ELECTRON, ['.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
function killTest() {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
}
async function stop(run) { killTest(); await until(() => run.exited, 15000, 200); await sleep(500); }
async function portOf() {
  return until(() => { try { const p = parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10); return p > 0 ? p : null; } catch (_) { return null; } }, 45000, 100);
}
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); } });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the page went away')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); setTimeout(() => { if (pend.delete(i)) rej(new Error(`${method}: no answer in 15 s`)); }, 15000); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
/** A page that has the bridge and is NOT a Mantle Files window (those come and go). */
async function driver(port) {
  const t = await until(async () => (await targets(port)).find((x) => !/\/ui\/files\//.test(x.url)), 30000, 200);
  if (!t) return null;
  const s = await attach(t);
  const ok = await until(() => s.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);
  return ok ? s : null;
}
const OPEN_RE = /files: (?:opened \((cold|warm)\) via [^:]+: shown (\d+|-) ms?, painted (\d+|-)(?: ms)?[^\n]*|open #\d+ \((cold|warm)\): shown (\d+|-)(?: ms)?[^\n]*)/g;
function opensIn(out) {
  const r = [];
  for (const m of out.matchAll(OPEN_RE)) {
    const line = m[0];
    if (m[1]) r.push({ kind: m[1], shown: Number(m[2]), painted: Number(m[3]), line });
    else {
      // an older build: "shown" was ready-to-show and its first view = "first view X ms"
      const fv = /first view (\d+) ms/.exec(line);
      r.push({ kind: m[4], shown: Number(m[5]), painted: fv ? Number(fv[1]) : NaN, line, old: true });
    }
  }
  return r;
}
const pct = (a, p) => { const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y); if (!s.length) return NaN; return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
function privateMb() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `$t=0; Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--profile-name=${PROFILE}') } | ForEach-Object { $t += $_.PrivatePageCount }; [math]::Round($t/1MB)`],
  { encoding: 'utf8', timeout: 30000 });
  return Number((r.stdout || '').trim());
}

async function phase(name) {
  const warm = name === 'warm';
  seed(warm);
  const run = launch();
  const res = { name, opens: [] };
  try {
    const port = await portOf();
    if (!check(`${name}: the --test copy started (DevTools port)`, !!port, run.out.slice(-400))) return res;
    const s = await driver(port);
    if (!check(`${name}: a Mantle page with the bridge to drive from`, !!s)) return res;
    await sleep(6000);                                     // start-up settles (and the keep-ready spare is made)
    if (warm) check('warm: the keep-ready spare exists before the first open', /keep ready: a hidden Mantle Files window is waiting/.test(run.out), run.out.slice(-600));
    else check('cold: keep ready OFF makes no hidden Files window', !/keep ready: a hidden/.test(run.out) && !(await targets(port)).some((t) => /\/ui\/files\//.test(t.url)));
    res.idleMb = privateMb();
    for (let i = 0; i < OPENS; i++) {
      const before = opensIn(run.out).length;
      const r = await s.ev("window.mantle.call('files.open', {})");
      if (!check(`${name}: open ${i + 1} answered ok`, r && r.ok, r)) break;
      const got = await until(() => opensIn(run.out).length > before, 25000, 50);
      if (!check(`${name}: open ${i + 1} logged its R7 line`, !!got, run.out.slice(-600))) break;
      const o = opensIn(run.out)[before];
      res.opens.push(o);
      if (i === 0) {
        res.firstLine = o.line;
        check(`${name}: BUG FIXED: the saved FILE opened its folder (no "listing failed")`, !/listing failed/.test(o.line), o.line);
        if (!o.old) check(`${name}: the start folder came from a file path`, /start folder: the saved last folder was a file/.test(run.out));
      }
      if (i === 1 && !o.old && name === 'cold') check('cold: the 2nd open drew the cached rows', /from the cache/.test(o.line), o.line);
      await sleep(400);
      await s.ev(`window.mantle.call('files.win', { w: ${JSON.stringify(r.w)}, op: 'close' })`);
      await sleep(warm ? 4800 : 700);                       // warm: the next spare is made 4 s after the close
    }
    // the bug's other half: what is saved now is a FOLDER
    await sleep(1200);
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'features', 'files.json'), 'utf8')).lastFolder; } catch (_) { /* unread */ }
    check(`${name}: the saved last folder is now the FOLDER`, saved && saved.toLowerCase() === DOCS.toLowerCase(), saved);
    s.close();
  } finally {
    await stop(run);
  }
  return res;
}

async function main() {
  if (gaming()) { console.log('FILES OPEN E2E: 0 passed, 0 failed (skipped: a game is running)'); return; }
  fs.mkdirSync(DOCS, { recursive: true });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(DOCS, `file ${String(i).padStart(2, '0')}.txt`), 'x'.repeat(i));
  fs.writeFileSync(NOTE, 'the live bug: lastFolder held this FILE');
  killTest();
  const all = [];
  for (const p of PHASES) all.push(await phase(p));
  for (const r of all) {
    const sh = r.opens.map((o) => o.shown), pa = r.opens.map((o) => o.painted);
    console.log(`${r.name}: ${r.opens.length} opens; shown p50 ${pct(sh, 50)} p95 ${pct(sh, 95)} max ${Math.max(...sh)} ms; painted p50 ${pct(pa, 50)} p95 ${pct(pa, 95)} max ${Math.max(...pa)} ms; idle private ${r.idleMb} MB`);
    if (r.firstLine) console.log(`  first: ${r.firstLine.trim()}`);
    // every open's own line, so a budget miss shows which open and which stage (listing vs paint) it was
    r.opens.slice(1).forEach((o, i) => console.log(`  #${i + 2}: ${String(o.line || '').trim()}`));
    if (!r.opens.length || r.opens[0].old) continue;
    if (r.name === 'cold') {
      check('cold budget: painted p95 <= 400 ms', pct(pa, 95) <= 400, `p95 ${pct(pa, 95)}`);
      check('cold ceiling: no open painted over 1 s', Math.max(...pa) <= 1000, `max ${Math.max(...pa)}`);
    }
    if (r.name === 'warm') check('warm budget: painted p95 <= 100 ms', pct(pa, 95) <= 100, `p95 ${pct(pa, 95)}`);
  }
  const cold = all.find((r) => r.name === 'cold'), warmR = all.find((r) => r.name === 'warm');
  if (cold && warmR && Number.isFinite(cold.idleMb) && Number.isFinite(warmR.idleMb)) console.log(`keep-ready spare costs ~${warmR.idleMb - cold.idleMb} MB private while idle (whole test copy ${cold.idleMb} -> ${warmR.idleMb} MB)`);
}

main().catch((e) => check('ran to the end', false, e.stack)).finally(() => {
  killTest();
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`FILES OPEN E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
