'use strict';
/*
 * emoji.e2e.test.js - Mantle's emoji picker END TO END in a hidden --test Mantle of this checkout (lane
 * mantle-emoji2, 2026-10-15). Modelled on toasts.e2e.test.js: the instance is spawned with a DevTools
 * port, the bar page calls the feature's TEST-ONLY commands (emoji.testopen / testkey / teststate /
 * testclose / testdrop, lib/features/emoji.js), and the picker page is read over CDP.
 *
 *   node lib/features/emoji.e2e.test.js     -> "EMOJI E2E TEST: n passed, m failed"
 *
 * NOTHING REACHES OWEN: a --test instance draws nothing and takes no key (lib/test-quiet.js), its arm
 * never reads the real foreground (testArm), and every pick is a dry run (emoji.type dryRun:true).
 *
 * THE BUDGET: 10 opens COLD (the window destroyed first, testdrop) and 10 WARM (kept hidden after a
 * close), each timed from the open to the page's second frame with content (emoji.painted, the R7
 * line). Warm p50 and p95 <= 50 ms; cold p95 <= 400 ms. Plus the picker window's renderer RAM.
 * Also: the window's look (see-through, never focusable), the keys from the watch (Enter types and stays
 * open, Shift+Enter types and closes, Esc closes), and testdrop destroys the window.
 *
 * SKIPS, with the reason printed, and counts as no failure: on CI and when a game is running.
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'emojie2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const RUNS = 10;
const WARM_BUDGET = 50, COLD_P95_BUDGET = 400;

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }
function pct(xs, p) { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; }
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
  // a fresh profile, so the recents and the tone start empty
  try { fs.rmSync(path.join(USER_DATA, 'features', 'emoji.json'), { force: true }); } catch (_) { /* none */ }
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
const result = {};
async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  const g = gaming();
  if (g !== 0) { skipped = g > 0 ? 'a game is running' : 'could not check for a running game'; return; }

  const run = launch();
  const open = [];
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 45000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null; } catch (_) { return null; } }, 30000, 300);
    if (!check('the bar page is up (the feature commands are called from it)', !!barT, run.out.slice(-600))) return;
    const bar = await attach(barT); open.push(bar);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);
    const st = () => bar.ev(call('emoji.teststate'));

    const s0 = await until(async () => { const s = await st(); return s && s.opens === 0 && typeof s.hasWindow === 'boolean' ? s : null; }, 20000, 400);
    if (!check('emoji.teststate answers (the feature is installed and on in --test)', !!s0, await st())) return;
    check('no picker window before the first Win+. (made on demand)', s0.hasWindow === false, s0);
    await sleep(3000);   // the instance's own start-up settles first, so the first cold open is not timed against it

    /** one open, timed by main itself (S.t0 -> the page's emoji.painted) */
    async function openOnce(kind) {
      const before = (await st()).opens;
      const r = await bar.ev(call('emoji.testopen'));
      if (!r || r.opened !== true) return { err: r };
      const s = await until(async () => { const x = await st(); return x && x.opens === before + 1 && x.last && x.last.n === before + 1 && x.open ? x : null; }, 4000, 15);
      if (!s) return { err: { r, st: await st() } };
      return { painted: s.last.painted, interactive: s.last.interactive, shown: s.last.shown, warm: s.last.warm, s };
    }
    async function closeAndWait() {
      await bar.ev(call('emoji.testclose'));
      return until(async () => { const x = await st(); return x && !x.open && x.visible === false ? x : null; }, 3000, 20);
    }

    // ---- 10 cold opens: the window destroyed before each
    const cold = [], splits = [];
    let firstErr = null;
    for (let i = 0; i < RUNS; i++) {
      await bar.ev(call('emoji.testdrop'));
      await until(async () => { const x = await st(); return x && !x.hasWindow; }, 3000, 30);
      await sleep(250);
      const o = await openOnce('cold');
      if (o.err) { firstErr = firstErr || o.err; continue; }
      cold.push(o.interactive);
      if (o.s.last.split) splits.push(o.s.last.split);
      if (i === 0) result.firstCold = o;
      await closeAndWait();
    }
    check(`all ${RUNS} cold opens painted`, cold.length === RUNS, { n: cold.length, firstErr });
    // ---- the window as it stands (open, from the last cold run)
    const o1 = await openOnce('warm');
    const shown = o1.s || await st();
    check('the window is never focusable (the app keeps the keyboard)', shown.focusable === false, shown.focusable);
    check('the window is panel + 18 px each side (+-1 px of DIP rounding)', shown.bounds && Math.abs(shown.bounds.width - 396) <= 1 && Math.abs(shown.bounds.height - 460) <= 1, shown.bounds);
    const mem = shown.memory;
    check('the picker window\'s renderer: its own pid and RAM read', shown.pid > 0 && mem && mem.workingSetSize > 0, { pid: shown.pid, mem });
    result.mem = mem;

    // ---- the picker page over CDP: the keys as the sidecar's watch plays them (emoji.testkey)
    const pageT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/emoji\//.test(t.url)) || null; } catch (_) { return null; } }, 5000, 100);
    if (check('the picker page is reachable over CDP', !!pageT)) {
      const page = await attach(pageT); open.push(page);
      const ps = () => page.ev('({ open: window.__emoji.S.open, q: window.__emoji.S.q, tab: window.__emoji.S.tab, sel: window.__emoji.S.sel, n: window.__emoji.S.items.length, on: document.getElementById("panel").classList.contains("on") })');
      check('the page is open with the grid built', (await ps()).open && (await ps()).on && (await ps()).n > 1000, await ps());
      for (const ch of 'heart') await bar.ev(call('emoji.testkey', { key: ch, text: ch, shift: false }));
      const q = await until(async () => { const p = await ps(); return p.q === 'heart' ? p : null; }, 2000, 30);
      check('typed keys from the watch search ("heart")', !!q && q.n > 0, await ps());
      const r0 = (await st()).recents.length;
      await bar.ev(call('emoji.testkey', { key: 'Enter', shift: false }));
      const afterEnter = await until(async () => { const x = await st(); return x.recents.length === r0 + 1 ? x : null; }, 2000, 30);
      check('Enter types it (a dry run: in the recents) and the picker stays open', !!afterEnter && afterEnter.open === true, await st());
      await bar.ev(call('emoji.testkey', { key: 'ArrowRight', shift: false }));
      await bar.ev(call('emoji.testkey', { key: 'Enter', shift: true }));
      const afterShift = await until(async () => { const x = await st(); return !x.open ? x : null; }, 2000, 30);
      check('Shift+Enter types it and closes', !!afterShift && afterShift.recents.length === r0 + 2, await st());
      await until(async () => { const x = await st(); return x.visible === false ? x : null; }, 2000, 20);
      await openOnce('warm');
      await bar.ev(call('emoji.testkey', { key: 'Escape', shift: false }));
      const afterEsc = await until(async () => { const x = await st(); return !x.open ? x : null; }, 2000, 30);
      check('Esc closes it', !!afterEsc, await st());
      const pAfter = await until(async () => { const p = await ps(); return !p.on ? p : null; }, 2000, 30);
      check('... and the page plays its close (panel off)', !!pAfter, await ps());
      await until(async () => { const x = await st(); return x.visible === false ? x : null; }, 2000, 20);
      const reopened = await openOnce('warm');
      const p2 = await ps();
      check('a warm reopen starts fresh: emoji tab, empty search', !reopened.err && p2.q === '' && p2.tab === 'emoji', p2);
      await closeAndWait();
    }

    // ---- 10 warm opens: closed and hidden, kept
    const warm = [];
    for (let i = 0; i < RUNS; i++) {
      await sleep(200);
      const o = await openOnce('warm');
      if (o.err) { firstErr = firstErr || o.err; continue; }
      warm.push(o.interactive);
      await closeAndWait();
    }
    check(`all ${RUNS} warm opens painted`, warm.length === RUNS, { n: warm.length, firstErr });
    result.cold = cold; result.warm = warm;
    const cp50 = pct(cold, 50), cp95 = pct(cold, 95), wp50 = pct(warm, 50), wp95 = pct(warm, 95);
    if (splits.length) {
      const med = {};
      for (const k of Object.keys(splits[0])) med[k] = pct(splits.map((x) => x[k]).filter(Number.isFinite), 50);
      console.log(`info: cold open split, median ms after the press: ${Object.keys(med).map((k) => `${k} ${med[k]}`).join(', ')} (nav = renderer navigation start, script = emoji.js ran, loaded = dom-ready in main, show = the page got emoji.show, draw = its first draw)`);
    }
    console.log(`info: cold open -> painted: p50 ${cp50} ms, p95 ${cp95} ms  [${cold.join(', ')}]`);
    console.log(`info: warm open -> painted: p50 ${wp50} ms, p95 ${wp95} ms  [${warm.join(', ')}]`);
    if (mem) console.log(`info: picker window renderer: working set ${(mem.workingSetSize / 1024).toFixed(1)} MB, private ${(mem.privateBytes / 1024).toFixed(1)} MB (pid ${shown.pid})`);
    check(`warm open p50 <= ${WARM_BUDGET} ms`, wp50 <= WARM_BUDGET, { wp50, warm });
    check(`warm open p95 <= ${WARM_BUDGET} ms`, wp95 <= WARM_BUDGET, { wp95, warm });
    check(`cold open p95 <= ${COLD_P95_BUDGET} ms`, cp95 <= COLD_P95_BUDGET, { cp95, cold });

    // ---- the RAM rule: dropped means gone
    await bar.ev(call('emoji.testdrop'));
    const gone = await until(async () => { const x = await st(); return x && !x.hasWindow ? x : null; }, 3000, 50);
    check('testdrop (as the idle timer does) destroys the window: no window kept', !!gone, await st());

    const q = await bar.ev(call('shell.quit')).catch((e) => ({ threw: e.message }));
    const exited = await until(() => run.exited, 30000, 250);
    check('shell.quit: the instance exits by itself', !!exited, { q, tail: run.out.slice(-400) });
  } finally {
    for (const p of open) p.close();
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  if (skipped) console.log(`EMOJI E2E: skipped: ${skipped}`);
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`EMOJI E2E TEST: ${passed} passed, ${failures.length} failed${skipped ? ' (skipped: ' + skipped + ')' : ''}`);
  process.exit(failures.length ? 1 : 0);
});
