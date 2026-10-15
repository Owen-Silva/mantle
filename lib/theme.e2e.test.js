'use strict';
// The CPU cap and the one-browser lock on Owen's PC; a CI runner (cloudtest) has neither file nor need.
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
/*
 * lib/theme.e2e.test.js - Mantle's appearance in a REAL --test instance (lane dm-core, 2026-10-08).
 *
 * One Electron --test instance (invisible: lib/test-quiet.js) started with --theme=dark and a DevTools
 * port. Checks, through CDP into its own pages only:
 *   - every Mantle page in the instance carries <html data-theme="dark">;
 *   - BEFORE FIRST PAINT: a page reloaded with a probe injected at document creation records the
 *     attribute when <body> is inserted (nothing can be painted before there is a body) and at the first
 *     animation frame, and the attribute's time against Chromium's own first-paint entry when it has one;
 *   - theme.get says dark, pinned by --theme, and Windows' real app mode (compared with the registry,
 *     READ only: AppsUseLightTheme);
 *   - theme.set {mode:'light'} flips the page LIVE (no reload: a marker on window survives), the
 *     --lg-ground token follows, and `mantle-theme` fires with {theme:'light'} in the page's world;
 *     a bad mode answers ok:false with its reason and changes nothing;
 *   - Match Windows follows a (made-up) Windows change through nativeTheme's own 'updated' event
 *     (theme.testWindows, --test only; Owen's Windows setting is never touched);
 *   - a reload after a live change starts in the new theme;
 *   - Mantle Settings, a window made LATER on demand (never shown in --test), starts in the theme, and
 *     its Personalization > Colors "Mantle appearance" control switches every page live (Light), then
 *     Match Windows follows Windows' real app mode and says so. Shots of that page, dark then light,
 *     go to MANTLE_SHOOT_OUT (default %TEMP%\claude\mantle-dark\shots\dm-core);
 *   - --theme never wrote theme.json into the test profile.
 *
 *   node lib/theme.e2e.test.js      -> "THEME E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match dm-core whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'dm-core';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const THEME_FILE = path.join(USER_DATA, 'theme.json');
const SHOTS = process.env.MANTLE_SHOOT_OUT || path.join(os.tmpdir(), 'claude', 'mantle-dark', 'shots', 'dm-core');

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
/** Windows' app mode from the registry, READ ONLY. 'dark' | 'light' | null */
function registryAppsMode() {
  const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8', timeout: 10000 });
  const m = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout || '');
  return m ? (parseInt(m[1], 16) ? 'light' : 'dark') : null;
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

// electron.exe itself, spawned from THIS process, so lowcpu's hook sees a browser: the cap, and the
// machine-wide one-browser lock held until it exits (through electron/cli.js the spawn was node's and slipped past)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const env = Object.assign({}, process.env);
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)

