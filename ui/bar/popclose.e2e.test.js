'use strict';
/*
 * ui/bar/popclose.e2e.test.js - the bar's pop-ups close on a click outside the bar and on Esc, in a
 * real --test bar (lane mn-pop, 2026-10-12, audit #1 and the privacy item).
 *
 * WHAT. One quiet Electron --test instance (invisible: lib/test-quiet.js) with --test-popwatch, so
 * main asks its own PASSIVE sidecar for the pop-up watch (sidecar/Hotkey.cs popwatch: the mouse hook
 * and Esc, observe-only in passive: nothing is ever swallowed). A second instance (--test-click) opens
 * pop-ups through the open path a click takes, a DevTools port reads the bar page, and main's test
 * hook (popwatch.test) hands lib/popwatch.js the same events the sidecar sends, at points inside
 * and outside the bar's real rectangle:
 *   the watch is armed while a pop-up is open and dropped when none is; a click outside closes it,
 *   a click inside does not; Esc closes it; its room goes back (nothing left pinning the bar); the
 *   right-click menu (a key that carries an app's pin name) logs only its kind.
 * NO real input is injected (a real click or Esc on this desktop would land in Helm). The real
 * hook-to-click road is the visible-slot check in the lane report.
 *
 *   node ui/bar/popclose.e2e.test.js
 * One summary line: "popclose e2e: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE = 'mn-pop';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail !== undefined ? `${name} (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : name);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0', '--test-popwatch'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: Object.assign({}, env, { LOWCPU: '0' }), encoding: 'utf8', timeout: 30000 });
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

async function attach(run) {
  const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
  if (!port) throw new Error('the test instance never wrote its DevTools port');
  const tgt = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && /\/ui\/bar\/index\.html/.test(t.url) && t.url.startsWith('file:'));
  }, 90000, 500);
  if (!tgt) throw new Error('the bar page never showed up in the test instance');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
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

async function main() {
  const r = launch();
  let c = null;
  try {
    c = await attach(r);
    const pw = (a) => c.ev(`window.mantle.call('popwatch.test', ${JSON.stringify(a || {})})`);
    const popOpen = () => c.ev(`!document.getElementById('pop').hidden`);
    const ready = await until(async () => (await c.ev(`!!document.getElementById('more') && !!window.mantle`)) || null, 30000, 300);
    check('the real bar page is up', !!ready);

    let s = await pw();
    check('nothing open: the watch is off', s && s.ok && s.state.mode === null && s.state.open.length === 0, s);

    // ---- More, opened by its real button: the watch arms through the real (passive) sidecar
    second(['--test-click=more']);
    check('the More menu opens (the test hook runs the same open a click does)', !!(await until(popOpen, 5000, 50)));
    s = await until(async () => { const x = await pw(); return x && x.state.mode === 'hook' ? x : null; }, 5000, 100);
    check('with a pop-up open, main armed the sidecar\'s watch (popwatch op of the worktree sidecar)', !!s && s.state.open.includes('bar'), s || await pw());
    check('a passive (test) sidecar only observes Esc, never swallows it', !!s && s.state.esc === 'observe', s);
    const bar = s ? s.bar : null;
    check('main knows the bar\'s rectangle', !!bar && bar.width > 0 && bar.height > 0, bar);

    // a click INSIDE the bar's rectangle closes nothing (the page's own handler owns those)
    s = await pw({ ev: { op: 'click', button: 'left', x: bar.x + Math.round(bar.width / 2), y: bar.y + Math.round(bar.height / 2) }, dip: true });
    await sleep(400);
    check('a click inside the bar leaves the pop-up open', s && s.result === 0 && await popOpen(), s);

    // a click OUTSIDE (well above the bar: an app, the desktop) closes it and gives the room back
    s = await pw({ ev: { op: 'click', button: 'left', x: bar.x + 20, y: Math.max(0, bar.y - 150) }, dip: true });
    const closed = await until(async () => !(await popOpen()), 3000, 50);
    check('a click outside the bar closes the pop-up', s && s.result === 1 && !!closed, s);
    s = await until(async () => { const x = await pw(); return x && x.barPopover === null && x.state.mode === null ? x : null; }, 3000, 100);
    check('and its room is given back: nothing pins the bar up, the watch is off again', !!s, s || await pw());

    // ---- Esc: the same road
    second(['--test-click=more']);
    await until(popOpen, 5000, 50);
    await until(async () => { const x = await pw(); return x && x.state.open.includes('bar') ? x : null; }, 5000, 100);
    s = await pw({ ev: { op: 'esc', swallowed: false } });
    check('Esc from another app goes to the bar\'s pop-up', s && s.result === 'bar', s);
    check('and closes it', !!(await until(async () => !(await popOpen()), 3000, 50)));

    // ---- switching away (lane mantle-m6): Alt+Tab is no click. The real foreground is never read in
    // a --test run (Owen's own switching would close it mid-test); made-up readings take the same road.
    second(['--test-click=more']);
    await until(popOpen, 5000, 50);
    await until(async () => { const x = await pw(); return x && x.state.open.includes('bar') ? x : null; }, 5000, 100);
    s = await pw();
    check('a --test run does not read the real foreground', !!s && s.state.watchingAway === false, s);
    s = await pw({ ev: { op: 'foreground', hwnd: 9101 } });          // the app in front when it opened
    check('the app that was in front: still open', s && s.result === 0 && await popOpen(), s);
    s = await pw({ ev: { op: 'foreground', hwnd: 9102, mine: true } });   // a Mantle window (Wi-Fi box, switcher)
    check('a Mantle window taking the keyboard: still open', s && s.result === 0 && await popOpen(), s);
    s = await pw({ ev: { op: 'foreground', hwnd: 9101 } });          // handed back
    check('the keyboard handed back to that app: still open', s && s.result === 0 && await popOpen(), s);
    s = await pw({ ev: { op: 'foreground', hwnd: 9103 } });          // Alt+Tab to another app
    check('a switch to another app closes the bar\'s pop-up', s && s.result === 1 && s.state.away >= 1, s);
    check('and it is gone, the watch off again', !!(await until(async () => { if (await popOpen()) return null; const x = await pw(); return x && x.state.open.length === 0 ? x : null; }, 3000, 50)));

    // ---- quick settings, the panel Owen opens most
    second(['--test-click=qs']);
    check('quick settings opens (the same test hook)', !!(await until(popOpen, 5000, 50)));
    const qs = await until(async () => { const x = await pw(); return x && x.state.open.includes('bar') ? x : null; }, 5000, 100);
    await sleep(600);   // the panel grows as its rows arrive: take the bar's rectangle once it has settled
    const qb = (await pw()).bar || (qs && qs.bar) || bar;
    const pt = { x: Math.max(0, qb.x - 40), y: qb.y + Math.round(qb.height / 2) };   // beside the bar: outside whatever its height
    s = await pw({ ev: { op: 'click', button: 'right', x: pt.x, y: pt.y }, dip: true });
    check('a right click outside closes quick settings', s && s.result === 1 && !!(await until(async () => !(await popOpen()), 3000, 50)), { s, pt });

    // ---- keys that carry an app's pin name (the right-click menu's jl:, the previews' app:): the
    // room is asked for the way those modules ask (the page's own bar.popover call), so the log
    // lines can be read. The page has no pop-up of its own open here, so an Esc's close is NOT
    // answered: main must take the room back by itself within 1 s (a hung or dead page can never
    // keep the bar pinned or Esc swallowed).
    await c.ev(`window.mantle.call('bar.popover', { open: true, height: 120, key: 'jl:Secret App.lnk' })`);
    await c.ev(`window.mantle.call('bar.popover', { open: true, height: 140, key: 'app:Secret App.lnk' })`);
    s = await until(async () => { const x = await pw(); return x && x.barPopover === 'window previews' && x.state.open.includes('bar') ? x : null; }, 5000, 100);
    check('a previews key is held as "window previews", and the watch is on', !!s, s || await pw());
    s = await pw({ ev: { op: 'esc' } });
    const back = await until(async () => { const x = await pw(); return x && x.barPopover === null && x.state.mode === null ? x : null; }, 3000, 100);
    check('Esc with a page that does not answer: main takes the room back within ~1 s, the watch goes off', s && s.result === 'bar' && !!back, back || await pw());
    await sleep(200);
    check('the log names the kinds ("right-click menu", "window previews"), never the keys',
      /bar\.popover open \(right-click menu,/.test(r.out) && /bar\.popover open \(window previews,/.test(r.out) && /bar pop-up \(window previews\) closed: Esc/.test(r.out) && !/Secret App/.test(r.out),
      (r.out.match(/.*(bar\.popover open|Secret).*/g) || []).slice(-3).join(' | '));
    check('the take-back is logged', /did not close its pop-up \(window previews\) within 1 s, so main took its room back/.test(r.out));
  } catch (e) {
    check('the run itself', false, e && e.stack || String(e));
  } finally {
    if (c) c.close();
    if (!r.exited) { second(['--quit']); await until(() => r.exited, 30000); }
    if (!r.exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    check('no bar.popover line logs a key with a file or app in it (app:, jl:, .lnk, .exe)', !/bar\.popover open \((app:|jl:)|bar\.popover[^\n]*\.(lnk|exe)/i.test(r.out), (r.out.match(/.*bar\.popover open.*/g) || []).slice(0, 3).join(' | '));
    check('the log says how pop-ups are watched', /pop-ups: a click outside them and Esc are watched by the sidecar/.test(r.out), (r.out.match(/.*pop-ups:.*/g) || []).join(' | ') || 'no pop-ups: line');
    check('no uncaught exception or handler failure', !/uncaught exception|handler threw|unhandled promise rejection/i.test(r.out),
      (r.out.match(/.*(uncaught exception|handler threw|unhandled promise rejection).*/i) || [''])[0]);
    try { fs.mkdirSync(path.join(os.tmpdir(), 'claude', 'mn-pop'), { recursive: true }); fs.writeFileSync(path.join(os.tmpdir(), 'claude', 'mn-pop', 'popclose-e2e.log'), r.out); } catch (_) { /* best effort */ }
  }
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`popclose e2e: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
