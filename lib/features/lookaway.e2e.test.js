'use strict';
/*
 * lookaway.e2e.test.js - the look-away blur END TO END through the real feature (lane lookaway2,
 * 2026-10-23). A hidden --test Mantle of this checkout runs lib/features/lookaway.js unchanged, its
 * hidden camera page (ui/lookaway/) and MediaPipe's face detector, fed a FAKE camera: a y4m clip made
 * from the licensed stills in _lookaway-fixtures/ (face, no face, face, profile; 4 s each; it loops).
 * The screen cover is a stand-in provider on the same _unfold-bus.js (no window: it only records, in
 * main's clock, when it was asked to cover and to reveal), so the whole decision chain is the real one.
 *
 *   node lib/features/lookaway.e2e.test.js     -> "LOOKAWAY E2E TEST: n passed, m failed"
 *
 * NEVER THE REAL CAMERA: the instance is spawned ONLY with --use-fake-device-for-media-stream and
 * --use-file-for-fake-video-capture=<clip> in its argv (checked before every spawn, the --quit
 * messenger included), and lookaway.js itself opens no camera in --test without the first switch.
 * Chromium reads both switches from the command line as given: main.js needs no change.
 *
 * Checks: the page reaches "watching" on the fake camera (its size is the clip's); each away part of
 * the clip covers exactly once and each face part after it reveals once (no cover during face parts);
 * every pause (lock, another app on the camera, a full-screen app, the switch off) takes the cover
 * down at once, says why with "the camera is off", and the page releases every track (released true);
 * a paused page's window goes after the park time, at once on the switch off; the provider taking the
 * cover down by itself (input) -> no new cover until a fresh look away; a clean --quit runs stop():
 * the cover comes down and no process of this profile is left. Nothing written outside os.tmpdir().
 *
 * MEASURED (info lines): cover latency = cover asked - the clip's switch to away - the delay option
 * (= the detection lag); reveal latency = reveal asked - the clip's switch back to the face. Time base:
 * the feature's "Watching" moment (main's clock, recorded by the stand-in) plus the clip timeline. The
 * clip's first frame plays a little BEFORE that moment (the device starts, getUserMedia resolves, the
 * page reports), so the true lags are longer by that gap; the output bounds it from the frames. The
 * headline numbers come from FRESH camera starts (the clip starts over at each one, checked): over
 * continuous loops Chromium's file camera can fall behind its timeline (measured: ~0.2 s by loop 2),
 * so those are printed too but marked as possibly late.
 *
 * Writes ONLY in os.tmpdir(): the clip and the fixture features in a mkdtemp folder (removed at the
 * end), the instance's profile %TEMP%\mantle-test-lookawaye2e (as every --test run) and its output log.
 *
 * SKIPS, with the reason, counting no failure: on CI, off Windows, while a game runs.
 * HEAVY (one Electron instance for about 4 minutes): run it through the machine's test gate.
 */
const os = require('os');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* best effort */ }
require('../../tools/dev-env.js').lowcpu();
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { buildY4m } = require('./_lookaway-y4m');

const ROOT = path.resolve(__dirname, '..', '..');
const FEATURES = path.join(ROOT, 'lib', 'features');
const PROFILE = 'lookawaye2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const OUT_LOG = path.join(os.tmpdir(), 'mantle-lookaway-e2e.log');
const FAKE_SWITCH = '--use-fake-device-for-media-stream';
const DELAY_S = 1;                 // the delay option for this run (Owen's default is 1.5 s)
const FPS = 10;
const CLIP_PLAN = [
  { file: 'frontal.png', seconds: 4 },
  { file: 'empty.png', seconds: 4, away: 'no face' },
  { file: 'frontal.png', seconds: 4 },
  { file: 'profile.png', seconds: 4, away: 'head turned (profile)' },
];
const LOOPS = 3;                   // clip loops measured without interruption
const PARK_MS = 20000;             // lookaway.js destroys a paused page's window after this
const HARD_MS = 12 * 60000;        // the whole run, at most

