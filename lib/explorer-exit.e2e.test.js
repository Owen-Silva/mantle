'use strict';
// The CPU cap and the one-browser lock on Owen's PC; a CI runner (cloudtest) has neither file nor need.
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
/*
 * explorer-exit.e2e.test.js -- Mantle SURVIVES Explorer going away (lane mantle-crash, 2026-10-15).
 *
 * Both times Explorer exited while Mantle was alive (10-11 17:01:15, 10-14 20:11:52) Mantle's main process
 * died in the same second with 0xc000041d. The desktop layer is a WS_CHILD of Explorer's Progman; a parent
 * owned by a DYING thread takes its cross-process child down with WM_NCDESTROY and no WM_DESTROY first.
 *
 * Never the real Explorer: tools/fake-progman.cs (compiled into %TEMP%) plays Progman. One invisible --test
 * instance (lib/test-quiet.js), profile 'mnexplorer'; the Node inspector into its own main:
 * each time the stand-in adopts the instance's CURRENT desktop layer as a WS_CHILD (what sidecar Desktop.cs
 * does), then goes away; Mantle's main must still run 10 s later and answer, the log must say what happened,
 * a NEW layer must be made with its page loaded, and the bar page must still answer:
 *   1. KILL: the stand-in is killed by pid (its own pid only) = Explorer crashing / End task;
 *   2. THREAD EXIT: its window thread ends without destroying the window (win32k cleans up);
 *   3. IN ORDER: DestroyWindow on its own thread = a clean Explorer exit (the guard must stay quiet);
 *   4. EXPLORER BACK: TaskbarCreated POSTED to this instance's own windows only (never a broadcast):
 *      Mantle says so once (not once per window) and keeps answering.
 * Before lib/foreign-parent.js, step 1 crashed main with 0xc000041d within a second (int3 at
 * electron.exe+0x353cba8, the same as both live crashes).
 *   node lib/explorer-exit.e2e.test.js   -> "EXPLORER EXIT E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match mnexplorer whatever happens; never
 * touches the live Mantle, explorer.exe, or another lane's instance.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'mnexplorer';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const FAKE_SRC = path.join(ROOT, 'tools', 'fake-progman.cs');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700) : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 200);
  }
}
function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}
function gaming() { return (parseInt(ps('@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'), 10) || 0) > 0; }

/** tools/fake-progman.cs compiled once per source version into %TEMP%. -> exe path, or throws with csc's words. */
function fakeProgmanExe() {
  const src = fs.readFileSync(FAKE_SRC);
  const tag = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const dir = path.join(os.tmpdir(), 'mantle-fake-progman');
  const exe = path.join(dir, `fake-progman-${tag}.exe`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(CSC, ['-nologo', '-optimize', `-out:${exe}`, FAKE_SRC], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('csc could not build tools/fake-progman.cs: ' + ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 400));
  return exe;
}

// electron.exe itself, spawned from THIS process, so lowcpu's hook sees a browser (theme.e2e's reason)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
delete env.ELECTRON_RUN_AS_NODE;

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(ELECTRON, ['.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0', '--inspect=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code, at: Date.now() }; });
  return run;
}
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('closed')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); try { ws.send(JSON.stringify({ id: i, method, params: params || {} })); } catch (e) { pend.delete(i); rej(e); } });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, send, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}

