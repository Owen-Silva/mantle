'use strict';
// The CPU cap and the one-browser lock on Owen's PC; a CI runner (cloudtest) has neither file nor need.
require('../../../tools/dev-env.js').lowcpu();
/*
 * ui/settings/sections/sysrows.e2e.test.js - the Settings rows that were taken out on 09-29 for missing sidecar
 * work and came back on 10-12 (8201879, 5ae1f59, 4da0968), driven END TO END: the real Settings page, the real
 * main halves (lib/features/_settings-sections/update.js, system.js) and the real sidecar (SysUpdate.cs,
 * SysAbout.cs, SysStorage.cs) inside ONE quiet --test instance (lib/test-quiet.js: never on screen, never
 * focused). Lane wk-mantle-settings, 2026-10-14.
 *
 *   Windows Update
 *     - "Windows Update is busy" with Try again: the status line says it in words (no code anywhere on the
 *       page), the button reads Try again, and clicking it is a test-run dry run that says so.
 *     - Pause: a running pause (Owen's real one, read from the registry) offers "Extend to <date>" counted
 *       from the day it BEGAN; picking one is a dry run that says so and springs back to "Paused until".
 *       No running pause = the extend checks say they were not run (the row then offers Pause for N weeks).
 *   Advanced options
 *     - Adjust active hours: Automatically / Manually shows what the registry holds (SmartActiveHoursState,
 *       1 = Automatically); flipping it is a dry run that says so and springs back.
 *   About
 *     - A rename waiting for a restart shows the NEW name and says the PC is still called its current name
 *       (the current name checked against the registry's ActiveComputerName); renaming is a dry run that
 *       says so; an empty name springs back with "Type a name for this PC".
 *   Storage > Temporary files
 *     - Every cleanup kind shows its size before a cleanup, or says in words why not; Delivery Optimization
 *       files are sized by the Delivery Optimization service and match its own WMI number.
 *
 * TWO stand-ins, TEST RUN ONLY (each read by its main half only when env.test): Windows Update cannot be
 * made busy on demand, so MANTLE_TEST_UPDATE_CHECK_CODE=0x80240009 stands in for the last check's code;
 * a rename cannot be left waiting without renaming the PC, so MANTLE_TEST_PENDING_PC_NAME stands in for
 * the waiting name. Everything else is real.
 *
 * NEVER a write to Windows: every write in a --test instance is a dryRun. The test proves it by reading
 * the registry (READ ONLY) before and after: WindowsUpdate\UX\Settings (Owen's real pause, active hours)
 * and the computer name keys must be byte-identical.
 *
 *   node ui/settings/sections/sysrows.e2e.test.js      -> "SYSROWS E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match wk-sysrows whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE = 'wk-sysrows';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const BUSY_CODE = '0x80240009';     // WU_E_OPERATIONINPROGRESS
const PENDING = 'MANTLE-E2E-NEW';   // 14 characters, a valid NetBIOS name
const WEEK = 7 * 86400e3;

let passed = 0;
const failures = [];
const skipped = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
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
    await sleep(every || 150);
  }
}
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}

/* ---- the registry, READ ONLY ---- */
function regDump(key) {
  const r = spawnSync('reg', ['query', key], { encoding: 'utf8', timeout: 10000 });
  return (r.stdout || '').replace(/\r/g, '').trim();
}
function regValue(dump, name) {
  const m = new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(dump);
  return m ? m[1].trim() : null;
}
const UX = 'HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings';
const CN = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName';
const ACN = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ActiveComputerName';
const TCP = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters';
const snapshot = () => ({ ux: regDump(UX), cn: regDump(CN), acn: regDump(ACN),
  tcp: [regValue(regDump(TCP), 'Hostname'), regValue(regDump(TCP), 'NV Hostname')].join('|') });
/** Is this test (and so the sidecar it starts) running ELEVATED? Owen's PC: no. The GitHub runner:
    yes, so the sidecar can walk C:\Windows\Temp and the Delivery Optimization cache itself and sizes
    them in files, where a standard user gets words (Windows Temp) or the service's own number (DO).
    "net session" answers only an administrator (zero-fail lane, 2026-10-14). */
