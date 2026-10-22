'use strict';
/*
 * tools/toast-latency.js - ARRIVAL-TO-BANNER time of Mantle's own notification banners (lane
 * mantle-toastfast, 2026-10-16), on a hidden --test Mantle of ANY checkout (so origin/master can be
 * measured with the same harness as a branch).
 *
 *   node tools/toast-latency.js --root=<checkout> [--label=before] [--cold=8] [--warm=15]
 *     -> "TOAST LATENCY <label> cold: p50 .. p95 .. max .. (n) | warm: ..." and "TOAST LATENCY <label>: done"
 *
 * Arrival = the moment just before Windows' Show() in the poster (tools/toast-poster.js: a throwaway
 * Mantle.ToastTest.fast* id, ShowBanner 0 BEFORE the first post, silent; removed at the end). Banner =
 * the moment the banner's title enters the banner page's DOM (a MutationObserver injected before the
 * page's own scripts through CDP auto-attach), stamped with Date.now(): the same system clock. The
 * window then shows on the next frame in a live Mantle; a --test instance never shows it (the user's screen
 * stays untouched), so that last frame is not in these numbers.
 * COLD = no banner window open (the harness waits for the idle close first); WARM = the window is open.
 * Runs BELOW NORMAL (children inherit it) under lowcpu.js; MANTLE_TEST_MIN_FREE_GB=0. Stops at once and
 * kills only the tree it started (by PID) if a Riot/VALORANT process shows up.
 */
require('./dev-env.js').lowcpu();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./toast-poster');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ROOT = path.resolve(arg('root', path.resolve(__dirname, '..')));
const LABEL = arg('label', path.basename(ROOT));
const COLD = Number(arg('cold', 8));
const WARM = Number(arg('warm', 15));
const JITTER = process.argv.includes("--jitter");   // random gaps between posts (a fixed gap can phase-lock with the sidecar poll)
const PROFILE = 'toastlat';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const RECORD = path.join(USER_DATA, 'notif-banners.json');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* lowcpu already did */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }
function riot() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process VALORANT*,RiotClient* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true });
  return parseInt((r.stdout || '').trim(), 10) || 0;
}
function gamingPause() {
  try { return /GAMING PAUSE/.test(fs.readFileSync(path.join(os.tmpdir(), 'claude-heavytest.mutex', 'owner.txt'), 'utf8')); } catch (_) { return false; }
}

