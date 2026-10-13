'use strict';
/*
 * lib/look.e2e.test.js - LOOK SYNC with Helm and Quartz in a REAL --test instance (lane looksync-e2e,
 * 2026-10-10; spec ~/look-sync/CONTRACT.md sections 2-5; lib/look-host.js, lib/look-desktop.js).
 *
 * One Electron --test instance (invisible: lib/test-quiet.js), profile 'looksync', started WITHOUT
 * --theme (that pins the theme and blocks theme sync): the first-ever seed of an empty shared folder
 * sets Dark. LOOK_SYNC_DIR points at a fresh temp folder; Owen's real %APPDATA%\look-sync is never
 * touched (checked at the end against a before/after snapshot). Through CDP into its own pages only:
 *   1. the seed: look.json schema 1, theme dark, accent null, glass = SEED, writer mantle; every page
 *      dark with NO --lg-* inline overrides;
 *   2. dark no-regression at the seed: bar, topbar and Settings tokens equal the HEAD e6bfcbb numbers;
 *   3. the desktop record after wallpaper.set builtin:snow-peak (still written, JPEG, not larger than
 *      the screen), look.get's view of it, and Windows' wallpaper left alone in a test run;
 *   4. consuming another app's change (fake-writer --app quartz) within 1 s, each timed;
 *   5. Mantle's own changes reaching look.json (look.glass, look.accent, theme.set);
 *   6. the sync switch: off ignores, on adopts the shared value;
 *   7. the status states: corrupt, newer (read only), and the way back;
 *   8. the 'look' event reaching a page as a view.
 *
 *   node lib/look.e2e.test.js      -> "LOOK E2E: n passed, m failed"
 * Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match looksync whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'looksync';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LS_DIR = path.join(os.tmpdir(), 'claude', 'looksync-e2e', 'ls');
const LOOK_FILE = path.join(LS_DIR, 'look.json');
const REAL_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'look-sync');
const FAKE_WRITER = process.env.LOOK_FAKE_WRITER || path.join(os.homedir(), 'look-sync', 'fake-writer.js');
const LS = require('./look-sync');
const accent = require('./accent');

// the dark tokens measured on HEAD e6bfcbb, before look sync; --lg-fill-pop = --lg-fill (.83, Helm's panel) since lane
// mantle-seethru-popups (2026-10-10; it was .88)
const SEED_TOKENS = {
  '--lg-fill-bar': 'rgba(9,10,11,.50)', '--lg-blur': 'blur(5px)', '--lg-fill': 'rgba(19,20,21,.83)',
  '--lg-fill-pop': 'rgba(19,20,21,.83)', '--lg-card': 'rgba(40,41,43,.62)', '--lg-field': 'rgba(10,11,12,.46)', '--lg-acc': '#9fb4cc',
};

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
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
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/([,(])0\./g, '$1.').toLowerCase();
const same = (a, b) => norm(a) === norm(b);

/** A snapshot of Owen's real look-sync folder: existence + every entry's size and mtime. */
function realSnapshot() {
  if (!fs.existsSync(REAL_DIR)) return 'absent';
  const walk = (d) => fs.readdirSync(d).sort().map((n) => {
    const p = path.join(d, n); const s = fs.statSync(p);
    return s.isDirectory() ? `${n}/[${walk(p).join(',')}]` : `${n}:${s.size}:${s.mtimeMs}`;
  });
  return `${fs.statSync(REAL_DIR).mtimeMs}|${walk(REAL_DIR).join(',')}`;
}
function readLook() { try { return JSON.parse(fs.readFileSync(LOOK_FILE, 'utf8')); } catch (_) { return null; } }
function fake(...args) {
  const r = spawnSync(process.execPath, [FAKE_WRITER, '--dir', LS_DIR, '--app', 'quartz', ...args.map(String)], { encoding: 'utf8', timeout: 15000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { LOOK_SYNC_DIR: LS_DIR });
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)

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
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { url: t.url, send, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const pageName = (u) => ((/\/ui\/([^?#]+)/.exec(u) || [])[1] || u).replace(/\/index\.html$/, '');

const TOKENS = `(() => { const cs = getComputedStyle(document.documentElement); const o = {};
  for (const k of ${JSON.stringify(Object.keys(SEED_TOKENS))}) o[k] = cs.getPropertyValue(k).trim();
  const st = document.documentElement.style; const inl = {};
  for (let i = 0; i < st.length; i++) if (st[i].startsWith('--lg-')) inl[st[i]] = st.getPropertyValue(st[i]).trim();
  o.theme = document.documentElement.getAttribute('data-theme'); o.inline = inl; return o; })()`;
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;

async function main() {
  if (gaming()) { console.log('a game is running: the look e2e test refuses to start an instance now'); check('not run: a game is running', false); return; }
  if (!fs.existsSync(FAKE_WRITER)) { check('fake-writer.js is there', false, FAKE_WRITER); return; }
  const realBefore = realSnapshot();
  fs.rmSync(LS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LS_DIR, { recursive: true });
  // a fresh start: no saved theme and no local look copy from an earlier run of this profile
  for (const f of ['theme.json', 'look-sync.json']) { try { fs.unlinkSync(path.join(USER_DATA, f)); } catch (_) { /* none */ } }

  const run = launch();
  const open = [];
  const times = {};
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-800))) return;
    const bt = await until(async () => (await targets(port)).find((t) => /\/ui\/bar\/index\.html/.test(t.url)), 90000, 400);
    if (!check('the bar page is there', !!bt)) return;
    await sleep(2500);
    const bar = await attach(bt); open.push(bar);
    const tt = (await targets(port)).find((t) => /\/ui\/topbar\/index\.html/.test(t.url));
    const top = tt ? await attach(tt) : null; if (top) open.push(top);
    check('the topbar page is there', !!top);
    const so = await bar.ev(call('settings.open', { section: 'personalization', page: 'colors' }));
    const st = await until(async () => (await targets(port)).find((t) => /\/ui\/settings\/index\.html/.test(t.url)), 30000, 300);
    const set = st ? await attach(st) : null; if (set) open.push(set);
    if (!check('Mantle Settings opened (a window made later)', !!set, so)) return;
    await until(() => set.ev(`document.readyState === 'complete'`), 15000, 200);
    const three = [['bar', bar], ['topbar', top], ['settings', set]].filter((x) => x[1]);
    const tokensAll = async () => { const v = await Promise.all(three.map(([, p]) => p.ev(TOKENS))); const o = {}; three.forEach(([n], i) => { o[n] = v[i]; }); return o; };

    /* 1. the seed ------------------------------------------------------------- */
    const doc0 = await until(() => readLook(), 10000, 200);
    check('seed: look.json exists in the temp folder after start', !!doc0, run.out.slice(-600));
    if (doc0) {
      check('seed: schema 1', doc0.schema === 1, doc0.schema);
      check('seed: look.theme dark', doc0.look && doc0.look.theme && doc0.look.theme.v === 'dark', doc0.look);
      check('seed: accent null', doc0.look && doc0.look.accent && doc0.look.accent.v && doc0.look.accent.v.hue === null, doc0.look);
      check('seed: glass is the agreed seed', doc0.look && doc0.look.glass && JSON.stringify(doc0.look.glass.v) === JSON.stringify(LS.SEED.glass), doc0.look && doc0.look.glass);
      check('seed: writer mantle', doc0.writer && doc0.writer.app === 'mantle', doc0.writer);
    }
    const pages = [];
    for (const t of await targets(port)) {
      const p = await attach(t);
      try { pages.push(Object.assign({ page: pageName(t.url) }, await p.ev(TOKENS))); } catch (e) { pages.push({ page: pageName(t.url), error: e.message }); }
      p.close();
    }
    const notDark = pages.filter((p) => p.theme !== 'dark');
    const withInline = pages.filter((p) => !p.inline || Object.keys(p.inline).length);
    console.log(`info: seed pages (${pages.length}): ${pages.map((p) => `${p.page}=${p.theme}`).join(', ')}`);
    check(`seed: every Mantle page (${pages.length}) carries data-theme="dark"`, pages.length > 0 && !notDark.length, notDark.map((p) => `${p.page}=${p.theme}${p.error ? ' ' + p.error : ''}`));
    check('seed: no page has an inline --lg-* override', pages.length > 0 && !withInline.length, withInline.map((p) => `${p.page}: ${JSON.stringify(p.inline)}`));

    /* 2. dark no-regression at the seed ----------------------------------------- */
    const seedTok = await tokensAll();
    for (const [n] of three) {
      const got = seedTok[n];
      const bad = Object.keys(SEED_TOKENS).filter((k) => !same(got[k], SEED_TOKENS[k]));
      check(`seed tokens on ${n} equal HEAD e6bfcbb`, !bad.length, bad.map((k) => `${k}: ${got[k]} (want ${SEED_TOKENS[k]})`));
      console.log(`info: seed tokens ${n}: ${Object.keys(SEED_TOKENS).map((k) => `${k} ${got[k]}`).join('; ')}`);
    }

    /* 3. publish: the desktop record ------------------------------------------- */
    const pick = await bar.ev(call('wallpaper.set', { id: 'builtin:snow-peak' }));
    check('wallpaper.set builtin:snow-peak answered', pick && pick.ok !== false, pick);
    const docD = await until(() => { const d = readLook(); return d && d.desktop && d.desktop.id === 'builtin:snow-peak' && d.desktop.ok ? d : null; }, 25000, 250);
    const D = docD && docD.desktop;
    check('desktop: look.json has the snow-peak record, ok', !!D, readLook() && readLook().desktop);
    if (D) {
      check('desktop: id/type/title', D.id === 'builtin:snow-peak' && D.type === 'builtin' && D.title === 'Snow peak', D);
      check('desktop: file is assets\\backgrounds\\snow-peak.jpg', typeof D.file === 'string' && /assets\\backgrounds\\snow-peak\.jpg$/i.test(D.file), D.file);
      const stillOk = typeof D.still === 'string' && path.dirname(D.still).toLowerCase() === path.join(LS_DIR, 'stills').toLowerCase() && /^wall-\d+\.jpg$/.test(path.basename(D.still));
      check('desktop: still is <tempdir>\\stills\\wall-<n>.jpg', stillOk, D.still);
      let magic = null;
      try { const b = fs.readFileSync(D.still); magic = b.slice(0, 2).toString('hex'); } catch (e) { magic = 'unreadable: ' + e.code; }
      check('desktop: the still exists and starts FF D8 (JPEG)', magic === 'ffd8', magic);
      const scr = await bar.ev(`[Math.round(screen.width * devicePixelRatio), Math.round(screen.height * devicePixelRatio)]`);
      const ss = D.stillSize;
      console.log(`info: still ${JSON.stringify(ss)} for a screen of ${JSON.stringify(scr)} physical px`);
      // cover fit (lib/look-desktop.js coverSize): the limiting dimension is at most the screen; the other
      // may run past it (cropped by the reader's own cover fit), and never bigger than the picture
      const lim = Array.isArray(ss) && ss.length === 2 ? Math.min(ss[0] / scr[0], ss[1] / scr[1]) : NaN;
      check('desktop: stillSize [w,h] is a cover fit, at most the screen in the dimension that limits', Array.isArray(ss) && ss[0] > 0 && ss[1] > 0 && lim <= 1.001, { ss, scr, lim });
    }
    const v3 = await until(async () => { const v = await bar.ev(call('look.get')); return v && v.desktop && v.desktop.ok ? v : null; }, 10000, 250);
    check('look.get: view.desktop.ok and its text names Snow peak', !!v3 && /Snow peak/.test(v3.desktop.text), v3 && v3.desktop);
    check('look.get: view.windows says it is a test run', !!v3 && v3.windows && /test run/i.test(v3.windows.text), v3 && v3.windows);

    /* 4. consume another app's change within 1 s --------------------------------- */
    await bar.ev(`(() => { window.__lsThemeEv = 0; window.addEventListener('mantle-theme', () => { window.__lsThemeEv++; }); return true; })()`);
    async function consume(label, args, probe) {
      const t0 = Date.now();
      const fw = fake(...args);
      const tw = Date.now();
      const got = await until(probe, 3000, 20);
      // timed from the moment the writer's file is down (tw), not from its process start: the fake writer is a
      // whole node process (~100-300 ms on a busy machine), which is not Mantle's latency (1002 ms = 119 + 883)
      const ms = got ? Date.now() - tw : null;
      times[label] = ms === null ? null : `${ms} (writer process ${tw - t0})`;
      check(`consume ${label}: applied within 1 s of the fake-writer call (${ms === null ? 'not within 3 s' : ms + ' ms'})`, ms !== null && ms <= 1000, { fw, writerMs: tw - t0, last: await tokensAll().catch(() => null) });
      return got;
    }
    const allTok = (k, want) => async () => { const t = await tokensAll(); return three.every(([n]) => same(t[n][k], want)) ? t : null; };
    await consume('glass.dark.dim 0.6', ['set', 'glass.dark.dim', 0.6], allTok('--lg-fill-bar', 'rgba(9,10,11,0.6)'));
    check('consume dim: mantle-theme fired in the bar page', (await bar.ev('window.__lsThemeEv')) > 0);
    await consume('glass.dark.blurPx 9', ['set', 'glass.dark.blurPx', 9], allTok('--lg-blur', 'blur(9px)'));
    await consume('glass.dark.panel -0.1', ['set', 'glass.dark.panel', -0.1], allTok('--lg-fill', 'rgba(19,20,21,0.73)'));
    const acc200 = accent.tokens(200, 'dark').acc;
    await consume('accent 200', ['set', 'accent', 200], allTok('--lg-acc', acc200));
    const tA = await tokensAll();
    check(`consume accent 200: --lg-acc is ${acc200}, not #9fb4cc`, !same(tA.bar['--lg-acc'], '#9fb4cc') && same(tA.bar['--lg-acc'], acc200), tA.bar['--lg-acc']);
    await consume('accent null', ['set', 'accent', 'null'], async () => { const t = await tokensAll(); return three.every(([n]) => same(t[n]['--lg-acc'], '#9fb4cc') && !('--lg-acc' in t[n].inline)) ? t : null; });
    // every page stays attached for the theme probes, so a poll costs one evaluate per page, not an attach
    const every = [];
    for (const t of await targets(port)) { const p = await attach(t); open.push(p); every.push(p); }
    const firstSeen = {};   // page -> ms after the fake-writer call that page first showed the new theme
    let themeT0 = 0;
    const themeAll = (want) => async () => {
      if (!themeT0) { themeT0 = Date.now(); for (const k of Object.keys(firstSeen)) delete firstSeen[k]; }
      const out = await Promise.all(every.map((p) => p.ev(`document.documentElement.getAttribute('data-theme')`).catch(() => null)));
      out.forEach((x, i) => { const n = pageName(every[i].url); if (x === want && firstSeen[n] === undefined) firstSeen[n] = Date.now() - themeT0; });
      return out.length && out.every((x) => x === want) ? out : null;
    };
    const themeSpread = () => { const s = Object.entries(firstSeen).sort((a, b) => a[1] - b[1]).map(([n, ms]) => `${n} ${ms}`).join(', '); themeT0 = 0; return s; };
    await consume('theme light', ['set', 'theme', 'light'], themeAll('light'));
    console.log(`info: theme light, ms after the writer exited when each page first showed it: ${themeSpread()}`);
    const tg = await bar.ev(call('theme.get'));
    check('consume theme light: theme.get mode light', tg && tg.mode === 'light', tg);
    await consume('theme dark', ['set', 'theme', 'dark'], themeAll('dark'));
    console.log(`info: theme dark, ms after the writer exited when each page first showed it: ${themeSpread()}`);
    console.log(`info: consume ms: ${Object.entries(times).map(([k, v]) => `${k} ${v === null ? 'n/a' : v}`).join('; ')}`);

    /* 5. Mantle -> shared ----------------------------------------------------- */
    let rev = readLook().rev;
    const g7 = await bar.ev(call('look.glass', { dim: 0.7 }));
    const d7 = await until(() => { const d = readLook(); return d && d.look.glass.v.dark.dim === 0.7 ? d : null; }, 3000, 50);
    check('look.glass {dim:0.7} -> look.json glass.dark.dim 0.7 by mantle, higher rev', !!d7 && d7.look.glass.by === 'mantle' && d7.rev > rev, { g7: g7 && g7.ok, d: d7 && d7.look.glass, rev0: rev, rev: d7 && d7.rev });
    rev = readLook().rev;
    const a212 = await bar.ev(call('look.accent', { hue: 212 }));
    const dA = await until(() => { const d = readLook(); return d && d.look.accent.v.hue === 212 ? d : null; }, 3000, 50);
    check('look.accent {hue:212} -> look.json accent 212 by mantle, higher rev', !!dA && dA.look.accent.by === 'mantle' && dA.rev > rev, { a212: a212 && a212.ok, d: dA && dA.look.accent });
    rev = readLook().rev;
    const themeRev0 = readLook().look.theme.rev;
    const sd = await bar.ev(call('theme.set', { mode: 'dark' }));
    await sleep(1000);
    // the only write allowed meanwhile is Mantle's desktop record (lane guard-mantle: a glass change a moment
    // ago republishes it with a new top-band darkening); the theme itself is not written again
    const dS = readLook();
    check('theme.set dark when already dark -> no theme write (no new rev, or only the desktop record)',
      dS.look.theme.rev === themeRev0 && (dS.rev === rev || (dS.desktop && dS.desktop.rev === dS.rev && dS.writer.app === 'mantle')), { sd, rev0: rev, rev: dS.rev, themeRev0, themeRev: dS.look.theme.rev, desktopRev: dS.desktop && dS.desktop.rev });
    // for comparison with the consume timings: Mantle's OWN theme change (no file, no watcher), call -> every page
    const tOwn = Date.now();
    let ownRet = null;
    const ownCall = bar.ev(call('theme.set', { mode: 'light' })).then((r) => { ownRet = Date.now() - tOwn; return r; });
    const ownSeen = await until(themeAll('light'), 3000, 20);
    const ownMs = ownSeen ? Date.now() - tOwn : null;
    await ownCall;
    console.log(`info: Mantle's own theme.set light (no look sync in the path): the call answered after ${ownRet} ms, every page light ${ownMs} ms after the call; per page ${themeSpread()}`);
    const dL = await until(() => { const d = readLook(); return d && d.look.theme.v === 'light' ? d : null; }, 3000, 50);
    check('theme.set light -> look.theme light by mantle', !!dL && dL.look.theme.by === 'mantle' && dL.rev > rev, dL && dL.look.theme);
    await bar.ev(call('theme.set', { mode: 'dark' }));
    const dD = await until(() => { const d = readLook(); return d && d.look.theme.v === 'dark' ? d : null; }, 3000, 50);
    check('theme.set dark again -> look.theme dark by mantle', !!dD && dD.look.theme.by === 'mantle', dD && dD.look.theme);

    /* 6. the switch ------------------------------------------------------------ */
    const off = await bar.ev(call('look.sync', { on: false }));
    check('look.sync off -> view.sync.state off', off && off.sync && off.sync.state === 'off', off && off.sync);
    const fw8 = fake('set', 'glass.dark.dim', 0.8);
    await sleep(1500);
    const tOff = await tokensAll();
    check('sync off: a fake-writer dim 0.8 is NOT applied (1.5 s)', three.every(([n]) => !same(tOff[n]['--lg-fill-bar'], 'rgba(9,10,11,0.8)')) && same(tOff.bar['--lg-fill-bar'], 'rgba(9,10,11,0.7)'), { fw8, bar: tOff.bar['--lg-fill-bar'] });
    const on = await bar.ev(call('look.sync', { on: true }));
    const got8 = await until(allTok('--lg-fill-bar', 'rgba(9,10,11,0.8)'), 3000, 50);
    check('look.sync on -> the shared dim 0.8 is adopted', !!got8, (await tokensAll()).bar['--lg-fill-bar']);
    const vOn = await bar.ev(call('look.get'));
    check('look.sync on: the view says it is matching the others', vOn && vOn.sync && vOn.sync.state === 'ok' && /matching the others/i.test(`${vOn.sync.reason || ''} ${vOn.sync.text || ''}`), { on: on && on.sync, now: vOn && vOn.sync });

    /* 8 (before 7, while the file is healthy). the 'look' event reaches a page ---- */
    await bar.ev(`(() => { window.__lsLook = []; window.__lsOff = window.mantle.on('look', (v) => { window.__lsLook.push(v); }); return true; })()`);
    await sleep(400);
    const n0 = await bar.ev('window.__lsLook.length');
    fake('set', 'glass.dark.blurPx', 6);
    const evv = await until(async () => { const a = await bar.ev('window.__lsLook'); const v = a.slice(n0).find((x) => x && x.glass && x.glass.blurPx === 6); return v || null; }, 3000, 50);
    check("the 'look' event brings a fake-writer change to the page as a VIEW", !!evv && evv.ok === true && evv.sync && typeof evv.sync.text === 'string', evv);
    await bar.ev('(() => { try { window.__lsOff && window.__lsOff(); } catch (_) {} return true; })()');

    /* 7. status states ------------------------------------------------------- */
    // first let the desktop record settle (lane guard-mantle: the glass the switch just adopted republishes it
    // with a new top-band darkening); a write landing after the corruption would replace its status
    const settled = await until(async () => {
      const d = readLook(); const v = await bar.ev(call('look.get'));
      const g = d && d.desktop && d.desktop.guard && d.desktop.guard.dark, gl = d && d.look.glass && d.look.glass.v.dark;
      return v && v.guard && v.guard.working === false && g && gl && g.dim === gl.dim && g.blurPx === gl.blurPx ? true : null;
    }, 10000, 100);
    check('the desktop record settled on the shared glass before the status checks', !!settled, readLook() && readLook().desktop && readLook().desktop.guard);
    await sleep(300);
    const fc = fake('corrupt');
    const vc = await until(async () => {
      const v = await bar.ev(call('look.get'));
      const s = v && v.sync;
      if (!s) return null;
      if (s.state === 'corrupt') return v;
      if (s.state === 'ok' && /damaged/i.test(`${s.reason || ''} ${s.text || ''}`)) return v;
      return null;
    }, 4000, 50);
    console.log(`info: after corrupt: state ${vc && vc.sync.state}, text "${vc && vc.sync.text}", reason "${vc && vc.sync.reason}"`);
    check('corrupt: state corrupt, or ok with a reason naming the damaged file', !!vc, { fc, now: (await bar.ev(call('look.get'))).sync });
    const bads = fs.readdirSync(LS_DIR).filter((n) => /^look\.json\.bad-/.test(n));
    check('corrupt: a look.json.bad-* copy exists', bads.length > 0, fs.readdirSync(LS_DIR));
    const fn = fake('newer');
    const t0 = Date.now();
    const vn = await until(async () => { const v = await bar.ev(call('look.get')); return v && v.sync && v.sync.state === 'newer' ? v : null; }, 3000, 25);
    times.newer = vn ? Date.now() - t0 : null;
    check(`newer: state newer within 1 s (${times.newer} ms)`, !!vn && times.newer <= 1000, { fn, now: (await bar.ev(call('look.get'))).sync });
    const gN = await bar.ev(call('look.glass', { dim: 0.55 }));
    check('newer: look.glass is refused (ok:false)', gN && gN.ok === false, gN);
    // the way back: remove the newer file, then a Mantle change writes it again
    fs.unlinkSync(LOOK_FILE);
    await sleep(600);
    const vMiss = await bar.ev(call('look.get'));
    let gB = await bar.ev(call('look.glass', { dim: 0.55 }));
    let how = 'deleted look.json, then look.glass';
    check('restore: once the newer file is deleted, look.glass is no longer refused as read only', gB && gB.ok !== false,
      { reason: gB && (gB.reason || gB.threw), stateAfterDelete: vMiss && vMiss.sync });
    if (!gB || gB.ok === false) {
      // look.glass still refused: a theme change from Mantle goes through publish (no read-only gate in look-host)
      how += ` (refused: "${(gB && (gB.reason || gB.threw)) || JSON.stringify(gB)}")`;
      await bar.ev(call('theme.set', { mode: 'light' }));
      await sleep(400);
      await bar.ev(call('theme.set', { mode: 'dark' }));
      await sleep(400);
      gB = await bar.ev(call('look.glass', { dim: 0.55 }));
      how += `, then theme.set light+dark, then look.glass (${gB && gB.ok === false ? 'refused again: ' + (gB.reason || gB.threw) : 'ok'})`;
    }
    const dB = await until(() => { const d = readLook(); return d && d.schema === 1 && d.look.glass && d.look.glass.v.dark.dim === 0.55 ? d : null; }, 3000, 50);
    const vB = await bar.ev(call('look.get'));
    console.log(`info: restore after newer: ${how}; state after delete "${vMiss && vMiss.sync.state}" (${vMiss && vMiss.sync.text}); look.glass ${gB && gB.ok === false ? 'refused: ' + gB.reason : 'ok'}; now ${vB && vB.sync.state}`);
    check('restore: deleting look.json and look.glass brings it back (schema 1, dim 0.55, state ok)', !!dB && vB.sync.state === 'ok', { how, gB: gB && (gB.reason || gB.ok), state: vB && vB.sync });
  } finally {
    for (const p of open) p.close();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    await until(() => run.exited, 15000, 200);
    const realAfter = realSnapshot();
    let who = null;
    try { who = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'look.json'), 'utf8')).writer; } catch (_) { /* none */ }
    check("Owen's real %APPDATA%\\look-sync was not created or modified by the run", realAfter === realBefore, { before: realBefore.slice(0, 200), after: realAfter.slice(0, 200), writer: who });
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`LOOK E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});
