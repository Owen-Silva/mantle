'use strict';
/*
 * lib/updater.e2e.test.js -- the in-app updater END TO END, in real --test instances against a local fake
 * release (lane mantle-updater-e2e, 2026-10-22; scenarios chain and neverup, lane mantle-verify, the same day).
 * Nothing reaches GitHub or the npm registry, nothing touches this tree's index or HEAD, and the user's own
 * Mantle and taskbar are never touched.
 *
 * SETUP. T = a fresh folder in %TEMP%. This tree's CURRENT working files become one commit c0 (a temp
 * GIT_INDEX_FILE, git add -A, write-tree, commit-tree), fetched into a bare T/origin.git as master and tag
 * v0.1.0. Each release is a commit on top of c0 made with plumbing in the bare repo (so no hook runs), tagged
 * there. A fake GitHub API on 127.0.0.1 answers releases/latest with whichever release the scenario is on.
 * MANTLE_UPDATE_TEST=<json> points a --test --profile-name=updE2E instance at all that (lib/features/updates.js,
 * TEST ONLY). The sidecar exe is COPIED into each clone (MANTLE_SIDECAR_EXE, or this checkout's sidecar/bin:
 * run npm run build:sidecar first).
 *
 * SCENARIOS (all by default; --only=plain,chain,neverup picks):
 *   plain    v0.1.1 = one trivial file. node_modules is a junction to this checkout's own (its real path),
 *            which is safe ONLY because nothing installs: the log must say "npm install not needed".
 *            Banner "Mantle v0.1.1 is out" with Update; a real mouse click; progress; the old main pid exits,
 *            a new instance comes up; HEAD = v0.1.1; update-done.json has the pending record's id;
 *            "Mantle updated to v0.1.1" on the new instance. PNGs light + dark of both banners.
 *   chain    ONE instance, three releases in a row, in a clone whose node_modules is a REAL copy (this
 *            checkout's packages without electron/dist, which the instance runs from this checkout) and an
 *            untracked .npmrc with offline=true, so npm can never reach the network:
 *              v0.2.1 adds a sidecar .cs that does not compile: build:sidecar runs and fails;
 *              v0.2.2 adds a local package whose install script fails: npm install runs and fails;
 *              v0.2.3 adds a good local package (package.json + package-lock.json) AND a sidecar .cs:
 *                     npm install and build:sidecar both run, the new sidecar is swapped in, Mantle restarts.
 *            Each failure must roll back (HEAD c0, clean, the old sidecar, no staged exe, the old packages) and
 *            keep the SAME process running with the reason on the banner; OK takes it down; the next release
 *            is found with updates.check. PNGs of both failure banners and the "updated" banner.
 *   neverup  v0.3.1's main.js exits at once, so the new Mantle never says it is up. The restart watcher waits
 *            confirmMs (20 s here), writes update-failed.json and, this being a --test run, never runs the
 *            restore script and shows no message box (asserted from its config and its log). Then, as the
 *            user would, git reset --keep back to v0.1.0 and start Mantle again by hand: it shows "The update
 *            to v0.3.1 did not start", OK clears the record. PNGs of that banner.
 *            Then (lane mantle-failed-release, 2026-10-23) the durable record: update-failed-release.json
 *            outlives that OK; updates.check warns "Mantle v0.3.1 did not start last time" with the reason and
 *            Try again / Skip this version (PNGs light + dark); a real click on Skip takes it down and is kept on
 *            disk; the next check answers "skipped" with no banner; v0.3.2 is published, the check offers it
 *            plainly and the record is gone.
 * ALWAYS: tools/kill-test.ps1 -Match updE2E, the restart watcher and any sidecar run from T stopped by PID,
 * no electron.exe left on the profile, every junction removed (cmd rmdir) BEFORE T is deleted.
 *
 *   node lib/updater.e2e.test.js [--only=plain,chain,neverup]   -> "UPDATER E2E TEST: n passed, m failed"
 * PNGs go to MANTLE_SHOT_DIR when it is set (else into T, checked for "not blank" and deleted with it).
 * Refuses while a game runs. Never sets MANTLE_TEST_VISIBLE. Heavy: run it through the test queue.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const TREE = path.join(__dirname, '..');
const PROFILE = 'updE2E';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
// what the throwaway clones run on: this checkout's own packages and sidecar
const DEPS_MODULES = (() => { try { return fs.realpathSync(path.join(TREE, 'node_modules')); } catch (_) { return path.join(TREE, 'node_modules'); } })();
const SIDECAR_SRC = process.env.MANTLE_SIDECAR_EXE ? path.resolve(process.env.MANTLE_SIDECAR_EXE) : path.join(TREE, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-upd-e2e-'));
const SHOT_DIR = process.env.MANTLE_SHOT_DIR ? path.resolve(process.env.MANTLE_SHOT_DIR) : path.join(T, 'shots');
const ORIGIN = path.join(T, 'origin.git');
const ONLY = ((process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)).split(',').map((s) => s.trim()).filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''));
  return ok;
}
const info = (s) => console.log('info: ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => String(s || '').slice(0, 7);
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
function race(p, ms) { return Promise.race([p, sleep(ms).then(() => ({ timedOut: true }))]).catch((e) => ({ err: e.message })); }
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };   // a dangling link too
const inside = (p, dir) => path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);

// ------------------------------------------------------------------ git
const GIT_ID = { GIT_AUTHOR_NAME: 'updater e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'updater e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' };
function git(cwd, args, extraEnv, input) {
  const env = Object.assign({}, process.env, GIT_ID, extraEnv || {});
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 180000, input, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${out.trim().slice(-400)}`);
  return (r.stdout || '').trim();
}

/** This tree's working files -> c0 in a bare T/origin.git (master + v0.1.0), without touching its index or HEAD. */
function snapshot() {
  const idx = path.join(T, 'snap.index');
  git(TREE, ['add', '-A'], { GIT_INDEX_FILE: idx });
  const tree0 = git(TREE, ['write-tree'], { GIT_INDEX_FILE: idx });
  const c0 = git(TREE, ['commit-tree', tree0, '-m', 'Mantle 0.1.0 (updater e2e snapshot of the working tree)']);
  // FETCHED from the bare side (an upload-pack that serves an unreferenced commit): no push, no pre-push hook
  git(T, ['init', '--bare', '-q', ORIGIN]);
  git(ORIGIN, ['fetch', '-q', '--no-tags', '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack', TREE, `${c0}:refs/heads/master`]);
  git(ORIGIN, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  git(ORIGIN, ['update-ref', 'refs/tags/v0.1.0', c0]);
  return c0;
}
let relN = 0;
/** A release: c0 plus `files` ({ path: text }), committed and tagged in the bare repo with plumbing (no hooks). */
function release(c0, tag, files) {
  const idx = path.join(T, `rel-${++relN}.index`);
  git(ORIGIN, ['read-tree', c0], { GIT_INDEX_FILE: idx });
  for (const [rel, text] of Object.entries(files)) {
    const blob = git(ORIGIN, ['hash-object', '-w', '--stdin'], null, text);
    git(ORIGIN, ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { GIT_INDEX_FILE: idx });
  }
  const tree = git(ORIGIN, ['write-tree'], { GIT_INDEX_FILE: idx });
  const c = git(ORIGIN, ['commit-tree', tree, '-p', c0, '-m', `Mantle ${tag} (updater e2e release)`]);
  git(ORIGIN, ['update-ref', `refs/tags/${tag}`, c]);
  return c;
}
/** The user's clone at v0.1.0, on master, origin = the bare repo, the way `git clone` leaves it; the sidecar copied in. */
function cloneApp(name) {
  const dir = path.join(T, name);
  git(T, ['clone', '-q', ORIGIN, dir]);
  fs.mkdirSync(path.join(dir, 'sidecar', 'bin'), { recursive: true });
  fs.copyFileSync(SIDECAR_SRC, path.join(dir, 'sidecar', 'bin', 'Mantle.Sidecar.exe'));
  return dir;
}
const clean = (dir) => git(dir, ['status', '--porcelain', '--untracked-files=no']);
const headOf = (dir) => git(dir, ['rev-parse', 'HEAD']);

// ------------------------------------------------------------------ node_modules
const JUNCTIONS = [];
function junction(link, target) {
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw new Error(`mklink /J failed: ${(r.stdout || '') + (r.stderr || '')}`);
  JUNCTIONS.push(link);
}
function unjunction(link) {
  try { fs.lstatSync(link); } catch (_) { return true; }
  spawnSync('cmd', ['/c', 'rmdir', link], { encoding: 'utf8', timeout: 20000 });
  try { fs.lstatSync(link); return false; } catch (_) { return true; }
}
/** A REAL copy of this checkout's packages for a clone npm will install in (never the shared folder itself).
    electron/dist is left out: the instance runs this checkout's electron.exe, and npm reads only package.json. */
function copyModules(dest) {
  if (!inside(dest, T)) throw new Error(`refusing to copy packages outside T: ${dest}`);
  const r = spawnSync('robocopy', [DEPS_MODULES, dest, '/E', '/XD', path.join(DEPS_MODULES, 'electron', 'dist'), '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { encoding: 'utf8', timeout: 300000, windowsHide: true });
  if (r.status === null || r.status >= 8) throw new Error(`robocopy exited ${r.status}: ${(r.stdout || '').slice(-300)}`);
  const st = fs.lstatSync(dest);
  if (st.isSymbolicLink()) throw new Error('the copy is a link, not a folder');
}

// ------------------------------------------------------------------ the fake GitHub API
function fakeApi() {
  const api = { hits: 0, notModified: 0, other: [], port: null, tag: null };
  api.set = (tag) => { api.tag = tag; };
  api.server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/repos/o/r/releases/latest' && api.tag) {
      api.hits++;
      const etag = `"upd-e2e-${api.tag}"`;
      if (req.headers['if-none-match'] === etag) { api.notModified++; res.writeHead(304, { ETag: etag }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
      res.end(JSON.stringify({ tag_name: api.tag, name: `Mantle ${api.tag.slice(1)}`, html_url: 'https://example.invalid/r', target_commitish: 'master' }));
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
function updJson(name, extra) {
  const f = path.join(T, `upd-${name}.json`);
  fs.writeFileSync(f, JSON.stringify(Object.assign({ apiBase: `http://127.0.0.1:${S.api.port}`, owner: 'o', repo: 'r', cloneUrl: ORIGIN, originUrl: ORIGIN,
    firstMs: 3000, everyMs: 3600000, confirmMs: 90000, updatedShowMs: 120000 }, extra || {}), null, 2));
  return f;
}

// ------------------------------------------------------------------ the instance + CDP
const cli = require.resolve('electron/cli.js', { paths: [TREE] });
function launch(cwd, upd) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const env = Object.assign({}, process.env, { MANTLE_UPDATE_TEST: upd });
  delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
  // MANTLE_SIDECAR_EXE is THIS script's input (the exe copied into each clone). Left in the env, Mantle runs that
  // file instead of the clone's sidecar/bin, and the update's swap of a running sidecar is never exercised.
  delete env.MANTLE_SIDECAR_EXE;
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
function toback() {
  // async: it waits for the windows to appear; never on the user's screen
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TREE, 'tools', 'toback.ps1'), '-Match', PROFILE],
    { stdio: 'ignore', windowsHide: true });
  S.toback.push(new Promise((r) => { p.on('exit', r); p.on('error', r); }));
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
function ownLeftovers(only) {
  const ud = USER_DATA.replace(/'/g, "''");
  const t = T.replace(/'/g, "''");
  const watcher = `($_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${ud}') -and $_.CommandLine.Contains('update-watch'))`;
  const sidecar = `($_.Name -eq 'Mantle.Sidecar.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${t}'))`;
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { ${only === 'watcher' ? watcher : only === 'sidecar' ? sidecar : `${watcher} -or ${sidecar}`} } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`);
  return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, exe] = l.split('|'); return { pid: Number(pid), exe: exe || '' }; });
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
  const conn = { dead: false, tid: t.id };
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
  const c = Object.assign(conn, { send, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } });
  S.conns.push(c);
  return c;
}
/** The banner page now (its window closes 30 s after its last banner and a new one comes with the next). */
async function toastsNow(port) {
  if (S.tp && !S.tp.dead && S.tp.port === port) return S.tp;
  const t = (await targets(port).catch(() => [])).find((x) => /\/ui\/toasts\//.test(x.url));
  if (!t) return null;
  S.tp = await attach(t);
  S.tp.port = port;
  return S.tp;
}
/** A page that stays up (the desktop or the bar) for mantle.call: the banner page comes and goes. */
async function ctlNow(port) {
  if (S.ctl && !S.ctl.dead && S.ctl.port === port) return S.ctl;
  const list = await targets(port).catch(() => []);
  const t = list.find((x) => /\/ui\/desktop\//.test(x.url)) || list.find((x) => /\/ui\/bar\//.test(x.url)) || list.find((x) => !/\/ui\/toasts\//.test(x.url));
  if (!t) return null;
  S.ctl = await attach(t);
  S.ctl.port = port;
  return S.ctl;
}
const CALL = (name, args) => `(async () => { try { return await window.mantle.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})}); } catch (e) { return { threw: String(e && e.message || e) }; } })()`;
async function call(port, name, args) { const c = await ctlNow(port); return c ? c.ev(CALL(name, args)).catch((e) => ({ threw: e.message })) : { threw: 'no Mantle page to call from' }; }
/** The own banner card whose title matches -> its rect, title, body, detail, actions, progress; or null */
const CARD = (re) => `(() => {
  const re = ${re};
  const el = Array.from(document.querySelectorAll('article.toast')).find((a) => { const t = a.querySelector('.title'); return t && re.test(t.textContent) && !a.hidden; });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const btns = Array.from(el.querySelectorAll('.own-actions .own-btn')).map((b) => ({ action: b.dataset.action, label: b.textContent.trim(), disabled: b.disabled }));
  const pw = el.querySelector('.own-progress');
  return { title: el.querySelector('.title').textContent, body: (el.querySelector('.body') || {}).textContent || '', detail: (el.querySelector('.own-detail') || {}).textContent || '',
    own: el.classList.contains('own'), x: r.x, y: r.y, w: r.width, h: r.height, btns, progress: pw && !pw.hidden ? (pw.textContent || '').trim() : null };
})()`;
/** Wait on the page until the card has come in (class "in", opacity 1, its own transitions over), then two frames. */
const SETTLE = (re) => `(async () => {
  const re = ${re};
  const find = () => Array.from(document.querySelectorAll('article.toast')).find((a) => { const t = a.querySelector('.title'); return t && re.test(t.textContent) && !a.hidden; });
  const t0 = performance.now();
  let el = find();
  while (performance.now() - t0 < 5000) {
    el = find();
    if (el) {
      const busy = el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations !== Infinity);
      if (el.classList.contains('in') && getComputedStyle(el).opacity === '1' && !busy.length) break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return el ? { in: el.classList.contains('in'), opacity: getComputedStyle(el).opacity, theme: document.documentElement.dataset.theme } : null;
})()`;
async function findCard(port, re, ms, pred) {
  return until(async () => {
    const p = await toastsNow(port);
    if (!p) return null;
    const c = await p.ev(CARD(re));
    return c && (!pred || pred(c)) ? { page: p, card: c } : null;
  }, ms, 250);
}

/** Does the PNG hold a picture (many different byte values once inflated), or is it blank? */
function pngVaried(buf) {
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return false;
    const idat = [];
    for (let o = 8; o < buf.length;) {
      const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o + 4, o + 8);
      if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
      o += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const seen = new Set();
    for (let i = 0; i < raw.length && seen.size < 64; i += 7) seen.add(raw[i]);
    return seen.size >= 32;
  } catch (_) { return false; }
}
async function shoot(page, re, name) {
  const c = await page.ev(CARD(re)).catch(() => null);
  if (!c || c.w < 2 || c.h < 2) return { name, why: 'no card on the page' };
  const pad = 12;
  const clip = { x: Math.max(0, c.x - pad), y: Math.max(0, c.y - pad), width: c.w + pad * 2, height: c.h + pad * 2, scale: 1 };
  const shot = await race(page.send('Page.captureScreenshot', { format: 'png', clip }), 20000);
  if (!shot || !shot.data) return { name, why: shot && shot.err ? shot.err : 'timed out' };
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const f = path.join(SHOT_DIR, name);
  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(f, buf);
  return { name, file: f, bytes: buf.length, varied: pngVaried(buf) };
}
/** Light and dark PNGs of one card. The --test banner window is otherwise never shown, and Chromium paints no
    frames for a window that was never shown (the blank PNG of the first run): toasts.testReveal shows it the
    lib/test-quiet.js way (layered alpha 0, click-through, never activates), so its page runs real frames. */
async function themed(port, re, base) {
  const p = await toastsNow(port);
  const rv = p ? await p.ev(CALL('toasts.testReveal')).catch((e) => ({ ok: false, reason: e.message })) : { ok: false, reason: 'no banner page' };
  check(`${base}: the banner window is shown the test-quiet way for the photos`, rv && rv.ok && rv.visible === true, rv);
  toback();
  for (const mode of ['light', 'dark']) {
    const s = await call(port, 'theme.set', { mode });
    const page = await toastsNow(port);
    const got = page ? await until(() => page.ev(`document.documentElement.dataset.theme === ${JSON.stringify(mode)}`), 5000, 100) : null;
    check(`${base}: the banner page is in ${mode}`, !!got, s);
    const st = page ? await race(page.ev(SETTLE(re)), 8000) : null;
    const shot = page ? await shoot(page, re, `${base}-${mode}.png`) : { why: 'no banner page' };
    check(`${base}-${mode}.png: captured, and not blank`, !!(shot.file && shot.varied), Object.assign({ settle: st }, shot));
    info(`${base}-${mode}.png: ${shot.file ? `${shot.file} (${shot.bytes} bytes${shot.varied ? '' : ', BLANK'})` : `not captured (${shot.why})`}`);
  }
  await call(port, 'theme.set', { mode: 'system' });
}

/** a real mouse click (CDP Input) at the button's centre; el.click() only if the mouse did not get through */
async function realClick(page, action) {
  const pos = await page.ev(`(() => { const b = Array.from(document.querySelectorAll('article.toast.own .own-actions .own-btn')).find((x) => x.dataset.action === ${JSON.stringify(action)});
    if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!pos) return { ok: false, how: 'no button' };
  await page.ev(`window.__clicked = 0; if (!window.__clickHook) { window.__clickHook = 1; document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('.own-btn')) window.__clicked++; }, true); } true`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  const got = await until(() => page.ev('window.__clicked > 0'), 1500, 100);
  if (got) return { ok: true, how: 'CDP mouse press/release at the button' };
  await page.ev(`Array.from(document.querySelectorAll('article.toast.own .own-actions .own-btn')).find((x) => x.dataset.action === ${JSON.stringify(action)}).click()`);
  return { ok: true, how: 'element.click() (the CDP mouse did not reach the hidden window)' };
}
const SEEN = `(() => { window.__seen = []; const look = () => { document.querySelectorAll('article.toast .title').forEach((t) => {
    const s = t.textContent; const p = t.closest('article').querySelector('.own-progress'); const w = p && !p.hidden ? p.textContent.trim() : '';
    const k = s + ' | ' + w; if (window.__seen.indexOf(k) < 0) window.__seen.push(k); }); };
  look(); new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true }); return true; })()`;
const reOf = (s) => `/^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$/`;

// ------------------------------------------------------------------ one instance
const S = { api: null, run: null, conns: [], tp: null, ctl: null, toback: [] };
/** Start a --test instance in `cwd` -> { port, pid } or null (the checks say why). */
async function start(label, cwd, upd, opts) {
  if (!(opts && opts.keepProfile)) fs.rmSync(USER_DATA, { recursive: true, force: true });   // our own test profile
  S.run = launch(cwd, upd);
  toback();
  const p = await until(readPort, 60000, 250);
  if (!check(`${label}: the test instance opened a DevTools port`, !!p, S.run.out.slice(-800))) return null;
  const mains = await until(() => { const m = mainPids(); return m.length ? m : null; }, 20000, 500);
  check(`${label}: one electron main process on the profile`, mains && mains.length === 1, mains);
  return { port: p.port, pid: mains && mains[0], t0: p.mtime };
}
async function stop(label) {
  for (const c of S.conns.splice(0)) c.close();
  S.tp = null; S.ctl = null;
  const k = killTest();
  info(`${label}: kill-test: ${k.replace(/\s+/g, ' ').slice(0, 200)}`);
  await sleep(1500);
  for (const l of ownLeftovers()) {
    try { process.kill(l.pid); info(`${label}: stopped our own leftover pid ${l.pid} (${l.exe || 'restart watcher'})`); } catch (err) { info(`could not stop pid ${l.pid}: ${err.message}`); }
  }
  await sleep(500);
}
/** Click Update on the "is out" banner and watch the progress until `done()` says so. -> { seen, stateUpdating, tClick } */
async function clickUpdate(label, port, tag, done, ms) {
  const found = await findCard(port, reOf(`Mantle ${tag} is out`), 45000, (c) => c.btns.some((b) => b.action === 'update' && !b.disabled));
  if (!check(`${label}: the banner shows "Mantle ${tag} is out" with an enabled Update button`, !!found, await call(port, 'toasts.state'))) return null;
  const page = found.page;
  await page.ev(SEEN).catch(() => null);
  const tClick = Date.now();
  const clicked = await realClick(page, 'update');
  check(`${label}: Update was clicked on the page`, clicked.ok, clicked);
  info(`${label}: click: ${clicked.how}`);
  let seen = [];
  let stateUpdating = null;
  const end = Date.now() + (ms || 120000);
  while (Date.now() < end) {
    if (!page.dead) { try { const s = await page.ev('window.__seen'); if (Array.isArray(s)) seen = s; } catch (_) { /* the page is going */ } }
    if (stateUpdating === null && S.ctl && !S.ctl.dead) { try { const s = await S.ctl.ev(CALL('updates.state')); if (s && s.updating) stateUpdating = s; } catch (_) { /* going */ } }
    if (await done()) break;
    await sleep(100);
  }
  info(`${label}: banner states seen: ${JSON.stringify(seen).slice(0, 700)}`);
  return { seen, stateUpdating, tClick };
}
/** After a click whose update must FAIL: the failure banner, the same process, everything rolled back. */
async function expectFailure(label, inst, app, c0, tag, bodyRe, extra) {
  let card = null;
  const w = await clickUpdate(label, inst.port, tag, async () => {
    const f = await findCard(inst.port, '/^Mantle was not updated$/', 400, (c) => bodyRe.test(c.body)).catch(() => null);
    if (f) card = f.card;
    return !!card || !alive(inst.pid);
  }, 240000);
  if (!w) return false;
  check(`${label}: progress was shown (banner "Updating Mantle to ${tag}", or updates.state.updating)`, w.seen.some((s) => s.startsWith(`Updating Mantle to ${tag} |`)) || !!w.stateUpdating, w);
  if (!check(`${label}: the failure banner "Mantle was not updated" says why`, !!card, { state: await call(inst.port, 'updates.state'), out: S.run.out.slice(-600) })) return false;
  info(`${label}: the banner says: ${card.body} | ${card.detail}`);
  check(`${label}: ...that the old version is still on and keeps running, with the log path, without repeating the title`, !/^Mantle was not updated/.test(card.body) && card.body.includes(`Mantle is still on ${short(c0)} and keeps running.`) && !/ But: /.test(card.body) && /Log: .*update\.log/.test(card.detail), card);
  check(`${label}: ...with an OK button`, card.btns.some((b) => b.action === 'ok' && !b.disabled), card.btns);
  check(`${label}: the SAME main process is still running (pid ${inst.pid})`, alive(inst.pid) && mainPids().join() === String(inst.pid), { pid: inst.pid, mains: mainPids() });
  const ans = await until(async () => (await fetch(`http://127.0.0.1:${inst.port}/json/version`, { signal: AbortSignal.timeout(3000) })).ok, 5000, 300);
  check(`${label}: ...and still answering (DevTools port ${inst.port})`, !!ans);
  const st = await call(inst.port, 'updates.state');
  check(`${label}: updates.state: not updating, the failure kept, rolled back`, st && st.updating === false && st.failure && st.failure.rolledBack === true, st);
  check(`${label}: HEAD is back on v0.1.0 (${short(c0)}), on master, no tracked changes`, headOf(app) === c0 && git(app, ['symbolic-ref', '--short', 'HEAD']) === 'master' && clean(app) === '', { head: headOf(app), status: clean(app) });
  const log = readText(path.join(USER_DATA, 'update.log'));
  check(`${label}: update.log has the rollback (git reset --keep ${short(c0)}: exit 0)`, new RegExp(`git reset --keep ${short(c0)}: exit 0`).test(log), log.slice(-900));
  if (extra) await extra(card, log);
  await themed(inst.port, '/^Mantle was not updated$/', `updater-${label}-failed`);
  const ok = await realClick((await toastsNow(inst.port)) || card.page, 'ok').catch((e) => ({ ok: false, how: e.message }));
  const gone = ok.ok ? await until(async () => { const p = await toastsNow(inst.port); return p ? !(await p.ev(CARD('/^Mantle was not updated$/'))) : true; }, 8000, 200) : null;
  check(`${label}: OK takes the failure banner down`, !!gone, ok);
  return true;
}
/** After a click whose update must SUCCEED: the old pid goes, a new instance comes up and confirms. */
async function expectRelaunch(label, inst, tag) {
  const pendingFile = path.join(USER_DATA, 'update-pending.json');
  let pending = null;
  const w = await clickUpdate(label, inst.port, tag, async () => {
    if (!pending) { const j = readJson(pendingFile); if (j && j.id) pending = j; }
    return !alive(inst.pid);
  }, 300000);
  if (!w) return null;
  if (!pending) { const j = readJson(pendingFile); if (j && j.id) pending = j; }
  check(`${label}: progress was shown (banner "Updating Mantle to ${tag}", or updates.state.updating)`, w.seen.some((s) => s.startsWith(`Updating Mantle to ${tag} |`)) || !!w.stateUpdating, w);
  check(`${label}: the old electron main pid exited`, !alive(inst.pid), { pid: inst.pid, out: S.run.out.slice(-800) });
  check(`${label}: a pending record was written before the restart`, !!pending, pending);
  for (const c of S.conns.splice(0)) c.close();
  S.tp = null; S.ctl = null;
  const p2 = await until(() => { const p = readPort(); return p && p.mtime >= w.tClick ? p : null; }, 90000, 200);
  check(`${label}: DevToolsActivePort was rewritten by a new instance`, !!p2, { now: readPort() });
  if (!p2) return { pending, port: null };
  toback();
  const answers = await until(async () => (await fetch(`http://127.0.0.1:${p2.port}/json/version`, { signal: AbortSignal.timeout(3000) })).ok, 30000, 300);
  check(`${label}: the new instance's DevTools port answers`, !!answers, { port: p2.port });
  const mains = await until(() => { const m = mainPids(); return m.length === 1 ? m : null; }, 15000, 500) || mainPids();
  check(`${label}: a NEW electron main process is up (not the old pid)`, mains.length === 1 && mains[0] !== inst.pid, { old: inst.pid, mains });
  const upd = answers ? await findCard(p2.port, reOf(`Mantle updated to ${tag}`), 30000) : null;
  check(`${label}: the new instance shows "Mantle updated to ${tag}"`, !!upd, answers ? await call(p2.port, 'toasts.state') : 'no new instance');
  if (upd) await themed(p2.port, reOf(`Mantle updated to ${tag}`), `updater-${label}-updated`);
  const done = await until(() => readJson(path.join(USER_DATA, 'update-done.json')), 10000, 200);
  check(`${label}: update-done.json carries the pending record's id, from the new main process`, !!done && !!pending && done.id === pending.id && mains.includes(Number(done.pid)), { done, pendingId: pending && pending.id, mains });
  const log = await until(() => { const s = readText(path.join(USER_DATA, 'update.log')); return /the new Mantle is up/.test(s) ? s : null; }, 20000, 300) || readText(path.join(USER_DATA, 'update.log'));
  check(`${label}: update.log has the ff-only merge (exit 0) and "the new Mantle is up"`, /git merge --ff-only [0-9a-f]{7}: exit 0/.test(log) && /the new Mantle is up/.test(log), log.slice(-900));
  return { pending, port: p2.port, pid: mains[0], log };
}

// ------------------------------------------------------------------ the scenarios
async function plain(c0) {
  const L = 'plain';
  const c1 = release(c0, 'v0.1.1', { 'UPDATER-E2E-RELEASE.txt': 'Release 0.1.1 of the updater e2e: one trivial file.\n' });
  const app = cloneApp('app-plain');
  junction(path.join(app, 'node_modules'), DEPS_MODULES);
  check(`${L}: node_modules junction made`, fs.existsSync(path.join(app, 'node_modules', 'electron')));
  check(`${L}: the clone is on v0.1.0, master, no tracked changes`, headOf(app) === c0 && git(app, ['symbolic-ref', '--short', 'HEAD']) === 'master' && clean(app) === '', clean(app));
  S.api.set('v0.1.1');
  const inst = await start(L, app, updJson(L));
  if (!inst) return;
  const card = await findCard(inst.port, '/^Mantle v0\\.1\\.1 is out$/', 45000);
  if (!check(`${L}: the banner shows "Mantle v0.1.1 is out"`, !!card, { toasts: await call(inst.port, 'toasts.state'), log: S.run.out.slice(-600) })) return;
  check(`${L}: it is Mantle's own banner with an Update button (and Later)`, card.card.own && card.card.btns.some((b) => b.action === 'update' && b.label === 'Update' && !b.disabled)
    && card.card.btns.some((b) => b.action === 'later'), card.card);
  const st = await call(inst.port, 'updates.state');
  const v = st && st.view;
  check(`${L}: updates.state: status available, canUpdate true, release v0.1.1, the v0.1.1 commit`, v && v.status === 'available' && v.canUpdate === true && v.release && v.release.tag === 'v0.1.1' && v.sha === c1, st);
  await themed(inst.port, '/^Mantle v0\\.1\\.1 is out$/', 'updater-available');
  const r = await expectRelaunch(L, inst, 'v0.1.1');
  if (r && r.log) check(`${L}: update.log says no npm install and no sidecar build were needed (so nothing installed into the junction)`, /npm install not needed; sidecar build not needed/.test(r.log), r.log.slice(-800));
  check(`${L}: HEAD is the v0.1.1 commit, still on master, clean`, headOf(app) === c1 && git(app, ['symbolic-ref', '--short', 'HEAD']) === 'master' && clean(app) === '', { head: headOf(app), c1 });
  await stop(L);
}

async function chain(c0) {
  const L = 'chain';
  const base = (f) => git(ORIGIN, ['show', `${c0}:${f}`]);
  const pkg0 = JSON.parse(base('package.json'));
  const lock0 = JSON.parse(base('package-lock.json'));
  /** package.json + package-lock.json with one more local package, the way npm 11 writes a file: dependency */
  const withDep = (name, dir) => {
    const pkg = JSON.parse(JSON.stringify(pkg0));
    pkg.dependencies = Object.assign({}, pkg.dependencies, { [name]: `file:${dir}` });
    const lock = JSON.parse(JSON.stringify(lock0));
    lock.packages[''].dependencies = Object.assign({}, lock.packages[''].dependencies, { [name]: `file:${dir}` });
    lock.packages[dir] = { name, version: '1.0.0' };
    lock.packages[`node_modules/${name}`] = { resolved: dir, link: true };
    const sorted = {};
    for (const k of Object.keys(lock.packages).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'en')))) sorted[k] = lock.packages[k];
    lock.packages = sorted;
    return { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` };
  };
  const BAD_CS = '// updater e2e: a sidecar source that does not compile, so the update\'s sidecar build fails.\nnamespace Mantle { internal static class UpdaterE2eBroken { this is not C# } }\n';
  const GOOD_CS = '// updater e2e: a sidecar source the release adds, so the update rebuilds the sidecar.\nnamespace Mantle { internal static class UpdaterE2eRelease { internal const string Tag = "v0.2.3"; } }\n';
  const BAD_PKG = `${JSON.stringify({ name: 'updater-e2e-bad', version: '1.0.0', scripts: { install: 'node -e "console.error(\'updater e2e: this package fails to install on purpose\');process.exit(7)"' } }, null, 2)}\n`;
  const GOOD_PKG = `${JSON.stringify({ name: 'updater-e2e-dep', version: '1.0.0', main: 'index.js' }, null, 2)}\n`;
  release(c0, 'v0.2.1', { 'sidecar/UpdaterE2eBroken.cs': BAD_CS });
  release(c0, 'v0.2.2', Object.assign(withDep('updater-e2e-bad', 'e2e-bad'), { 'e2e-bad/package.json': BAD_PKG }));
  const c3 = release(c0, 'v0.2.3', Object.assign(withDep('updater-e2e-dep', 'e2e-dep'), { 'e2e-dep/package.json': GOOD_PKG,
    'e2e-dep/index.js': "module.exports = 'updater e2e: a local package the release added';\n", 'sidecar/UpdaterE2eRelease.cs': GOOD_CS }));

  const app = cloneApp('app-chain');
  const nm = path.join(app, 'node_modules');
  try { copyModules(nm); } catch (err) { check(`${L}: a real copy of the packages for the clone (npm installs into it)`, false, err.message); return; }
  check(`${L}: a real copy of the packages for the clone (npm installs into it), not a link`, !fs.lstatSync(nm).isSymbolicLink() && fs.existsSync(path.join(nm, 'koffi', 'package.json')) && fs.existsSync(path.join(nm, 'electron', 'package.json')));
  fs.writeFileSync(path.join(app, '.npmrc'), 'offline=true\naudit=false\nfund=false\nupdate-notifier=false\n');   // untracked: npm can never reach the network
  check(`${L}: the clone is on v0.1.0, master, no tracked changes`, headOf(app) === c0 && clean(app) === '', clean(app));
  const exe = path.join(app, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
  const next = path.join(app, 'sidecar', 'bin-next', 'Mantle.Sidecar.exe');
  const exe0 = sha256(exe);

  S.api.set('v0.2.1');
  const inst = await start(L, app, updJson(L));
  if (!inst) return;
  await ctlNow(inst.port);
  // (b) + (c): the sidecar build fails
  const ok1 = await expectFailure('chain-build', inst, app, c0, 'v0.2.1', /The sidecar did not build/, async (card, log) => {
    check('chain-build: the reason is csc\'s own first error (the file, the line, the code)', /^The sidecar did not build \(exit 1: UpdaterE2eBroken\.cs\(\d+,\d+\): error CS\d+: /.test(card.body), card.body);
    check('chain-build: update.log: the build ran and failed (sidecar build: exit non-zero), no npm install', /sidecar build: exit [1-9]\d*/.test(log) && /npm install not needed; sidecar build needed/.test(log), log.slice(-900));
    check('chain-build: the running sidecar exe is untouched, nothing staged, the broken source gone', sha256(exe) === exe0 && !fs.existsSync(next) && !fs.existsSync(path.join(app, 'sidecar', 'UpdaterE2eBroken.cs')), fs.readdirSync(path.dirname(exe)));
  });
  if (!ok1) { await stop(L); return; }
  // (a) + (c): npm install fails
  S.api.set('v0.2.2');
  const c2 = await call(inst.port, 'updates.check');
  check('chain-npm: updates.check finds v0.2.2 (Update offered)', c2 && c2.ok && c2.view && c2.view.status === 'available' && c2.view.canUpdate === true && c2.view.release.tag === 'v0.2.2', c2);
  const ok2 = await expectFailure('chain-npm', inst, app, c0, 'v0.2.2', /npm install failed/, async (card, log) => {
    check('chain-npm: the reason is npm\'s own words, not its log line', /^npm install failed \(exit 7: updater e2e: this package fails to install on purpose\)/.test(card.body), card.body);
    check('chain-npm: update.log: npm install ran (exit 7), then again for the old packages (exit 0)', /npm install: exit 7/.test(log) && /npm install \(putting the old packages back\): exit 0/.test(log), log.slice(-1200));
    check('chain-npm: the failed package is gone again, koffi is still there', !lexists(path.join(nm, 'updater-e2e-bad')) && fs.existsSync(path.join(nm, 'koffi', 'package.json')), fs.readdirSync(nm));
  });
  if (!ok2) { await stop(L); return; }
  // (a) + (b): both run and succeed, then the restart
  S.api.set('v0.2.3');
  const c3v = await call(inst.port, 'updates.check');
  check('chain-ok: updates.check finds v0.2.3 (Update offered)', c3v && c3v.ok && c3v.view && c3v.view.canUpdate === true && c3v.view.release.tag === 'v0.2.3', c3v);
  const r = await expectRelaunch('chain-ok', inst, 'v0.2.3');
  if (r && r.log) {
    check('chain-ok: update.log: npm install ran (exit 0) and the sidecar was built (exit 0)', /npm install needed; sidecar build needed/.test(r.log) && /npm install: exit 0/.test(r.log) && /sidecar build: exit 0/.test(r.log), r.log.slice(-1200));
  }
  check('chain-ok: HEAD is the v0.2.3 commit, on master, no tracked changes (npm left package-lock.json alone)', headOf(app) === c3 && git(app, ['symbolic-ref', '--short', 'HEAD']) === 'master' && clean(app) === '', { head: headOf(app), status: clean(app) });
  const dep = path.join(nm, 'updater-e2e-dep');
  check('chain-ok: the new local package is installed (a link to the release\'s folder)', fs.existsSync(path.join(dep, 'package.json')) && readText(path.join(dep, 'index.js')).includes('a local package the release added'));
  check('chain-ok: a NEW sidecar exe is in place, nothing left staged', !!sha256(exe) && sha256(exe) !== exe0 && !fs.existsSync(next), { exe0, now: sha256(exe) });
  if (r && r.port) {
    const ok = await until(async () => { const s = await call(r.port, 'state.get'); return s && s.sidecar && s.sidecar.status === 'ok' ? s.sidecar : null; }, 30000, 500);
    check('chain-ok: the new instance\'s sidecar is up (state.get sidecar ok)', !!ok, await call(r.port, 'state.get').then((s) => s && s.sidecar).catch(() => null));
    // the old sidecar watches its parent and exits with the old Mantle: give it a moment
    const running = await until(() => { const l = ownLeftovers('sidecar'); return l.length === 1 ? l : null; }, 15000, 500) || ownLeftovers('sidecar');
    check('chain-ok: ...and exactly one sidecar runs from T: the new exe in the clone\'s sidecar/bin', running.length === 1 && path.resolve(running[0].exe).toLowerCase() === exe.toLowerCase(), running);
    const olds = fs.readdirSync(path.dirname(exe)).filter((f) => /\.old-\d+$/.test(f));
    info(`chain-ok: sidecar/bin now: ${JSON.stringify(fs.readdirSync(path.dirname(exe)))}; the new start ${/removed \d+ sidecar file/.test(S.run.out) ? 'swept' : 'left'} ${olds.length} old exe(s) (one still running is swept at the next start)`);
  }
  await stop(L);
}

async function neverup(c0) {
  const L = 'neverup';
  const r31 = release(c0, 'v0.3.1', { 'main.js': '// updater e2e: a release whose Mantle never starts, so the restart watcher has to give up.\nprocess.exit(0);\n' });
  const app = cloneApp('app-neverup');
  junction(path.join(app, 'node_modules'), DEPS_MODULES);
  check(`${L}: node_modules junction made, the clone on v0.1.0 and clean`, fs.existsSync(path.join(app, 'node_modules', 'electron')) && headOf(app) === c0 && clean(app) === '');
  S.api.set('v0.3.1');
  const inst = await start(L, app, updJson(L, { confirmMs: 20000 }));
  if (!inst) return;
  await ctlNow(inst.port);
  const failedFile = path.join(USER_DATA, 'update-failed.json');
  const w = await clickUpdate(L, inst.port, 'v0.3.1', async () => !alive(inst.pid), 120000);
  if (!w) { await stop(L); return; }
  check(`${L}: the old electron main pid exited (the restart went ahead)`, !alive(inst.pid));
  for (const c of S.conns.splice(0)) c.close();
  S.tp = null; S.ctl = null;
  // the watcher's own config: a --test run's, never the live restore
  const cfg = await until(() => readJson(path.join(USER_DATA, 'update-watch.json')), 5000, 200);
  check(`${L}: the watcher's config: live false, its restore script the clone's own (never the user's install)`, cfg && cfg.live === false && cfg.confirmMs === 20000 &&
    path.resolve(cfg.restoreScript).toLowerCase() === path.join(app, 'tools', 'restore-windows.ps1').toLowerCase(), cfg);
  const rec = await until(() => readJson(failedFile), 60000, 500);
  check(`${L}: after confirmMs the watcher writes update-failed.json for v0.3.1`, rec && rec.tag === 'v0.3.1' && rec.id === (cfg && cfg.id), rec);
  check(`${L}: ...and says the restore script was NOT run (a --test run never runs it)`, rec && rec.restore && rec.restore.ran === false && /not run: this was a --test run/.test(rec.restore.out), rec && rec.restore);
  const log = readText(path.join(USER_DATA, 'update.log'));
  check(`${L}: update.log: the watcher gave up after 20 s, no message box, no restore line`, /watcher: the new Mantle did not say it was up within 20 s/.test(log) && /watcher: test run: no message box/.test(log) && !/restore-windows\.ps1: (verified|NOT verified)/.test(log), log.slice(-1000));
  const watcherGone = await until(() => ownLeftovers('watcher').length === 0, 15000, 500);
  check(`${L}: the watcher exited by itself`, !!watcherGone, ownLeftovers('watcher'));
  check(`${L}: no Mantle came back on the profile (the new one exited)`, mainPids().length === 0, mainPids());
  check(`${L}: the watcher removed the pending record (a Mantle started by hand must not call this an update), no done record`,
    !fs.existsSync(path.join(USER_DATA, 'update-pending.json')) && !fs.existsSync(path.join(USER_DATA, 'update-done.json')), fs.readdirSync(USER_DATA).filter((f) => /^update/.test(f)));
  // what the user is told to do: go back, start Mantle again by hand
  git(app, ['reset', '-q', '--keep', c0]);
  check(`${L}: git reset --keep back to v0.1.0 (the way back the watcher gives) leaves it clean`, headOf(app) === c0 && clean(app) === '', clean(app));
  await stop(`${L} (between)`);
  const again = await start(`${L}-again`, app, updJson(`${L}-again`, { firstMs: 3600000 }), { keepProfile: true });
  if (!again) return;
  await ctlNow(again.port);
  const card = await findCard(again.port, '/^The update to v0\\.3\\.1 did not start$/', 30000);
  if (check(`${L}: started again by hand, Mantle says "The update to v0.3.1 did not start"`, !!card, await call(again.port, 'toasts.state'))) {
    check(`${L}: ...that it did not come back and was started again by hand, the way back (git reset --keep ${short(c0)}) and the log`,
      /did not come back after updating/.test(card.card.body) && /started again by hand/.test(card.card.body) && !/Windows was put back/.test(card.card.body) &&
      card.card.detail.includes(`git reset --keep ${short(c0)}`) && /update\.log/.test(card.card.detail), card.card);
    await themed(again.port, '/^The update to v0\\.3\\.1 did not start$/', 'updater-restart-failed');
    const ok = await realClick((await toastsNow(again.port)) || card.page, 'ok');
    const cleared = ok.ok ? await until(() => !fs.existsSync(failedFile), 8000, 200) : null;
    check(`${L}: OK clears the failed record (shown once)`, !!cleared, { ok, left: fs.existsSync(failedFile) });
    await failedRelease(L, again, c0, r31);
  }
  await stop(`${L}-again`);
}

/** neverup, continued (lane mantle-failed-release): the release that did not start is remembered past that once;
    the next check warns before offering it, Skip this version is kept, and a newer release clears the record. */
async function failedRelease(L, again, c0, r31) {
  const relFile = path.join(USER_DATA, 'update-failed-release.json');
  const mem = readJson(relFile);
  check(`${L}: the record of the release that did not start outlives OK (v0.3.1, its commit, from v0.1.0, the watcher's reason, not skipped)`,
    mem && mem.tag === 'v0.3.1' && mem.sha === r31 && mem.from === c0 && mem.reason === 'it did not finish starting within 20 seconds' && mem.skipped === false && typeof mem.at === 'number', mem);
  const WARN = '/^Mantle v0\\.3\\.1 did not start last time$/';
  const c1 = await call(again.port, 'updates.check');
  const warn = await findCard(again.port, WARN, 20000);
  if (!check(`${L}: the next check warns before offering v0.3.1 again ("Mantle v0.3.1 did not start last time")`, !!warn, { c1, toasts: await call(again.port, 'toasts.state') })) return;
  check(`${L}: ...the reason, that this is the version from before (${short(c0)}), and what to do`,
    warn.card.body === `Last time, it did not finish starting within 20 seconds. You are back on the version you had before (${short(c0)}). Try again to install it once more, or skip this version until a newer one is out.`, warn.card.body);
  check(`${L}: ...two enabled choices on Mantle's own banner: Try again and Skip this version (no Update, no Later)`, warn.card.own &&
    warn.card.btns.map((b) => `${b.action}:${b.label}:${b.disabled ? 'off' : 'on'}`).sort().join('|') === 'retry:Try again:on|skip:Skip this version:on', warn.card.btns);
  check(`${L}: ...when it was tried, and the log`, /^Tried \d{4}-\d\d-\d\d \d\d:\d\d\nLog: .*update\.log$/.test(warn.card.detail), warn.card.detail);
  const st = await call(again.port, 'updates.state');
  const v = st && st.view;
  check(`${L}: updates.state: still available with Update allowed, failedBefore v0.3.1, no record fault`,
    v && v.status === 'available' && v.canUpdate === true && v.failedBefore && v.failedBefore.tag === 'v0.3.1' && v.recordError === null, v);
  await themed(again.port, WARN, 'updater-failed-release');
  const sk = await realClick((await toastsNow(again.port)) || warn.page, 'skip');
  const gone = sk.ok ? await until(async () => !(await findCard(again.port, WARN, 300)), 8000, 300) : null;
  check(`${L}: Skip this version (clicked) takes the banner down`, !!gone, sk);
  const kept = await until(() => { const j = readJson(relFile); return j && j.skipped === true ? j : null; }, 5000, 200);
  check(`${L}: ...the skip is kept on disk, same tag and commit`, !!kept && kept.tag === 'v0.3.1' && kept.sha === r31, readJson(relFile));
  const st2 = await call(again.port, 'updates.state');
  check(`${L}: ...updates.state says skipped`, st2 && st2.view && st2.view.status === 'skipped' && st2.posted === null, st2 && st2.view);
  const c2 = await call(again.port, 'updates.check');
  check(`${L}: the next check answers "skipped" (no offer)`, c2 && c2.ok && c2.view && c2.view.status === 'skipped' && c2.view.release.tag === 'v0.3.1', c2);
  check(`${L}: ...and no banner comes back`, !(await findCard(again.port, '/^Mantle v0\\.3\\.1 /', 3000)), await call(again.port, 'toasts.state'));
  // a newer release clears it
  const r32 = release(c0, 'v0.3.2', { 'docs/updater-e2e-0.3.2.md': 'updater e2e: a release after the one that did not start\n' });
  S.api.set('v0.3.2');
  const c3 = await call(again.port, 'updates.check');
  check(`${L}: a newer release (v0.3.2) is offered as usual`, c3 && c3.ok && c3.view && c3.view.status === 'available' && c3.view.release.tag === 'v0.3.2' && c3.view.sha === r32 && c3.view.failedBefore === null, c3 && c3.view);
  const plain = await findCard(again.port, '/^Mantle v0\\.3\\.2 is out$/', 15000);
  check(`${L}: ...its banner is the plain one ("Mantle v0.3.2 is out", Update and Later)`, !!plain && plain.card.btns.map((b) => b.action).sort().join() === 'later,update', plain && plain.card);
  check(`${L}: ...and the record of v0.3.1 is gone`, !fs.existsSync(relFile), readJson(relFile));
  const log = readText(path.join(USER_DATA, 'update.log'));
  check(`${L}: update.log: recorded by the watcher, skipped by the user, removed for v0.3.2`, /watcher: recorded that v0\.3\.1 did not start/.test(log) &&
    /v0\.3\.1 skipped by the user/.test(log) && /record of the update that did not start was removed: a different release is out now \(v0\.3\.2, not v0\.3\.1\)/.test(log), log.slice(-1200));
}

// ------------------------------------------------------------------ the run
async function main() {
  if (gaming()) {
    console.log('SKIPPED: a game is running (no test instances while the user games)');
    return;
  }
  info(`T = ${T}; scenarios: ${ONLY.length ? ONLY.join(', ') : 'plain, chain, neverup'}`);
  killTest();
  if (!check('a sidecar exe to copy in', fs.existsSync(SIDECAR_SRC), `${SIDECAR_SRC} is missing: run npm run build:sidecar, or set MANTLE_SIDECAR_EXE`)) return;
  let c0;
  try { c0 = snapshot(); } catch (err) { check('the fake origin was made from this tree', false, err.message); return; }
  check('the fake origin was made from this tree', true);
  S.api = await fakeApi();
  const run = async (name, fn) => {
    if (!want(name)) return;
    const t0 = Date.now();
    try { await fn(c0); } catch (err) { check(`${name}: the scenario did not throw`, false, err && err.stack); }
    await stop(`${name} (end)`);
    info(`${name}: ${Math.round((Date.now() - t0) / 1000)} s`);
  };
  await run('plain', plain);
  await run('chain', chain);
  await run('neverup', neverup);
  info(`fake API: ${S.api.hits} request(s), ${S.api.notModified} answered 304; others: ${JSON.stringify(S.api.other)}`);
  check('the fake API was asked, and nothing else was', S.api.hits >= 1 && S.api.other.length === 0, { hits: S.api.hits, other: S.api.other });
}

async function cleanup() {
  for (const c of S.conns.splice(0)) c.close();
  info('kill-test: ' + killTest().replace(/\s+/g, ' ').slice(0, 300));
  await sleep(1500);
  for (const l of ownLeftovers()) {
    try { process.kill(l.pid); info(`stopped our own leftover pid ${l.pid} (${l.exe || 'restart watcher'})`); } catch (err) { info(`could not stop pid ${l.pid}: ${err.message}`); }
  }
  await Promise.race([Promise.all(S.toback), sleep(15000)]);
  if (S.api) await new Promise((r) => S.api.server.close(r));
  await sleep(500);
  const left = electronsFor();
  check(`cleanup: no electron.exe left with --profile-name=${PROFILE}`, left === 0, `count=${left}`);
  const stuck = JUNCTIONS.filter((j) => !unjunction(j));
  check('cleanup: every node_modules junction was removed (rmdir)', stuck.length === 0, stuck);
  if (!stuck.length) {
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { /* a file still held: try again */ }
      gone = !fs.existsSync(T);
      if (!gone) await sleep(1500);
    }
    check('cleanup: T was removed', gone, T);
  } else {
    info(`T was NOT removed because a junction is still there: ${stuck.join(', ')}`);
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