// ---- CDP over the browser endpoint, flat sessions
async function cdp(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let n = 0;
  const pend = new Map();
  const handlers = [];
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); return; }
    if (j.method) for (const h of handlers) h(j);
  });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the DevTools connection closed')); pend.clear(); });
  // every command answers or fails within 15 s: a hang can never stall a hold
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const i = ++n;
    const t = setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error(`${method} did not answer within 15 s`)); } }, 15000);
    pend.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify(Object.assign({ id: i, method, params: params || {} }, sessionId ? { sessionId } : {})));
  });
  return { send, on: (h) => handlers.push(h), close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
// injected into every NEW page before its own scripts; only the banner page records anything
const STAMP = `(function () {
  if (!/\\/ui\\/toasts\\//.test(location.pathname) || window.__latOn) return;
  window.__latOn = 1;
  window.__toastLifeMs = 500;
  var seen = {}; window.__lat = [];
  new MutationObserver(function (recs) {
    var now = Date.now();
    for (var i = 0; i < recs.length; i++) for (var j = 0; j < recs[i].addedNodes.length; j++) {
      var t = recs[i].addedNodes[j].textContent || '';
      var m = /Mantle lat (\\d+)/.exec(t);
      if (m && !seen[m[1]]) {
        seen[m[1]] = 1; window.__lat.push({ k: Number(m[1]), at: now });
        if (typeof window.__latBinding === 'function') window.__latBinding(JSON.stringify({ k: Number(m[1]), at: now }));
      }
    }
  }).observe(document, { childList: true, subtree: true });
})();`;

(async () => {
  if (riot() || gamingPause()) { console.log(`TOAST LATENCY ${LABEL}: SKIPPED (a game is running or main says GAMING PAUSE)`); process.exit(0); }
  let run = null, c = null, poster = null, stopped = null;
  const res = { cold: [], warm: [], missed: 0 };
  try {
    try { fs.unlinkSync(RECORD); } catch (_) { /* none */ }
    try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none */ }
    // the id's Settings key exists (no value) before Mantle starts, so the instance takes it (writes 0)
    poster = await P.open({ takenBy: 'mantle' });
    const env = Object.assign({}, process.env, { MANTLE_TEST_MIN_FREE_GB: '0' });
    delete env.MANTLE_TEST_VISIBLE;
    const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
    run = { out: '', exited: null };
    run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    run.proc.stdout.on('data', (b) => { run.out += b.toString('utf8'); });
    run.proc.stderr.on('data', (b) => { run.out += b.toString('utf8'); });
    run.proc.on('exit', (code) => { run.exited = { code }; });
    const guard = setInterval(() => {
      if (stopped || !(riot() || gamingPause())) return;
      stopped = 'a Riot/VALORANT process (or GAMING PAUSE) appeared mid-run';
      spawnSync('taskkill', ['/PID', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
    }, 5000);
    guard.unref();
    // the whole run in 15 min or it stops itself (its own tree only, by PID); the finally still cleans up
    const watchdog = setTimeout(() => {
      if (stopped) return;
      stopped = 'the run took over 15 min (watchdog)';
      spawnSync('taskkill', ['/PID', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
      if (c) c.close();
    }, 15 * 60000);
    watchdog.unref();

    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 60000, 250);
    if (!port) throw new Error('the --test instance never opened its DevTools port: ' + run.out.slice(-400));
    c = await cdp(port);
    // pause every NEW page until the stamp script is in (the banner window is made on demand)
    // the page PUSHES each stamp (Runtime.addBinding): nothing polls the renderer being timed
    const stamps = new Map();
    c.on((j) => {
      if (j.method === 'Runtime.bindingCalled' && j.params.name === '__latBinding') {
        try { const x = JSON.parse(j.params.payload); if (!stamps.has(x.k)) stamps.set(x.k, x.at); } catch (_) { /* not ours */ }
        return;
      }
      // the page's document can exist before addScriptToEvaluateOnNewDocument lands (the 00:12 run: the
      // binding was in, the script was not), so the stamp also goes into each new main-world context the
      // moment Chromium reports it, before the page's own scripts run; __latOn keeps it to one install
      if (j.method === 'Runtime.executionContextCreated' && j.sessionId && j.params.context && j.params.context.auxData && j.params.context.auxData.isDefault) {
        c.send('Runtime.evaluate', { expression: STAMP, contextId: j.params.context.id }, j.sessionId).catch(() => {});
        return;
      }
      if (j.method !== 'Target.attachedToTarget') return;
      const sid = j.params.sessionId;
      const go = () => c.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
      if (j.params.targetInfo.type !== 'page') return void go();
      // SENT back to back, NOT awaited: a page paused at start may not answer Runtime commands until it
      // runs (the first hold hung here, 2026-10-17 00:08). CDP keeps one session's commands in order, so
      // the script and the binding are in before the resume is handled (Puppeteer's pattern).
      c.send('Page.addScriptToEvaluateOnNewDocument', { source: STAMP }, sid).catch(() => {});
      c.send('Runtime.addBinding', { name: '__latBinding' }, sid).catch(() => {});
      c.send('Runtime.enable', {}, sid).catch(() => {});
      go();
    });
    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const bar = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === 'page' && /\/ui\/bar\//.test(t.url)) || null;
    }, 30000, 300);
    if (!bar) throw new Error('no bar page: ' + run.out.slice(-400));
    const { sessionId: barS } = await c.send('Target.attachToTarget', { targetId: bar.id, flatten: true });
    const ev = async (sid, expr) => {
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
      if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.text || ''));
      return r.result.value;
    };
    const call = (cmd, a) => ev(barS, `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(a || {})}).then((r) => r, (e) => ({ ok: false, threw: String(e && e.message || e) }))`);
    await until(() => ev(barS, '!!(window.mantle && window.mantle.call)'), 15000, 200);
    const st = await until(async () => { const s = await call('toasts.state'); return s && s.ok && s.access ? s : null; }, 30000, 500);
    if (!st || st.access !== 'Allowed') throw new Error(`notification access is not Allowed (${st && st.access}): nothing to measure`);
    const taken = () => { try { const r = JSON.parse(fs.readFileSync(RECORD, 'utf8')); return !!(r.owned && Object.prototype.hasOwnProperty.call(r.owned, poster.aumid)) && poster.bannerOff(); } catch (_) { return false; } };
    let owned = await until(taken, 10000, 250);
    if (!owned) { await call('toasts.apply'); owned = await until(taken, 10000, 250); }
    if (!owned) throw new Error('the test instance never took the poster\'s id (no ShowBanner 0 from it), so nothing is posted');
    console.log(`  ${LABEL}: instance up, ${poster.aumid} taken; measuring ${COLD} cold + ${WARM} warm`);

    let k = 0;
    // the stamp the banner page pushed; on a timeout, ONE look at the page says "drawn but not stamped" or "never drawn"
    async function stampOf(key, ms) {
      const at = await until(() => stamps.get(key) || null, ms, 10);
      if (at) return { k: key, at };
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const pg = list.find((t) => t.type === 'page' && /\/ui\/toasts\//.test(t.url));
        if (!pg) return null;
        const s = (await c.send('Target.attachToTarget', { targetId: pg.id, flatten: true })).sessionId;
        try {
          return (await ev(s, `(window.__lat || []).filter(function (x) { return x.k === ${key}; })[0] || (document.body && /Mantle lat ${key}\\b/.test(document.body.textContent) ? { k: ${key}, at: 0 } : null)`)) || null;
        } finally { c.send('Target.detachFromTarget', { sessionId: s }).catch(() => {}); }
      } catch (_) { return null; }
    }
    async function sample(kind) {
      if (stopped) throw new Error(stopped);
      const key = ++k;
      const p = await poster.post(`Mantle lat ${key}`);
      const s = await stampOf(key, 6000);
      if (!s || !s.at) { res.missed++; console.log(`  ${kind} ${key}: ${s ? 'banner seen but not stamped (the page was made before the stamp script)' : 'no banner within 6 s'}`); return; }
      res[kind].push(s.at - p.before);
      console.log(`  ${kind} ${key}: ${Math.round(s.at - p.before)} ms (Show() took ${Math.round(p.after - p.before)} ms)`);
    }
    // COLD: no window open
    for (let i = 0; i < COLD; i++) {
      const gone = await until(async () => { const d = await call('toasts.debug'); return d && d.win === false; }, 60000, 500);
      if (!gone) { console.log('  the banner window never closed; cold sample skipped'); continue; }
      await sleep(JITTER ? 100 + Math.random() * 800 : 300);
      await sample('cold');
    }
    // WARM: one primer opens the window, then posts while it is open
    await poster.post(`Mantle lat ${++k}`); await stampOf(k, 6000);
    for (let i = 0; i < WARM; i++) {
      await sleep(JITTER ? 600 + Math.random() * 800 : 900);   // random gaps: a fixed one can phase-lock with the poll
      const d = await call('toasts.debug');
      if (!d || !d.win || !d.ready) { console.log('  the window was not open and ready; warm sample skipped'); continue; }
      await sample('warm');
    }
    const dbg = await call('toasts.debug');
    const sc = P.stats(res.cold), sw = P.stats(res.warm);
    console.log(`TOAST LATENCY ${LABEL} cold: p50 ${sc.p50} p95 ${sc.p95} max ${sc.max} min ${sc.min} (n ${sc.n}) | warm: p50 ${sw.p50} p95 ${sw.p95} max ${sw.max} min ${sw.min} (n ${sw.n}) | missed ${res.missed} | makes ${dbg && dbg.makes} prewarms ${dbg && dbg.prewarms !== undefined ? dbg.prewarms : 'n/a'} unused ${dbg && dbg.prewarmsUnused !== undefined ? dbg.prewarmsUnused : 'n/a'}`);
    console.log(`  raw cold: ${res.cold.map((x) => Math.round(x)).join(' ')}`);
    console.log(`  raw warm: ${res.warm.map((x) => Math.round(x)).join(' ')}`);
    const signal = run.out.split('\n').filter((l) => /early signal|made and loaded in|notification changes/.test(l)).slice(-6);
    console.log('  log: ' + signal.map((l) => l.trim().slice(0, 200)).join('\n  log: '));
    await call('shell.quit').catch(() => {});
    await until(() => run.exited, 20000, 250);
  } catch (e) {
    console.log(`TOAST LATENCY ${LABEL}: FAILED (${stopped || e.message})`);
    process.exitCode = 1;
  } finally {
    if (c) c.close();
    if (run && !run.exited) spawnSync('taskkill', ['/PID', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
    if (poster) await poster.close();
    try { fs.unlinkSync(RECORD); } catch (_) { /* none */ }
    console.log(`TOAST LATENCY ${LABEL}: done`);
    process.exit();
  }
})();
