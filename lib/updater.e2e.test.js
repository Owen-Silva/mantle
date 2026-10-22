'use strict';
/*
 * lib/updater.e2e.test.js -- the in-app updater END TO END, in a real --test instance against a local fake
 * release (lane mantle-updater-e2e, 2026-10-22). Nothing reaches GitHub, nothing touches this tree's index
 * or HEAD, and the user's own Mantle and taskbar are never touched.
 *
 *   1. T = a fresh folder in %TEMP%. This tree's CURRENT working files become one commit (a temp
 *      GIT_INDEX_FILE, git add -A, write-tree, commit-tree), fetched into a bare T/origin.git as master and
 *      tag v0.1.0. Release v0.1.1 = one trivial file on top (plumbing in the bare repo, so no hook runs).
 *   2. The user's clone: git clone T/origin.git T/app, reset --hard v0.1.0 (master behind origin/master).
 *      node_modules is a junction to this checkout's own (its real path); the sidecar exe is COPIED in
 *      (MANTLE_SIDECAR_EXE, or this checkout's sidecar/bin: run npm run build:sidecar first).
 *   3. A fake GitHub API on 127.0.0.1 answers releases/latest with v0.1.1 (and an ETag).
 *   4. MANTLE_UPDATE_TEST=T/upd.json points a --test --profile-name=updE2E instance at all that
 *      (lib/features/updates.js, TEST ONLY), first check after 3 s.
 *   5. Over CDP: the banner "Mantle v0.1.1 is out" with Update; updates.state available + canUpdate; PNGs of
 *      the card; a real mouse click on Update; the progress banner; the old main pid exits and a new instance
 *      comes up (DevToolsActivePort rewritten, answering); T/app HEAD = v0.1.1; update-done.json has the
 *      pending record's id; "Mantle updated to v0.1.1" on the new instance; update.log has the ff-only merge
 *      and "the new Mantle is up"; the fake API was asked.
 *   6. Always: tools/kill-test.ps1 -Match updE2E, the restart watcher stopped by PID if still alive, no
 *      electron.exe left on the profile, the junction removed (cmd rmdir) BEFORE T is deleted.
 *
 *   node lib/updater.e2e.test.js   -> "UPDATER E2E TEST: n passed, m failed" (exit 1 on any failure)
 * PNGs of the cards go to MANTLE_SHOT_DIR when it is set (none otherwise).
 * Refuses while a game runs. Never sets MANTLE_TEST_VISIBLE. Heavy: run it through the test queue.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const TREE = path.join(__dirname, '..');
const PROFILE = 'updE2E';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
// what the throwaway clone runs on: this checkout's own packages and sidecar
const DEPS_MODULES = (() => { try { return fs.realpathSync(path.join(TREE, 'node_modules')); } catch (_) { return path.join(TREE, 'node_modules'); } })();
const SIDECAR_SRC = process.env.MANTLE_SIDECAR_EXE ? path.resolve(process.env.MANTLE_SIDECAR_EXE) : path.join(TREE, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
const SHOT_DIR = process.env.MANTLE_SHOT_DIR ? path.resolve(process.env.MANTLE_SHOT_DIR) : null;
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-upd-e2e-'));
const ORIGIN = path.join(T, 'origin.git');
const APP = path.join(T, 'app');
const JUNCTION = path.join(APP, 'node_modules');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
  return ok;
}
const info = (s) => console.log('info: ' + s);
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

// ------------------------------------------------------------------ git
const GIT_ID = { GIT_AUTHOR_NAME: 'updater e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'updater e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' };
function git(cwd, args, extraEnv, input) {
  const env = Object.assign({}, process.env, GIT_ID, extraEnv || {});
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 180000, input, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${out.trim().slice(-400)}`);
  return (r.stdout || '').trim();
}

function buildRepos() {
  // 1a. this tree's working files -> one commit, without touching its index or HEAD
  const idx = path.join(T, 'snap.index');
  git(TREE, ['add', '-A'], { GIT_INDEX_FILE: idx });
  const tree0 = git(TREE, ['write-tree'], { GIT_INDEX_FILE: idx });
  const c0 = git(TREE, ['commit-tree', tree0, '-m', 'Mantle 0.1.0 (updater e2e snapshot of the working tree)']);
  // 1b. a bare origin with it as master + v0.1.0. FETCHED from the bare side (an upload-pack that serves an
  //     unreferenced commit), so no push and no pre-push hook runs in this tree.
  git(T, ['init', '--bare', '-q', ORIGIN]);
  git(ORIGIN, ['fetch', '-q', '--no-tags', '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack', TREE, `${c0}:refs/heads/master`]);
  git(ORIGIN, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  git(ORIGIN, ['update-ref', 'refs/tags/v0.1.0', c0]);
  // 1c. release v0.1.1: one trivial file, no package.json / lock / sidecar change (plumbing: no hooks)
  const blob = git(ORIGIN, ['hash-object', '-w', '--stdin'], null, 'Release 0.1.1 of the updater e2e: one trivial file.\n');
  const idx2 = path.join(T, 'rel.index');
  git(ORIGIN, ['read-tree', c0], { GIT_INDEX_FILE: idx2 });
  git(ORIGIN, ['update-index', '--add', '--cacheinfo', `100644,${blob},UPDATER-E2E-RELEASE.txt`], { GIT_INDEX_FILE: idx2 });
  const tree1 = git(ORIGIN, ['write-tree'], { GIT_INDEX_FILE: idx2 });
  const c1 = git(ORIGIN, ['commit-tree', tree1, '-p', c0, '-m', 'Mantle 0.1.1 (updater e2e release)']);
  git(ORIGIN, ['update-ref', 'refs/heads/master', c1, c0]);
  git(ORIGIN, ['update-ref', 'refs/tags/v0.1.1', c1]);
  // 2. the user's clone, one release behind
  git(T, ['clone', '-q', ORIGIN, APP]);
  git(APP, ['reset', '-q', '--hard', 'v0.1.0']);
  return { c0, c1 };
}

function junction(link, target) {
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw new Error(`mklink /J failed: ${(r.stdout || '') + (r.stderr || '')}`);
}
function unjunction(link) {
  let st = null;
  try { st = fs.lstatSync(link); } catch (_) { return true; }
  if (!st) return true;
  spawnSync('cmd', ['/c', 'rmdir', link], { encoding: 'utf8', timeout: 20000 });
  try { fs.lstatSync(link); return false; } catch (_) { return true; }
}

// ------------------------------------------------------------------ the fake GitHub API
function fakeApi() {
  const api = { hits: 0, notModified: 0, other: [], port: null };
  const ETAG = '"upd-e2e-v0.1.1"';
  const body = JSON.stringify({ tag_name: 'v0.1.1', name: 'Mantle 0.1.1', html_url: 'https://example.invalid/r', target_commitish: 'master' });
  api.server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/repos/o/r/releases/latest') {
      api.hits++;
      if (req.headers['if-none-match'] === ETAG) { api.notModified++; res.writeHead(304, { ETag: ETAG }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: ETAG });
      res.end(body);
      return;
    }
    api.other.push(`${req.method} ${req.url}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"Not Found"}');
  });
  return new Promise((resolve, reject) => {
    api.server.once('error', reject);
    api.server.listen(0, '127.0.0.1', () => { api.port = api.server.address().port; resolve(api); });
  });
}

// ------------------------------------------------------------------ the instance + CDP
const cli = require.resolve('electron/cli.js', { paths: [TREE] });
function launch(updJson) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const env = Object.assign({}, process.env, { MANTLE_UPDATE_TEST: updJson });
  delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'],
    { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
function toback() {
  // async: it waits for the windows to appear; never on the user's screen
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TREE, 'tools', 'toback.ps1'), '-Match', PROFILE],
    { stdio: 'ignore', windowsHide: true });
  return new Promise((r) => { p.on('exit', r); p.on('error', r); });
}
function killTest() {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TREE, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}
function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}
/** electron.exe main processes (no --type=) on the profile -> [pid] (READ only) */
function mainPids() {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--profile-name=${PROFILE}') -and -not $_.CommandLine.Contains('--profile-name=${PROFILE}-') -and -not $_.CommandLine.Contains('--type=') } | ForEach-Object { $_.ProcessId }`);
  return out.split(/\s+/).filter(Boolean).map(Number);
}
function electronsFor() {
  return parseInt(ps(`@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--profile-name=${PROFILE}') -and -not $_.CommandLine.Contains('--profile-name=${PROFILE}-') }).Count`), 10);
}
/** Our own leftovers: the restart watcher (electron as node, its config under USER_DATA) and a sidecar run from T. */
function ownLeftovers() {
  const ud = USER_DATA.replace(/'/g, "''");
  const t = T.replace(/'/g, "''");
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${ud}') -and $_.CommandLine.Contains('update-watch')) -or ($_.Name -eq 'Mantle.Sidecar.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${t}')) } | ForEach-Object { $_.ProcessId }`);
  return out.split(/\s+/).filter(Boolean).map(Number);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } }
function readPort() {
  try {
    const st = fs.statSync(PORT_FILE);
    const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0].trim();
    return /^\d+$/.test(s) ? { port: s, mtime: st.mtimeMs } : null;
  } catch (_) { return null; }
}
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pend = new Map();
  const conn = { dead: false };
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  ws.addEventListener('close', () => { conn.dead = true; for (const p of pend.values()) p.rej(new Error('the page went away')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => {
    if (conn.dead) { rej(new Error('the page went away')); return; }
    const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return Object.assign(conn, { send, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } });
}
const CALL = (name, args) => `(async () => { try { return await window.mantle.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})}); } catch (e) { return { threw: String(e && e.message || e) }; } })()`;
/** The own banner card whose title matches -> its rect, title, actions, progress; or null */
const CARD = (re) => `(() => {
  const re = ${re};
  const el = Array.from(document.querySelectorAll('article.toast')).find((a) => { const t = a.querySelector('.title'); return t && re.test(t.textContent) && !a.hidden; });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const btns = Array.from(el.querySelectorAll('.own-actions .own-btn')).map((b) => ({ action: b.dataset.action, label: b.textContent.trim(), disabled: b.disabled }));
  const pw = el.querySelector('.own-progress');
  return { title: el.querySelector('.title').textContent, body: (el.querySelector('.body') || {}).textContent || '', own: el.classList.contains('own'),
    x: r.x, y: r.y, w: r.width, h: r.height, btns, progress: pw && !pw.hidden ? (pw.textContent || '').trim() : null };
})()`;

async function shoot(page, re, name) {
  try {
    const c = await page.ev(CARD(re));
    if (!c || c.w < 2 || c.h < 2) { info(`${name}: not captured (no card on the page)`); return null; }
    if (!SHOT_DIR) { info(`${name}: not saved (set MANTLE_SHOT_DIR to keep the PNGs)`); return null; }
    const pad = 12;
    const clip = { x: Math.max(0, c.x - pad), y: Math.max(0, c.y - pad), width: c.w + pad * 2, height: c.h + pad * 2, scale: 1 };
    const shot = await Promise.race([page.send('Page.captureScreenshot', { format: 'png', clip }), sleep(20000).then(() => null)]).catch((e) => ({ err: e.message }));
    if (shot && shot.data) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const f = path.join(SHOT_DIR, name);
      fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
      info(`${name}: captured -> ${f} (${fs.statSync(f).size} bytes)`);
      return f;
    }
    info(`${name}: not captured (${shot && shot.err ? shot.err : 'timed out: the --test toasts window is never shown, so it may not render'})`);
  } catch (err) { info(`${name}: not captured (${err.message})`); }
  return null;
}
async function themed(page, re, base) {
  const out = [];
  for (const mode of ['light', 'dark']) {
    const s = await page.ev(CALL('theme.set', { mode })).catch(() => null);
    if (!s || !s.ok) { info(`theme.set ${mode} did not answer ok (${JSON.stringify(s).slice(0, 160)}); shot taken in the current theme`); }
    await sleep(500);
    out.push(await shoot(page, re, `${base}-${mode}.png`));
  }
  await page.ev(CALL('theme.set', { mode: 'system' })).catch(() => null);
  return out;
}

/** a real mouse click (CDP Input) at the button's centre; el.click() only if the mouse did not get through */
async function realClick(page, action) {
  const pos = await page.ev(`(() => { const b = Array.from(document.querySelectorAll('article.toast.own .own-actions .own-btn')).find((x) => x.dataset.action === ${JSON.stringify(action)});
    if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!pos) return { ok: false, how: 'no button' };
  await page.ev(`window.__clicked = 0; document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('.own-btn')) window.__clicked++; }, true); true`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  const got = await until(() => page.ev('window.__clicked > 0'), 1500, 100);
  if (got) return { ok: true, how: 'CDP mouse press/release at the button' };
  await page.ev(`Array.from(document.querySelectorAll('article.toast.own .own-actions .own-btn')).find((x) => x.dataset.action === ${JSON.stringify(action)}).click()`);
  return { ok: true, how: 'element.click() (the CDP mouse did not reach the hidden window)' };
}

async function toastsPage(port, ms) {
  const t = await until(async () => (await targets(port)).find((x) => /\/ui\/toasts\//.test(x.url)), ms, 300);
  return t ? attach(t) : null;
}

// ------------------------------------------------------------------ the run
const S = { run: null, api: null, page: null, page2: null, toback: [] };

async function main() {
  if (gaming()) {
    console.log('SKIPPED: a game is running (no test instances while the user games)');
    return;
  }
  info(`T = ${T}`);
  killTest();
  fs.rmSync(USER_DATA, { recursive: true, force: true });   // our own test profile: a fresh one every run

  // 1 + 2. repos and the clone
  let shas;
  try { shas = buildRepos(); } catch (err) { check('the fake origin and the user\'s clone were made', false, err.message); return; }
  check('the fake origin and the user\'s clone were made', true);
  const c1 = shas.c1;
  try { junction(JUNCTION, DEPS_MODULES); } catch (err) { check('node_modules junction made', false, err.message); return; }
  check('node_modules junction made', fs.existsSync(path.join(JUNCTION, 'electron')));
  fs.mkdirSync(path.join(APP, 'sidecar', 'bin'), { recursive: true });
  if (!check('a sidecar exe to copy in', fs.existsSync(SIDECAR_SRC), `${SIDECAR_SRC} is missing: run npm run build:sidecar, or set MANTLE_SIDECAR_EXE`)) return;
  fs.copyFileSync(SIDECAR_SRC, path.join(APP, 'sidecar', 'bin', 'Mantle.Sidecar.exe'));
  const dirty = git(APP, ['status', '--porcelain', '--untracked-files=no']);
  if (!check('T/app has no uncommitted changes to tracked files', dirty === '', dirty.slice(0, 400))) return;
  const behind = git(APP, ['rev-list', '--count', 'HEAD..origin/master']);
  check('T/app master is one release behind origin/master', behind === '1', behind);
  const head0 = git(APP, ['rev-parse', 'HEAD']);

  // 3. the fake API
  S.api = await fakeApi();
  // 4. the config and the instance
  const updJson = path.join(T, 'upd.json');
  fs.writeFileSync(updJson, JSON.stringify({ apiBase: `http://127.0.0.1:${S.api.port}`, owner: 'o', repo: 'r', cloneUrl: ORIGIN, originUrl: ORIGIN,
    firstMs: 3000, everyMs: 3600000, confirmMs: 90000 }, null, 2));
  S.run = launch(updJson);
  S.toback.push(toback());
  const p1 = await until(readPort, 60000, 250);
  if (!check('the test instance opened a DevTools port', !!p1, S.run.out.slice(-800))) return;
  const port1 = p1.port;
  const mains1 = await until(() => { const m = mainPids(); return m.length ? m : null; }, 20000, 500);
  check('one electron main process on the profile', mains1 && mains1.length === 1, mains1);
  const oldPid = mains1 && mains1[0];

  // 5a. the banner
  S.page = await toastsPage(port1, 45000);
  if (!check('the toasts page is up (a /ui/toasts/ target)', !!S.page, S.run.out.slice(-800))) return;
  const card = await until(() => S.page.ev(CARD('/^Mantle v0\\.1\\.1 is out$/')), 45000, 250);
  if (!check('the banner shows "Mantle v0.1.1 is out"', !!card, { toasts: await S.page.ev(CALL('toasts.state')).catch((e) => e.message), log: S.run.out.slice(-600) })) return;
  check('it is Mantle\'s own banner with an Update button (and Later)', card.own && card.btns.some((b) => b.action === 'update' && b.label === 'Update' && !b.disabled)
    && card.btns.some((b) => b.action === 'later'), card);
  const st = await S.page.ev(CALL('updates.state'));
  const v = st && st.view;
  check('updates.state: status available, canUpdate true, release v0.1.1', v && v.status === 'available' && v.canUpdate === true && v.release && v.release.tag === 'v0.1.1', st);
  check('updates.state: the tag commit is the v0.1.1 commit', v && v.sha === c1, { sha: v && v.sha, c1 });
  await themed(S.page, '/^Mantle v0\\.1\\.1 is out$/', 'updater-available');

  // 5b. click Update, watch the progress
  await S.page.ev(`(() => { window.__seen = []; const look = () => { document.querySelectorAll('article.toast .title').forEach((t) => {
      const s = t.textContent; const p = t.closest('article').querySelector('.own-progress'); const w = p && !p.hidden ? p.textContent.trim() : '';
      const k = s + ' | ' + w; if (window.__seen.indexOf(k) < 0) window.__seen.push(k); }); };
    look(); new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true }); return true; })()`);
  const tClick = Date.now();
  const clicked = await realClick(S.page, 'update');
  check('Update was clicked on the page', clicked.ok, clicked);
  info(`click: ${clicked.how}`);
  let seen = [];
  let pending = null;
  let stateUpdating = null;
  const pendingFile = path.join(USER_DATA, 'update-pending.json');
  const doneFile = path.join(USER_DATA, 'update-done.json');
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (!pending) { try { const j = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); if (j && j.id) pending = j; } catch (_) { /* not yet */ } }
    if (!S.page.dead) {
      try { const s = await S.page.ev('window.__seen'); if (Array.isArray(s)) seen = s; } catch (_) { /* the page is going */ }
      if (stateUpdating === null) { try { const s = await S.page.ev(CALL('updates.state')); if (s && s.updating) stateUpdating = s; } catch (_) { /* going */ } }
    }
    if (oldPid && !alive(oldPid)) break;
    await sleep(60);
  }
  if (!pending) { try { const j = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); if (j && j.id) pending = j; } catch (_) { /* gone */ } }
  const progressSeen = seen.some((s) => /^Updating Mantle to v0\.1\.1 \|/.test(s));
  check('a progress state was seen (banner "Updating Mantle to v0.1.1", or updates.state.updating)', progressSeen || !!stateUpdating, { seen, stateUpdating });
  info(`banner states seen: ${JSON.stringify(seen).slice(0, 600)}`);
  check('the old electron main pid exited', oldPid && !alive(oldPid), { oldPid, log: S.run.out.slice(-800) });
  check('a pending record was written before the restart', !!pending, pending);
  try { S.page.close(); } catch (_) { /* gone */ }

  // 5c. the new instance
  const p2 = await until(() => { const p = readPort(); return p && p.mtime >= tClick ? p : null; }, 90000, 200);
  check('DevToolsActivePort was rewritten by a new instance', !!p2, { p1, now: readPort() });
  let port2 = p2 && p2.port;
  if (p2) S.toback.push(toback());
  const answers = port2 ? await until(async () => { const r = await fetch(`http://127.0.0.1:${port2}/json/version`, { signal: AbortSignal.timeout(3000) }); return r.ok; }, 30000, 300) : null;
  check('the new instance\'s DevTools port answers', !!answers, { port2 });
  const mains2 = mainPids();
  check('a NEW electron main process is up (not the old pid)', mains2.length === 1 && mains2[0] !== oldPid, { oldPid, mains2 });
  if (answers) {
    S.page2 = await toastsPage(port2, 30000);
    const upd = S.page2 ? await until(() => S.page2.ev(CARD('/^Mantle updated to v0\\.1\\.1$/')), 14000, 150) : null;
    check('the new instance shows "Mantle updated to v0.1.1"', !!upd, S.page2 ? await S.page2.ev(CALL('toasts.state')).catch((e) => e.message) : 'no toasts page on the new instance');
    if (upd) await themed(S.page2, '/^Mantle updated to v0\\.1\\.1$/', 'updater-updated');
    const st2 = S.page2 ? await S.page2.ev(CALL('updates.state')).catch(() => null) : null;
    info(`new instance updates.state: ${JSON.stringify(st2 && { view: st2.view && { status: st2.view.status, reason: st2.view.reason }, posted: st2.posted, updating: st2.updating })}`);
  }

  // 5d. the files
  const head1 = git(APP, ['rev-parse', 'HEAD']);
  check('T/app HEAD is the v0.1.1 commit', head1 === c1, { head0, head1, c1 });
  check('T/app is still on master, clean', git(APP, ['symbolic-ref', '--short', 'HEAD']) === 'master' && git(APP, ['status', '--porcelain', '--untracked-files=no']) === '');
  const done = await until(() => { try { return JSON.parse(fs.readFileSync(doneFile, 'utf8')); } catch (_) { return null; } }, 10000, 200);
  check('update-done.json carries the pending record\'s id', !!done && !!pending && done.id === pending.id, { done, pendingId: pending && pending.id });
  check('the done record is from the new main process', !!done && mains2.includes(Number(done.pid)), { done, mains2 });
  const logFile = path.join(USER_DATA, 'update.log');
  const log = await until(() => { const s = fs.readFileSync(logFile, 'utf8'); return /the new Mantle is up/.test(s) ? s : null; }, 20000, 300)
    || (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch (_) { return ''; } })();
  check('update.log has the ff-only merge (exit 0)', /git merge --ff-only [0-9a-f]{7}: exit 0/.test(log), log.slice(-800));
  check('update.log says "the new Mantle is up"', /the new Mantle is up/.test(log), log.slice(-800));
  check('update.log says no npm install and no sidecar build were needed', /npm install not needed; sidecar build not needed/.test(log), log.slice(-800));
  check('the fake API was asked at least once', S.api.hits >= 1, { hits: S.api.hits, other: S.api.other });
  info(`fake API: ${S.api.hits} request(s), ${S.api.notModified} answered 304; others: ${JSON.stringify(S.api.other)}`);
}