const SEG_MS = CLIP_PLAN.map((s) => Math.max(1, Math.round(s.seconds * FPS)) * 1000 / FPS);
const PERIOD = SEG_MS.reduce((a, b) => a + b, 0);
const OFFS = SEG_MS.map((_, i) => SEG_MS.slice(0, i).reduce((a, b) => a + b, 0));
const FIRST_AWAY = CLIP_PLAN.findIndex((s) => s.away);

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)})` : ''}`); return !!ok; }
const info = (s) => console.log('info: ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { let v = null; try { v = await fn(); } catch (_) { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }
const r0 = (x) => (typeof x === 'number' ? Math.round(x) : x);
function stats(xs) {
  const a = xs.filter((x) => typeof x === 'number').sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const m = a.length >> 1;
  return { n: a.length, median: r0(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2), min: r0(a[0]), max: r0(a[a.length - 1]) };
}

function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process VALORANT*,RiotClientServices,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const n = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : -1;
}
function ps(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').trim();
}
/** READ ONLY: this profile's electron processes (main / child) and every process running `exe`. */
function procDetail(exe) {
  const exeQ = String(exe).replace(/'/g, "''");
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Mantle.Sidecar.exe'" | ForEach-Object { $c = [string]$_.CommandLine; $k = ''; if ($_.Name -eq 'electron.exe' -and ($c.Contains('--profile-name=${PROFILE}') -or $c.Contains('mantle-test-${PROFILE}'))) { if ($c.Contains('--type=')) { $k = 'child' } else { $k = 'main' } } elseif ($_.Name -eq 'Mantle.Sidecar.exe' -and $_.ExecutablePath -and ($_.ExecutablePath -ieq '${exeQ}')) { $k = 'sidecar' }; if ($k) { '' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $_.Name + '|' + $_.CreationDate.ToFileTimeUtc() + '|' + $k } }`);
  return out ? out.split(/\r?\n/).map((l) => l.trim().split('|')).filter((p) => p.length === 5).map(([pid, ppid, name, created, kind]) => ({ pid: +pid, ppid: +ppid, name, created, kind })) : [];
}
function killTest() {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

/* ---------------- fixtures (all in os.tmpdir()) ---------------- */

const BUS = path.join(FEATURES, '_unfold-bus.js');
const fakeCoverSource = (logFile) => `'use strict';
// fakecover.js - a stand-in for the full-screen cover (written by lookaway.e2e.test.js, in a temp folder).
// No window: it records, in main's clock, every ask and when the look-away feature's state line moves.
const fs = require('fs');
const bus = require(${JSON.stringify(BUS)});
const LOG = ${JSON.stringify(logFile)};
const FOLD_MS = 300;
const now = () => performance.timeOrigin + performance.now();
const later = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = {
  name: 'fakecover', label: 'Fake screen cover (test)', defaultOn: true,
  install(ctx) {
    const S = { covered: false, by: null, events: [], key: '' };
    const rec = (e) => { e.t = now(); S.events.push(e); try { fs.appendFileSync(LOG, JSON.stringify(e) + '\\n'); } catch (_) { /* the in-memory list still has it */ } return e; };
    const unprovide = bus.provide({
      async cover(a) { const from = (a && a.from) || ''; rec({ op: 'cover', from }); S.covered = true; S.by = from || null; await later(FOLD_MS); rec({ op: 'covered' }); bus.changed(); return { ok: true }; },
      async reveal(a) { rec({ op: 'reveal', from: (a && a.from) || '' }); await later(FOLD_MS); S.covered = false; S.by = null; rec({ op: 'revealed' }); bus.changed(); return { ok: true }; },
      state() { return { covered: S.covered, by: S.by }; },
    });
    ctx.host.features.onChange((e) => {
      if (!e || e.feature !== 'lookaway') return;
      const f = ctx.host.features.list().find((x) => x.name === 'lookaway');
      if (!f) return;
      const key = f.enabled + '|' + f.ok + '|' + f.reason;
      if (key === S.key) return;
      S.key = key;
      rec({ op: 'state', reason: f.reason, ok: f.ok, on: f.enabled });
    });
    ctx.command('log', async (a) => ({ ok: true, now: now(), covered: S.covered, by: S.by, n: S.events.length, events: S.events.slice(Math.max(0, Number(a && a.since) || 0)) }));
    // "input took the cover down": the provider reveals on its own and says so
    ctx.command('selfReveal', async () => { const was = S.covered; S.covered = false; S.by = null; rec({ op: 'selfReveal', was }); bus.changed(); return { ok: true, was }; });
    // the look-away feature's own switch, through the same host call Mantle Settings uses
    ctx.command('switch', async (a) => { const on = !!(a && a.on); const r = await ctx.host.features.setEnabled('lookaway', on); rec({ op: 'switch', on }); return r; });
    return {
      stop() {
        rec({ op: 'stop' });
        // the asker's stop() runs at the same moment: keep the cover answering a little longer
        return later(1000).then(() => { unprovide(); rec({ op: 'unprovided' }); });
      },
    };
  },
};
`;

function writeFixtures(dir, logFile) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lookaway.js'), `'use strict';\n// the REAL feature, loaded from the test's fixture folder\nmodule.exports = require(${JSON.stringify(path.join(FEATURES, 'lookaway.js'))});\n`);
  fs.writeFileSync(path.join(dir, 'fakecover.js'), fakeCoverSource(logFile));
}
/** The test profile: the feature switched ON and the delay shortened, before the instance starts. */
function writeProfile() {
  fs.mkdirSync(path.join(USER_DATA, 'features'), { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'features.json'), JSON.stringify({ lookaway: true, fakecover: true }, null, 2));
  fs.writeFileSync(path.join(USER_DATA, 'features', 'lookaway.json'), JSON.stringify({ delay: DELAY_S, turn: 'normal' }, null, 2));
}
function readLog(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; }
}
/** What this test must never touch: the live profile's files for these features, the worktree. */
function untouchedSnap() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const o = {};
  for (const f of [path.join(appdata, 'mantle', 'features', 'lookaway.json'), path.join(appdata, 'mantle', 'features', 'fakecover.json'),
    path.join(FEATURES, 'fakecover.js'), path.join(ROOT, 'ui', 'fakecover')]) {
    try { o[f] = fs.statSync(f).mtimeMs; } catch (_) { o[f] = null; }
  }
  for (const d of [ROOT, FEATURES, path.join(ROOT, 'ui', 'lookaway')]) {
    try { for (const n of fs.readdirSync(d)) if (/\.(y4m|jsonl)$/i.test(n)) o[path.join(d, n)] = fs.statSync(path.join(d, n)).mtimeMs; } catch (_) { /* none */ }
  }
  return o;
}

/* ---------------- the instance and CDP ---------------- */

const CLI = require.resolve('electron/cli.js', { paths: [ROOT] });
const instanceArgs = (clip) => [CLI, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0', FAKE_SWITCH, `--use-file-for-fake-video-capture=${clip}`];
const quitArgs = (clip) => [CLI, '.', '--quit', '--test', `--profile-name=${PROFILE}`, FAKE_SWITCH, `--use-file-for-fake-video-capture=${clip}`];
/** The real camera must never open: an argv without BOTH fake-capture switches (and the clip on disk) is refused. */
function fakeOnly(args, clip) {
  let size = 0; try { size = fs.statSync(clip).size; } catch (_) { size = 0; }
  return args.includes(FAKE_SWITCH) && args.includes(`--use-file-for-fake-video-capture=${clip}`) && size > 0;
}

let run = null;
function launch(args, env) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const r = { out: '', buf: '', lines: [], exited: null };
  const onData = (c) => {
    const s = c.toString('utf8'); const t = Date.now();
    r.out += s; r.buf += s;
    let i;
    while ((i = r.buf.indexOf('\n')) >= 0) { r.lines.push({ t, line: r.buf.slice(0, i).replace(/\r$/, '') }); r.buf = r.buf.slice(i + 1); }
  };
  r.proc = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  r.proc.stdout.on('data', onData);
  r.proc.stderr.on('data', onData);
  r.proc.on('exit', (code) => { r.exited = { code, at: Date.now() }; });
  return r;
}
const tail = (n) => (run ? run.out.slice(-(n || 600)) : '');
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
async function lookPage(port) { try { return (await targets(port)).find((t) => /\/ui\/lookaway\//.test(t.url)) || null; } catch (_) { return null; } }
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let n = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the page closed')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++n; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;

const isCover = (e) => e.op === 'cover' && e.from === 'lookaway';
const isReveal = (e) => e.op === 'reveal' && e.from === 'lookaway';
const isWatching = (e) => e.op === 'state' && /^Watching/.test(e.reason || '');

/** The stand-in provider's record, mirrored here (main's clock). */
function mirror(bar) {
  const M = { ev: [], now: 0, covered: false };
  M.sync = async () => {
    let r = null;
    try { r = await bar.ev(call('fakecover.log', { since: M.ev.length })); } catch (_) { return null; }
    if (!r || r.ok !== true) return null;
    for (const e of r.events) M.ev.push(e);
    M.now = r.now; M.covered = r.covered;
    return r;
  };
  M.find = (pred, after) => M.ev.find((e) => e.t > after && pred(e)) || null;
  M.wait = (pred, after, ms, step) => until(async () => { await M.sync(); return M.find(pred, after); }, ms, step || 100);
  M.count = (pred, from, to) => M.ev.filter((e) => e.t >= from && e.t < to && pred(e)).length;
  M.at = async (tMain) => { for (;;) { await M.sync(); if (M.now >= tMain || (run && run.exited)) return; await sleep(Math.max(20, Math.min(250, tMain - M.now))); } };
  return M;
}
/** A cover asked by the feature after `after`, its fold done, the screen still covered and the cover
 *  young (asked < 1.5 s ago, so most of that away part is still to come). Older ones are skipped. */
async function waitCovered(M, after, ms) {
  const end = Date.now() + ms;
  let from = after;
  while (Date.now() < end) {
    const c = await M.wait(isCover, from, Math.max(0, end - Date.now()), 100);
    if (!c) return null;
    const done = await M.wait((e) => e.op === 'covered', c.t - 0.001, 3000, 50);
    if (done && M.covered && !M.find(isReveal, c.t) && M.now - c.t < 1500) return c;
    from = c.t;
  }
  return null;
}
/** The first cover after a camera restart, in the clip's first away part: a lag sample if the clip starts over. */
function restartSample(cov, watchT) {
  if (watchT === null || !cov) return;
  const sw = watchT + OFFS[FIRST_AWAY];
  if (cov.t >= sw - 500 && cov.t < sw + SEG_MS[FIRST_AWAY]) measured.freshCover.push(cov.t - sw - DELAY_S * 1000);
}
/** Which away part of the clip (played from `base`) holds time t: { sw, back } or null. */
function partOf(t, base) {
  const k = Math.floor((t - base) / PERIOD);
  for (const kk of [k, k - 1]) {
    for (let i = 0; i < CLIP_PLAN.length; i++) {
      if (!CLIP_PLAN[i].away) continue;
      const sw = base + kk * PERIOD + OFFS[i];
      if (t >= sw - 500 && t < sw + SEG_MS[i]) return { sw, back: sw + SEG_MS[i] };
    }
  }
  return null;
}
/** The page's verdicts as they reached main (the feature's test log; arrival time on this side). */
const SEEN_RE = /LOOKAWAY seen face=\d verdict=(\w+)/;
function frames(from, to) { const r = []; for (const l of run.lines) { if (l.t < from || l.t >= to) continue; const m = SEEN_RE.exec(l.line); if (m) r.push({ t: l.t, v: m[1] }); } return r; }
/** Around a clip switch at `sw` (to away, or back to the face): when the first frame with the new verdict
 *  and the last frame with the old one before it arrived, relative to sw. The true switch lies between
 *  the two frames' capture times, which brackets the clip's real timing (drift, its start offset). */
function around(sw, end, toAway) {
  const fr = frames(sw - 2000, end);
  const isNew = (v) => (toAway ? v === 'away' : v === 'looking');
  const isOld = (v) => (toAway ? v === 'looking' : v === 'away');
  const first = fr.find((f) => f.t >= sw - 600 && isNew(f.v));
  const last = first ? [...fr].reverse().find((f) => f.t < first.t && isOld(f.v)) : null;
  return { first: first ? first.t - sw : null, lastOld: last ? last.t - sw : null };
}
const releasedTrue = () => run.lines.filter((l) => /LOOKAWAY page stopped released=true/.test(l.line)).length;
const releasedFalse = () => run.lines.filter((l) => /LOOKAWAY page stopped released=false/.test(l.line)).length;

/* ---------------- the run ---------------- */

let skipped = null;
let WORK = null, FAKELOG = null;
const measured = { cover: [], reveal: [], loops: [], freshCover: [], freshReveal: [], faceBefore: [] };

async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session to run a Mantle test instance in'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  const g = gaming();
  if (g !== 0) { skipped = g > 0 ? 'a game is running' : 'could not check for a running game'; return; }
  const exe = process.env.MANTLE_SIDECAR_EXE || [path.join(ROOT, 'sidecar', 'bin-next', 'Mantle.Sidecar.exe'), path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe')].find((p) => fs.existsSync(p)) || '';
  if (!check('a sidecar exe built from this tree (MANTLE_SIDECAR_EXE, else sidecar/bin-next or sidecar/bin)', !!exe && fs.existsSync(exe), exe || 'none: run sidecar/build.ps1 -Out sidecar/bin-next/Mantle.Sidecar.exe')) return;

  const before = untouchedSnap();
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-lookaway-e2e-'));
  FAKELOG = path.join(WORK, 'fakecover.jsonl');
  const CLIP = path.join(WORK, 'clip.y4m');
  const built = buildY4m({ frames: CLIP_PLAN.map((s) => ({ file: s.file, seconds: s.seconds })), fps: FPS }, CLIP);
  check(`the fake-camera clip is built in the temp folder (${built.frames} frames, ${PERIOD / 1000} s a loop)`, built.frames === PERIOD * FPS / 1000 && path.resolve(CLIP).startsWith(path.resolve(os.tmpdir())), built);
  const FIX = path.join(WORK, 'features');
  writeFixtures(FIX, FAKELOG);
  writeProfile();

  const env = Object.assign({}, process.env, { MANTLE_FEATURES_DIR: FIX, MANTLE_SIDECAR_EXE: exe });
  delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
  const envMsg = Object.assign({}, env, { LOWCPU: '0' });   // the --quit messenger (README "Testing")
  const args = instanceArgs(CLIP);
  if (!check('REFUSES to launch without the fake camera: both fake-capture switches are in the argv and the clip exists', fakeOnly(args, CLIP), args.slice(2))) return;
  run = launch(args, env);
  const open = [];
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 60000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, tail())) return;
    const barT = await until(async () => (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null, 30000, 300);
    if (!check('the bar page is up (the commands are called from it)', !!barT, tail())) return;
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);
    const M = mirror(bar);
    if (!check('the stand-in cover provider is installed (fakecover.log answers)', !!(await until(() => M.sync(), 20000, 250)), tail())) return;
    const status = () => bar.ev(call('lookaway.status'));

    /* ---- 1. watching on the fake camera ---- */
    const w0 = await M.wait(isWatching, 0, 90000, 150);
    if (!check('the hidden page reaches watching: the state line says "Watching. The camera light is on"', !!w0, { status: await status().catch(() => null), tail: tail(400) })) return;
    const t0 = w0.t;
    const st0 = await status();
    check('status: on, watching, page "watching", healthy, the cover is there', st0 && st0.on === true && st0.watching === true && st0.page === 'watching' && st0.ok === true && st0.cover && st0.cover.available === true && st0.pauses && st0.pauses.cover === false,
      st0 && { on: st0.on, watching: st0.watching, page: st0.page, ok: st0.ok, reason: st0.reason, cover: st0.cover });
    const camLine = (run.lines.find((l) => /LOOKAWAY watching \d+x\d+@/.test(l.line)) || {}).line || '';
    const cm = /watching (\d+)x(\d+)@([\d.]+)/.exec(camLine);
    check('the page reports the FAKE camera\'s size: 320x240, the clip\'s', !!cm && cm[1] === '320' && cm[2] === '240', camLine || tail(300));
    if (cm) info(`camera as the page reports it: ${cm[1]}x${cm[2]} at ${cm[3]} fps (the clip is ${FPS} fps)`);
    if (st0 && st0.camera) check('status.camera is the clip\'s size', st0.camera.width === 320 && st0.camera.height === 240, st0.camera);
    else info('lookaway.status has no camera size field: the size above is from the page\'s own "watching" report (the feature\'s test log)');
    check('the look-away page is a window of its own (CDP lists ui/lookaway)', !!(await lookPage(port)));

    /* ---- 2. LOOPS loops of the clip, measured ---- */
    await M.at(t0 + 5000);
    await status();   // cost() measures between two asks
    await M.at(t0 + LOOPS * PERIOD + 1500);
    const stC = await status();
    if (stC && stC.cost) info(`cost while watching (the page and the camera service, ${LOOPS * PERIOD / 1000 - 5} s): ${stC.cost.cpuPctOfOneCore}% of one core, ${stC.cost.workingSetMB} MB working set, ${stC.cost.processes} processes`);
    const segs = [];
    for (let k = 0; k < LOOPS; k++) CLIP_PLAN.forEach((s, i) => { if (s.away) segs.push({ k, what: s.away, sw: t0 + k * PERIOD + OFFS[i], back: t0 + k * PERIOD + OFFS[i] + SEG_MS[i] }); });
    let inAway = 0;
    for (const s of segs) {
      const cs = M.ev.filter((e) => isCover(e) && e.t >= s.sw - 500 && e.t < s.back + 500);
      const rs = M.ev.filter((e) => isReveal(e) && e.t >= s.back - 500 && e.t < s.back + 3500);
      inAway += cs.length;
      s.covers = cs.length; s.reveals = rs.length;
      s.lagC = cs.length ? cs[0].t - s.sw - DELAY_S * 1000 : null;
      s.lagR = rs.length ? rs[0].t - s.back : null;
      s.a = around(s.sw, s.back, true);
      s.f = around(s.back, s.back + 3500, false);
    }
    for (const what of [...new Set(segs.map((s) => s.what))]) {
      const mine = segs.filter((s) => s.what === what);
      check(`clip part "${what}": each of the ${mine.length} look-aways led to exactly one cover`, mine.every((s) => s.covers === 1), mine.map((s) => s.covers));
      check(`clip part "${what}": the face coming back after it led to exactly one reveal each time`, mine.every((s) => s.reveals === 1), mine.map((s) => s.reveals));
      const j = (xs) => xs.map(r0).join(', ');
      info(`"${what}" per loop (ms from the computed switch): cover detection lag ${j(mine.map((s) => s.lagC))}; reveal lag ${j(mine.map((s) => s.lagR))}; first away frame at ${j(mine.map((s) => s.a.first))}, last face frame before it at ${j(mine.map((s) => s.a.lastOld))}; first face frame back at ${j(mine.map((s) => s.f.first))}, last away frame before it at ${j(mine.map((s) => s.f.lastOld))}`);
    }
    // a frame with the OLD verdict arriving well after the computed switch = the clip plays later than its timeline
    const lateBy = segs.map((s) => Math.max(s.a.lastOld === null ? -Infinity : s.a.lastOld, s.f.lastOld === null ? -Infinity : s.f.lastOld));
    info(`clip drift check, per away part: the old verdict was still arriving ${lateBy.map(r0).join(', ')} ms after the computed switch (above ~+60 ms the clip runs late by at least that much less the frame's processing)`);
    const allCovers = M.count(isCover, t0, t0 + LOOPS * PERIOD);
    check('no cover was asked while the clip showed the face (covers outside the away parts: 0)', allCovers - inAway === 0, { all: allCovers, inAway });
    measured.cover = segs.map((s) => s.lagC).filter((x) => x !== null);
    measured.reveal = segs.map((s) => s.lagR).filter((x) => x !== null);
    measured.loops = segs.map((s) => `L${s.k} ${s.what === 'no face' ? 'empty' : 'profile'} ${r0(s.lagC)}/${r0(s.lagR)}`);
    check('every cover came 0.25 s early at most and 1.5 s late at most after the delay', measured.cover.length > 0 && measured.cover.every((x) => x >= -250 && x <= 1500), measured.cover.map(r0));
    check('every reveal came within 1 s of the face coming back', measured.reveal.length > 0 && measured.reveal.every((x) => x >= -250 && x <= 1000), measured.reveal.map(r0));
    {
      // how often the page really looks, on this 10 fps clip (it skips frames to its rate)
      const gaps = (fr) => fr.slice(1).map((f, i) => f.t - fr[i].t);
      const s0 = segs[0];
      const idle = gaps(frames(t0 + 1800, s0.sw - 100)), streak = gaps(frames(s0.sw + (s0.a.first || 0) + 50, s0.sw + 900)), cov = gaps(frames(s0.sw + 1600, s0.back - 50));
      info(`frames looked at (median gap): face, no streak ${stats(idle).median} ms; away streak ${stats(streak).median} ms; covered ${stats(cov).median} ms (the feature asks 3 / 4 / 5 a second)`);
    }

    /* ---- 2b. fresh camera starts: the clip starts over each time, so no drift (the headline numbers) ---- */
    let base = t0;   // where the clip timeline starts now
    {
      const FRESH = 5;
      const fa = [];
      for (let i = 0; i < FRESH; i++) {
        const rel = releasedTrue();
        await M.sync(); const tL = M.now;
        await bar.ev(call('lookaway.testLock', { on: true }));
        await until(() => (releasedTrue() > rel ? true : null), 5000, 50);   // the device is closed
        await bar.ev(call('lookaway.testLock', { on: false }));
        const w = await M.wait(isWatching, tL, 30000, 100);
        if (!check(`fresh start ${i + 1}: the camera starts again and watches`, !!w, { status: await status().catch(() => null) })) break;
        base = w.t;
        const sw = w.t + OFFS[FIRST_AWAY], back = sw + SEG_MS[FIRST_AWAY];
        await M.at(back + 1500);
        const c = M.ev.find((e) => isCover(e) && e.t >= sw - 500 && e.t < back + 500);
        const r = M.ev.find((e) => isReveal(e) && e.t >= back - 500 && e.t < back + 1500);
        if (c) measured.freshCover.push(c.t - sw - DELAY_S * 1000);
        if (r) measured.freshReveal.push(r.t - back);
        const a = around(sw, back, true), f = around(back, back + 1500, false);
        fa.push(a); measured.faceBefore.push(a.lastOld === null ? null : -a.lastOld);
        check(`fresh start ${i + 1}: its first look-away covered and the face coming back revealed`, !!c && !!r, { cover: !!c, reveal: !!r });
        info(`fresh start ${i + 1}: cover detection lag ${c ? r0(c.t - sw - DELAY_S * 1000) : '-'} ms, reveal lag ${r ? r0(r.t - back) : '-'} ms; first away frame at ${r0(a.first)}, last face frame at ${r0(a.lastOld)}; first face frame back at ${r0(f.first)} ms`);
      }
      check('the clip starts over at every camera start (each first away frame arrived within 0.7 s after the expected switch, none before it)', fa.length > 0 && fa.every((a) => a.first !== null && a.first >= -100 && a.first <= 700), fa.map((a) => r0(a.first)));
    }

    /* ---- 3. the provider takes the cover down by itself (input) ---- */
    let freshT = null;   // the fresh cover can be the first pause case's cover
    const c3 = await waitCovered(M, base, PERIOD + 4000);
    const p3 = c3 && partOf(c3.t, base);
    const back3 = p3 ? p3.back : 0;
    if (check('input test: a look-away covered the screen first', !!c3 && !!p3, c3 ? r0(c3.t - base) : tail(300)) && c3.t < back3 - 300) {
      await M.sync(); const tS = M.now;
      const sr = await bar.ev(call('fakecover.selfReveal'));
      const st3 = await until(async () => { const s = await status(); return s && s.core && s.core.needFresh === true ? s : null; }, 2000, 100);
      check('input test: the provider showed the screen by itself; the feature no longer counts it as covered and waits for a fresh look away', sr && sr.was === true && !!st3 && st3.core.covered === false, st3 && st3.core);
      await M.at(back3 + 1200);
      check('input test: no new cover for the rest of that same look-away', M.count(isCover, tS, back3) === 0, M.count(isCover, tS, back3));
      check('input test: no reveal asked for a cover the feature no longer has', M.count(isReveal, tS, back3 + 1200) === 0, M.count(isReveal, tS, back3 + 1200));
      const fresh = await M.wait(isCover, tS, PERIOD + 4000, 150);
      check('input test: after the face is seen again, the next look-away covers again', !!fresh && fresh.t > back3, fresh ? r0(fresh.t - back3) : 'no cover');
      if (fresh) freshT = fresh.t;
    } else if (c3 && p3) check('input test: the cover came early enough in the away part to test it', false, r0(c3.t - back3));

    /* ---- 4. every pause turns the camera off, says why and takes the cover down ---- */
    const ctx = { since: freshT !== null ? freshT - 1 : M.now, lastWatch: null };
    async function pauseCase(p) {
      const cov = await waitCovered(M, ctx.since, PERIOD + 6000);
      if (!check(`${p.name}: a look-away covered the screen first`, !!cov, tail(300))) return false;
      restartSample(cov, ctx.lastWatch);
      const relT = releasedTrue(), relF = releasedFalse();
      await M.sync(); const tA = M.now;
      const r = await bar.ev(call(p.cmd, { on: true }));
      check(`${p.name}: ${p.cmd} answers`, !!r && r.ok !== false, r);
      const rv = await M.wait(isReveal, tA, 3000, 50);
      check(`${p.name}: the cover comes down at once (reveal asked ${rv ? r0(rv.t - tA) + ' ms' : 'never'} after the pause)`, !!rv && rv.t - tA < 1000);
      const st = await until(async () => { const s = await status(); return s && s.watching === false && (s.page === 'stopped' || s.page === 'none') ? s : null; }, 6000, 150);
      const sNow = st || await status();
      check(`${p.name}: the state line says why and that the camera is off ("${sNow && sNow.reason}")`, !!st && p.re.test(st.reason) && /camera is off/i.test(st.reason) && st.pauses && st.pauses[p.flag] === true,
        sNow && { reason: sNow.reason, page: sNow.page, watching: sNow.watching, pauses: sNow.pauses });
      const rel = await until(() => (releasedTrue() > relT ? true : null), 6000, 100);
      check(`${p.name}: the page stopped every camera track (it reports released true)`, !!rel && releasedFalse() === relF, { releasedTrue: releasedTrue() - relT, releasedFalse: releasedFalse() - relF });
      if (p.park) {
        check(`${p.name}: right after the pause the page is only parked (its window kept for a quick resume)`, !!(await lookPage(port)));
        await M.at(tA + PARK_MS + 2500);
        const s2 = await status();
        const left = await lookPage(port);
        check(`${p.name}: ${PARK_MS / 1000} s into the pause the hidden page's window is gone`, !!s2 && s2.page === 'none' && !left, s2 && { page: s2.page, target: !!left });
      }
      await M.sync(); const tU = M.now;
      check(`${p.name}: no cover was asked while paused`, M.count(isCover, tA, tU) === 0, M.count(isCover, tA, tU));
      await bar.ev(call(p.cmd, { on: false }));
      const w = await M.wait(isWatching, tU, 45000, 150);
      check(`${p.name} over: the camera comes back on and it watches again`, !!w, { status: await status().catch(() => null) });
      if (w) { ctx.since = w.t; ctx.lastWatch = w.t; }
      return !!w;
    }
    const cases = [
      { name: 'screen locked', cmd: 'lookaway.testLock', flag: 'locked', re: /screen is locked/i, park: true },
      { name: 'another app uses the camera', cmd: 'lookaway.testOtherApp', flag: 'otherApp', re: /another app uses the camera/i },
      { name: 'a full-screen app in front', cmd: 'lookaway.testFullscreen', flag: 'fullscreen', re: /full-screen app/i },
    ];
    for (const p of cases) if (!(await pauseCase(p))) break;

    // the switch off: Mantle Settings' / the tray's own path (host features.setEnabled)
    {
      const cov = await waitCovered(M, ctx.since, PERIOD + 6000);
      if (check('switch off: a look-away covered the screen first', !!cov, tail(300))) {
        restartSample(cov, ctx.lastWatch);
        await M.sync(); const tA = M.now;
        const r = await bar.ev(call('fakecover.switch', { on: false }));
        check('switch off: the switch moves', !!r && r.ok === true, r);
        const rv = await M.wait(isReveal, tA, 3000, 50);
        check(`switch off: the cover comes down at once (reveal asked ${rv ? r0(rv.t - tA) + ' ms' : 'never'} after)`, !!rv && rv.t - tA < 1000);
        const st = await until(async () => { const s = await status(); return s && s.on === false && s.page === 'none' && s.watching === false ? s : null; }, 5000, 150);
        check('switch off: off, not watching, the state line empty, no page', !!st && st.reason === '', st || await status());
        const gone = await until(async () => ((await lookPage(port)) ? null : true), 3000, 150);
        check('switch off: the hidden page\'s window is destroyed at once (the camera goes with its renderer)', !!gone);
        await sleep(2500); await M.sync();
        check('switch off: no cover asked while off', M.count(isCover, tA, M.now) === 0);
        const tU = M.now;
        await bar.ev(call('fakecover.switch', { on: true }));
        const w = await M.wait(isWatching, tU, 45000, 150);
        check('switch on again: a new page opens the camera and watches', !!w, { status: await status().catch(() => null) });
        if (w) { ctx.since = w.t; ctx.lastWatch = w.t; }
      }
    }

    /* ---- 5. a clean quit runs stop(): the cover comes down, nothing is left ---- */
    const cq = await waitCovered(M, ctx.since, PERIOD + 6000);
    if (check('quit: a look-away covered the screen first', !!cq, tail(300))) {
      restartSample(cq, ctx.lastWatch);
      const procs = procDetail(exe);
      const mainP = procs.find((p) => p.kind === 'main');
      const sides = procs.filter((p) => p.kind === 'sidecar' && mainP && p.ppid === mainP.pid);
      check('quit: the instance runs its own sidecar, this tree\'s exe', sides.length >= 1, procs.map((p) => `${p.kind} ${p.pid}<${p.ppid}`).join(', '));
      await M.sync(); const tQ = M.now;
      const qa = quitArgs(CLIP);
      if (check('the --quit messenger carries the fake-camera switches too', fakeOnly(qa, CLIP))) {
        const q = spawnSync(process.execPath, qa, { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000, windowsHide: true });
        const exited = await until(() => run.exited, 30000, 200);
        check('--quit: the instance exits by itself', !!exited, ((q.stdout || '') + (q.stderr || '')).slice(-300) + ' | ' + tail(300));
        const all = readLog(FAKELOG);
        const stopE = all.find((e) => e.op === 'stop' && e.t > tQ);
        const rq = all.find((e) => isReveal(e) && e.t > tQ);
        const done = rq && all.find((e) => e.op === 'revealed' && e.t > rq.t);
        const unp = all.find((e) => e.op === 'unprovided' && e.t > tQ);
        check('clean quit: stop() ran and the feature asked the cover down', !!stopE && !!rq, all.filter((e) => e.t > tQ).map((e) => e.op + (e.from ? ':' + e.from : '')));
        check('clean quit: the screen was uncovered before the cover let go', !!done && (!unp || done.t <= unp.t), { revealed: !!done, unprovided: !!unp });
        if (stopE && rq) info(`quit: the cover was asked down ${r0(rq.t - stopE.t)} ms after stop() began`);
        const left = await until(() => { const l = procDetail(exe).filter((p) => p.kind !== 'sidecar' || sides.some((s) => s.pid === p.pid && s.created === p.created)); return l.length ? null : true; }, 20000, 1000);
        check('clean quit: no electron process of this profile and not its sidecar is left', !!left, procDetail(exe).map((p) => `${p.kind} ${p.pid}`).join(', '));
      }
    }
    check('nothing was written outside the temp folders (live feature files, the worktree)', JSON.stringify(untouchedSnap()) === JSON.stringify(before), { before, after: untouchedSnap() });
  } finally {
    for (const p of open) p.close();
    if (run && !run.exited) { killTest(); await until(() => run.exited, 15000, 200); }
  }
}

const hard = setTimeout(() => {
  console.log(`FAIL the run took over ${HARD_MS / 60000} min: the test instance is stopped`);
  if (run && !run.exited) killTest();
  console.log(`LOOKAWAY E2E TEST: ${passed} passed, ${failures.length + 1} failed`);
  process.exit(1);
}, HARD_MS);
hard.unref();

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  clearTimeout(hard);
  if (run) { try { fs.writeFileSync(OUT_LOG, run.out); console.log(`instance output: ${OUT_LOG}`); } catch (_) { /* best effort */ } }
  if (WORK) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) { /* temp */ } }
  if (skipped) { console.log(`LOOKAWAY E2E TEST: SKIPPED (${skipped})`); process.exit(0); }
  const fc = stats(measured.freshCover), fr = stats(measured.freshReveal), c = stats(measured.cover), rv = stats(measured.reveal);
  const gap = stats(measured.faceBefore.filter((x) => x !== null));
  const line = (s) => `n=${s.n} median ${s.median} ms, min ${s.min}, max ${s.max}`;
  if (fc.n) console.log(`MEASURED (fresh camera starts, no drift) cover detection lag = cover asked - switch to away - ${DELAY_S} s delay: ${line(fc)}`);
  if (fr.n) console.log(`MEASURED (fresh camera starts, no drift) reveal lag = reveal asked - switch back to the face: ${line(fr)}`);
  if (c.n) console.log(`MEASURED (${LOOPS} continuous loops, the clip may drift late) cover ${line(c)}; reveal ${line(rv)}; per part ${measured.loops.join(' | ')}`);
  if (fc.n || c.n) {
    console.log('UNCERTAINTY: time base = the feature\'s "Watching" moment in main + the clip timeline (switches sit exactly on frame boundaries). The clip\'s first frame plays BEFORE that moment by an unmeasured gap g, so the true lags are the numbers above + g.'
      + (gap.n ? ` Bound from the frames: the last face frame reached main at least ${gap.min} ms before a computed switch, so g < ${gap.min} ms + one frame's processing (n=${gap.n}).` : '')
      + ' The page looks at whole frames of a 10 fps clip, so lags move in ~100 ms steps and samples from one run are not independent.');
  }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`LOOKAWAY E2E TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
