'use strict';
/*
 * recover.e2e.test.js -- Mantle heals itself, in a REAL quiet --test instance (lane mn-recover, 2026-10-12;
 * audit #10, #11, #12, the volume pop-up crash, the Look Sync fallback toast).
 *
 * One invisible --test instance (lib/test-quiet.js), profile 'mnrecover', LOOK_SYNC_DIR = a fresh temp folder
 * holding a CORRUPT look.json, a short sidecar liveness check (MANTLE_TEST_SIDECAR_HEALTH) and a short hang
 * wait (MANTLE_TEST_PAGE_HANG_MS). Through CDP into its own pages and the Node inspector into its own main:
 *   1. look sync: the corrupt shared look is said once in the pop-up (ui/ontop page), with its reason;
 *   2. KILL: the test sidecar is ended by pid (taskkill /F, this instance's child only); the speaker glyph says
 *      "not being read" while it is down, then the volume / network / battery / window list come back from a
 *      NEW sidecar, and main says it read them again;
 *   3. HANG: the new sidecar is SUSPENDED (NtSuspendProcess, its pid only); the liveness check ends it, a new
 *      one starts, and the readouts come back;
 *   4. WAKE: powerMonitor 'resume' + 'unlock-screen' (emitted in main) re-arm and re-read everything, once;
 *   5. the volume pop-up page crashed (Page.crash): it is made again and its page loads;
 *   6. a HUNG bar (a busy loop + input): 'unresponsive', then its renderer is ended and the page reloaded;
 *   7. the bar crashed past the reload cap: the window shows the "stopped" page with the reason, not a blank;
 *   8. a launcher load that fails is tried again (1 s, 5 s) before the error page.
 *   node lib/recover.e2e.test.js   -> "RECOVER E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match mnrecover whatever happens; never touches
 * the live Mantle, its sidecar, or another lane's.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'mnrecover';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LS_DIR = path.join(os.tmpdir(), 'claude', 'mnrecover-e2e', 'ls');
const SIDECAR_DIR = path.join(ROOT, 'sidecar', 'bin').toLowerCase();

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''));
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

/** This instance's sidecar: a Mantle.Sidecar.exe from THIS worktree whose parent is this profile's electron. */
function sidecarPid() {
  const out = ps(`$e = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--profile-name=${PROFILE}') } | ForEach-Object { $_.ProcessId }); ` +
    `Get-CimInstance Win32_Process -Filter "Name='Mantle.Sidecar.exe'" | Where-Object { $e -contains $_.ParentProcessId } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`);
  const rows = out.split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).filter(([, p]) => p && p.toLowerCase().startsWith(SIDECAR_DIR));
  return rows.length === 1 ? Number(rows[0][0]) : null;
}

let koffiFns = null;
function suspend(pid) {
  if (!koffiFns) {
    const koffi = require('koffi');
    const k = koffi.load('kernel32.dll'); const n = koffi.load('ntdll.dll');
    koffiFns = {
      open: k.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      close: k.func('int __stdcall CloseHandle(void *h)'),
      suspend: n.func('int32_t __stdcall NtSuspendProcess(void *h)'),
    };
  }
  const h = koffiFns.open(0x0800, 0, pid);
  if (!h) return -1;
  try { return koffiFns.suspend(h); } finally { koffiFns.close(h); }
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, {
  LOOK_SYNC_DIR: LS_DIR,
  MANTLE_TEST_SIDECAR_HEALTH: '1500,700,2',
  MANTLE_TEST_PAGE_HANG_MS: '3000',
});
delete env.MANTLE_TEST_VISIBLE;
delete env.ELECTRON_RUN_AS_NODE;

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0', '--inspect=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:'));
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
const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;

async function pageOf(port, re, open) {
  const t = await until(async () => (await targets(port)).find((x) => re.test(x.url)), 30000, 300);
  if (!t) return null;
  const p = await attach(t.webSocketDebuggerUrl);
  open.push(p);
  const ready = await until(() => p.ev('document.readyState === "complete"'), 15000, 200);
  return ready ? Object.assign(p, { url: t.url, id: t.id }) : null;
}

