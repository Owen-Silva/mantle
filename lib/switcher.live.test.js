'use strict';
/*
 * lib/switcher.live.test.js - the Alt+Tab list follows windows that open and close while it is up,
 * end to end in a REAL quiet --test Mantle (lane mn-alttab, 2026-10-12).
 *
 * One Electron --test instance (invisible: lib/test-quiet.js; its sidecar is passive, so there is no
 * keyboard hook and nothing is switched). Through CDP into its own pages only:
 *   1. switcher.rehearse {op:'open'}: a session on the live window list, with no keyboard, drawn by
 *      the real switcher page exactly as an Alt+Tab is (parked, never shown);
 *   2. this test's OWN windows (sidecar/alttab-probe.js: alpha 0, never activated, on no bar) open
 *      and close while it is up: each appears / leaves as a tile within half a second, every other
 *      tile stays the SAME element (in place, no flash), the selection stays on its window or moves
 *      to the neighbour when that one closed, and the window never gets smaller;
 *   3. the log says how many opened and closed, never which (no probe title in it).
 *
 *   node lib/switcher.live.test.js     -> "SWITCHER LIVE E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match mn-alttab whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Probe = require('../sidecar/alttab-probe');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'mn-alttab';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LOCK = path.join(os.tmpdir(), 'mantle-electron-lock');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(detail ? `${name} (${detail})` : name);
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
    await sleep(every || 50);
  }
}
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
delete env.MANTLE_SWITCHER_DRYRUN;

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'],
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
    if (r.exceptionDetails) throw new Error('page threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;
// the switcher page's tiles, by window handle (no titles leave the page)
const TILES = `[...document.querySelectorAll('#rows .tile')].map((t) => ({ hwnd: t.dataset.hwnd, born: t.__born || null, sel: t.classList.contains('is-sel'), isNew: t.classList.contains('is-new') }))`;

async function main() {
  if (gaming()) { console.log('a game is running: the switcher live e2e refuses to start an instance now'); check('not run: a game is running', false); return; }
  let locked = false;
  for (let i = 0; i < 960 && !locked; i++) { try { fs.mkdirSync(LOCK); locked = true; } catch (_) { await sleep(500); } }
  if (!locked) console.log('the Mantle electron lock was not free in 8 min: running anyway [LOCK NOT HELD]');
  let probe = null;
  const run = launch();
  const open = [];
  try {
    probe = await Probe.start();
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-600))) return;
    const st = await until(async () => (await targets(port)).find((t) => /\/ui\/switcher\/index\.html/.test(t.url)), 90000, 400);
    const bt = await until(async () => (await targets(port)).find((t) => /\/ui\/bar\/index\.html/.test(t.url)), 90000, 400);
    if (!check('the switcher and bar pages are there', !!st && !!bt)) return;
    const sw = await attach(st); open.push(sw);
    const bar = await attach(bt); open.push(bar);
    check('the switcher page said ready', !!(await until(() => /the switcher page is ready/.test(run.out), 60000, 200)));
    await sleep(1500);

    const o = await bar.ev(call('switcher.rehearse', { op: 'open' }));
    if (!check('a rehearsal Alt+Tab opens (no keyboard, passive sidecar)', o && o.ok && o.seq > 0 && o.hooks === 4, JSON.stringify(o && { ok: o.ok, seq: o.seq, hooks: o.hooks, reason: o.reason }))) return;
    const n0 = o.n;
    const drawn = await until(async () => { const t = await sw.ev(TILES); return t.length === n0 ? t : null; }, 4000);
    check(`the page draws it: one tile per window (${n0})`, !!drawn);
    await sw.ev(`(() => { [...document.querySelectorAll('#rows .tile')].forEach((t) => { t.__born = 'open'; });
      window.__rm = 0; window.__vw = [window.innerWidth]; window.__added = {};
      new MutationObserver((ms) => { const now = Date.now(); for (const m of ms) { for (const n of m.removedNodes) if (n.classList && n.classList.contains('tile')) window.__rm++;
        for (const n of m.addedNodes) if (n.classList && n.classList.contains('tile') && n.dataset && n.dataset.hwnd && !window.__added[n.dataset.hwnd]) window.__added[n.dataset.hwnd] = now; } })
        .observe(document.getElementById('rows'), { childList: true });
      window.addEventListener('resize', () => window.__vw.push(window.innerWidth));
      return true; })()`);

    // A opens while it is up
    let t0 = Date.now();
    const A = await probe.open(1);
    let tl = await until(async () => { const t = await sw.ev(TILES); return t.some((x) => x.hwnd === A) ? t : null; }, 3000);
    // Timed by the PAGE: the moment the tile element went into the list (a MutationObserver stamp), from
    // just before the window was asked to open. The test's own CDP polling (50 ms + an evaluate that
    // takes 100+ ms on a 2-vCPU runner) is not part of what the user sees (zero-fail lane, 2026-10-14:
    // the runner's 509 ms was mostly that).
    const addedAt = tl ? await sw.ev(`window.__added[${JSON.stringify(String(A))}] || 0`).catch(() => 0) : 0;
    const msA = addedAt ? addedAt - t0 : Date.now() - t0;
    console.log(`info: window open -> tile on the page ${msA} ms (${addedAt ? 'page stamp' : 'no stamp: the poll time'}); the poll saw it ${Date.now() - t0} ms after the open`);
    check(`a window that opens appears as a tile (${msA} ms, open -> on the page)`, !!tl, `probe ${A}`);
    check('...within half a second (open -> the tile is on the page, stamped by the page)', !!tl && !!addedAt && msA <= 500, `${msA} ms${addedAt ? '' : ' (no page stamp for the new tile)'}`);
    if (tl) {
      check('...every tile that was there is the same element (in place: nothing rebuilt, nothing flashes)', tl.filter((x) => x.hwnd !== A).every((x) => x.born === 'open') && (await sw.ev('window.__rm')) === 0, JSON.stringify({ removed: await sw.ev('window.__rm') }));
      check('...and only the new one animates in', tl.filter((x) => x.isNew).map((x) => x.hwnd).join() === A);
    }

    // select A, then B opens: the selection stays on A
    await bar.ev(call('switcher.rehearse', { op: 'select', hwnd: A }));
    const selA = await until(async () => (await sw.ev(TILES)).find((x) => x.sel && x.hwnd === A), 2000);
    check('the selection moves to the window asked for', !!selA);
    const B = await probe.open(2);
    tl = await until(async () => { const t = await sw.ev(TILES); return t.some((x) => x.hwnd === B) ? t : null; }, 3000);
    check('a second window appears', !!tl);
    check('...and the selection stays on the window it was on', !!tl && tl.filter((x) => x.sel).map((x) => x.hwnd).join() === A);

    // A (selected) closes: the neighbour
    tl = await sw.ev(TILES);
    const iA = tl.findIndex((x) => x.hwnd === A);
    const want = (tl[iA + 1] || tl[iA - 1] || {}).hwnd;
    await probe.close(1);
    tl = await until(async () => { const t = await sw.ev(TILES); return t.some((x) => x.hwnd === A) ? null : t; }, 3000);
    check('the selected window closes: its tile leaves', !!tl);
    check('...and the selection is on the neighbour that slid into its place', !!tl && tl.filter((x) => x.sel).map((x) => x.hwnd).join() === want, tl ? `sel ${tl.filter((x) => x.sel).map((x) => x.hwnd)}, want ${want}` : '');
    check('...the others are still the same elements', !!tl && tl.filter((x) => x.hwnd !== B).every((x) => x.born === 'open'));

    await probe.close(2);
    tl = await until(async () => { const t = await sw.ev(TILES); return t.some((x) => x.hwnd === B) ? null : t; }, 3000);
    check('the other window closes: gone too, back to the windows it opened with', !!tl && tl.length === n0, tl ? `${tl.length} vs ${n0}` : '');
    const vws = await sw.ev('window.__vw');
    check('the window never got smaller while it was up', vws.every((v, i) => i === 0 || v >= vws[i - 1]), JSON.stringify(vws));

    const s2 = await bar.ev(call('switcher.rehearse', { op: 'status' }));
    check('main drew every update (reflows counted on the session)', s2 && s2.page && s2.page.reflows >= 4 && s2.page.rehearsal, JSON.stringify(s2 && s2.page));
    const c = await bar.ev(call('switcher.rehearse', { op: 'close' }));
    check('closing the rehearsal takes every hook out', c && c.ok && c.closed === true && c.hooks === 0, JSON.stringify(c));
    check('...and the page is cleared', !!(await until(async () => (await sw.ev(TILES)).length === 0, 2000)));

    const lines = run.out.split(/\r?\n/).filter((l) => /the list changed while it was up/.test(l));
    check('the log says how many opened and closed', lines.some((l) => /1 opened, 0 closed/.test(l)) && lines.some((l) => /0 opened, 1 closed/.test(l)), `${lines.length} lines`);
    check('...and never which window (no probe title in the log)', !/Mantle Alt\+Tab probe/.test(run.out));
    const outside = await bar.ev(call('switcher.rehearse', { op: 'status' }));
    check('switcher.rehearse answers (test mode)', outside && outside.ok === true && outside.open === false, JSON.stringify(outside));
  } catch (err) {
    check('the e2e ran to the end', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
  } finally {
    for (const p of open) p.close();
    if (probe) probe.quit();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    if (locked) { try { fs.rmdirSync(LOCK); } catch (_) { /* gone */ } }
  }
}

main().then(() => {
  console.log(`SWITCHER LIVE E2E: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exitCode = failures.length || !passed ? 1 : 0;
});
