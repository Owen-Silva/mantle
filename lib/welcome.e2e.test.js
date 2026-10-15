'use strict';
// The CPU cap and the one-browser lock on Owen's PC; a CI runner (cloudtest) has neither file nor need.
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
/*
 * lib/welcome.e2e.test.js - the first-start welcome in REAL --test instances (lane mantle-firstrun,
 * 2026-10-15). Invisible like every --test window (lib/test-quiet.js); driven through CDP into Mantle's
 * own pages only. Five boots:
 *
 *   1. a FRESH profile with --first-run: the welcome comes (ui/welcome target), flag = pending.
 *      Stopped without an answer.
 *   2. the same profile again: still due ("not finished or skipped yet"). Keyboard: Enter, Right,
 *      Left through the real page; light and dark shots of all three cards; Esc = Skip, recorded,
 *      the window closes.
 *   3. the same profile again: NOT shown (sampled from the first frame for 5 s); Settings > About >
 *      Welcome tour "Show again" (the real Settings page's button) opens it; finishing on the last
 *      card records finished and closes it.
 *   4. an EXISTING profile (Mantle's own files already in it) with --first-run: no welcome target at
 *      any sample from the first frame for 5 s (and 3 s past the bar's load); flag = existing-profile.
 *   5. a plain --test run (no --first-run) on an empty profile: never shown, no flag written.
 *
 *   node lib/welcome.e2e.test.js   -> "WELCOME E2E: n passed, m failed" (exit 1 on any failure)
 * Shots go to MANTLE_SHOTS_DIR (default %TEMP%\mantle-welcome-shots) as real-<n>-<card>-<theme>.png.
 * Refuses while a game runs. Never sets MANTLE_TEST_VISIBLE. Every instance is stopped by
 * tools/kill-test.ps1 -Match <profile>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'welcome-e2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const FLAG = path.join(USER_DATA, 'first-run.json');
const SHOTS = path.resolve(process.env.MANTLE_SHOTS_DIR || path.join(os.tmpdir(), 'mantle-welcome-shots'));

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
const flag = () => { try { return JSON.parse(fs.readFileSync(FLAG, 'utf8')); } catch (_) { return null; } };
function wipe() { try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* in use? kill-test ran first */ } }

// electron.exe itself, spawned from THIS process, so lowcpu's hook sees a browser (theme.e2e's pattern)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)

function launch(extra) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null, t0: Date.now() };
  run.proc = spawn(ELECTRON, ['.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'].concat(extra || []),
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
function killTest() {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
}
async function stop(run) {
  killTest();
  await until(() => run.exited, 15000, 200);
  await sleep(500);
}
async function portOf() {
  return until(() => { try { const p = parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10); return p > 0 ? p : null; } catch (_) { return null; } }, 45000, 50);
}
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
const pageName = (u) => ((/\/ui\/([^?#]+)/.exec(u) || [])[1] || u).replace(/\/index\.html$/, '');
const find = async (port, name) => (await targets(port)).find((t) => pageName(t.url) === name) || null;
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await Promise.race([new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); }),
    sleep(10000).then(() => { throw new Error('CDP socket did not open in 10 s'); })]);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  // a window that closes (Skip, finish) ends its socket: every call still waiting fails instead of hanging
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the page went away')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { if (pend.delete(i)) rej(new Error(`${method}: no answer in 15 s`)); }, 15000);
    pend.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    try { ws.send(JSON.stringify({ id: i, method, params: params || {} })); } catch (e) { pend.delete(i); clearTimeout(t); rej(e); }
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { send, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const KEYS = { Enter: [13, 'Enter', '\r'], ArrowRight: [39, 'ArrowRight'], ArrowLeft: [37, 'ArrowLeft'], Escape: [27, 'Escape'] };
async function key(s, k) {
  const [vk, code, text] = KEYS[k];
  await s.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text, unmodifiedText: text });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).catch(() => {});   // the page may already be closing
  await sleep(260);   // past the 200 ms step animation
}
async function welcomePage(port, ms) {
  const t = await until(() => find(port, 'welcome'), ms || 20000, 100);
  if (!t) return null;
  const s = await attach(t);
  await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });   // keys reach the page with no OS focus
  await until(() => s.ev('document.documentElement.getAttribute("data-ready") === "1"'), 10000, 100);
  return s;
}
const stepOf = (s) => s.ev('document.documentElement.getAttribute("data-step")');
/** Sample the target list from the first frame: ms total, and at least `past` ms after the bar loaded. */
async function sampleNoWelcome(run, port, ms, past) {
  const t0 = Date.now();
  let samples = 0, seen = null, barAt = null;
  while (Date.now() - t0 < ms || (barAt === null && Date.now() - t0 < 30000) || (barAt !== null && Date.now() - barAt < past)) {
    const list = await targets(port).catch(() => []);
    samples++;
    if (list.some((t) => pageName(t.url) === 'welcome')) { seen = Date.now() - t0; break; }
    if (barAt === null && list.some((t) => pageName(t.url) === 'bar')) barAt = Date.now();
    await sleep(100);
  }
  return { samples, seen, ms: Date.now() - t0, barLoaded: barAt !== null };
}

