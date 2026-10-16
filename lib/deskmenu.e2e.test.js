'use strict';
// The CPU cap and the one-browser lock on Owen's PC; a CI runner (cloudtest) has neither file nor need.
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
/*
 * deskmenu.e2e.test.js -- the desktop right-click menu end to end (lane mantle-deskmenu, 2026-10-15, plan P6).
 *
 * Never the real desktop: tools/fake-progman.cs "desk" plays it (MantleFakeProgman > SHELLDLL_DefView >
 * SysListView32, off every monitor), and the --test instance (profile mndeskmenu, invisible: lib/test-quiet.js)
 * arms the sidecar's hook against THAT class only (MANTLE_DESKMENU_TEST_CLASS). No input is made: each
 * right-click goes through the hook's real decision via deskmenu.testclick, naming the stand-in's icon layer
 * as the window under the cursor (WindowFromPoint finds nothing off every monitor).
 *   1. right-click on the empty desktop: the menu window opens at the click, shown without the keyboard,
 *      on top, its five rows drawn; ONE log line "opened (cold|warm) ... shown, painted, interactive";
 *      the helper got its ack (no fallback); no new renderer process (the desktop page's own);
 *   2. BUDGET: 12 opens, warm p95 painted <= 50 ms (the first, cold one is reported);
 *   3. rows: Change wallpaper opens Mantle Wallpapers, Display settings opens Settings, the widgets switch
 *      flips the desktop page, each closes the menu with a "done" line;
 *   4. Shift+right-click passes (no menu); off the desktop passes;
 *   5. WIN+D / desktop focus: opening and closing the menu leaves the foreground window as it was and the
 *      menu window cannot take the keyboard;
 *   6. EXPLORER RESTART: the stand-in killed (the click passes), a new one made: the menu opens again;
 *   7. MENU KEYS: the pop-up watch's key events (made up through popwatch.test) walk the rows and Enter picks.
 *   node lib/deskmenu.e2e.test.js   -> "DESKMENU E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match mndeskmenu whatever happens; never
 * touches the live Mantle, explorer.exe, or another lane's instance.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'mndeskmenu';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const FAKE_SRC = path.join(ROOT, 'tools', 'fake-progman.cs');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const DESK = { x: -30000, y: -30000, w: 400, h: 300 };

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
    await sleep(every || 100);
  }
}
function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}
function gaming() { return (parseInt(ps('@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'), 10) || 0) > 0; }
function fakeExe() {
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
async function startDesk(exe) {
  const f = { out: '' };
  f.proc = spawn(exe, ['desk'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  f.proc.stdout.on('data', (c) => { f.out += c.toString('utf8'); });
  await until(() => /^desk /m.test(f.out), 8000, 50);
  const m = /^desk ([0-9a-f]+) ([0-9a-f]+)/m.exec(f.out);
  f.defview = m ? String(parseInt(m[2], 16)) : null;
  return f;
}
function killDesk(f) { if (f && f.proc && f.proc.exitCode === null) { try { process.kill(f.proc.pid); } catch (_) { /* gone */ } } }

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const env = Object.assign({}, process.env, { MANTLE_DESKMENU_TEST_CLASS: 'MantleFakeProgman' });
delete env.MANTLE_TEST_VISIBLE;
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.MANTLE_SIDECAR_EXE) env.MANTLE_SIDECAR_EXE = process.env.MANTLE_SIDECAR_EXE;

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
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}

const DESKTOP = `E.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /\\/ui\\/desktop\\/index\\.html/.test(x.webContents.getURL()))`;
const MENU = `E.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === 'Mantle desktop menu')`;
const OPEN_RE = /desktop menu: opened \((cold|warm)\) via right-click: shown ([\d.]+), painted ([\d.]+), interactive ([\d.]+) ms/g;