async function cleanup() {
  try { if (S.page) S.page.close(); } catch (_) { /* gone */ }
  try { if (S.page2) S.page2.close(); } catch (_) { /* gone */ }
  info('kill-test: ' + killTest().replace(/\s+/g, ' ').slice(0, 300));
  await sleep(1500);
  for (const pid of ownLeftovers()) {
    try { process.kill(pid); info(`stopped our own leftover pid ${pid} (restart watcher or sidecar from T)`); } catch (err) { info(`could not stop pid ${pid}: ${err.message}`); }
  }
  await Promise.race([Promise.all(S.toback), sleep(15000)]);
  if (S.api) await new Promise((r) => S.api.server.close(r));
  await sleep(500);
  const left = electronsFor();
  check('cleanup: no electron.exe left with --profile-name=updE2E', left === 0, `count=${left}`);
  const unj = unjunction(JUNCTION);
  check('cleanup: the node_modules junction was removed (rmdir)', unj);
  if (unj) {
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { /* a file still held: try again */ }
      gone = !fs.existsSync(T);
      if (!gone) await sleep(1500);
    }
    check('cleanup: T was removed', gone, T);
  } else {
    info(`T was NOT removed because the junction is still there: ${JUNCTION}`);
  }
}

main().catch((err) => { check('the run itself did not throw', false, err && err.stack); })
  .then(() => cleanup())
  .catch((err) => { check('cleanup did not throw', false, err && err.stack); })
  .finally(() => {
    for (const f of failures) console.log('FAIL ' + f);
    console.log(`UPDATER E2E TEST: ${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  });