async function main() {
  if (gaming()) { console.log('WELCOME E2E: skipped: a game is running'); console.log('WELCOME E2E: 0 passed, 0 failed'); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  killTest();
  wipe();
  let run = null;
  try {
    /* ---- 1. fresh profile: due; stopped halfway */
    console.log(`welcome-e2e: stage 1 at ${Math.round(process.uptime())} s`);
    run = launch(['--first-run']);
    let port = await portOf();
    check('1: the instance started', !!port, run.out.slice(-400));
    let s = port ? await welcomePage(port, 30000) : null;
    check('1: a fresh profile shows the welcome', !!s, run.out.slice(-600));
    check('1: main said why', /mantle: welcome: due: a brand-new profile/.test(run.out), run.out.slice(-600));
    check('1: the flag is pending while it is open', flag() && flag().state === 'pending', flag());
    if (s) s.close();
    await stop(run);

    /* ---- 2. a quit halfway brings it back; keys; shots; Esc */
    console.log(`welcome-e2e: stage 2 at ${Math.round(process.uptime())} s`);
    run = launch(['--first-run']);
    port = await portOf();
    s = port ? await welcomePage(port, 30000) : null;
    check('2: still due after a quit halfway', !!s && /not finished or skipped yet/.test(run.out), run.out.slice(-600));
    if (s) {
      check('2: card 1 first, Next has the keyboard', await stepOf(s) === 'changed' && await s.ev('document.activeElement.id') === 'next');
      await key(s, 'Enter');
      check('2: Enter goes to the keys card', await stepOf(s) === 'keys');
      const lines = await s.ev('[...document.querySelectorAll(".cline")].map((l) => l.textContent).join("|")');
      check('2: the keys card shows this instance\'s real corners', lines === 'Top-left:Task view|Bottom-right:Show desktop'
        && await s.ev('document.querySelector(".corners").getAttribute("data-live")') === '1', lines);
      await key(s, 'ArrowRight');
      check('2: Right arrow goes to the switch-back card', await stepOf(s) === 'back');
      await key(s, 'ArrowLeft');
      check('2: Left arrow goes back', await stepOf(s) === 'keys');
      // shots of every card, light then dark (theme.set is this test profile's own setting)
      const cards = ['changed', 'keys', 'back'];
      for (const theme of ['light', 'dark']) {
        await s.ev(`window.mantle.call('theme.set', { mode: '${theme}' }).then(() => true)`);
        const got = await until(() => s.ev(`document.documentElement.getAttribute('data-theme') === '${theme}'`), 5000, 100);
        check(`2: the welcome follows the theme live (${theme})`, !!got);
        for (let i = 0; i < 3; i++) {
          await s.ev(`document.querySelector('[data-act="step"][data-i="${i}"]').click()`);
          await sleep(300);
          const shot = await s.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
          if (shot && shot.data) fs.writeFileSync(path.join(SHOTS, `real-${i + 1}-${cards[i]}-${theme}.png`), Buffer.from(shot.data, 'base64'));
          check(`2: real shot of "${cards[i]}" (${theme})`, !!(shot && shot.data && shot.data.length > 2000));
        }
      }
      await s.ev('document.getElementById("next").focus()');
      await key(s, 'Escape');
      const f = await until(() => { const v = flag(); return v && v.state === 'done' ? v : null; }, 5000, 100);
      check('2: Esc skips: recorded done/skipped', f && f.how === 'skipped', flag());
      const gone = await until(async () => !(await find(port, 'welcome')), 5000, 100);
      check('2: the welcome window closes after Skip', !!gone);
      s.close();
    }
    await stop(run);

    /* ---- 3. answered: never again on start; Settings' "Show again"; finish */
    console.log(`welcome-e2e: stage 3 at ${Math.round(process.uptime())} s`);
    run = launch(['--first-run']);
    port = await portOf();
    const smp = await sampleNoWelcome(run, port, 5000, 3000);
    check(`3: after Skip it never shows on start (${smp.samples} samples over ${smp.ms} ms from the first frame)`, smp.seen === null && smp.samples >= 10 && smp.barLoaded, smp);
    check('3: main said why', /mantle: welcome: not shown: this profile is done with the welcome \(skipped/.test(run.out), run.out.slice(-500));
    const bar = await until(() => find(port, 'bar'), 10000, 100);
    if (bar) {
      const b = await attach(bar);
      await b.ev('window.mantle.call("settings.open", { section: "about" }).then(() => true, (e) => String(e))');
      b.close();
    }
    const st = await until(() => find(port, 'settings'), 20000, 150);
    check('3: Mantle Settings opened', !!st);
    if (st) {
      const ss = await attach(st);
      const btn = await until(() => ss.ev('!!document.querySelector(\'[data-row="about.welcome"] [data-act="welcome"]\')'), 15000, 150);
      check('3: Settings > About has "Welcome tour" with Show again', !!btn && /Welcome tour/.test(await ss.ev('(document.querySelector(\'[data-row="about.welcome"]\') || {}).textContent || ""')));
      if (btn) await ss.ev('document.querySelector(\'[data-row="about.welcome"] [data-act="welcome"]\').click()');
      ss.close();
    }
    s = await welcomePage(port, 15000);
    // main logs "shown" at ready-to-show, which can land just after the page says it is ready
    const shownLine = await until(() => /mantle: welcome: shown \(asked from Settings\)/.test(run.out), 5000, 100);
    check('3: Show again opens the welcome', !!s && !!shownLine, run.out.slice(-500));
    if (s) {
      await s.ev('document.getElementById("next").focus()');
      await key(s, 'Enter'); await key(s, 'Enter');
      check('3: on the last card the button is "Start using Mantle"', await s.ev('document.getElementById("next").textContent') === 'Start using Mantle');
      await key(s, 'Enter');
      const f = await until(() => { const v = flag(); return v && v.how === 'finished' ? v : null; }, 5000, 100);
      check('3: finishing records done/finished', !!f, flag());
      check('3: and closes the window', !!(await until(async () => !(await find(port, 'welcome')), 5000, 100)));
      s.close();
    }
    await stop(run);

    /* ---- 4. an existing profile: never, from the first frame */
    console.log(`welcome-e2e: stage 4 at ${Math.round(process.uptime())} s`);
    wipe();
    fs.mkdirSync(path.join(USER_DATA, 'features'), { recursive: true });
    fs.writeFileSync(path.join(USER_DATA, 'shell-state.json'), '{}');
    fs.writeFileSync(path.join(USER_DATA, 'theme.json'), '{"mode":"system"}');
    run = launch(['--first-run']);
    port = await portOf();
    const ex = await sampleNoWelcome(run, port, 5000, 3000);
    check(`4: an existing profile never shows it (${ex.samples} samples over ${ex.ms} ms from the first frame, bar loaded)`, ex.seen === null && ex.samples >= 10 && ex.barLoaded, ex);
    check('4: no welcome window was ever loaded', !/window loaded: welcome\//.test(run.out));
    check('4: main said why, naming the evidence', /mantle: welcome: not shown: this profile has been used \(shell-state\.json, theme\.json, features\)/.test(run.out), run.out.slice(-600));
    const fx = flag();
    check('4: the profile is marked existing-profile', fx && fx.state === 'done' && fx.how === 'existing-profile' && fx.evidence.length === 3, fx);
    await stop(run);

    /* ---- 5. a plain --test run: never, and nothing written */
    console.log(`welcome-e2e: stage 5 at ${Math.round(process.uptime())} s`);
    wipe();
    run = launch([]);
    port = await portOf();
    const pl = await sampleNoWelcome(run, port, 5000, 2000);
    check('5: a plain --test run never shows it', pl.seen === null && pl.barLoaded, pl);
    check('5: and writes no flag', flag() === null && !fs.existsSync(FLAG));
    check('5: main said why', /mantle: welcome: not shown: a test run without --first-run/.test(run.out), run.out.slice(-400));
    await stop(run);
    run = null;
  } finally {
    if (run) await stop(run);
    killTest();
    wipe();
  }
  console.log(`welcome: shots in ${SHOTS}`);
  console.log(`WELCOME E2E: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.log('WELCOME E2E: crashed: ' + (e && e.stack || e)); console.log(`WELCOME E2E: ${passed} passed, ${failures.length + 1} failed`); killTest(); process.exit(1); });
