'use strict';
/*
 * toasts.e2e.test.js - Mantle's notification banners END TO END on a real Windows toast (lane
 * mantle-toasts2, 2026-10-15): a hidden --test Mantle of this checkout (lib/features/toasts.js + a
 * PASSIVE sidecar, sidecar/ToastBanners.cs), a real toast posted through WinRT from a throwaway app id.
 *
 *   node lib/features/toasts.e2e.test.js     -> "TOASTS E2E TEST: n passed, m failed"
 *
 * NEVER OWEN'S APPS: the only app ids are Mantle.ToastTest.e2e<random>-post / -one, registered here
 * (HKCU\Software\Classes\AppUserModelId) with their Notifications\Settings keys made in advance, so the
 * test instance takes them before the first toast (a --test owner manages ONLY Mantle.ToastTest* ids,
 * _toasts-owner.js TEST_RE, and a passive sidecar writes only those, ToastBanners.cs). The toast is
 * silent and is posted ONLY once Windows' banner for that id reads 0, so Windows never pops one on
 * Owen's screen; the test instance never shows a window (lib/test-quiet.js, toasts.js reveal()).
 * Every key, the AUMID and the toast history are removed in the finally, pass or fail.
 *
 * Checks: the test ids are taken (ShowBanner 0, originals in the instance's own record); the posted
 * toast is in Windows' notification centre (History) AND on Mantle's banner page (CDP into the page,
 * its title and app); Windows' value is still 0 while the banner is up; the banner window's RAM
 * (toasts.debug, test-only); the window is DESTROYED after the idle wait (no background window); a clean
 * quit (shell.quit) puts every original back (no value -> deleted, 1 -> 1).
 *
 * SKIPS, with the reason printed, and counts as no failure: on CI (no desktop session, no notification
 * centre), when a game is running, and when Windows does not let Mantle read notifications (access is
 * not "Allowed": nothing would be taken, by design).
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'toastse2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const RECORD = path.join(USER_DATA, 'notif-banners.json');
const TAG = 'Mantle.ToastTest.e2e' + Math.random().toString(36).slice(2, 8);
const POST = `${TAG}-post`;   // posts the toast; no ShowBanner before (original null)
const ONE = `${TAG}-one`;     // never posts; ShowBanner 1 before (original 1)
const SET = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
const AUMID_KEY = 'HKCU\\Software\\Classes\\AppUserModelId';
const TITLE = `Mantle e2e ${TAG.slice(-6)}`;

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }

const reg = (args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
/** ShowBanner of an app: number | null (no value) | 'nokey' */
function banner(app) {
  if (reg(['query', `${SET}\\${app}`]).status !== 0) return 'nokey';
  const r = reg(['query', `${SET}\\${app}`, '/v', 'ShowBanner']);
  if (r.status !== 0) return null;
  const m = /ShowBanner\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
  return m ? parseInt(m[1], 16) : 'odd';
}
function ps(script, ms) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: ms || 30000 });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}
const WINRT = '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;';
function postToast() {
  return ps(`${WINRT} $x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${TITLE}</text><text>A test from Mantle. It goes away by itself.</text></binding></visual><audio silent="true"/></toast>'); $t = [Windows.UI.Notifications.ToastNotification]::new($x); $t.Tag = 'e2e'; $t.Group = 'mantle'; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POST}').Show($t); 'posted'`);
}
function inCentre() {
  const out = ps(`${WINRT} @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${POST}') | Where-Object { $_.Tag -eq 'e2e' }).Count`);
  return parseInt(out, 10) || 0;
}
function gaming() {
  try {
    const n = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process VALORANT*,RiotClientServices,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true });
    return parseInt((n.stdout || '').trim(), 10) || 0;
  } catch (_) { return -1; }
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  return { url: t.url, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;

let skipped = null;
async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session and no notification centre to post a real toast to'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  const g = gaming();
  if (g !== 0) { skipped = g > 0 ? 'a game is running' : 'could not check for a running game'; return; }

  // a fresh profile record: this instance's originals only
  try { fs.unlinkSync(RECORD); } catch (_) { /* none */ }
  reg(['add', `${AUMID_KEY}\\${POST}`, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Mantle test', '/f']);
  reg(['add', `${SET}\\${POST}`, '/f']);
  reg(['add', `${SET}\\${ONE}`, '/v', 'ShowBanner', '/t', 'REG_DWORD', '/d', '1', '/f']);
  check('setup: the test ids\' settings keys exist before Mantle starts (post: no value, one: 1)', banner(POST) === null && banner(ONE) === 1, { post: banner(POST), one: banner(ONE) });

  const run = launch();
  const open = [];
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 45000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null; } catch (_) { return null; } }, 30000, 300);
    if (!check('the bar page is up (the window commands are called from it)', !!barT, run.out.slice(-600))) return;
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);

    // access: what the instance's own notification list says
    const st0 = await until(async () => { const s = await bar.ev(call('toasts.state')); return s && s.ok && s.access ? s : null; }, 30000, 500);
    if (!st0) { const s = await bar.ev(call('toasts.state')); check('toasts.state reports notification access within 30 s', false, s); return; }
    if (st0.access !== 'Allowed') { skipped = `Windows does not let Mantle read notifications (access "${st0.access}": ${st0.accessWhy || 'no reason'}), so by design nothing is taken; allow it in Settings > Privacy > Notifications`; return; }
    check('toasts.state: on, access Allowed', st0.on === true && st0.accessOk === true, st0);

    // the test ids are taken before any toast
    let took = await until(() => (banner(POST) === 0 && banner(ONE) === 0 ? true : null), 8000, 250);
    if (!took) { await bar.ev(call('toasts.apply')); took = await until(() => (banner(POST) === 0 && banner(ONE) === 0 ? true : null), 8000, 250); }
    if (!check('the test ids are taken: ShowBanner 0 for both', !!took, { post: banner(POST), one: banner(ONE), tail: run.out.slice(-400) })) return;
    let rec = null; try { rec = JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch (_) { /* none */ }
    check('the instance\'s record keeps the originals (post: null, one: 1) and owns only test ids',
      rec && rec.owned[POST] === null && rec.owned[ONE] === 1 && Object.keys(rec.owned).every((k) => /^Mantle\.ToastTest/i.test(k)), rec);
    const d0 = await bar.ev(call('toasts.debug'));
    check('no banner window before a toast (made on demand)', d0 && d0.ok && d0.win === false, d0);

    // the real toast (only now: Windows' banner for it reads 0, so Windows shows none)
    const posted = postToast();
    check('a real toast is posted from the test id', /posted/.test(posted), posted);
    const t0 = Date.now();
    const toastT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/toasts\//.test(t.url)) || null; } catch (_) { return null; } }, 15000, 150);
    if (!check('Mantle\'s banner page opens for it', !!toastT, run.out.slice(-600))) return;
    const page = await attach(toastT); open.push(page);
    const seen = await until(async () => {
      try { return await page.ev(`(() => { const t = Array.from(document.querySelectorAll('.toast')).find((e) => (e.querySelector('.title') || {}).textContent === ${JSON.stringify(TITLE)}); return t ? { app: t.querySelector('.app').textContent, body: t.querySelector('.body').textContent, n: document.querySelectorAll('.toast').length } : null; })()`); } catch (_) { return null; }
    }, 10000, 100);
    const ms = Date.now() - t0;
    check('the banner is on Mantle\'s page with the toast\'s title and app name', !!seen && seen.app === 'Mantle test' && /A test from Mantle/.test(seen.body), seen);
    console.log(`info: toast posted -> Mantle banner on its page in ~${ms} ms (page made on demand)`);
    check('Windows\' banner for the app is still off (ShowBanner 0) while Mantle\'s is up', banner(POST) === 0, banner(POST));
    check('the toast is still in Windows\' notification centre', inCentre() === 1, inCentre());
    const theme = await page.ev('document.documentElement.getAttribute("data-theme")');
    check('the banner page wears Mantle\'s theme (data-theme set)', theme === 'dark' || theme === 'light', theme);

    const d1 = await bar.ev(call('toasts.debug'));
    const mem = d1 && d1.memory;
    check('toasts.debug: a window, its own process, memory read', d1 && d1.win === true && d1.pid > 0 && mem && mem.workingSetSize > 0, d1);
    check('the window was made once', d1 && d1.makes === 1, d1 && d1.makes);
    check('the test window is never shown on screen (isVisible false with a banner up)', d1 && d1.visible === false, d1 && d1.visible);
    if (mem) console.log(`info: banner window process: working set ${(mem.workingSetSize / 1024).toFixed(1)} MB, private ${(mem.privateBytes / 1024).toFixed(1)} MB (pid ${d1.pid})`);

    // the banner leaves by itself; the window goes IDLE_CLOSE_MS later
    page.close();
    const gone = await until(async () => { const d = await bar.ev(call('toasts.debug')); return d && d.win === false ? d : null; }, 75000, 1000);
    check(`the banner window is destroyed after the banner left + the idle wait (no window kept in the background)`, !!gone, await bar.ev(call('toasts.debug')));
    if (gone) console.log(`info: window gone ${Math.round((Date.now() - t0) / 1000)} s after the post`);
    check('... and Windows\' banner is still Mantle\'s while it runs', banner(POST) === 0 && banner(ONE) === 0);

    // a clean quit puts every original back
    const q = await bar.ev(call('shell.quit')).catch((e) => ({ threw: e.message }));
    const exited = await until(() => run.exited, 30000, 250);
    check('shell.quit: the instance exits by itself', !!exited, { q, tail: run.out.slice(-400) });
    check('clean quit: the posting id has no ShowBanner again (its original was none)', banner(POST) === null, banner(POST));
    check('clean quit: the other id is back to 1', banner(ONE) === 1, banner(ONE));
  } finally {
    for (const p of open) p.close();
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  // cleanup, always: the toast history, every test key, the AUMID, this profile's record
  if (process.platform === 'win32' && !(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')) {
    ps(`${WINRT} try { [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('${POST}') } catch {}`);
    for (const k of [`${SET}\\${POST}`, `${SET}\\${ONE}`, `${AUMID_KEY}\\${POST}`]) reg(['delete', k, '/f']);
    try { fs.unlinkSync(RECORD); } catch (_) { /* none */ }
    const left = [`${SET}\\${POST}`, `${SET}\\${ONE}`, `${AUMID_KEY}\\${POST}`].filter((k) => reg(['query', k]).status === 0);
    check('cleanup: every test key is gone', left.length === 0, left);
  }
  if (skipped) console.log(`TOASTS E2E: skipped: ${skipped}`);
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`TOASTS E2E TEST: ${passed} passed, ${failures.length} failed${skipped ? ' (skipped: ' + skipped + ')' : ''}`);
  process.exit(failures.length ? 1 : 0);
});
