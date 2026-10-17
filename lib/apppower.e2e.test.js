'use strict';
/*
 * apppower.e2e.test.js -- App power end to end, in a REAL quiet --test instance (lane mantle-power-e2e,
 * 2026-10-14). The top bar's CPU / RAM dropdowns, main (lib/features/apppower.js + lib/apppower-core.js)
 * and the instance's own passive sidecar (sidecar/AppPower*.cs), driven through the page the way Owen
 * drives it: CDP mouse events and key events into the real topbar page, never a direct call.
 *
 * NEVER ON OWEN'S APPS. Two throwaway exes (sidecar/apppower-burner.js, compiled with csc into
 * %TEMP%\mantle-apppower-test\run-<id>\) are the only processes anything is applied to:
 *   - mpburn-<id>.exe, 2 spinning threads, named in MANTLE_APPPOWER_TEST_EXE for the instance: the
 *     only exe the feature sends for real, and the only one the passive sidecar will write to;
 *   - mpctl-<id>.exe (a copy of the same burner, touching ~1.2 GB so it sits in the RAM list): NOT
 *     allowed, so a change to it must come back as a test dry run and leave it as it was.
 * Both are killed by pid in the finally; the instance is stopped with tools/kill-test.ps1 -Match apppowere2e.
 *
 * Checks (one invisible --test instance, profile 'apppowere2e'; CDP into its pages, the Node inspector
 * into its main; a second passive sidecar of this worktree only READS the burners back, apppower.read):
 *   1. the burner's row arrives decorated (label, key, controls); through the real panel: Efficiency mode,
 *      then CPU limit 10% (CAP): read back (priority low/idle, throttling on, job CPU rate 10) from the sidecar
 *      AND from the burner's own report of itself; its CPU share over ~6 s windows before/after each
 *      step; the row's leaf and 10% badge; Remember on by default puts the rule in the instance's
 *      settings file; Back to normal hands it back (priority normal, throttling Windows-managed, no limit);
 *   2. the not-allowed exe: Lower memory priority through its panel replies dryRun and reads back unchanged;
 *   3. protected rows (System / Service Host / Mantle's own electron) say why and offer no controls;
 *   4. the window that hosts the dropdown, sampled from main every ~8 ms and the page every frame, grows
 *      before the panel unfolds and shrinks after it folds: never below where it started, no zero or
 *      odd frame, the dropdown never hidden (blink) or cut off, the panel inside the page once settled;
 *   5. keys through the real page: Down reaches the row, Enter opens its panel, Tab walks its controls,
 *      Esc (and separately Left) closes the panel with the menu still open, a second Esc closes the menu;
 *   6. Mantle Settings > App power lists the remembered rule with its summary; Remove empties it and the
 *      burner reads back normal; Undo puts it back (and the burner is limited again).
 *   node lib/apppower.e2e.test.js   -> "APPPOWER E2E: n passed, m failed"
 * Heavy (an Electron instance): run it in the cloud (cloudtest --recipe mantle-core -- node lib/apppower.e2e.test.js)
 * unless the laptop has >= 2.5 GB free. Refuses while a game runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const B = require('../sidecar/apppower-burner');
const T = require('../sidecar/test-lib');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'apppowere2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const RULES_FILE = path.join(USER_DATA, 'features', 'apppower.json');
const OUT_DIR = path.join(os.tmpdir(), 'claude', 'apppower-e2e');
const SIDECAR_EXE = path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
const NCPU = os.cpus().length;
const WINDOW_MS = 6000;
// the CPU limit picked in the panel: 10% of the whole CPU bites on a 2-thread burner (at most 2 of NCPU
// logical CPUs, 25% on 8); 25% did not, so it proved nothing about the limit itself
const CAP = 10;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700) : ''));
  return ok;
}
const info = (s) => console.log('info: ' + s);
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
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`no answer in ${ms} ms`); })]);
function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}
function gaming() { return (parseInt(ps('@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'), 10) || 0) > 0; }

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
function launch(env) {
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
async function pageOf(port, re, open, ms) {
  const t = await until(async () => (await targets(port)).find((x) => re.test(x.url)), ms || 30000, 300);
  if (!t) return null;
  const p = await attach(t.webSocketDebuggerUrl);
  open.push(p);
  const ready = await until(() => p.ev('document.readyState === "complete"'), 15000, 200);
  return ready ? Object.assign(p, { url: t.url, id: t.id }) : null;
}

/* ---- input through CDP (the test windows take no OS input: lib/test-quiet.js) ------------------------ */
const fallbacks = [];   // top bar clicks that did not land through CDP input and were made as DOM clicks instead
const softFallbacks = [];   // the same in Mantle Settings (a --test Settings window is never shown: said, not failed)
const J = JSON.stringify;
async function centerOf(p, sel) {
  return p.ev(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null; const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    return { x, y, inView: r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight }; })()`);
}
async function cdpClick(p, x, y) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
/** Click `sel` with CDP mouse events; `effect` (a page expression) must come true. A click that did not
 *  land is made again as a DOM click and remembered in `fallbacks` (its own check fails). */
async function clickEl(p, sel, effect, what, ms, soft) {
  const c = await centerOf(p, sel);
  if (c && c.inView) {
    try { await within(cdpClick(p, c.x, c.y), 4000); } catch (_) { /* said below through the fallback */ }
    const ok = await until(() => p.ev(effect), ms || 2500, 40);
    if (ok) return ok;
  }
  (soft ? softFallbacks : fallbacks).push(`${what}${c ? (c.inView ? '' : ' (out of view)') : ' (not found)'}`);
  await p.ev(`(() => { const el = document.querySelector(${J(sel)}); if (el) el.click(); return !!el; })()`);
  return until(() => p.ev(effect), ms || 2500, 40);
}
const VK = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Tab: 9, Escape: 27 };
async function press(p, k) {
  const base = { key: k, code: k, windowsVirtualKeyCode: VK[k], nativeVirtualKeyCode: VK[k] };
  await p.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await p.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  await sleep(70);
}

/* ---- the rules file ----------------------------------------------------------------------------------- */
function savedRules() {
  try {
    const v = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return Array.isArray(v.rules) ? v.rules : (v.settings && Array.isArray(v.settings.rules) ? v.settings.rules : []);
  } catch (_) { return null; }
}

(async () => {
  if (gaming()) { check('not run: a game is running', false); return finish(); }
  if (!check('this worktree\'s sidecar is built', fs.existsSync(SIDECAR_EXE), SIDECAR_EXE)) return finish();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try { fs.unlinkSync(RULES_FILE); } catch (_) { /* a fresh profile */ }

  /* the two throwaway exes */
  const rd = B.runDir();
  const id = rd.name.replace(/^mpburn-/, '');
  const NAME = rd.name;                  // mpburn-<id>: the one real target
  const CTL = 'mpctl-' + id;             // the not-allowed copy
  const pids = [];
  let run = null, rs = null, diagAtEnd = null;
  const open = [];
  try {
    const exeA = B.build(rd.dir, NAME);
    const exeC = path.join(rd.dir, CTL + '.exe');
    fs.copyFileSync(exeA, exeC);
    const A = B.start(exeA, ['spin', '2'], { life: 900 }); pids.push(A.pid);
    const C = B.start(exeC, ['touch', '1200'], { life: 900 }); pids.push(C.pid);
    rs = await T.startPassive({ exe: SIDECAR_EXE });
    const read = async (pid) => { const r = await rs.send('apppower.read', { pid }, 8000); return r.ok ? r.result : { error: r.error }; };
    const self = (b, pred, ms) => until(() => { const i = b.info(); return i && pred(i) ? i : null; }, ms || 8000, 150);
    async function cpuPct(pid, ms) {
      const a = await read(pid), t0 = Date.now();
      await sleep(ms);
      const b = await read(pid), t1 = Date.now();
      return +((100 * (b.cpuMs - a.cpuMs)) / ((t1 - t0) * NCPU)).toFixed(1);
    }
    const cpuLog = [];
    async function measure(label) { const pct = await cpuPct(A.pid, WINDOW_MS); cpuLog.push([label, pct]); info(`burner CPU, ${label}: ${pct}% of the whole CPU (${NCPU} logical, ${WINDOW_MS / 1000} s)`); return pct; }

    await self(A, (i) => i.rate > 0, 6000);
    await self(C, (i) => !!i, 6000);
    const a0 = await read(A.pid), c0 = await read(C.pid);
    // a CI runner starts every step's processes in its own job at below-normal priority (and memory
    // priority 2): "back to normal" is what each burner had before, read here
    const s0 = A.info() || {};
    info(`before: burner priority ${a0.priority} (${s0.prio}), memory priority ${a0.memPriority}, in a job: ${a0.inJob}; copy priority ${c0.priority}, memory priority ${c0.memPriority}`);
    check('before: the burner reads untouched (Windows-managed throttling, not low or idle, no CPU limit)', a0.exe === NAME && a0.eco === null && a0.priority !== 'low' && !a0.jobCpuRate && s0.thrCtl === 0, { a0, s0 });
    check('before: the not-allowed copy reads untouched', c0.exe === CTL && c0.eco === null && c0.priority !== 'low' && !c0.jobMemLimit, c0);
    const asBefore = (i) => i.prio === s0.prio && i.thrCtl === 0 && i.cpuFlags === 0;
    const readAsBefore = (r) => r.priority === a0.priority && r.eco === null && !r.jobCpuRate;

    /* the instance */
    // MANTLE_TOPBAR_TEST_PIN_FOCUS: the bar keeps its first app, so an app switch on the desktop during
    // the run cannot close the dropdown under the test (ui/topbar/focus-pin.test.js says why)
    const env = Object.assign({}, process.env, { MANTLE_APPPOWER_TEST_EXE: NAME, MANTLE_TOPBAR_TEST_PIN_FOCUS: '1' });
    delete env.MANTLE_TEST_VISIBLE;
    delete env.ELECTRON_RUN_AS_NODE;
    run = launch(env);
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-800))) return;
    const insp = /Debugger listening on (ws:\/\/\S+)/.exec(run.out);
    if (!check('main has an inspector', !!insp, run.out.slice(-800))) return;
    const main = await attach(insp[1]);
    open.push(main);
    const M = (body) => main.ev(`(async () => { const E = process.mainModule.require('electron'); ${body} })()`);
    const top = await pageOf(port, /\/ui\/topbar\/index\.html/, open, 90000);
    if (!check('the top bar page is there', !!top)) return;
    await top.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => null);

    // a passive recorder of the apppower.* replies, on main's own IPC handler (the call still goes through)
    const spy = await M(`const H = E.ipcMain && E.ipcMain._invokeHandlers; if (!H || typeof H.get !== 'function') return 'no handler table';
      const h = H.get('mantle:call'); if (!h) return 'no mantle:call handler'; if (h.__apSpy) return 'ok';
      global.__apRec = [];
      const w = async (e, name, args) => { const r = await h(e, name, args); if (/^apppower\\./.test(String(name))) global.__apRec.push({ name: String(name), args, r, at: Date.now() }); return r; };
      w.__apSpy = true; H.set('mantle:call', w); return 'ok';`).catch((e) => e.message);
    info(`main's reply recorder: ${spy}`);
    const replies = async (since) => (spy === 'ok' ? M(`return (global.__apRec || []).filter((x) => x.at >= ${since});`) : []);
    const hasDry = (r) => /"dryRun":true/.test(J(r));

    // page helpers: the rows (AppPower's own state, read only) and a mark on a row's element
    const rowsJs = `(() => { const P = window.AppPower && window.AppPower.state(); if (!P || !P.els) return null; const out = [];
      for (const [id, l] of P.last) { const e = l.e || {}; const it = P.els.rows.get(id); out.push({ id, key: e.key || null, label: e.label || null, name: e.name, exe: e.exe || null, n: e.n, ctl: e.ctl, why: e.why || null, test: e.test,
        set: e.set || null, dom: it ? { name: it.n.textContent, ctl: it.item.classList.contains('ctl'), sub: it.sub.textContent, exp: it.row.getAttribute('aria-expanded'), open: it.item.classList.contains('is-open'),
        lock: getComputedStyle(it.c.querySelector('svg + svg')).display !== 'none', marks: it.m.textContent, leaf: !!it.m.querySelector('.ap-mk.eco'), cap: (it.m.querySelector('.ap-mk.cap') || {}).textContent || null } : null }); }
      return out; })()`;
    const rows = () => top.ev(rowsJs);
    const rowOf = async (label) => ((await rows()) || []).find((r) => r.label === label && r.dom) || null;
    const mark = (label, tag) => top.ev(`(() => { const its = [...document.querySelectorAll('#menus .ap-item')]; its.forEach((it) => { if (it.dataset.e2e === ${J(tag)}) delete it.dataset.e2e; });
      const it = its.find((x) => { const t = x.querySelector('.ap-n').textContent; return t === ${J(label)} || t.startsWith(${J(label + ' (')}); }); if (it) it.dataset.e2e = ${J(tag)}; return !!it; })()`);
    const ITEM = (tag) => `#menus .ap-item[data-e2e="${tag}"]`;
    const isOpen = (tag) => `(() => { const it = document.querySelector(${J(ITEM(tag))}); return !!it && it.classList.contains('is-open') && it.classList.contains('open'); })()`;
    const isFolded = (tag) => `(() => { const it = document.querySelector(${J(ITEM(tag))}); return !!it && !it.classList.contains('is-open'); })()`;
    const menuOpen = (k) => `!!document.querySelector('.st[data-k="${k}"].open') && !!document.getElementById('menus').firstElementChild`;
    const openMenu = async (k) => {
      if (await top.ev(menuOpen(k))) return true;
      await until(() => top.ev(`!!document.querySelector('.st[data-k="${k}"]')`), 30000, 300);
      return clickEl(top, `.st[data-k="${k}"]`, menuOpen(k), `the ${k} meter`);
    };
    const closeMenus = async () => { for (let i = 0; i < 3 && (await top.ev('!!document.getElementById("menus").firstElementChild')); i++) await press(top, 'Escape'); };
    const awayFromList = () => top.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none' }).catch(() => null);

    // WHAT REACHED THE BAR (lane mantle-idlefix-race): every topbar.stats the page got (ms since the
    // recorder, its detail kind or "." or P:<pause reason>, the CPU top rows: count + d(ecorated)/u),
    // every close and blur, and main's answers to the page's detail asks and menu states. Said as info
    // lines when the dropdown or the burner's row does not come, so a failure names its step.
    await top.ev(`(() => { if (window.__apDiag) return true; const D = window.__apDiag = { t0: Date.now(), ev: [] };
      const add = (x) => { if (D.ev.length > 300) D.ev.shift(); D.ev.push([Date.now() - D.t0].concat(x)); };
      const rowsOf = (d) => d && Array.isArray(d.top) ? d.top.length + (d.top.some((e) => e && typeof e.ctl === 'boolean') ? 'd' : 'u') : '-';
      mantle.on('topbar.stats', (ev) => add([ev && ev.paused ? 'P:' + ev.reason : (ev && ev.detail) || '.', rowsOf(ev && ev.cpu)]));
      mantle.on('topbar.close', () => add(['CLOSE']));
      window.addEventListener('blur', () => add(['BLUR']));
      document.addEventListener('mousedown', (e) => add(['DOWN', String((e.target && e.target.className) || (e.target && e.target.tagName) || '').slice(0, 24)]), true);
      document.addEventListener('keydown', (e) => add(['KEY', e.key]), true);
      mantle.on('topbar.focus', (f) => add(['FOCUS', String((f && f.hwnd) || ''), f && f.self ? 'self' : '', f && f.fullscreen ? 'fs' : '']));
      return true; })()`).catch(() => null);
    const tbSpy = await M(`const H = E.ipcMain && E.ipcMain._invokeHandlers; if (!H || typeof H.get !== 'function') return 'no handler table';
      const h = H.get('mantle:call'); if (!h) return 'no mantle:call handler'; if (h.__tbSpy) return 'ok';
      global.__tbRec = []; global.__tbT0 = Date.now();
      const w = async (e, name, args) => { const t = Date.now(); const r = await h(e, name, args);
        if (/^topbar\\.(statsDetail|menuState)$/.test(String(name))) { if (global.__tbRec.length > 200) global.__tbRec.shift(); global.__tbRec.push([t - global.__tbT0, Date.now() - t, String(name).slice(7), JSON.stringify(args || null).slice(0, 50), JSON.stringify(r).slice(0, 90)]); }
        return r; };
      w.__tbSpy = true; w.__apSpy = h.__apSpy; H.set('mantle:call', w); return 'ok';`).catch((e) => e.message);
    async function barDiag(why) {
      const pg = await top.ev(`(() => { const S = window.__topbar || {}, D = window.__apDiag || { ev: [] }, c = S.stats && S.stats.cpu;
        return { open: S.open ? (S.open.stat || S.open.tool || 'title') : null, paused: S.paused || null, note: S.note || null, detail: (S.stats && S.stats.detail) || null,
          top: c && Array.isArray(c.top) ? c.top.length : null, decorated: !!(c && Array.isArray(c.top) && c.top.some((e) => e && typeof e.ctl === 'boolean')),
          ap: !!(window.AppPower && window.AppPower.state() && window.AppPower.state().els), ev: D.ev.slice(-300) }; })()`).catch((e) => ({ error: e.message }));
      const calls = tbSpy === 'ok' ? await M('return { t0: global.__tbT0, rec: (global.__tbRec || []).slice(-40) };').catch((e) => ({ error: e.message })) : { spy: tbSpy };
      info(`DIAG ${why}: page ${J(Object.assign({}, pg, { ev: undefined }))}`);
      info(`DIAG ${why}: page events [ms, detail|.|P:reason|CLOSE|BLUR, cpu rows]: ${J(pg && pg.ev)}`);
      info(`DIAG ${why}: main answers [ms, took, call, args, reply]: ${J(calls)}`);
      const said = run.out.split(/\r?\n/).filter((l) => /stepped aside|back from aside|stats|sidecar (exited|restart|died|crash|is not)|apppower|app power|NOT healthy/i.test(l)).slice(-15);
      info(`DIAG ${why}: instance log lines: ${J(said)}`);
    }
    diagAtEnd = barDiag;

    /* ================================================================ 1. the burner's row, decorated */
    if (!check('the CPU dropdown opens from its meter', !!(await openMenu('cpu')))) { await barDiag('the CPU dropdown did not open'); return; }
    const rowA = await until(async () => { const r = await rowOf(NAME); return r && r.key && r.dom ? r : null; }, 60000, 500);
    if (!rowA) await barDiag('no decorated burner row');
    if (!check('cpu: the burner\'s row arrives decorated by main (label, key, controls, test copy)', !!rowA && typeof rowA.key === 'string' && rowA.key.length > 0 && rowA.ctl === true && rowA.test === true && rowA.dom.ctl === true && rowA.dom.name === NAME && !rowA.dom.lock,
      rowA || ((await rows()) || []).map((r) => [r.label, r.ctl, r.why]))) return;
    const cpuRows = (await rows()) || [];
    info(`cpu rows: ${cpuRows.map((r) => `${r.label}${r.ctl ? '' : ' [' + r.why + ']'}`).join(' | ')}`);
    await mark(NAME, 'burner');

    const pBase = await measure('baseline (2 spinning threads)');

    /* ================================================================ 4a. the window grows, the panel unfolds */
    const SAMPLER = `const w = E.BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /\\/ui\\/topbar\\/index\\.html/.test(x.webContents.getURL()));
      if (!w) return 'no topbar window'; clearInterval(global.__apT); global.__apS = [];
      const one = () => { const b = w.getBounds(); global.__apS.push([Date.now(), b.x, b.y, b.width, b.height]); };
      one(); global.__apT = setInterval(one, 8); return 'ok';`;
    const PAGE_SAMPLER = `(() => { window.__apP = []; window.__apOn = true; const tick = () => { if (!window.__apOn) return;
        const dd = document.getElementById('menus').firstElementChild, it = document.querySelector(${J(ITEM('burner'))}), p = it && it.querySelector('.ap-p');
        const pr = p && p.getBoundingClientRect();
        window.__apP.push([Date.now(), innerHeight, dd ? dd.offsetTop + dd.offsetHeight : null, dd ? dd.classList.contains('wait') : null, dd ? getComputedStyle(dd).visibility : null,
          pr ? Math.round(pr.bottom) : null, pr ? Math.round(pr.height) : null, dd ? dd._growTo || 0 : null, dd ? dd.querySelectorAll('.ap-row').length : null, dd ? dd.offsetTop : null]);
        requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`;
    async function sampled(action, ms) {
      const sm = await M(SAMPLER);
      await top.ev(PAGE_SAMPLER);
      await sleep(120);
      const t0 = Date.now();
      const res = await action();
      await sleep(ms);
      const mainS = await M('clearInterval(global.__apT); return global.__apS;');
      const pageS = await top.ev('(() => { window.__apOn = false; return window.__apP; })()');
      return { sm, t0, res, mainS: mainS || [], pageS: pageS || [] };
    }
    const g1 = await sampled(() => clickEl(top, `${ITEM('burner')} .ap-row`, isOpen('burner'), 'the burner\'s row (open)'), 1200);
    check('cpu: a click on the burner\'s row opens its panel', !!g1.res);
    {
      const before = g1.mainS.filter((s) => s[0] < g1.t0), during = g1.mainS.filter((s) => s[0] >= g1.t0);
      const start = before.length ? before[before.length - 1] : g1.mainS[0];
      const hs = during.map((s) => s[4]);
      const maxH = Math.max(...hs), minH = Math.min(...hs), endH = hs[hs.length - 1];
      const odd = during.filter((s) => s[1] !== start[1] || s[2] !== start[2] || s[3] !== start[3] || s[4] <= 0 || s[3] <= 0);
      const pDuring = g1.pageS.filter((s) => s[0] >= g1.t0);
      const hidden = pDuring.filter((s) => s[3] === true || s[4] === 'hidden');
      const cut = pDuring.filter((s) => s[3] !== true && s[2] != null && s[2] > s[1] + 1);
      const settled = pDuring.filter((s) => s[0] >= g1.t0 + 700);
      const out = settled.filter((s) => s[5] == null || s[5] > s[1]);
      info(`unfold: window ${start[3]}x${start[4]} -> max ${maxH}, end ${endH}, min during ${minH}; ${during.length} main samples (${g1.sm}), ${pDuring.length} page frames; dropdown hidden in ${hidden.length}, cut off in ${cut.length}; panel outside the page in ${out.length} of ${settled.length} settled frames`);
      check('grow: the window was sampled from main through the unfold', g1.sm === 'ok' && during.length >= 20, { sm: g1.sm, n: during.length });
      check('grow: the window grew for the panel', maxH > start[4] && endH > start[4], { start: start[4], maxH, endH });
      check('grow: it never shrank below its starting height during the unfold', minH >= start[4], { start: start[4], minH });
      check('grow: no zero or odd frame (same x, y and width; height > 0)', odd.length === 0, odd.slice(0, 5));
      check('grow: the dropdown never blinked out while the panel unfolded (never .wait / hidden)', pDuring.length >= 10 && hidden.length === 0, { frames: pDuring.length, hidden: hidden.slice(0, 5),
        // the frames around the first one (time from the click, window inner height, dropdown bottom, .wait, visibility,
        // panel bottom, panel height, the dropdown's _growTo, its rows, its top)
        around: hidden.length ? pDuring.slice(Math.max(0, pDuring.indexOf(hidden[0]) - 3), pDuring.indexOf(hidden[0]) + 3).map((x) => [x[0] - g1.t0].concat(x.slice(1))) : [] });
      check('grow: the dropdown was never cut off by the window during the unfold', cut.length === 0, cut.slice(0, 5));
      check('grow: once settled the panel\'s bottom is inside the page at every frame', settled.length >= 5 && out.length === 0, { settled: settled.length, out: out.slice(0, 5) });
      g1.start = start;
    }
    await sleep(300);
    check('cpu: Remember for this app is on by default', (await top.ev(`(() => { const c = document.querySelector(${J(ITEM('burner') + ' .ap-ck')}); return c && c.getAttribute('aria-checked'); })()`)) === 'true');

    /* ================================================================ 1. Efficiency mode, through the panel */
    let tR = Date.now();
    const ecoOn = await clickEl(top, `${ITEM('burner')} .ap-sw[data-f="eco"]`, `(() => { const s = document.querySelector(${J(ITEM('burner') + ' .ap-sw[data-f="eco"]')}); return s && s.getAttribute('aria-checked') === 'true'; })()`, 'Efficiency mode');
    check('eco: the switch shows on', !!ecoOn);
    const iEco = await self(A, (i) => i.prio === 0x40 && i.thrCtl === 1 && i.thrState === 1, 10000);
    const rEco = await read(A.pid);
    check('eco: the burner sees itself at IDLE priority with power throttling on (its own report)', !!iEco, A.info());
    check('eco: the sidecar reads it back (priority low, throttling on)', rEco.priority === 'low' && rEco.eco === true, rEco);
    const repEco = (await replies(tR)).filter((x) => x.name === 'apppower.set');
    if (spy === 'ok') check('eco: main answered ok, a REAL write (no dry run) for the allowed burner', repEco.length >= 1 && repEco.every((x) => x.r && x.r.ok !== false && !hasDry(x.r)), repEco.map((x) => x.r));
    const leaf = await until(async () => { const r = await rowOf(NAME); return r && r.dom.leaf ? r : null; }, 5000, 200);
    check('eco: the row shows the leaf', !!leaf);
    const pEco = await measure('Efficiency mode');

    /* ================================================================ 1. CPU limit (CAP) */
    tR = Date.now();
    const capOn = await clickEl(top, `${ITEM('burner')} [data-f="cpuCap"] [data-v="${CAP}"]`, `(() => { const b = document.querySelector(${J(ITEM('burner') + ` [data-f="cpuCap"] [data-v="${CAP}"]`)}); return b && b.getAttribute('aria-checked') === 'true'; })()`, `CPU limit ${CAP}%`);
    check(`cap: ${CAP}% shows picked`, !!capOn);
    const iCap = await self(A, (i) => i.inJob === true && i.cpuFlags === 5 && i.cpuRate === CAP * 100, 10000);
    const rCap = await read(A.pid);
    check(`cap: the burner sees ENABLE|HARD_CAP at ${CAP * 100} in its own job (its own report)`, !!iCap, A.info());
    check(`cap: the sidecar reads back job CPU rate ${CAP}, still low priority with throttling on`, rCap.jobCpuRate === CAP && rCap.inJob === true && rCap.priority === 'low' && rCap.eco === true, rCap);
    const repCap = (await replies(tR)).filter((x) => x.name === 'apppower.set');
    if (spy === 'ok') check('cap: main answered ok, a REAL write for the allowed burner', repCap.length >= 1 && repCap.every((x) => x.r && x.r.ok !== false && !hasDry(x.r)), repCap.map((x) => x.r));
    const badge = await until(async () => { const r = await rowOf(NAME); return r && r.dom.leaf && r.dom.cap === `CPU ${CAP}%` ? r : null; }, 5000, 200);
    check(`cap: the row shows the leaf and the ${CAP}% badge`, !!badge, await rowOf(NAME));
    const pCap = await measure(`Efficiency mode + CPU limit ${CAP}%`);
    check(`cap: the burner runs under its ${CAP}% limit (6 s of process times)`, pCap <= CAP + 3.5, { pCap });
    check('cap: the limit cut its CPU from the baseline', pBase > CAP + 5 ? pCap < pBase - 4 : true, { pBase, pCap });

    /* remember: the rule in the instance's settings file */
    const saved = await until(() => { const l = savedRules(); const r = l && l.find((x) => String(x.exe || '').toLowerCase() === NAME); return r && r.set && r.set.eco && r.set.cpuCap === CAP ? r : null; }, 5000, 200);
    check(`remember: the rule is in the instance's settings file (features/apppower.json) with Efficiency mode and the ${CAP}% limit`, !!saved, savedRules());

    /* ================================================================ 4b. the panel folds, the window shrinks after */
    const g2 = await sampled(() => clickEl(top, `${ITEM('burner')} .ap-row`, isFolded('burner'), 'the burner\'s row (fold)'), 1200);
    check('cpu: a second click folds the panel', !!g2.res);
    {
      const during = g2.mainS.filter((s) => s[0] >= g2.t0), start = g2.mainS.filter((s) => s[0] < g2.t0).pop() || g2.mainS[0];
      const hs = during.map((s) => s[4]), endH = hs[hs.length - 1];
      const odd = during.filter((s) => s[1] !== start[1] || s[2] !== start[2] || s[3] !== start[3] || s[4] <= 0);
      const pDuring = g2.pageS.filter((s) => s[0] >= g2.t0);
      const cut = pDuring.filter((s) => s[3] !== true && s[2] != null && s[2] > s[1] + 1);
      const hidden = pDuring.filter((s) => s[3] === true || s[4] === 'hidden');
      info(`fold: window ${start[4]} -> end ${endH} (before the unfold it was ${g1.start[4]}), min ${Math.min(...hs)}; ${during.length} main samples, ${pDuring.length} page frames; cut off in ${cut.length}, hidden in ${hidden.length}` +
        (hidden.length ? ` at +${hidden.map((x) => x[0] - g2.t0).join('/')} ms (main heights then: ${hidden.map((x) => (during.filter((m) => Math.abs(m[0] - x[0]) <= 24).map((m) => m[4]).join(','))).join(' / ')})` : ''));
      check('fold: the window shrank back after the panel folded', endH < start[4] && endH <= g1.start[4] + 40, { open: start[4], endH, before: g1.start[4] });
      check('fold: no zero or odd frame', odd.length === 0, odd.slice(0, 5));
      check('fold: the window never cut the dropdown off while it folded, nor hid it', pDuring.length >= 10 && cut.length === 0 && hidden.length === 0, { frames: pDuring.length, cut: cut.slice(0, 5), hidden: hidden.slice(0, 5) });
    }

    /* ================================================================ 5. keys through the real page */
    await awayFromList();
    await sleep(150);
    let hotOk = null;
    for (let i = 0; i < 8 && !hotOk; i++) {
      await press(top, 'ArrowDown');
      hotOk = await top.ev(`(() => { const it = document.querySelector(${J(ITEM('burner'))}); return !!it && it.classList.contains('hot') && document.activeElement === it.querySelector('.ap-row'); })()`);
    }
    check('keys: Down reaches the burner\'s row (highlighted, focused)', !!hotOk);
    await press(top, 'Enter');
    const kOpen = await until(() => top.ev(`(() => { const it = document.querySelector(${J(ITEM('burner'))}); return !!it && it.classList.contains('is-open') && it.querySelector('.ap-p').contains(document.activeElement); })()`), 2000, 40);
    check('keys: Enter opens its panel and puts the focus in it', !!kOpen);
    const focusOf = `(() => { const a = document.activeElement; if (!a) return null; const g = a.closest('[data-f]'); return (g ? g.dataset.f : a.tagName) + (a.dataset.v != null ? '=' + a.dataset.v : ''); })()`;
    await sleep(300);
    const stops = [await top.ev(focusOf)];
    await press(top, 'Tab'); stops.push(await top.ev(focusOf));
    await press(top, 'Tab'); stops.push(await top.ev(focusOf));
    info(`keys: Tab walked ${stops.join(' -> ')}`);
    check('keys: Tab moves through the panel\'s controls (Efficiency mode -> Priority -> CPU limit)', /^eco/.test(stops[0] || '') && /^priority/.test(stops[1] || '') && /^cpuCap/.test(stops[2] || ''), stops);
    await press(top, 'Escape');
    const kEsc = await until(() => top.ev(`(() => { const it = document.querySelector(${J(ITEM('burner'))}); return !!it && !it.classList.contains('is-open') && document.activeElement === it.querySelector('.ap-row') && ${menuOpen('cpu')}; })()`), 2000, 40);
    check('keys: Esc closes the panel, the menu stays open, the focus back on the row', !!kEsc);
    await sleep(300);
    await press(top, 'Enter');
    const kOpen2 = await until(() => top.ev(isOpen('burner')), 2000, 40);
    await sleep(300);
    await press(top, 'ArrowLeft');
    const kLeft = await until(() => top.ev(`(() => { const it = document.querySelector(${J(ITEM('burner'))}); return !!it && !it.classList.contains('is-open') && ${menuOpen('cpu')}; })()`), 2000, 40);
    check('keys: Enter opens it again and Left closes it, the menu still open', !!kOpen2 && !!kLeft, { kOpen2, kLeft });
    await sleep(300);
    await press(top, 'Escape');
    const kGone = await until(() => top.ev('!document.querySelector(".st.open") && !document.getElementById("menus").firstElementChild'), 2000, 40);
    check('keys: a second Esc closes the menu', !!kGone);

    /* ================================================================ 6. Mantle Settings > App power */
    await top.ev(`window.mantle.call('settings.open', { section: 'apppower' }).then(() => true, () => false)`);
    const sp = await pageOf(port, /\/ui\/settings\/index\.html/, open, 30000);
    if (check('settings: Mantle Settings opened on App power', !!sp)) {
      await sp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => null);
      const RROW = `[data-row="apppower.rules.${NAME}"]`;
      const ruleRows = `[...document.querySelectorAll('[data-row^="apppower.rules."]')].map((r) => ({ row: r.dataset.row, label: r.querySelector('.row-t').textContent, help: (r.querySelector('.row-h') || {}).textContent || '' }))`;
      const listed = await until(async () => { const l = await sp.ev(ruleRows); const r = l.find((x) => x.label === NAME); return r ? Object.assign(r, { all: l.length }) : null; }, 20000, 300);
      check('settings: the remembered rule is listed with its summary', !!listed && /Efficiency mode/.test(listed.help) && new RegExp(`CPU limit ${CAP}%`).test(listed.help) && !/Only until Mantle restarts/.test(listed.help), listed || await sp.ev(ruleRows));
      const removed = await clickEl(sp, `${RROW} button`, `(() => { const b = document.querySelector(${J(RROW + ' button')}); return !b || b.disabled; })()`, 'Settings: Remove', 4000, true);
      const empty = await until(async () => ((await sp.ev(ruleRows)).length === 0 ? true : null), 8000, 200);
      check('settings: Remove empties the list', !!removed && !!empty, await sp.ev(ruleRows));
      const iOff = await self(A, asBefore, 10000);
      const rOff = await read(A.pid);
      check('settings: after Remove the burner reads back as it was (its own report and the sidecar)', !!iOff && readAsBefore(rOff), { self: A.info(), read: rOff });
      check('settings: the rule left the settings file', ((savedRules() || []).filter((x) => String(x.exe || '').toLowerCase() === NAME)).length === 0, savedRules());
      const undone = await clickEl(sp, '[data-row="apppower.undo"] button', `(() => { const b = document.querySelector('[data-row="apppower.undo"] button'); return !b || b.disabled; })()`, 'Settings: Undo', 4000, true);
      const back = await until(async () => { const l = await sp.ev(ruleRows); return l.find((x) => x.label === NAME && new RegExp(`CPU limit ${CAP}%`).test(x.help)) || null; }, 8000, 200);
      check('settings: Undo puts the rule back', !!undone && !!back, await sp.ev(ruleRows));
      const iBack = await self(A, (i) => i.prio === 0x40 && i.thrCtl === 1 && i.cpuFlags === 5 && i.cpuRate === CAP * 100, 10000);
      const rBack = await read(A.pid);
      check(`settings: after Undo the burner is limited again (idle, throttled, ${CAP}%)`, !!iBack && rBack.jobCpuRate === CAP && rBack.eco === true, { self: A.info(), read: rBack });
      check('settings: the rule is back in the settings file', !!(savedRules() || []).find((x) => String(x.exe || '').toLowerCase() === NAME && x.set && x.set.cpuCap === CAP), savedRules());
    }

    /* ================================================================ 1. Back to normal from the panel */
    if (await openMenu('cpu')) {
      // the dropdown can open on the last sample it kept (from before Undo) and repaint on the fresh one a moment
      // later: wait for the row to show the restored rule, and keep the last row seen for the failure line
      let lastRow = null;
      const again = (await until(async () => { const r = await rowOf(NAME); if (r && r.dom) lastRow = r; return r && r.dom && r.dom.leaf && r.dom.cap === `CPU ${CAP}%` ? r : null; }, 15000, 300)) || lastRow;
      if (check('cpu: the burner\'s row is there again with its leaf and badge', !!again && again.dom.leaf && again.dom.cap === `CPU ${CAP}%`, again)) {
        await mark(NAME, 'burner');
        await clickEl(top, `${ITEM('burner')} .ap-row`, isOpen('burner'), 'the burner\'s row (open again)');
        await sleep(400);
        tR = Date.now();
        const lnk = `${ITEM('burner')} .ap-lnk[data-f="reset"]`;
        const reset = await clickEl(top, lnk, `(() => { const l = document.querySelector(${J(lnk)}); return !l || l.disabled || l.hidden; })()`, 'Back to normal');
        check('reset: Back to normal is offered and takes the click', !!reset);
        const iN = await self(A, asBefore, 10000);
        const rN = await read(A.pid);
        check('reset: the burner reads back as it was (its own priority, throttling Windows-managed, limit cleared)', !!iN && readAsBefore(rN), { self: A.info(), read: rN });
        const plain = await until(async () => { const r = await rowOf(NAME); return r && !r.dom.leaf && !r.dom.cap ? r : null; }, 5000, 200);
        check('reset: the row shows no leaf or badge', !!plain, await rowOf(NAME));
        check('reset: the rule left the settings file', ((savedRules() || []).filter((x) => String(x.exe || '').toLowerCase() === NAME)).length === 0, savedRules());
        const pN = await measure('after Back to normal');
        check('reset: its CPU came back above the limit', pBase > CAP + 5 ? pN > CAP + 3.5 : true, { pBase, pN });
      }
      await closeMenus();
    }
    info(`burner CPU through the real UI: ${cpuLog.map(([l, p]) => `${l} ${p}%`).join('; ')}`);

    /* ================================================================ 2 + 3. the RAM list: the not-allowed copy, the protected rows */
    if (check('the RAM dropdown opens from its meter', !!(await openMenu('mem')))) {
      const rowC = await until(async () => { const r = await rowOf(CTL); return r && r.key && r.dom ? r : null; }, 20000, 400);
      const memRows = (await rows()) || [];
      info(`ram rows: ${memRows.map((r) => `${r.label}${r.ctl ? '' : ' [' + r.why + ']'}`).join(' | ')}`);
      if (check('ram: the not-allowed copy\'s row is there with controls (a test copy)', !!rowC && rowC.ctl === true && rowC.test === true, rowC)) {
        await mark(CTL, 'ctl');
        await clickEl(top, `${ITEM('ctl')} .ap-row`, isOpen('ctl'), 'the copy\'s row (open)');
        await sleep(400);
        const note = await top.ev(`(() => { const t = document.querySelector(${J(ITEM('ctl') + ' .ap-test')}); return t ? t.textContent : null; })()`);
        check('ram: its panel says this is a test copy that leaves the app as it is', /test copy/.test(note || ''), note);
        tR = Date.now();
        const sw = `${ITEM('ctl')} .ap-sw[data-f="memLow"]`;
        const on = await clickEl(top, sw, `(() => { const s = document.querySelector(${J(sw)}); return s && s.getAttribute('aria-checked') === 'true'; })()`, 'Lower memory priority (the copy)');
        check('ram: Lower memory priority shows on for the copy', !!on);
        const rep = await until(async () => { const l = (await replies(tR)).filter((x) => x.name === 'apppower.set'); return l.length ? l : null; }, 5000, 200);
        if (spy === 'ok') check('ram: main answered the copy\'s change as a test dry run', !!rep && rep.every((x) => x.r && x.r.ok !== false && hasDry(x.r)), rep && rep.map((x) => x.r));
        else check('ram: main\'s replies could be recorded', false, spy);
        const capSel = `${ITEM('ctl')} [data-f="memCap"] [data-v="536870912"]`;
        const capOn2 = await clickEl(top, capSel, `(() => { const b = document.querySelector(${J(capSel)}); return b && b.getAttribute('aria-checked') === 'true'; })()`, 'Memory limit 512 MB (the copy)');
        check('ram: Memory limit 512 MB shows picked for the copy', !!capOn2);
        const rep2 = await until(async () => { const l = (await replies(tR)).filter((x) => x.name === 'apppower.set'); return l.length >= 2 ? l : null; }, 5000, 200);
        if (spy === 'ok') check('ram: the memory limit was answered as a test dry run too', !!rep2 && rep2.every((x) => x.r && x.r.ok !== false && hasDry(x.r)), rep2 && rep2.map((x) => x.r));
        await sleep(2500);
        const c1 = await read(C.pid), ic = C.info();
        check('ram: the copy reads back UNCHANGED (its memory priority and priority, Windows-managed throttling, no memory or CPU limit)', c1.memPriority === c0.memPriority && c1.priority === c0.priority && c1.eco === null && !c1.jobMemLimit && !c1.jobCpuRate && c1.inJob === c0.inJob && (!ic || (ic.memPrio === c0.memPriority && !ic.jobMem)), { read: c1, self: ic });
        const lnk = `${ITEM('ctl')} .ap-lnk[data-f="reset"]`;
        await clickEl(top, lnk, `(() => { const l = document.querySelector(${J(lnk)}); return !l || l.disabled || l.hidden; })()`, 'Back to normal (the copy)');
        await sleep(600);
        await clickEl(top, `${ITEM('ctl')} .ap-row`, isFolded('ctl'), 'the copy\'s row (fold)');
        await sleep(400);
      }
      /* 3. protected rows: CPU and RAM lists together */
      const all = cpuRows.concat((await rows()) || []);
      const PROT = /^(system|svchost|registry|memory compression|msmpeng|mpdefendercoreservice|csrss|dwm|lsass|services|wininit|winlogon|smss|explorer|sihost|ctfmon|fontdrvhost|audiodg|nissrv|securityhealthservice|sgrmbroker|mantle\.sidecar)$/i;
      const prot = all.filter((r) => r.dom && (r.label === 'Mantle' || PROT.test(String(r.exe || r.label || ''))));
      const seen = [...new Set(prot.map((r) => r.label))];
      info(`protected rows seen: ${seen.join(', ') || 'none'}`);
      check('protected: Mantle\'s own electron, Service Host or System is in the CPU or RAM list', prot.some((r) => r.label === 'Mantle' || /^(system|svchost)$/i.test(String(r.exe || ''))), all.map((r) => [r.label, r.exe]));
      const bad = prot.filter((r) => r.ctl !== false || r.dom.ctl || r.dom.exp != null || !r.dom.lock || !(r.label === 'Mantle' ? r.dom.sub === 'This is Mantle' : r.dom.sub === 'Windows protects this process'));
      check('protected: each says why in plain words, shows the lock and offers no controls', prot.length > 0 && bad.length === 0, bad.map((r) => ({ label: r.label, ctl: r.ctl, dom: r.dom })));
      const pr = ((await rows()) || []).find((r) => r.dom && !r.ctl && (r.label === 'Mantle' || PROT.test(String(r.exe || ''))));
      if (pr) {
        await mark(pr.label, 'prot');
        const c = await centerOf(top, `${ITEM('prot')} .ap-row`);
        if (c && c.inView) await within(cdpClick(top, c.x, c.y), 4000).catch(() => null);
        await sleep(500);
        const st = await top.ev(`(() => { const it = document.querySelector(${J(ITEM('prot'))}); return { open: !it || it.classList.contains('is-open') || it.classList.contains('open'), inner: it ? it.querySelector('.ap-pi').innerHTML.length : -1 }; })()`);
        check(`protected: a click on ${pr.label} opens nothing`, !!c && c.inView && st.open === false && st.inner === 0, { c, st });
      }
      await closeMenus();
    }

    check('every top bar click landed through CDP input (no DOM-click fallback)', fallbacks.length === 0, fallbacks);
    if (softFallbacks.length) info(`Settings clicks made as DOM clicks (CDP input did not reach the never-shown --test Settings window): ${softFallbacks.join(', ')}`);
    const mainLines = run.out.split('\n').filter((l) => !/^mantle: \[[^\]]+\] /.test(l)).join('\n');
    check('no main-process exception in the run', !/Uncaught Exception|UnhandledPromiseRejection|TypeError: /.test(mainLines), (mainLines.match(/.*(Uncaught Exception|UnhandledPromiseRejection|TypeError: ).*/) || [''])[0]);
    const apLines = run.out.split('\n').filter((l) => /app power:/.test(l));
    if (apLines.length) info(`main's app power lines: ${apLines.slice(-6).join(' | ')}`);
    check('main logged no app power failure', !apLines.some((l) => /failed|not applied/.test(l)), apLines.slice(-6));
  } catch (err) {
    check('the run did not throw', false, err && err.stack ? err.stack : String(err));
  } finally {
    if (failures.length && diagAtEnd) await diagAtEnd('at the end of a failing run').catch(() => null);
    if (run && /MANTLE_TOPBAR_TEST_PIN_FOCUS/.test(run.out)) info('the desktop\'s foreground changed during the run; the test bar kept its first app (pinned), so its menus stayed open');
    for (const p of open) p.close();
    if (run) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    for (const pid of pids) B.kill(pid);
    if (rs) await rs.stop().catch(() => null);
    try { fs.writeFileSync(path.join(OUT_DIR, 'last-run.log'), run ? run.out : ''); } catch (_) { /* no folder */ }
    // a cloud run brings the instance's log back as an artifact (cloudtest --env APPPOWER_E2E_OUT=<folder in the checkout>)
    if (process.env.APPPOWER_E2E_OUT) { try { fs.mkdirSync(process.env.APPPOWER_E2E_OUT, { recursive: true }); fs.writeFileSync(path.join(process.env.APPPOWER_E2E_OUT, 'last-run.log'), run ? run.out : ''); } catch (_) { /* said by its absence */ } }
    await B.cleanup(rd.dir);
    finish();
  }
})();

function finish() {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`APPPOWER E2E: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}