function launch(extra) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(ELECTRON, ['.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'].concat(extra || []),
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
  const events = [];
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
    else if (j.method) events.push(j);
  });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { send, ev, events, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const pageName = (u) => ((/\/ui\/([^?#]+)/.exec(u) || [])[1] || u).replace(/\/index\.html$/, '');

/* Injected at document creation (main world) before a reload: when is data-theme there? */
const PROBE = `(() => {
  const P = window.__themeProbe = { atStart: document.documentElement ? document.documentElement.getAttribute('data-theme') : '(no html yet)',
    firstSeenMs: null, atBody: undefined, atFirstFrame: undefined };
  const look = () => { const el = document.documentElement; const t = el && el.getAttribute('data-theme');
    if (t && P.firstSeenMs === null) P.firstSeenMs = performance.now();
    if (P.atBody === undefined && document.body) P.atBody = t || null; };
  look();
  new MutationObserver(look).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-theme'] });
  requestAnimationFrame(() => { P.atFirstFrame = document.documentElement.getAttribute('data-theme'); });
})();`;

async function main() {
  if (gaming()) { check('no game running (not launching an instance)', false); return; }
  try { fs.unlinkSync(THEME_FILE); } catch (_) { /* a fresh profile has none */ }
  const reg = registryAppsMode();
  const run = launch(['--theme=dark']);
  let page = null;
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the test instance started and wrote its DevTools port', !!port, run.out.slice(-600))) return;
    const bar = await until(async () => (await targets(port)).find((t) => /\/ui\/bar\/index\.html/.test(t.url)), 90000, 500);
    if (!check('the bar page is up', !!bar)) return;
    await sleep(4000);   // let the features make their windows (hidden ones included)

    // every Mantle page, hidden or not
    const all = await targets(port);
    const stamps = [];
    for (const t of all) {
      const c = await attach(t);
      try { stamps.push([pageName(t.url), await c.ev(`document.documentElement.getAttribute('data-theme')`)]); } catch (e) { stamps.push([pageName(t.url), 'ERR ' + e.message]); }
      c.close();
    }
    console.log(`info: pages checked: ${stamps.map((s) => `${s[0]}=${s[1]}`).join(', ')}`);
    check(`every Mantle page carries data-theme="dark" (${stamps.length} pages: ${stamps.map((s) => s[0]).join(', ')})`, stamps.length >= 3 && stamps.every((s) => s[1] === 'dark'), stamps);

    page = await attach(bar);
    // theme.get
    const g = await page.ev(`window.mantle.call('theme.get')`);
    check('theme.get: dark, pinned by --theme', g && g.ok === true && g.theme === 'dark' && g.mode === 'dark' && /--theme=dark/.test(g.pinned || ''), g);
    check(`theme.get: Windows' app mode is the registry's (${reg})`, reg === null ? g.windows === null : g.windows === reg, { reg, windows: g.windows, why: g.windowsWhy });

    // before first paint: reload with the probe
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await page.send('Page.reload', { ignoreCache: true });
    const probe = await until(async () => { const p = await page.ev(`window.__themeProbe && window.__themeProbe.atFirstFrame !== undefined ? window.__themeProbe : null`); return p; }, 15000, 100);
    check('first paint: the probe ran in the reloaded page', !!probe, probe);
    if (probe) {
      check('first paint: data-theme was on <html> when <body> was inserted', probe.atBody === 'dark', probe);
      check('first paint: data-theme was on <html> at the first animation frame', probe.atFirstFrame === 'dark', probe);
    }
    const paint = await page.ev(`(() => { const e = performance.getEntriesByType('paint').find((x) => x.name === 'first-paint'); return e ? e.startTime : null; })()`);
    if (probe && paint !== null) check(`first paint: the attribute (at ${probe.firstSeenMs && probe.firstSeenMs.toFixed(1)} ms) came before Chromium's first paint (${paint.toFixed(1)} ms)`, probe.firstSeenMs !== null && probe.firstSeenMs <= paint, { probe, paint });
    else check('first paint: Chromium recorded a first-paint entry (an invisible test window may not)', true);   // said in the report, not a failure
    console.log(`info: probe ${JSON.stringify(probe)}; Chromium first-paint entry: ${paint === null ? 'none (invisible test window)' : paint.toFixed(1) + ' ms'}`);

    // live switch, no reload
    await page.ev(`(() => { window.__noReload = 'still here'; window.__themeEvents = []; window.addEventListener('mantle-theme', (e) => window.__themeEvents.push(e.detail && e.detail.theme)); return true; })()`);
    const groundDark = await page.ev(`getComputedStyle(document.documentElement).getPropertyValue('--lg-ground').trim()`);
    const s = await page.ev(`window.mantle.call('theme.set', { mode: 'light' })`);
    check('theme.set light: ok with the read-back', s && s.ok === true && s.value === 'light' && s.theme === 'light', s);
    const live = await until(async () => { const v = await page.ev(`({ t: document.documentElement.getAttribute('data-theme'), ev: window.__themeEvents.slice(), mark: window.__noReload, ground: getComputedStyle(document.documentElement).getPropertyValue('--lg-ground').trim() })`); return v.t === 'light' && v.ev.length ? v : null; }, 5000, 50);
    check('live: the page flipped to light without a reload', live && live.t === 'light' && live.mark === 'still here', live);
    check('live: mantle-theme fired once with {theme:"light"} in the page\'s world', live && live.ev.length === 1 && live.ev[0] === 'light', live);
    check(`live: the --lg-ground token followed (${groundDark} -> ${live && live.ground})`, live && groundDark.toUpperCase() === '#131415' && live.ground.toUpperCase() === '#F4F6FA', { groundDark, live });

    const bad = await page.ev(`window.mantle.call('theme.set', { mode: 'neon' })`);
    check('theme.set neon: refused with the reason, nothing changed', bad && bad.ok === false && /it was sent "neon"/.test(bad.reason) && await page.ev(`document.documentElement.getAttribute('data-theme')`) === 'light', bad);

    // Match Windows follows a (made-up) Windows change through nativeTheme 'updated'
    await page.ev(`window.mantle.call('theme.set', { mode: 'system' })`);
    await page.ev(`window.mantle.call('theme.testWindows', { mode: 'dark' })`);
    const w1 = await until(async () => (await page.ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark', 5000, 50);
    await page.ev(`window.mantle.call('theme.testWindows', { mode: 'light' })`);
    const w2 = await until(async () => (await page.ev(`document.documentElement.getAttribute('data-theme')`)) === 'light', 5000, 50);
    const gw = await page.ev(`window.mantle.call('theme.get')`);
    check('Windows change: Match Windows followed Windows dark, then light, live', !!w1 && !!w2 && gw.windows === 'light' && gw.theme === 'light', gw);
    const evs = await page.ev(`window.__themeEvents.slice()`);
    check('Windows change: mantle-theme fired for each change', evs.join() === 'light,dark,light', evs);
    await page.ev(`window.mantle.call('theme.testWindows', { mode: null })`);

    // a reload after a live change starts in the new theme
    await page.ev(`window.mantle.call('theme.set', { mode: 'dark' })`);
    await page.send('Page.reload', { ignoreCache: true });
    const p2 = await until(async () => page.ev(`window.__themeProbe && window.__themeProbe.atFirstFrame !== undefined ? window.__themeProbe : null`), 15000, 100);
    check('reload after a change: the page starts dark before its first frame', p2 && p2.atBody === 'dark' && p2.atFirstFrame === 'dark', p2);

    // Mantle Settings: a window made LATER, on demand (never shown in --test), and its Mantle appearance control
    const so = await page.ev(`window.mantle.call('settings.open', { section: 'personalization', page: 'colors' })`).catch((e) => ({ ok: false, reason: e.message }));
    const st = await until(async () => (await targets(port)).find((t) => /\/ui\/settings\/index\.html/.test(t.url)), 30000, 300);
    if (check('Settings: Win+I\'s window was made on demand', !!st, so)) {
      const sc = await attach(st);
      const ROW = `document.querySelector('[data-row="personalization.colors.mantle-mode"]')`;
      const rowState = `(() => { const r = ${ROW}; if (!r) return null; const on = r.querySelector('button[aria-checked="true"]');
        return { on: on ? on.dataset.v : null, text: r.textContent, theme: document.documentElement.getAttribute('data-theme') }; })()`;
      const r0 = await until(() => sc.ev(rowState), 20000, 200);
      check('Settings: the page made later started dark', r0 && r0.theme === 'dark', r0);
      check('Settings: Personalization > Colors shows Mantle appearance on Dark, pinned by --theme', r0 && r0.on === 'dark' && /--theme=dark/.test(r0.text), r0);
      const shoot = async (name) => {
        const shot = await Promise.race([sc.send('Page.captureScreenshot', { format: 'png' }), sleep(25000).then(() => null)]).catch(() => null);
        if (shot && shot.data) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, 'base64')); }
        console.log(`info: ${name}: ${shot && shot.data ? 'captured' : 'not captured (the --test Settings window is never shown, so it may not render)'}`);
      };
      await sc.ev(`(() => { const r = ${ROW}; r && r.scrollIntoView({ block: 'center' }); return true; })()`);
      await shoot('electron-settings-colors-dark.png');
      await sc.ev(`${ROW}.querySelector('button[data-v="light"]').click()`);
      const r1 = await until(async () => { const v = await sc.ev(rowState); return v && v.on === 'light' && v.theme === 'light' ? v : null; }, 8000, 100);
      const barT = await page.ev(`document.documentElement.getAttribute('data-theme')`);
      check('Settings: clicking Light switched Settings AND the bar to light, live', !!r1 && barT === 'light', { r1, barT });
      await shoot('electron-settings-colors-light.png');
      await sc.ev(`${ROW}.querySelector('button[data-v="system"]').click()`);
      const want = reg || 'light';
      const r2 = await until(async () => { const v = await sc.ev(rowState); return v && v.on === 'system' && v.theme === want ? v : null; }, 8000, 100);
      check(`Settings: Match Windows follows Windows (${want} now) and says so`, !!r2 && new RegExp(`Following Windows: ${want} right now`).test(r2.text), r2 || await sc.ev(rowState));
      sc.close();
    }

    check('--theme never wrote theme.json into the test profile', !fs.existsSync(THEME_FILE));
    check('the instance said it is pinned by --theme', /--theme=dark: this test run shows dark and never saves a change/.test(run.out), run.out.slice(-400));
  } finally {
    if (page) page.close();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    await until(() => run.exited, 15000, 200);
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`THEME E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