(async () => {
  if (gaming()) { check('not run: a game is running', false); return finish(); }
  let exe;
  try { exe = fakeExe(); } catch (e) { check('the stand-in desktop builds', false, e.message); return finish(); }
  let desk = await startDesk(exe);
  const desks = [desk];
  if (!check('the stand-in desktop starts', !!desk.defview, desk.out)) return finish();
  const run = launch();
  let main = null;
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started', !!port, run.out.slice(-800))) return;
    const insp = /Debugger listening on (ws:\/\/\S+)/.exec(run.out);
    if (!check('main has an inspector', !!insp, run.out.slice(-800))) return;
    main = await attach(insp[1]);
    const M = (body) => main.ev(`(async () => { const E = process.mainModule.require('electron'); ${body} })()`);
    if (!check('the desktop layer page is there', !!(await until(() => M(`const w = ${DESKTOP}; return !!w && !w.webContents.isLoading();`), 30000, 300)))) return;
    const armed = await until(() => /desktop menu: armed \(the helper started\) on the stand-in desktop MantleFakeProgman/.test(run.out), 30000, 200);
    if (!check('the feature armed the helper on the stand-in desktop (never the real one)', !!armed, run.out.split('\n').filter((l) => /deskmenu|desktop menu/.test(l)).slice(-5).join(' | '))) return;
    const call = (name, args) => M(`const w = ${DESKTOP}; return await w.webContents.executeJavaScript(${JSON.stringify(`window.mantle.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})})`)});`);
    const at = () => ({ x: DESK.x + 200, y: DESK.y + 150, under: desk.defview });
    const opensSoFar = () => (run.out.match(OPEN_RE) || []).length;
    const renderers = () => M(`return E.app.getAppMetrics().filter((m) => m.type === 'Tab').length;`);
    const fg = () => M(`try { const u = process.mainModule.require('koffi').load('user32.dll'); return Number(u.func('intptr_t __stdcall GetForegroundWindow()')()); } catch (e) { return 'no koffi: ' + e.message; }`);

    /** one right-click on the stand-in; resolves with the open's numbers, or null */
    async function rightClick(extra) {
      const n0 = opensSoFar();
      const r = await call('deskmenu.testclick', Object.assign(at(), extra || {}));
      if (!r || r.taken !== true) return { r };
      const ok = await until(() => opensSoFar() > n0, 5000, 20);
      const all = Array.from(run.out.matchAll(OPEN_RE));
      const m = ok ? all[all.length - 1] : null;
      return { r, open: m ? { how: m[1], shown: +m[2], painted: +m[3] } : null };
    }

    /* 1. a right-click on the empty desktop */
    const rend0 = await renderers();
    const fg0 = await fg();
    const first = await rightClick();
    check('1. the hook took the right-click on the empty stand-in desktop', first.r && first.r.taken === true, first.r);
    check('1. ONE log line: opened (cold) via right-click, shown, painted, interactive', !!first.open && first.open.how === 'cold', run.out.split('\n').filter((l) => /desktop menu/.test(l)).slice(-4).join(' | '));
    const w1 = await M(`const w = ${MENU}; if (!w) return null; const b = w.getBounds(); return { visible: w.isVisible(), focusable: w.isFocusable(), top: w.isAlwaysOnTop(), b, url: w.webContents.getURL() };`);
    check('1. the menu window shows at the click, cannot take the keyboard, is on top, about:blank', !!w1 && w1.visible && w1.focusable === false && w1.top && w1.url === 'about:blank' &&
      Math.abs(w1.b.x - (DESK.x + 200 - 10)) <= 2 && Math.abs(w1.b.y - (DESK.y + 150 - 10)) <= 2 && w1.b.width > 200 && w1.b.height > 200, w1);
    const rows = await M(`const w = ${MENU}; return await w.webContents.executeJavaScript("Array.from(document.querySelectorAll('.dm-row .dm-tx')).map((e) => e.textContent).join(',')");`);
    check('1. its five rows are drawn', rows === 'Change wallpaper,Display settings,Personalize,Hide desktop widgets,Mantle Settings', rows);
    check('1. no new renderer process for the menu (it lives in the desktop page\'s)', (await renderers()) === rend0, { before: rend0, after: await renderers() });
    let st = await call('deskmenu.status');
    check('1. the helper got its ack in time (no fallback)', st && st.sidecar && st.sidecar.fallbacks === 0 && st.sidecar.swallowed >= 1, st && st.sidecar);
    check('5. WIN+D / desktop focus: the foreground window did not change when the menu opened', (await fg()) === fg0, { before: fg0, after: await fg() });
    await call('deskmenu.hide', { why: 'the e2e' });
    await until(() => M(`const w = ${MENU}; return !!w && !w.isVisible();`), 3000, 50);
    check('5. ...nor when it closed', (await fg()) === fg0);

    /* 2. budget */
    const warm = [];
    for (let i = 0; i < 12; i++) {
      const o = await rightClick();
      if (o.open) warm.push(o.open);
      await call('deskmenu.hide', { why: 'the e2e' });
      await sleep(120);
    }
    const ps95 = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
    const painted = warm.filter((o) => o.how === 'warm').map((o) => o.painted);
    console.log(`budget: cold painted ${first.open && first.open.painted} ms; warm painted ms: ${painted.join(', ')}`);
    check(`2. BUDGET: warm right-click -> painted p95 ${ps95(painted)} ms <= 50 ms (12 opens; cold first ${first.open && first.open.painted} ms)`, painted.length === 12 && ps95(painted) <= 50, painted);
    st = await call('deskmenu.status');
    check('2. no fallback in all of them', st.sidecar.fallbacks === 0, st.sidecar);

    /* 3. rows */
    async function pick(id) {
      const o = await rightClick();
      if (!o.open) return { ok: false, why: 'no menu' };
      const n = run.out.length;
      await M(`const w = ${MENU}; await w.webContents.executeJavaScript("document.querySelector('.dm-row[data-id=\\"${id}\\"]').click()"); return 1;`);
      const line = await until(() => { const m = /desktop menu: (\S+)(: done| did not work: [^\n]*)/.exec(run.out.slice(n)); return m ? m[0] : null; }, 8000, 50);
      const hidden = await until(() => M(`const w = ${MENU}; return !w || !w.isVisible();`), 3000, 50);
      return { line, hidden };
    }
    let p = await pick('wallpaper');
    const wallWin = await until(() => M(`return E.BrowserWindow.getAllWindows().some((x) => !x.isDestroyed() && /wallpaper/i.test(x.getTitle() + ' ' + x.webContents.getURL()) && !/desktop\\/index/.test(x.webContents.getURL()));`), 8000, 200);
    check('3. Change wallpaper: Mantle Wallpapers opens, "done", the menu closes', /wallpaper: done/.test(p.line || '') && !!p.hidden && !!wallWin, { p, wallWin });
    p = await pick('display');
    const setWin = await until(() => M(`return E.BrowserWindow.getAllWindows().some((x) => !x.isDestroyed() && /\\/ui\\/settings\\//.test(x.webContents.getURL()));`), 8000, 200);
    check('3. Display settings: Mantle Settings opens, "done", the menu closes', /display: done/.test(p.line || '') && !!p.hidden && !!setWin, { p, setWin });
    p = await pick('widgets');
    const off = await M(`const w = ${DESKTOP}; return await w.webContents.executeJavaScript("document.body.classList.contains('widgets-off')");`);
    check('3. Hide desktop widgets: the desktop page hides them, "done", the menu closes', /widgets: done/.test(p.line || '') && !!p.hidden && off === true, { p, off });
    p = await pick('widgets');
    const on = await M(`const w = ${DESKTOP}; return await w.webContents.executeJavaScript("document.body.classList.contains('widgets-off')");`);
    check('3. ...and Show brings them back', /widgets: done/.test(p.line || '') && on === false, { p, on });

    /* 7. menu keys: the watch's key events (made up: a --test run makes no real key) walk the menu and pick */
    {
      const o = await rightClick();
      const key = (k) => call('popwatch.test', { ev: { op: 'key', key: k } });
      const sel = () => M(`const w = ${MENU}; return await w.webContents.executeJavaScript("Array.from(document.querySelectorAll('.dm-row.sel')).map((e) => e.dataset.id).join(',')");`);
      const k1 = await key('down');
      const s1 = await until(async () => { const s = await sel(); return s ? s : null; }, 2000, 30);
      check('7. KEYS: Down reaches the open menu through the pop-up watch and highlights the first row', !!o.open && k1 && k1.result === 'deskmenu' && s1 === 'wallpaper', { open: !!o.open, k1: k1 && k1.result, s1 });
      await key('down'); await key('down'); await key('up');
      const s2 = await until(async () => { const s = await sel(); return s === 'display' ? s : null; }, 2000, 30);
      check('7. KEYS: Down, Down, Up lands on Display settings', s2 === 'display', await sel());
      const n = run.out.length;
      await key('enter');
      const line = await until(() => { const m = /desktop menu: (\S+)(: done| did not work: [^\n]*)/.exec(run.out.slice(n)); return m ? m[0] : null; }, 8000, 50);
      const hidden = await until(() => M(`const w = ${MENU}; return !w || !w.isVisible();`), 3000, 50);
      check('7. KEYS: Enter runs the highlighted row ("display: done") and the menu closes', /display: done/.test(line || '') && !!hidden, { line, hidden });
      const k2 = await key('down');
      check('7. KEYS: with the menu closed, a key goes to nobody', k2 && k2.result === null, k2 && k2.result);
    }

    /* 4. passes */
    const n4 = opensSoFar();
    let r = await call('deskmenu.testclick', Object.assign({ shift: true }, at()));
    await sleep(400);
    check('4. Shift+right-click passes to Windows\' menu (no Mantle menu)', r && r.taken === false && r.why === 'shift' && opensSoFar() === n4, r);
    r = await call('deskmenu.testclick', { x: 5, y: 500 });
    check('4. a right-click on a real window passes', r && r.taken === false, r);

    /* 6. Explorer restart */
    killDesk(desk);
    await sleep(500);
    r = await call('deskmenu.testclick', at());
    check('6. Explorer gone: the click passes (no desktop to take it from)', r && r.taken === false, r);
    desk = await startDesk(exe);
    desks.push(desk);
    const again = await rightClick();
    check('6. EXPLORER RESTART: on the new desktop the menu opens again', !!desk.defview && again.r && again.r.taken === true && !!again.open, again);
    await call('deskmenu.hide', { why: 'the e2e' });
    check('main is still running and answers', !run.exited && (await M('return 1 + 1;')) === 2);
  } catch (e) {
    check('no exception in the test itself', false, e.stack);
  } finally {
    if (main) main.close();
    for (const f of desks) killDesk(f);
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    finish();
  }
})();

function finish() {
  console.log(`DESKMENU E2E: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length || !passed ? 1 : 0);
}