function elevated() {
  const r = spawnSync('net', ['session'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return r.status === 0;
}

function doCacheBytes() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-CimInstance -Namespace root/Microsoft/Windows/DeliveryOptimization -ClassName MSFT_DOCurrentStatus -ErrorAction Stop).CacheSizeBytes'],
  { encoding: 'utf8', timeout: 20000 });
  const n = Number((r.stdout || '').trim());
  return r.status === 0 && Number.isFinite(n) ? n : null;
}

/* ---- the --test instance and CDP into its own pages ---- */
// electron.exe itself, spawned from THIS process, so lowcpu's hook sees a browser: the cap, and the
// machine-wide one-browser lock held until it exits (through electron/cli.js the spawn was node's and slipped past)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const env = Object.assign({}, process.env, { MANTLE_TEST_UPDATE_CHECK_CODE: BUSY_CODE, MANTLE_TEST_PENDING_PC_NAME: PENDING });
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(ELECTRON, ['.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'],
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
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { send, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}

/* ---- page helpers (run inside the Settings page) ---- */
const ROW = (row) => `document.querySelector('[data-row=${JSON.stringify(row)}]')`;
const rowText = (sc, row) => sc.ev(`(() => { const r = ${ROW(row)}; return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
const pick = (sc, row, value) => sc.ev(`(() => { const s = ${ROW(row)}.querySelector('select'); s.value = ${JSON.stringify(value)};
  s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const selValue = (sc, row) => sc.ev(`(() => { const s = ${ROW(row)} && ${ROW(row)}.querySelector('select'); return s ? s.value : null; })()`);
const selOptions = (sc, row) => sc.ev(`(() => { const s = ${ROW(row)} && ${ROW(row)}.querySelector('select'); return s ? [...s.options].map((o) => [o.value, o.textContent]) : null; })()`);
const segOn = (sc, row) => sc.ev(`(() => { const r = ${ROW(row)}; const b = r && r.querySelector('button[aria-checked="true"]'); return b ? b.dataset.v : null; })()`);
const call = (sc, cmd, args) => sc.ev(`window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})`);
const pageText = (sc) => sc.ev(`document.body.innerText`);
async function open(page, sc, section, sub, row) {
  await page.ev(`window.mantle.call('settings.open', { section: ${JSON.stringify(section)}, page: ${JSON.stringify(sub)} })`);
  return until(() => sc.ev(`!!${ROW(row)}`), 20000, 150);
}

async function main() {
  if (gaming()) { check('no game running (not launching an instance)', false); return; }
  const before = snapshot();
  const pauseEnd = Date.parse(regValue(before.ux, 'PauseUpdatesExpiryTime') || '');
  const pauseStart = Date.parse(regValue(before.ux, 'PauseUpdatesStartTime') || '');
  const paused = Number.isFinite(pauseEnd) && pauseEnd > Date.now();
  const smart = regValue(before.ux, 'SmartActiveHoursState');
  const smartOn = smart ? parseInt(smart, 16) === 1 : false;
  const activeName = regValue(before.acn, 'ComputerName');
  console.log(`info: registry before: paused=${paused}${paused ? ` (since ${new Date(pauseStart).toISOString()}, until ${new Date(pauseEnd).toISOString()})` : ''}, SmartActiveHoursState=${smart}, ActiveComputerName set=${!!activeName}`);

  // Owen's laptop (11.7 GB): an Electron instance only with at least 2.5 GB free; wait up to 10 minutes.
  // MANTLE_TEST_MIN_FREE_GB sets that floor for one run when Owen allows it (0 = no floor); unset, it stays 2.5.
  const minFreeGb = process.env.MANTLE_TEST_MIN_FREE_GB !== undefined && process.env.MANTLE_TEST_MIN_FREE_GB !== '' && Number(process.env.MANTLE_TEST_MIN_FREE_GB) >= 0 ? Number(process.env.MANTLE_TEST_MIN_FREE_GB) : 2.5;
  const freeGb =() => { const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { encoding: 'utf8', timeout: 20000 }); return (Number((r.stdout || '').trim()) || 0) / 1048576; };
  if (process.env.CI !== 'true' && !await until(() => freeGb() >= minFreeGb, 600000, 15000)) {
    check(`at least ${minFreeGb} GB of free memory to start a test instance (${freeGb().toFixed(2)} GB free after 10 minutes)`, false); return;
  }
  const run = launch();
  let page = null, sc = null;
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the quiet --test instance started and wrote its DevTools port', !!port, run.out.slice(-600))) return;
    const bar = await until(async () => (await targets(port)).find((t) => !/\/ui\/settings\//.test(t.url)), 60000, 300);
    if (!check('a Mantle page is up to ask Settings to open', !!bar)) return;
    page = await attach(bar);
    await until(() => page.ev(`!!(window.mantle && window.mantle.call)`), 30000, 200);
    await page.ev(`window.mantle.call('settings.open', { section: 'update', page: 'windows-update' })`).catch(() => null);
    const st = await until(async () => (await targets(port)).find((t) => /\/ui\/settings\/index\.html/.test(t.url)), 30000, 300);
    if (!check('Settings: the window was made on demand (never shown in --test)', !!st)) return;
    sc = await attach(st);
    await until(() => sc.ev(`!!(window.mantle && window.mantle.call)`), 20000, 150);

    // ======================= Windows Update: busy, Try again
    check('update: the main page is open', !!await open(page, sc, 'update', 'windows-update', 'update.main.status'));
    const busy = await until(async () => { const t = await rowText(sc, 'update.main.status'); return t && /Windows Update is busy/.test(t) ? t : null; }, 30000, 200);
    check('update: the status line says "Windows Update is busy" with the reason in words', !!busy && /busy with another check or an install, so it did not check now\. Try again in a few minutes/.test(busy), busy || await rowText(sc, 'update.main.status'));
    const txt = await pageText(sc);
    check('update: no error code anywhere on the page', !/0x[0-9a-f]{8}/i.test(txt) && !txt.includes(BUSY_CODE), (/0x[0-9a-f]{8}/i.exec(txt) || [])[0]);
    const btn = await sc.ev(`(() => { const b = ${ROW('update.main.check')}.querySelector('button'); return b ? { text: b.textContent.trim(), disabled: b.disabled, title: b.title || '' } : null; })()`);
    check('update: the check button reads Try again and is enabled', btn && btn.text === 'Try again' && !btn.disabled, btn);
    const helpT = await rowText(sc, 'update.main.check');
    check('update: Try again says what it does', /Asks Windows Update again; it said it was busy last time/.test(helpT || '') || /it said it was busy/.test(btn && btn.title || ''), helpT);
    await sc.ev(`${ROW('update.main.check')}.querySelector('button').click()`);
    const tried = await until(async () => { const t = await rowText(sc, 'update.main.check'); return t && /Test run, nothing changed/.test(t) ? t : null; }, 20000, 150);
    check('update: clicking Try again reaches the sidecar as a dry run and says so', !!tried && /search Windows Update online|check/i.test(tried), tried || await rowText(sc, 'update.main.check'));

    // ======================= Windows Update: extend a pause from its start
    const s = await call(sc, 'settings.update.status');
    const p = (s && s.pause) || {};
    check('update: the sidecar reads the pause the registry holds', !!s && s.ok !== false && !!p.paused === paused, { paused, p });
    if (paused) {
      check('update: the pause start the sidecar reads is the registry\'s PauseUpdatesStartTime', Number.isFinite(pauseStart) && typeof p.since === 'number' && Math.abs(p.since - pauseStart) < 60e3, { since: p.since, pauseStart });
      const opts = await until(async () => { const o = await selOptions(sc, 'update.main.pause'); return o && o.some(([v]) => v === 'paused') ? o : null; }, 15000, 150);
      check('update: the pause row reads "Paused until" with Resume as a choice', !!opts && /^Paused until /.test(opts[0][1]) && opts.some(([v, l]) => v === '0' && l === 'Resume updates'), opts);
      const max = p.maxDays || 35;
      const ext = (opts || []).filter(([v]) => /^x[1-5]$/.test(v));
      const want = [1, 2, 3, 4, 5].filter((w) => w * 7 <= max && pauseStart + w * WEEK > pauseEnd);
      check('update: "Extend to" offers exactly the week counts that end after the current end, counted from the start', ext.map(([v]) => Number(v.slice(1))).join() === want.join(), { ext, want });
      if (ext.length) {
        const [v, label] = ext[ext.length - 1];
        const w = Number(v.slice(1));
        const d = new Date(pauseStart + w * WEEK);
        check('update: the extend label is the start plus the weeks (not now plus the weeks)', label.startsWith('Extend to ') && label.includes(String(d.getDate())), { label, from: d.toDateString() });
        await pick(sc, 'update.main.pause', v);
        const said = await until(async () => { const t = await rowText(sc, 'update.main.pause'); return t && /Test run, nothing changed/.test(t) ? t : null; }, 20000, 150);
        check(`update: picking "${label}" is a dry run that says so`, !!said, await rowText(sc, 'update.main.pause'));
        const back = await until(async () => (await selValue(sc, 'update.main.pause')) === 'paused', 5000, 100);
        check('update: the pause row springs back to "Paused until"', !!back, await selValue(sc, 'update.main.pause'));
      } else {
        const t = await rowText(sc, 'update.main.pause');
        check('update: at the limit the row says why it cannot extend', /already as long as Windows allows/.test(t || ''), t);
      }
    } else {
      skipped.push('extend a pause (no pause is running on this PC, so there is nothing to extend)');
    }

    // ======================= Advanced options: Adjust active hours Automatically / Manually
    check('advanced: the page is open', !!await open(page, sc, 'update', 'advanced', 'update.advanced.active-auto'));
    const on0 = await until(async () => { const o = await segOn(sc, 'update.advanced.active-auto'); const t = await rowText(sc, 'update.advanced.active-hours'); return o && t && !/Reading/.test(t) ? o : null; }, 20000, 150);
    check('advanced: Adjust active hours shows what the registry holds', on0 === (smartOn ? 'auto' : 'manual'), { on0, smart });
    const other = on0 === 'auto' ? 'manual' : 'auto';
    await sc.ev(`${ROW('update.advanced.active-auto')}.querySelector('button[data-v="${other}"]').click()`);
    const said2 = await until(async () => { const t = await rowText(sc, 'update.advanced.active-auto'); return t && /Test run, nothing changed/.test(t) ? t : null; }, 20000, 150);
    check(`advanced: choosing ${other === 'auto' ? 'Automatically' : 'Manually'} is a dry run that says so`, !!said2, await rowText(sc, 'update.advanced.active-auto'));
    const back2 = await until(async () => (await segOn(sc, 'update.advanced.active-auto')) === on0, 5000, 100);
    check('advanced: Adjust active hours springs back', !!back2, await segOn(sc, 'update.advanced.active-auto'));
    const st2 = await sc.ev(`(() => { const s = ${ROW('update.advanced.active-start')}.querySelector('select'); return s ? s.disabled : null; })()`);
    check('advanced: start time is editable only while Manually', st2 === (on0 === 'auto'), { st2, on0 });

    // ======================= About: a rename waiting for a restart
    check('about: the page is open', !!await open(page, sc, 'system', 'aboutpc', 'system.about.name'));
    const nm = await until(async () => { const v = await sc.ev(`(() => { const i = ${ROW('system.about.name')}.querySelector('input'); return i ? i.value : null; })()`); return v && v !== 'Reading…' ? v : null; }, 20000, 150);
    check('about: the name box shows the NEW name a rename is waiting to give', nm === PENDING, nm);
    const about = await rowText(sc, 'system.about.name');
    check('about: it says the new name takes effect after a restart and the PC is still called its current name (the registry\'s)',
      !!activeName && new RegExp(`takes effect after a restart\\. Until then this PC is still called ${activeName.replace(/[^A-Za-z0-9-]/g, '.')}`, 'i').test(about || ''), { about, activeName: !!activeName });
    const setName = (v) => sc.ev(`(() => { const i = ${ROW('system.about.name')}.querySelector('input'); i.focus(); i.value = ${JSON.stringify(v)};
      i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await setName('');
    const empty = await until(async () => { const t = await rowText(sc, 'system.about.name'); return t && /Type a name for this PC/.test(t) ? t : null; }, 8000, 100);
    const emptyV = await sc.ev(`${ROW('system.about.name')}.querySelector('input').value`);
    check('about: an empty name says "Type a name for this PC" and springs back to the shown name', !!empty && emptyV === PENDING, { empty, emptyV });
    await setName('MANTLE-E2E-TRY');
    const ren = await until(async () => { const t = await rowText(sc, 'system.about.name'); return t && /test run/i.test(t) ? t : null; }, 15000, 150);
    check('about: renaming is a dry run that says Windows would ask for administrator permission', !!ren && /administrator permission to rename this PC; nothing was changed/.test(ren), ren || await rowText(sc, 'system.about.name'));

    // ======================= Storage > Temporary files: a size for every kind, or why not
    check('storage: the page is open', !!await open(page, sc, 'system', 'storage', 'system.storage.temp.temp'));
    const KINDS = ['temp', 'thumbnails', 'systemTemp', 'deliveryOptimization', 'windowsUpdate', 'recycleBin', 'downloads'];
    const filled = await until(async () => {
      const t = await Promise.all(KINDS.map((k) => rowText(sc, `system.storage.temp.${k}`)));
      return t.every((x) => x && !/Measuring/.test(x)) ? t : null;
    }, 120000, 500);
    check('storage: every cleanup kind finished measuring', !!filled);
    const sized = /\d[\d.,]*\s?(B|KB|MB|GB|TB|bytes)\b/;
    const admin = elevated();
    console.log(`sysrows: this test runs ${admin ? 'ELEVATED (an administrator, like the cloud runner): Windows Temp and the Delivery Optimization cache are walked and sized in files' : 'as a standard user (like Owen\'s PC): Windows Temp says why it has no size, Delivery Optimization is sized by its service'}`);
    (filled || []).forEach((t, i) => {
      const k = KINDS[i];
      if (k === 'systemTemp' && !admin) check('storage: Windows temporary files says in words why it has no size yet (a standard user cannot list it)', /size not known yet/.test(t) && t.length > 60, t);
      else if (k === 'deliveryOptimization' && !admin) check('storage: Delivery Optimization files show a size from the Delivery Optimization service', sized.test(t) && /as the Delivery Optimization service reports it/.test(t), t);
      else check(`storage: ${k} shows its size and count before a cleanup${admin && (k === 'systemTemp' || k === 'deliveryOptimization') ? ' (elevated: the folder itself is walked)' : ''}`, sized.test(t) && /in [\d,]+ (files|items)/.test(t), t);
    });
    const tr = await call(sc, 'settings.system.read', { what: 'storageTemp' });
    const dox = tr && tr.ok && (tr.kinds || []).find((x) => x.kind === 'deliveryOptimization');
    const wmi = admin ? null : doCacheBytes();
    if (admin) {
      check('storage: elevated, Delivery Optimization is measured by walking its folder (not the service)', !!dox && dox.measured && dox.via !== 'service' && Number.isFinite(dox.files), dox);
      skipped.push('Delivery Optimization size vs WMI: this test runs elevated, so the sidecar walks the cache folder itself and never asks the service (the service number is only used for a standard user)');
    } else if (wmi === null) skipped.push('Delivery Optimization size vs WMI (WMI did not answer here)');
    else check('storage: the Delivery Optimization size is the service\'s own WMI number (within 1 MB: the cache moves)', !!dox && dox.via === 'service' && dox.files === null && Math.abs(dox.bytes - wmi) <= 1048576, { bytes: dox && dox.bytes, wmi, via: dox && dox.via });
    const stxt = await pageText(sc);
    check('storage: no error code on the page', !/0x[0-9a-f]{8}/i.test(stxt), (/0x[0-9a-f]{8}/i.exec(stxt) || [])[0]);
  } finally {
    if (sc) sc.close();
    if (page) page.close();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    await until(() => run.exited, 15000, 200);
  }
  const after = snapshot();
  check('NOTHING changed in Windows Update\'s settings (pause, active hours: the registry is identical)', after.ux === before.ux, 'the UX\\Settings dump differs');
  check('NOTHING changed in the PC name (ComputerName, ActiveComputerName, Tcpip host names identical)', after.cn === before.cn && after.acn === before.acn && after.tcp === before.tcp);
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  for (const s of skipped) console.log('NOT RUN ' + s);
  console.log(`SYSROWS E2E: ${passed} passed, ${failures.length} failed${skipped.length ? `, ${skipped.length} not run` : ''}`);
  process.exit(failures.length ? 1 : 0);
});
