'use strict';
/*
 * look-isolation.e2e.test.js -- a --test Mantle NEVER touches the user's real %APPDATA%\look-sync
 * (lane looksync-ship, 2026-10-10: a test instance without LOOK_SYNC_DIR had published its own
 * wallpaper and theme into the real file, and live Quartz followed it).
 *
 * LOOK_SYNC_DIR is DELETED from the child's env on purpose: the instance must fall back to a
 * look-sync folder inside its own temp profile (main.js getLook), never the real one.
 *   1. snapshot every file under the real %APPDATA%\look-sync (size + mtime, stills included);
 *   2. launch one --test instance (profile lsiso), wait for the bar page;
 *   3. wallpaper.set builtin:snow-peak from the bar page;
 *   4. %TEMP%\mantle-test-lsiso\look-sync\look.json appears with a desktop record for
 *      builtin:snow-peak (the test used its own folder);
 *   5. stop it with tools/kill-test.ps1 -Match lsiso; snapshot again: identical.
 * Refuses while a game runs. Never shown on screen (lib/test-quiet.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'lsiso';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const TEST_LOOK_DIR = path.join(USER_DATA, 'look-sync');
const REAL_LOOK_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'look-sync');

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
/** every file under dir (recursive): { relpath: "size@mtimeMs" }; {} when the folder is not there */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else { try { const s = fs.statSync(p); out[path.relative(dir, p)] = `${s.size}@${s.mtimeMs}`; } catch (_) { out[path.relative(dir, p)] = 'gone'; } }
    }
  };
  walk(dir);
  return out;
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
delete env.LOOK_SYNC_DIR;         // ON PURPOSE: the instance must pick its own folder

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
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;
function readTestLook() {
  try { return JSON.parse(fs.readFileSync(path.join(TEST_LOOK_DIR, 'look.json'), 'utf8')); } catch (_) { return null; }
}

async function main() {
  if (gaming()) { check('no game running (not launching an instance)', false); return; }
  try { fs.rmSync(TEST_LOOK_DIR, { recursive: true, force: true }); } catch (_) { /* a fresh profile has none */ }
  const before = snapshot(REAL_LOOK_DIR);
  const run = launch();
  let bar = null;
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the test instance started and wrote its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => (await targets(port)).find((t) => /\/ui\/bar\/index\.html/.test(t.url)), 90000, 500);
    if (!check('the bar page is up', !!barT)) return;
    bar = await attach(barT);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 20000, 300);
    const pick = await bar.ev(call('wallpaper.set', { id: 'builtin:snow-peak' }));
    check('wallpaper.set builtin:snow-peak answered', pick && pick.ok !== false, pick);
    const doc = await until(() => { const d = readTestLook(); return d && d.desktop && d.desktop.id === 'builtin:snow-peak' ? d : null; }, 30000, 300);
    check('the test profile\'s own look-sync\\look.json has a desktop record for builtin:snow-peak', !!doc, readTestLook());
    if (doc && doc.desktop && doc.desktop.still) {
      check('that record\'s still is inside the test profile, not the real folder',
        path.resolve(doc.desktop.still).toLowerCase().startsWith(path.resolve(TEST_LOOK_DIR).toLowerCase() + path.sep), doc.desktop.still);
    }
  } finally {
    if (bar) bar.close();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    await until(() => run.exited, 15000, 200);
    await sleep(500);
    const after = snapshot(REAL_LOOK_DIR);
    const diff = [...new Set(Object.keys(before).concat(Object.keys(after)))].filter((k) => before[k] !== after[k])
      .map((k) => `${k}: ${before[k] || 'absent'} -> ${after[k] || 'absent'}`);
    check('The user\'s real %APPDATA%\\look-sync is untouched (every file\'s size and mtime, stills included)', diff.length === 0, diff.join('; '));
    process.stdout.write(`  (real look-sync: ${Object.keys(before).length} file(s) before, ${Object.keys(after).length} after)\n`);
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`LOOK ISOLATION E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
