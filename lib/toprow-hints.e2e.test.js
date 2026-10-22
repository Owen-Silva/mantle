'use strict';
/*
 * toprow-hints.e2e.test.js -- Quartz's / Helm's TOP-ROW HINTS in a REAL --test instance (lane mantle-topbar-zero,
 * 2026-10-11; look-sync CONTRACT.md "Top-row hints (v1)"; receiver lib/toprow-hints.js, wired in
 * lib/features/topbar.js; painted by the sidecar's colour layer, sidecar/UnderPaint.cs).
 *
 * One invisible --test instance (lib/test-quiet.js), profile 'tbhints', LOOK_SYNC_DIR = a fresh temp folder,
 * MANTLE_TOPBAR_UNDER_HOLD=1 (the sampler runs, the page is not driven by the user's real screen). Clients are
 * tools/toprow-fake-client.js; the windows hints name are tools/toprow-probe-window.js, HIDDEN, run with
 *   - Mantle's own electron.exe (a window that is NOT Quartz's), and
 *   - ~\browser's electron.exe when it is there (stands in for Quartz: lib/toprow-hints.js appOwns).
 *   1. topbar.status.hints: listening on the TEST pipe (look-sync-toprow-test-<pid>), never live's;
 *   2. refused, with the reason counted: a line that is not JSON, an unknown app, a window that is not the
 *      app's (Mantle's electron), a window that does not exist; none kept, none forwarded;
 *   3. accepted (when ~\browser's electron is there): kept and forwarded (the layer counts it), dropped when the
 *      client disconnects;
 *   4. topbar.status.under says the layer's state: native (a transparent passive layer under the bar) or why not;
 *   5. LIGHT: a valid hint is counted 'light theme' and nothing is kept or forwarded; the layer is off.
 *   node lib/toprow-hints.e2e.test.js   -> "TOPROW HINTS E2E: n passed, m failed"
 * Needs a sidecar with `underpaint` / `winproc` (this lane): point MANTLE_SIDECAR_EXE at a fresh build when
 * sidecar/bin is older. Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match tbhints whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'tbhints';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LS_DIR = path.join(os.tmpdir(), 'claude', 'tbhints-e2e', 'ls');
const FAKE = path.join(ROOT, 'tools', 'toprow-fake-client.js');
const PROBE = path.join(ROOT, 'tools', 'toprow-probe-window.js');
const MANTLE_ELECTRON = require('electron');   // (from node: the path of Mantle's electron.exe)
const QUARTZ_ELECTRON = path.join(os.homedir(), 'browser', 'node_modules', 'electron', 'dist', 'electron.exe');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 150);
  }
}
const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { LOOK_SYNC_DIR: LS_DIR, MANTLE_TOPBAR_UNDER_HOLD: '1' });
delete env.MANTLE_TEST_VISIBLE;
delete env.ELECTRON_RUN_AS_NODE;
delete env.MANTLE_TOPBAR_UNDER;
delete env.LOOK_SYNC_TOPROW_PIPE;   // the --test default: its own pipe

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** A hidden probe window run with `exe` -> {hwnd, proc} | null */
async function probe(exe) {
  const e2 = Object.assign({}, process.env); delete e2.ELECTRON_RUN_AS_NODE; delete e2.MANTLE_TEST_VISIBLE;
  const p = spawn(exe, [PROBE], { env: e2, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  p.stdout.on('data', (c) => { out += c.toString('utf8'); });
  p.stderr.on('data', () => {});
  p.stdin.on('error', () => {});
  const m = await until(() => /hwnd (\d+)/.exec(out), 20000, 100);
  return m ? { hwnd: m[1], proc: p } : (p.kill(), null);
}
/** One fake-client message (stays connected `hold` ms) -> its stdout */
function fake(pipe, args, hold) {
  const r = spawnSync(process.execPath, [FAKE, '--pipe', pipe, '--wait', '3000', '--hold', String(hold || 300), ...args], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '') + (r.stderr || '');
}
function fakeBg(pipe, args, hold) {
  const p = spawn(process.execPath, [FAKE, '--pipe', pipe, '--wait', '3000', '--hold', String(hold), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (c) => { out += c.toString('utf8'); });
  return { proc: p, out: () => out };
}
const FLAT = JSON.stringify({ kind: 'flat', rgb: [30, 40, 50] });

async function main() {
  if (gaming()) { check('not run: a game is running', false); return; }
  fs.rmSync(LS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LS_DIR, { recursive: true });
  for (const f of ['theme.json', 'look-sync.json']) { try { fs.unlinkSync(path.join(USER_DATA, f)); } catch (_) { /* none */ } }
  const run = launch();
  const open = [], probes = [];
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-800))) return;
    const tt = await until(async () => (await targets(port)).find((t) => /\/ui\/topbar\/index\.html/.test(t.url)), 90000, 400);
    if (!check('the topbar page is there', !!tt)) return;
    await sleep(2500);
    const top = await attach(tt); open.push(top);
    const theme = await top.ev('document.documentElement.getAttribute(\'data-theme\')');
    if (theme !== 'dark') { await top.ev(call('theme.set', { mode: 'dark' })); await until(() => top.ev('document.documentElement.getAttribute(\'data-theme\') === \'dark\''), 8000); }
    check('the instance is dark', await top.ev('document.documentElement.getAttribute(\'data-theme\')') === 'dark');
    const status = () => top.ev(call('topbar.status'));
    const ign = (s, k) => (s && s.hints && s.hints.ignored && s.hints.ignored[k]) || 0;
    const kept = (s) => (s && s.hints && s.hints.hints ? s.hints.hints.quartz + s.hints.hints.helm : -1);

    /* 1. listening on the test pipe */
    const s0 = await until(async () => { const s = await status(); return s && s.hints && s.hints.listening ? s : null; }, 10000, 200);
    const h0 = s0 && s0.hints;
    check('hints: topbar.status.hints is listening', !!h0 && h0.listening === true, h0);
    const pipe = h0 && h0.pipe;
    check('hints: ...on the TEST pipe (look-sync-toprow-test-<pid>), never live\'s', /\\look-sync-toprow-test-\d+$/.test(pipe || ''), pipe);
    if (!pipe) return;

    /* 2. refused, each with its reason counted */
    let o = fake(pipe, ['--raw', '{"v":1,"app":"quartz", not json']);
    let s = await until(async () => { const x = await status(); return ign(x, 'not valid JSON') >= 1 ? x : null; }, 5000, 150);
    check('refused: a line that is not JSON (counted "not valid JSON")', !!s && kept(s) === 0, { out: o, ignored: s && s.hints.ignored });
    o = fake(pipe, ['--app', 'zork', '--hwnd', '12345', '--top', FLAT]);
    s = await until(async () => { const x = await status(); return ign(x, 'unknown app') >= 1 ? x : null; }, 5000, 150);
    check('refused: an unknown app (counted "unknown app")', !!s && kept(s) === 0, { out: o, ignored: s && s.hints.ignored });
    const notQ = await probe(MANTLE_ELECTRON);
    if (notQ) probes.push(notQ);
    if (check('a hidden probe window run with Mantle\'s electron.exe (not Quartz\'s)', !!notQ)) {
      o = fake(pipe, ['--app', 'quartz', '--hwnd', notQ.hwnd, '--top', FLAT]);
      s = await until(async () => { const x = await status(); return ign(x, 'window is not that app\'s') >= 1 ? x : null; }, 6000, 150);
      check('refused: a hint naming a window that is not Quartz\'s (counted "window is not that app\'s"), not kept', !!s && kept(s) === 0, { out: o, ignored: s && s.hints.ignored });
    }
    o = fake(pipe, ['--app', 'helm', '--hwnd', '999999999', '--top', FLAT]);
    s = await until(async () => { const x = await status(); return ign(x, 'window check failed') >= 1 ? x : null; }, 6000, 150);
    check('refused: a window that does not exist (counted "window check failed"), not kept', !!s && kept(s) === 0, { out: o, ignored: s && s.hints.ignored });

    /* 4. the layer's state */
    const su = await until(async () => { const x = await status(); return x && x.under && (x.under.native || x.under.nativeWhy || x.under.src === 'poll') ? x : null; }, 15000, 300);
    const un = su && su.under;
    if (un && un.native) {
      check('under: native, the layer is up (mode native, transparent: a passive sidecar, directly under the bar)',
        !!un.layer && un.layer.mode === 'native' && /transparent: a test/.test(un.layer.layer || '') && /under the bar/.test(un.layer.layer || '') && !/NOT directly/.test(un.layer.layer || ''), un.layer);
      console.log(`info: the layer: ${un.layer && un.layer.layer}; paints ${un.layer && un.layer.paints}`);
    } else {
      check('under: not native, and it says why', !!un && typeof un.nativeWhy === 'string' && un.nativeWhy.length > 0, un);
      console.log(`info: the layer is not up here: ${un && (un.nativeWhy || un.srcWhy)}`);
    }

    /* 3. accepted: a window of ~\browser's electron.exe (Quartz) */
    let qz = null;
    if (!fs.existsSync(QUARTZ_ELECTRON)) console.log(`SKIP accepted-hint checks: ${QUARTZ_ELECTRON} is not there`);
    else {
      qz = await probe(QUARTZ_ELECTRON);
      if (qz) probes.push(qz);
      if (check('a hidden probe window run with ~\\browser\'s electron.exe (stands in for Quartz)', !!qz)) {
        const bg = fakeBg(pipe, ['--app', 'quartz', '--hwnd', qz.hwnd, '--top', FLAT], 5000);
        s = await until(async () => { const x = await status(); return x && x.hints && x.hints.hints.quartz === 1 ? x : null; }, 6000, 150);
        check('accepted: a Quartz hint for a Quartz window is kept (hints.quartz 1)', !!s, { out: bg.out(), hints: s && s.hints });
        if (un && un.native) {
          const sl = await until(async () => { const x = await status(); return x && x.under && x.under.layer && x.under.layer.hints >= 1 ? x : null; }, 4000, 200);
          check('accepted: ...and forwarded to the sidecar\'s layer (its hints count, read on the next keep-alive)', !!sl, sl && sl.under.layer);
        }
        await until(() => bg.proc.exitCode !== null, 8000, 200);
        s = await until(async () => { const x = await status(); return x && x.hints && x.hints.hints.quartz === 0 ? x : null; }, 4000, 150);
        check('accepted: ...and dropped when its client disconnects', !!s, s && s.hints);
      }
    }

    /* 5. LIGHT: nothing kept, nothing forwarded, no layer */
    await top.ev(call('theme.set', { mode: 'light' }));
    const lit = await until(() => top.ev('document.documentElement.getAttribute(\'data-theme\') !== \'dark\''), 8000);
    check('light: the instance switched to light', !!lit);
    await sleep(800);
    const l0 = await status();
    const target = qz || notQ;
    if (target) {
      o = fake(pipe, ['--app', 'quartz', '--hwnd', target.hwnd, '--top', FLAT]);
      s = await until(async () => { const x = await status(); return ign(x, 'light theme') > ign(l0, 'light theme') ? x : null; }, 5000, 150);
      check('light: a hint is counted "light theme" and not kept', !!s && kept(s) === 0, { out: o, ignored: s && s.hints.ignored });
    }
    const l1 = await until(async () => { const x = await status(); return x && x.under && x.under.native === false ? x : null; }, 5000, 200);
    check('light: the layer is off (under.native false)', !!l1, l1 && l1.under);
    await top.ev(call('theme.set', { mode: 'dark' }));
  } finally {
    if (failures.length) {
      const lines = run.out.split(/\r?\n/).filter((l) => /hints|winproc|underhint|underpaint/i.test(l)).slice(-12);
      console.log('info: the instance\'s hint lines:\n  ' + lines.join('\n  '));
    }
    for (const p of open) p.close();
    for (const p of probes) { try { p.proc.stdin.end(); } catch (_) { /* gone */ } setTimeout(() => { try { p.proc.kill(); } catch (_) { /* gone */ } }, 1500).unref(); }
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    await until(() => run.exited, 15000, 200);
  }
}
main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`TOPROW HINTS E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