(async () => {
  if (gaming()) { check('not run: a game is running', false); return finish(); }
  fs.rmSync(LS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LS_DIR, { recursive: true });
  fs.writeFileSync(path.join(LS_DIR, 'look.json'), '{"schema": 1, "rev": 3, "theme": "da');   // cut off mid-write
  for (const f of ['theme.json', 'look-sync.json']) { try { fs.unlinkSync(path.join(USER_DATA, f)); } catch (_) { /* none */ } }
  const run = launch();
  const open = [];
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-800))) return;
    const insp = /Debugger listening on (ws:\/\/\S+)/.exec(run.out);
    if (!check('main has an inspector', !!insp, run.out.slice(-800))) return;
    const main = await attach(insp[1]);
    open.push(main);
    const M = (body) => main.ev(`(async () => { const E = process.mainModule.require('electron'); ${body} })()`);
    let bar = await pageOf(port, /\/ui\/bar\/index\.html/, open);
    if (!check('the bar page is there', !!bar)) return;
    /* 1. look sync fallback toast (first: the pop-up lives 30 s in a --test run) */
    let toast = await until(async () => (await targets(port)).find((x) => /\/ui\/ontop\/index\.html/.test(x.url)), 12000, 300);
    if (!toast) {
      await bar.ev('window.mantle.call("look.sync", { on: true }).catch(() => null)');
      toast = await until(async () => (await targets(port)).find((x) => /\/ui\/ontop\/index\.html/.test(x.url)), 12000, 300);
    }
    if (check('look sync: a corrupt shared look opens the pop-up', !!toast, run.out.split('\n').filter((l) => /look/.test(l)).slice(-5).join(' | '))) {
      const tp = await attach(toast.webSocketDebuggerUrl); open.push(tp);
      const said = await until(async () => { const v = await tp.ev('({ text: document.getElementById("text").textContent, why: document.getElementById("why").textContent })'); return v && v.text ? v : null; }, 8000, 200);
      check('look sync: the pop-up says the shared look was reset, with look-sync\'s own reason', !!said && said.text === 'The shared look was reset' && /damaged/.test(said.why), said);
      check('look sync: the log names the state, not the reason', /look sync: the shared look is corrupt; a pop-up says why/.test(run.out) && !/look sync: .*damaged/.test(run.out));
      // the damaged copy was moved aside, so a later read is ok, and a new damage would be said again
      check('look sync: the damaged file was set aside and a healthy one written', fs.readdirSync(LS_DIR).some((f) => /^look\.json\.bad-/.test(f)) && (() => { try { JSON.parse(fs.readFileSync(path.join(LS_DIR, 'look.json'), 'utf8')); return true; } catch (_) { return false; } })());
    }

    const okSidecar = await until(() => sidecarPid(), 60000, 1000);
    check('the test sidecar is running (this instance\'s child, this worktree\'s exe)', !!okSidecar, run.out.slice(-600));

    /* the recorder: every readout the bar hears, with when */
    const REC = 'window.__rec = window.__rec || []; ["volume", "net", "battery", "windows"].forEach((n) => window.mantle.on(n, (p) => window.__rec.push({ n, ok: n === "windows" ? Array.isArray(p) : !!(p && p.ok !== false), at: Date.now() }))); true';
    await bar.ev(REC);
    const recSince = (t) => bar.ev(`window.__rec.filter((r) => r.at >= ${t})`);
    const base = await until(async () => { const r = await recSince(0); const has = (n) => r.some((x) => x.n === n && x.ok); return has('volume') && has('net') && has('windows') ? r : null; }, 30000, 500);
    check('before: volume, network and the window list were read', !!base, base);

    /* 2. KILL the test sidecar */
    const pid1 = sidecarPid();
    const rereads0 = count(run.out, /reading the bar's readouts again: the sidecar started again/);
    const t1 = await bar.ev('Date.now()');
    const k = spawnSync('taskkill', ['/PID', String(pid1), '/F'], { encoding: 'utf8' });
    check('kill: taskkill ended this instance\'s sidecar only', k.status === 0 && !!pid1, (k.stdout || '') + (k.stderr || ''));
    const downSaid = await until(async () => (await recSince(t1)).some((x) => x.n === 'volume' && !x.ok), 10000, 200);
    check('kill: while it is down the speaker glyph says it is not being read', !!downSaid);
    const back1 = await until(async () => {
      const r = await recSince(t1);
      const lastOk = (n) => { const l = r.filter((x) => x.n === n).pop(); return !!(l && l.ok); };
      return count(run.out, /reading the bar's readouts again: the sidecar started again/) > rereads0 && lastOk('volume') && lastOk('net') && r.some((x) => x.n === 'windows' && x.ok) ? r : null;
    }, 40000, 500);
    check('kill: volume, network and the window list come back from a new sidecar, and main read them again', !!back1, (await recSince(t1)).slice(-12));
    const pid2 = await until(() => { const p = sidecarPid(); return p && p !== pid1 ? p : null; }, 20000, 1000);
    check('kill: a NEW sidecar process runs', !!pid2, { pid1, pid2 });

    /* 3. HANG: suspend the new sidecar; the liveness check ends it */
    if (pid2) {
      const t2 = await bar.ev('Date.now()');
      const st = suspend(pid2);
      check('hang: NtSuspendProcess on this instance\'s sidecar', st === 0, `status ${st}`);
      const noticed = await until(() => /did not answer \d+ pings in a row/.test(run.out), 20000, 300);
      check('hang: the liveness check noticed and said why', !!noticed, run.out.slice(-600));
      const pid3 = await until(() => { const p = sidecarPid(); return p && p !== pid2 ? p : null; }, 30000, 1000);
      check('hang: a new sidecar process replaced the frozen one', !!pid3, { pid2, pid3 });
      const gone = ps(`@(Get-Process -Id ${pid2} -ErrorAction SilentlyContinue).Count`);
      check('hang: the frozen process is gone', gone === '0', gone);
      if (gone !== '0') spawnSync('taskkill', ['/PID', String(pid2), '/F']);
      const back2 = await until(async () => {
        const r = await recSince(t2);
        const lastOk = (n) => { const l = r.filter((x) => x.n === n).pop(); return !!(l && l.ok); };
        return lastOk('volume') && lastOk('net') ? r : null;
      }, 40000, 500);
      check('hang: volume and network come back after the restart', !!back2, (await recSince(t2)).slice(-10));
    }

    /* 4. WAKE: resume + unlock in main */
    const wakes0 = count(run.out, /reading the bar's readouts again: the PC woke up and the screen was unlocked\n/);
    const t4 = await bar.ev('Date.now()');
    await M('E.powerMonitor.emit("resume"); E.powerMonitor.emit("unlock-screen"); return true;');
    const woke = await until(() => count(run.out, /reading the bar's readouts again: the PC woke up and the screen was unlocked\n/) === wakes0 + 1, 12000, 300);
    check('wake: one re-read for the resume + unlock pair, 3 s after', !!woke, run.out.slice(-500));
    const wokeRec = await until(async () => (await recSince(t4)).some((x) => x.n === 'windows' && x.ok), 8000, 300);
    check('wake: the window list was read again', !!wokeRec);

    /* 5. the volume pop-up page crashes */
    const osd = await pageOf(port, /\/ui\/osd\/index\.html/, open);
    if (check('osd: the volume pop-up page is there', !!osd)) {
      osd.send('Page.crash').catch(() => { /* the page is gone: that is the point */ });
      const remade = await until(() => /volume pop-up: made again after the page crashed/.test(run.out), 30000, 300);
      check('osd: the crashed pop-up page is made again and loads', !!remade, run.out.split('\n').filter((l) => /osd|volume pop-up/.test(l)).slice(-5).join(' | '));
      const osd2 = await pageOf(port, /\/ui\/osd\/index\.html/, open);
      check('osd: a live pop-up page is there again', !!osd2 && osd2.id !== osd.id, osd2 && osd2.id);
    }

    /* 6. a HUNG bar */
    await bar.ev('setTimeout(() => { const t = Date.now(); while (Date.now() - t < 120000) { /* hung */ } }, 100); true');
    await sleep(500);
    // Chromium's hang monitor only runs for input that reaches a VISIBLE widget, and a --test window is
    // hidden (lib/test-quiet.js): the page really is stuck in a busy loop, and main hears 'unresponsive'
    // the way Electron delivers it, as an event on that webContents.
    const emitted = await M('const w = E.webContents.getAllWebContents().find((x) => /\\/ui\\/bar\\/index\\.html/.test(x.getURL())); if (w) w.emit("unresponsive"); return !!w;');
    check('hang: main told the bar\'s webContents it is unresponsive', emitted === true, emitted);
    const hungSaid = await until(() => /The bar stopped responding; its page is restarted/.test(run.out), 10000, 300);
    check('hang: the bar\'s page was seen to stop responding', !!hungSaid, run.out.slice(-400));
    const restarted = await until(() => /The bar did not respond for 3 s, so its page is restarted/.test(run.out) && /The bar's renderer died/.test(run.out), 20000, 300);
    check('hang: still stuck 3 s later, its renderer is ended and the death is handled', !!restarted, run.out.slice(-400));
    bar.close();
    bar = await until(async () => { const p = await pageOf(port, /\/ui\/bar\/index\.html/, open); return p && (await p.ev('!!window.mantle')) ? p : null; }, 30000, 500);
    check('hang: the bar page is back and alive', !!bar);

    /* 7. the bar crashes past the reload cap: the "stopped" page, never a blank window */
    // The reviver allows 3 reloads in 2 min; the hang above was the first death.
    let crashes = 0;
    while (bar && crashes < 5 && !/The bar shows a "stopped" page/.test(run.out)) {
      bar.send('Page.crash').catch(() => { /* the page is gone: that is the point */ });
      crashes++;
      await sleep(1000);
      bar.close();
      if (/The bar shows a "stopped" page/.test(run.out)) break;
      bar = await until(async () => { const p = await pageOf(port, /\/ui\/bar\/index\.html/, open); return p && (await p.ev('!!window.mantle')) ? p : null; }, 40000, 500);
      check(`cap: the bar is reloaded after crash ${crashes}`, !!bar);
    }
    const stopped = await pageOf(port, /\/ui\/shared\/page-stopped\.html/, open);
    if (check('cap: past the cap the bar shows the stopped page', !!stopped, run.out.split('\n').filter((l) => /The bar/.test(l)).slice(-4).join(' | '))) {
      const s = await stopped.ev('({ what: document.getElementById("what").textContent, why: document.getElementById("why").textContent, compact: document.body.classList.contains("compact") })');
      check('cap: it says what stopped and why, in the bar\'s compact form', s && s.what === 'The bar' && /crashed again and again/.test(s.why) && s.compact === true, s);
      check('cap: the log says so', /The bar shows a "stopped" page instead of a blank window/.test(run.out));
      // the theme plumbing (preload) reaches it and its colours are the --lg-* tokens, so it follows light and dark
      const look = await stopped.ev('(() => { const cs = getComputedStyle(document.getElementById("s")); return { theme: document.documentElement.getAttribute("data-theme"), ink: getComputedStyle(document.documentElement).getPropertyValue("--lg-ink").trim(), color: cs.color, bg: cs.backgroundColor }; })()');
      check('cap: the stopped page takes the theme and the --lg-* tokens', !!look && /^(dark|light)$/.test(look.theme || '') && !!look.ink && look.bg !== 'rgba(0, 0, 0, 0)', look);
    }

    /* 8. a launcher page that will not load is tried again first */
    const hasLauncher = await M('return E.webContents.getAllWebContents().some((x) => /\\/ui\\/launcher\\//.test(x.getURL()));');
    if (check('launcher: its page is there', !!hasLauncher)) {
      await M('const w = E.webContents.getAllWebContents().find((x) => /\\/ui\\/launcher\\//.test(x.getURL())); w.loadURL("file:///C:/mantle-recover-e2e-missing/none.html").catch(() => {}); return true;');
      const retried = await until(() => /The launcher did not load its page \([^)]*\); loading it again in 1 s \(try 1 of 3\)/.test(run.out) &&
        /The launcher did not load its page \([^)]*\); loading it again in 5 s \(try 2 of 3\)/.test(run.out), 15000, 300);
      check('launcher: a failed load is tried again at 1 s and 5 s', !!retried, run.out.split('\n').filter((l) => /launcher/i.test(l)).slice(-4).join(' | '));
    }

    /* the wake's second pass (20 s on), and the toast said only once */
    const second = await until(() => /reading the bar's readouts again: the PC woke up and the screen was unlocked, 20 s on/.test(run.out), 25000, 500);
    check('wake: the second, read-only pass ran 20 s on', !!second);
    check('look sync: the damage was said once', count(run.out, /look sync: the shared look is corrupt;/) === 1, count(run.out, /look sync: the shared look is corrupt;/));
    // main's own lines only: a page's console is forwarded as "mantle: [<page>] ..." (a renderer killed
    // mid-start logs Electron's own sandbox-bundle TypeError there)
    const mainLines = run.out.split('\n').filter((l) => !/^mantle: \[[^\]]+\] /.test(l)).join('\n');
    check('no main-process exception in the run', !/Uncaught Exception|UnhandledPromiseRejection|TypeError: /.test(mainLines), (mainLines.match(/.*(Uncaught Exception|UnhandledPromiseRejection|TypeError: ).*/) || [''])[0]);
  } catch (err) {
    check('the run did not throw', false, err && err.stack ? err.stack : String(err));
  } finally {
    for (const p of open) p.close();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    fs.writeFileSync(path.join(os.tmpdir(), 'claude', 'mnrecover-e2e', 'last-run.log'), run.out);
    finish();
  }
})();

function finish() {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`RECOVER E2E: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}
