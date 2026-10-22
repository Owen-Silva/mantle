'use strict';
/*
 * look-guard-topbar.e2e.test.js -- the SHARED top-band darkening in a REAL --test instance (lane
 * guard-mantle, 2026-10-10; CONTRACT.md "desktop.guard"; lib/look-guard.js, lib/look-desktop.js).
 *
 * One invisible --test instance (lib/test-quiet.js), profile 'lsguard', LOOK_SYNC_DIR = a fresh temp
 * folder (the user's real %APPDATA%\look-sync is snapshotted before and after: untouched). Through CDP into
 * its own pages only:
 *   1. wallpaper.set builtin:snow-peak -> look.json desktop.guard.dark (alpha, contrast, dim, blurPx,
 *      region 0/100, monitor = the primary display in DIP); look.get's view says it;
 *   2. the TOP BAR page uses it: __topbarGlass.lookGuard {use, alpha} = the record's, and with its glass
 *      on, its tint IS that alpha (source 'shared');
 *   3. Quartz (fake-writer) sets glass.dark.dim .6 -> Mantle republishes (rev up, dim .6) and the top bar
 *      follows the new alpha;
 *   4. a STALE record (guard dim .7 while the glass is .6) -> the top bar falls back to its own guard and
 *      says why (failure, "out of date"); the BOTTOM bar's tint does not move (it keeps its own guard);
 *   5. a record with guardReason -> the top bar's reason carries it.
 *   node lib/look-guard-topbar.e2e.test.js   -> "LOOK GUARD TOPBAR E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match lsguard whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'lsguard';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LS_DIR = path.join(os.tmpdir(), 'claude', 'lsguard-e2e', 'ls');
const LOOK_FILE = path.join(LS_DIR, 'look.json');
const REAL_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'look-sync');
const FAKE_WRITER = process.env.LOOK_FAKE_WRITER || path.join(os.homedir(), 'look-sync', 'fake-writer.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 150);
  }
}
function realSnapshot() {
  if (!fs.existsSync(REAL_DIR)) return 'absent';
  const walk = (d) => fs.readdirSync(d).sort().map((n) => { const p = path.join(d, n); const s = fs.statSync(p); return s.isDirectory() ? `${n}/[${walk(p).join(',')}]` : `${n}:${s.size}:${s.mtimeMs}`; });
  return `${fs.statSync(REAL_DIR).mtimeMs}|${walk(REAL_DIR).join(',')}`;
}
function readLook() { try { return JSON.parse(fs.readFileSync(LOOK_FILE, 'utf8')); } catch (_) { return null; } }
function fake(...args) {
  const r = spawnSync(process.execPath, [FAKE_WRITER, '--dir', LS_DIR, '--app', 'quartz', ...args.map(String)], { encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
/* Another writer replaces the desktop record (to force a stale / failed guard): atomic, rev + 1. */
function writeDesktop(mut) {
  const d = readLook();
  const rev = d.rev + 1;
  d.desktop = Object.assign(mut(JSON.parse(JSON.stringify(d.desktop))), { rev });
  d.rev = rev;
  d.writer = { app: 'quartz', instance: 'lsguard-e2e', pid: process.pid, at: new Date().toISOString() };
  const tmp = `${LOOK_FILE}.e2e.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(tmp, LOOK_FILE);
  return rev;
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
// MANTLE_TOPBAR_UNDER=0: the colour under the bar (lib/topbar-under.js) is not run, so this test of the glass
// does not depend on the user's real screen (a window filling the row under the bar rests the glass by design)
const env = Object.assign({}, process.env, { LOOK_SYNC_DIR: LS_DIR, MANTLE_TOPBAR_UNDER: '0' });
delete env.MANTLE_TOPBAR_UNDER_HOLD;
delete env.MANTLE_TEST_VISIBLE;
delete env.ELECTRON_RUN_AS_NODE;

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;
const TOP = '(() => { const g = window.__topbarGlass || {}; return { lg: g.lookGuard || null, source: g.source || null, tint: g.tint, png: !!g.png, why: g.why || null, solve: g.solve ? g.solve.alpha : null, theme: document.documentElement.getAttribute(\'data-theme\') }; })()';
const BAR = '(() => { const g = window.__barGlass || {}; return { tint: g.tint, solve: g.solve ? g.solve.alpha : null }; })()';

async function main() {
  if (gaming()) { check('not run: a game is running', false); return; }
  if (!fs.existsSync(FAKE_WRITER)) { check('fake-writer.js is there', false, FAKE_WRITER); return; }
  const realBefore = realSnapshot();
  fs.rmSync(LS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LS_DIR, { recursive: true });
  for (const f of ['theme.json', 'look-sync.json']) { try { fs.unlinkSync(path.join(USER_DATA, f)); } catch (_) { /* none */ } }
  const run = launch();
  const open = [];
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-800))) return;
    const bt = await until(async () => (await targets(port)).find((t) => /\/ui\/bar\/index\.html/.test(t.url)), 90000, 400);
    const tt = await until(async () => (await targets(port)).find((t) => /\/ui\/topbar\/index\.html/.test(t.url)), 30000, 400);
    if (!check('the bar and topbar pages are there', !!bt && !!tt)) return;
    await sleep(2000);
    const bar = await attach(bt); open.push(bar);
    const top = await attach(tt); open.push(top);
    // The seed is Match Windows: dark on the user's PC (apps dark), LIGHT on the GitHub runner (apps light).
    // Every check below is about the DARK top band, so on a light Windows another app (the fake Quartz)
    // sets the shared theme to dark first, as the user would from Quartz; Windows itself is never touched
    // (zero-fail lane, 2026-10-14: this was a hard "the instance is dark" and failed 9 checks on the runner).
    const q = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8', windowsHide: true });
    const m = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(q.stdout || ''));
    const winMode = m && parseInt(m[1], 16) !== 0 ? 'light' : 'dark';
    console.log(`info: Windows' apps are ${winMode} here (AppsUseLightTheme = ${m ? parseInt(m[1], 16) : '?'})`);
    const theme = await top.ev('document.documentElement.getAttribute(\'data-theme\')');
    check(`the instance follows Windows at the seed (Match Windows: ${winMode})`, theme === winMode, theme);
    if (winMode === 'light') {
      console.log('info: Windows\' apps are light here, so another app sets the shared theme to dark first and the dark top band is checked on that');
      const fwd = fake('set', 'theme', 'dark');
      const dark = await until(async () => (await top.ev('document.documentElement.getAttribute(\'data-theme\')')) === 'dark' || null, 5000, 50);
      check('light Windows: another app\'s theme dark reaches the top bar', !!dark, fwd);
    }

    /* 1. the record */
    const pick = await bar.ev(call('wallpaper.set', { id: 'builtin:snow-peak' }));
    check('wallpaper.set builtin:snow-peak answered', pick && pick.ok !== false, pick);
    const d1 = await until(() => { const d = readLook(); return d && d.desktop && d.desktop.id === 'builtin:snow-peak' && d.desktop.guard ? d : null; }, 20000, 200);
    if (!check('look.json desktop record carries guard.dark', !!d1, readLook() && readLook().desktop)) return;
    const g1 = d1.desktop.guard.dark;
    const disp = await top.ev('({ w: screen.width, h: screen.height })');
    check('guard.dark shape: alpha, contrast, dim .5, blur 5, band 0/100, monitor = the display in DIP',
      typeof g1.alpha === 'number' && typeof g1.contrast === 'number' && g1.dim === 0.5 && g1.blurPx === 5 && g1.region.topDip === 0 && g1.region.heightDip === 100
      && g1.monitor[0] === disp.w && g1.monitor[1] === disp.h, { g1, disp });
    check('snow-peak alpha stays at .50 and keeps 4.2:1', g1.alpha === 0.5 && g1.contrast >= 4.2, g1);
    const v1 = await bar.ev(call('look.get'));
    check('look.get view: guard ok with the value', v1 && v1.guard && v1.guard.ok === true && v1.guard.alpha === g1.alpha && /darkened to/.test(v1.guard.text), v1 && v1.guard);

    /* 2. the top bar uses it */
    const t1 = await until(async () => { const t = await top.ev(TOP); return t.lg && t.lg.use && t.lg.alpha === g1.alpha && (!t.png || (t.source === 'shared' && t.tint === g1.alpha)) ? t : null; }, 8000, 150);
    check('top bar: uses the shared alpha (tint = guard.dark.alpha when its glass is on)', !!t1, await top.ev(TOP));
    const tNow = await top.ev(TOP);
    console.log(`info: top bar glass ${tNow.png ? 'on' : 'off (' + tNow.why + ')'}; shared ${g1.alpha}, its own solve would be ${tNow.solve}, tint ${tNow.tint}`);
    check('top bar: its glass is on in this test instance (so the tint check above is real)', tNow.png === true, tNow);

    /* 3. a dim change from Quartz republishes, the top bar follows */
    // count 'topbar.guard' events in BOTH pages from here on: the top bar gets them, the bottom bar never
    const COUNT = 'window.__lgSeen = 0; window.mantle.on(\'topbar.guard\', () => { window.__lgSeen++; }); true';
    await bar.ev(COUNT); await top.ev(COUNT);
    const rev1 = d1.desktop.rev;
    const fw = fake('set', 'glass.dark.dim', 0.6);
    check('fake-writer (Quartz) set glass.dark.dim .6', fw.code === 0, fw);
    const d2 = await until(() => { const d = readLook(); return d && d.desktop && d.desktop.guard && d.desktop.guard.dark.dim === 0.6 ? d : null; }, 10000, 100);
    check('Mantle republished the record for dim .6 (rev up, same still)', !!d2 && d2.desktop.rev > rev1 && d2.desktop.still === d1.desktop.still && d2.desktop.guard.dark.alpha >= 0.6, d2 && d2.desktop);
    const a2 = d2 ? d2.desktop.guard.dark.alpha : null;
    const t2 = await until(async () => { const t = await top.ev(TOP); return t.lg && t.lg.use && t.lg.alpha === a2 && (!t.png || t.tint === a2) ? t : null; }, 8000, 150);
    check('top bar: follows the new shared alpha', !!t2, await top.ev(TOP));
    await sleep(1500);
    const barBefore = await bar.ev(BAR);

    /* 4. a stale record -> own guard, said; the bottom bar does not move */
    writeDesktop((x) => { x.guard.dark.dim = 0.7; return x; });
    const tSoft = await until(async () => { const t = await top.ev(TOP); return t.lg && t.lg.use === false && (!t.png || t.source === 'own') ? t : null; }, 8000, 100);
    check('top bar: a stale guard -> its own guard at once, held as "being worked out" first (no flash of a failure)', !!tSoft && tSoft.lg.failure === false && /being worked out/.test(tSoft.lg.why), tSoft || await top.ev(TOP));
    const t3 = await until(async () => { const t = await top.ev(TOP); return t.lg && t.lg.use === false && t.lg.failure === true ? t : null; }, 9000, 150);
    check('top bar: ... still stale after the grace -> a said failure ("out of date")', !!t3 && /out of date/.test(t3.lg.why) && (!t3.png || t3.source === 'own'), t3 || await top.ev(TOP));
    await sleep(1200);
    const barAfter = await bar.ev(BAR);
    const seen = { bar: await bar.ev('window.__lgSeen'), top: await top.ev('window.__lgSeen') };
    check('bottom bar: no shared darkening reaches it (0 topbar.guard events; the top bar got them)', seen.bar === 0 && seen.top >= 2, seen);
    const barTok = await bar.ev('({ fill: getComputedStyle(document.documentElement).getPropertyValue(\'--lg-fill-bar\').trim(), tint: document.querySelector(\'.bar, #bar\') ? getComputedStyle(document.querySelector(\'.bar, #bar\')).getPropertyValue(\'--bar-tint\').trim() : null })');
    check('bottom bar: keeps its own floor (--lg-fill-bar = the glass dim .6), not the shared alpha', /,\s*0?\.6\)$/.test(barTok.fill), { barTok });
    // its own guard's tint comes and goes with its captured backdrop in a --test instance, so it is reported, not compared
    console.log(`info: bottom bar's own guard: tint ${barBefore.tint} before, ${barAfter.tint} after (null = no captured backdrop at that moment)`);

    /* 5. guardReason -> the reason reaches the top bar */
    writeDesktop((x) => { delete x.guard; x.guardReason = 'made up: the still decoded empty'; return x; });
    const t4 = await until(async () => { const t = await top.ev(TOP); return t.lg && t.lg.use === false && /made up: the still decoded empty/.test(t.lg.why || '') ? t : null; }, 8000, 150);
    check('top bar: guardReason -> its own guard, says the reason', !!t4 && t4.lg.failure === true, await top.ev(TOP));
  } finally {
    for (const p of open) p.close();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    await until(() => run.exited, 15000, 200);
    check("The user's real %APPDATA%\\look-sync was not created or modified by the run", realSnapshot() === realBefore);
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`LOOK GUARD TOPBAR E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