/** The stand-in Progman adopting `hexHwnd`; resolves once it says "adopted". */
function startFake(exe, hexHwnd, mode, secs) {
  const f = { out: '', exited: null };
  f.proc = spawn(exe, ['parent', hexHwnd, mode].concat(secs ? [String(secs)] : []), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  f.proc.stdout.on('data', (c) => { f.out += c.toString('utf8'); });
  f.proc.stderr.on('data', (c) => { f.out += c.toString('utf8'); });
  f.proc.on('exit', (code) => { f.exited = { code }; });
  return f;
}

const DESKTOP_HWND = `(() => { const w = E.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /\\/ui\\/desktop\\/index\\.html/.test(x.webContents.getURL()));
  if (!w) return null; const b = w.getNativeWindowHandle(); return { id: w.id, hex: (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString(16) }; })()`;

(async () => {
  if (gaming()) { check('not run: a game is running', false); return finish(); }
  let exe;
  try { exe = fakeProgmanExe(); } catch (e) { check('the stand-in Progman builds', false, e.message); return finish(); }
  const run = launch();
  const open = [];
  const fakes = [];
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-800))) return;
    const insp = /Debugger listening on (ws:\/\/\S+)/.exec(run.out);
    if (!check('main has an inspector', !!insp, run.out.slice(-800))) return;
    const main = await attach(insp[1]);
    open.push(main);
    const M = (body) => main.ev(`(async () => { const E = process.mainModule.require('electron'); ${body} })()`);

    const d0 = await until(() => M(`return ${DESKTOP_HWND};`), 30000, 300);
    if (!check('the desktop layer window is there', !!d0)) return;
    await sleep(1500);   // let the page settle, as a live layer would be by the time Explorer goes

    const GUARD_RE = /its parent window in another process went away without closing it .*finished the close in order/g;
    const MADE_RE = /desktop layer: made again \((\d+)\); its page loaded/g;
    const count = (re) => (run.out.match(re) || []).length;
    /**
     * One way for Explorer to go: the stand-in adopts the CURRENT layer, then goes `mode`. Mantle must still be
     * running 10 s later (a crash can take WER several seconds to finish), answer, and have a NEW layer whose
     * page loaded. guardExpected: the in-order close (DestroyWindow) needs no help, so the guard stays quiet.
     */
    async function goAway(label, mode, guardExpected) {
      const d = await until(() => M(`return ${DESKTOP_HWND};`), 15000, 300);
      if (!check(`${label}: there is a desktop layer to adopt`, !!d)) return null;
      const guards0 = count(GUARD_RE);
      const made0 = count(MADE_RE);
      const f = startFake(exe, d.hex, mode, mode === 'hold' ? 0 : 1.5);
      fakes.push(f);
      if (!check(`${label}: the stand-in Progman adopted the desktop layer`, !!(await until(() => /adopted /.test(f.out), 10000, 100)), f.out)) return null;
      await sleep(mode === 'hold' ? 1000 : 0);
      const at = Date.now();
      if (mode === 'hold') { try { process.kill(f.proc.pid); } catch (_) { /* already gone */ } }   // its own pid only
      await sleep(10000);
      if (!check(`${label}: Mantle main is still running 10 s after its desktop layer's parent went away`, !run.exited,
        run.exited ? `exited 0x${(run.exited.code >>> 0).toString(16)} ${run.exited.at - at} ms later; last lines: ${run.out.split('\n').slice(-6).join(' | ')}` : undefined)) return null;
      const alive = await M('return 1 + 1;').catch((e) => e.message);
      check(`${label}: main still answers`, alive === 2, alive);
      check(guardExpected ? `${label}: the log says the close was finished in order, and why` : `${label}: an in-order close needed no help (no guard line)`,
        count(GUARD_RE) === guards0 + (guardExpected ? 1 : 0), run.out.split('\n').filter((l) => /parent window|desktop layer/.test(l)).slice(-4).join(' | '));
      check(`${label}: the log says the layer closed and a new one is being made`, /desktop layer: it closed while Mantle runs: making a new one/.test(run.out.slice(-20000)));
      const made = await until(() => count(MADE_RE) > made0, 15000, 300);
      check(`${label}: a NEW desktop layer was made and its page loaded`, !!made, run.out.split('\n').filter((l) => /desktop layer/.test(l)).slice(-3).join(' | '));
      const d2 = await until(() => M(`return ${DESKTOP_HWND};`), 10000, 300);
      check(`${label}: the new layer is a different window`, !!d2 && d2.hex !== d.hex, { before: d.hex, after: d2 && d2.hex });
      const bar = await M(`const w = E.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /\\/ui\\/bar\\/index\\.html/.test(x.webContents.getURL()));
        return w ? await w.webContents.executeJavaScript('document.readyState + ":" + (typeof window.mantle)') : null;`).catch((e) => e.message);
      check(`${label}: the bar page still answers`, bar === 'complete:object', bar);
      return d2;
    }

    /* 1. KILL: the stand-in is killed by pid (Explorer crashing, End task): the layer gets WM_NCDESTROY only */
    if (!(await goAway('KILL', 'hold', true))) return;
    /* 2. THREAD EXIT: the stand-in's window thread ends without destroying its window (win32k cleans up) */
    if (!(await goAway('THREAD EXIT', 'exitthread', true))) return;
    /* 3. IN ORDER: DestroyWindow on the stand-in's own thread (a clean Explorer exit): WM_DESTROY comes first */
    if (!(await goAway('IN ORDER', 'destroy', false))) return;

    /* 4. EXPLORER BACK: TaskbarCreated, POSTED to this instance's own top-level windows only (never broadcast) */
    const back0 = (run.out.match(/Explorer is back \(TaskbarCreated/g) || []).length;
    // posted from THIS process (another process, as Explorer's broadcast is), to the instance's own windows
    const hwnds = await M(`return E.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => { const b = w.getNativeWindowHandle(); return Number(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0)); });`).catch((e) => e.message);
    let posted;
    try {
      const u = require('koffi').load('user32.dll');
      const reg = u.func('uint32_t __stdcall RegisterWindowMessageW(str16 n)');
      const post = u.func('bool __stdcall PostMessageW(intptr_t h, uint32_t m, uintptr_t w, intptr_t l)');
      const id = reg('TaskbarCreated');
      posted = Array.isArray(hwnds) ? hwnds.filter((h) => post(h, id, 0, 0)).length : hwnds;
    } catch (e) { posted = e.message; }
    check('EXPLORER BACK: TaskbarCreated was posted to this instance\'s windows', typeof posted === 'number' && posted > 0, posted);
    const heard = await until(() => (run.out.match(/Explorer is back \(TaskbarCreated/g) || []).length > back0, 8000, 200);
    check('EXPLORER BACK: Mantle heard it and says what it does about it (once, not once per window)', !!heard &&
      (run.out.match(/Explorer is back \(TaskbarCreated/g) || []).length === back0 + 1, run.out.split('\n').filter((l) => /Explorer is back/.test(l)).slice(-3).join(' | '));
    check('EXPLORER BACK: main still answers', (await M('return 1 + 1;').catch((e) => e.message)) === 2);
  } catch (e) {
    check('no exception in the test itself', false, e.stack);
  } finally {
    for (const p of open) p.close();
    for (const f of fakes) { if (!f.exited) { try { process.kill(f.proc.pid); } catch (_) { /* gone */ } } }
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    finish();
  }
})();

function finish() {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`EXPLORER EXIT E2E: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}
