'use strict';
/*
 * lib/updater.js -- Mantle updates itself from its GitHub releases (lane mantle-updater, 2026-10-22).
 *
 * The user installs Mantle with `git clone`, so an update is a fast-forward of that clone to the newest
 * release's tag. Nothing is downloaded but git objects and, when the release changes them, npm packages.
 *
 * WHERE RELEASES COME FROM: GitHub Releases of the public repo, `GET /repos/{owner}/{repo}/releases/latest`,
 * unauthenticated, with the last ETag (a 304 reuses the stored release). A rate-limit answer is a state with
 * the time it lifts, and the next check waits for it. owner, repo, the API base and the clone URL are options,
 * so the tests run against a fake API and a local bare repo.
 *
 * WHEN AN UPDATE COUNTS AS AVAILABLE: only when the release tag's commit is NOT already in HEAD
 * (`git merge-base --is-ancestor <tag> HEAD`, after fetching that one tag). A folder at or ahead of the
 * release is never prompted.
 *
 * NEVER CHECKS AT ALL (status 'off', not a fault): a --test run (unless a test hands in its own fake release
 * source), a linked git worktree (`.git` is a file), a folder that is not a git clone, or the opt-out file
 * OPT_OUT_FILE in the app folder. The feature's own switch (Settings, tray > Features) is the user's way.
 *
 * WHEN THE UPDATE BUTTON IS OFFERED (eligibility): a normal clone (not a linked worktree), origin is the
 * public repo, HEAD is on the default branch (origin/HEAD), tracked files are clean, a fast-forward is
 * possible, and the release does not change a package the running Mantle has loaded (RUNNING_DEPS: npm
 * cannot replace electron.exe or koffi's native module under a running process on Windows). Otherwise the
 * view says why, and carries the commands to update by hand.
 *
 * WHAT UPDATE DOES (apply): fetch the tag, `git merge --ff-only <tag commit>`; `npm install` only when
 * package.json or package-lock.json changed (install, not ci: ci deletes node_modules, which the running
 * Mantle is executing from; --no-save, so npm never rewrites package.json or package-lock.json: a lock npm
 * rewrote is a tracked change, which makes `git reset --keep` refuse the rollback and takes the Update
 * button away from the next release. Measured 2026-10-22: a plain `npm install` on 0.1.0's lock added a
 * "license" line to it. Any package file npm changes anyway is put back as committed, and said in the log);
 * the sidecar is rebuilt only when its sources changed, into sidecar/bin-next
 * (the running sidecar holds sidecar/bin open), and swapped in just before the restart by renaming
 * (Windows allows renaming a running exe, not overwriting it). Then the host's restart: the same verified
 * restore-then-relaunch road as "Restart Mantle", with the same flags (main.js restartForUpdate). A
 * detached watcher (lib/update-watch.js) waits for the new Mantle to say it is up; if it never does, the
 * watcher runs tools/restore-windows.ps1 (live runs only) and tells the user how to start Mantle again.
 *
 * IF ANYTHING FAILS before the restart: `git reset --keep <old sha>`, npm install again if it had run, the
 * staged sidecar removed (and the swap undone if it had happened), and the old version keeps running. The
 * result says the reason and the log path (<userData>/update.log).
 *
 * A RELEASE THAT DID NOT START (lane mantle-failed-release, 2026-10-23): when the watcher gives up on a
 * release, it also writes RELEASE_FILE (<userData>/update-failed-release.json: the tag, its commit, when, the
 * reason), written to a temp file, flushed and renamed, so it survives the restart and a crash. Unlike
 * update-failed.json (shown once at the next start, then cleared), this one stays. The next check that finds
 * that same tag still offers it, with the record on the view (failedBefore), so the banner warns first and
 * offers Try again or Skip this version. skipRelease(tag) marks it skipped: the check then answers 'skipped'
 * (no banner, no tray row, apply refuses) until a different release is out. The record goes away when a
 * different release is the latest, when the tag now names another commit, when this folder is running that
 * release (it started), or when the update to it confirms its start. A record that cannot be read or
 * written is never ignored quietly: the view carries recordError (the feature's health shows it) and the log
 * says it.
 *
 * Every function answers a value with a reason; nothing here throws at its caller.
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
// the watcher's own durable write (it is self-contained; requiring it runs nothing)
const { writeDurable } = require('./update-watch');

const DEFAULTS = Object.freeze({ owner: 'Owen-Silva', repo: 'mantle', apiBase: 'https://api.github.com', webBase: 'https://github.com' });
/** In the app folder: its presence turns the updater fully off (gitignored by the *.local pattern). */
const OPT_OUT_FILE = 'no-updates.local';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
/** Packages the running Mantle has loaded: a release that changes their version is updated by hand. */
const RUNNING_DEPS = Object.freeze(['electron', 'koffi']);
const SIDECAR_EXE = path.join('sidecar', 'bin', 'Mantle.Sidecar.exe');
const SIDECAR_NEXT = path.join('sidecar', 'bin-next', 'Mantle.Sidecar.exe');
const PENDING_FILE = 'update-pending.json';
const DONE_FILE = 'update-done.json';
const FAILED_FILE = 'update-failed.json';
const RELEASE_FILE = 'update-failed-release.json';
const LOG_FILE = 'update.log';
const CONFIRM_MS = 3 * 60 * 1000;   // how long the watcher waits for the new Mantle to say it is up
const UA = 'mantle-updater';
/** What Update runs when the release changes the packages (see WHAT UPDATE DOES above for --no-save). */
const INSTALL_CMD = 'npm install --no-save --no-audit --no-fund';
const PACKAGE_FILES = Object.freeze(['package.json', 'package-lock.json']);

/** Run a program; never rejects. -> { code (null = it did not start), out (stdout + stderr, the tail) } */
function run(file, args, opt) {
  const o = opt || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(file, args, { cwd: o.cwd, env: o.env || process.env, windowsHide: true, timeout: o.timeoutMs || 120000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = tail(`${stdout || ''}${stderr ? `\n${stderr}` : ''}`, 6000);
          if (err && typeof err.code !== 'number') {
            const why = err.killed ? `it was stopped after ${Math.round((o.timeoutMs || 120000) / 1000)} s` : (err.code === 'ENOENT' ? `${file} is not installed or not on PATH` : err.message);
            resolve({ code: null, out: out ? `${why}\n${out}` : why });
            return;
          }
          resolve({ code: err ? err.code : 0, out });
        });
    } catch (err) {
      resolve({ code: null, out: err.message });
      return;
    }
    child.on('error', () => { /* the callback above has the error */ });
  });
}
function tail(s, n) { const t = String(s || '').replace(/\r/g, '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; }
function lastLine(s) { const l = String(s || '').trim().split('\n').map((x) => x.trim()).filter(Boolean); return l.length ? l[l.length - 1].slice(0, 200) : ''; }
/**
 * Why npm failed, in its own words: the last line that says something. npm ends every failure with "A
 * complete log of this run can be found in: ..." and frames the cause with code / path / command lines,
 * which as a reason would say nothing (seen 2026-10-22: "exit 7: npm error A complete log of this run ...").
 */
function npmWhy(r) {
  if (!r || r.code === null) return lastLine(r && r.out) || 'npm did not start';
  const said = String(r.out || '').split('\n').map((x) => x.trim()).filter(Boolean)
    .filter((l) => !/complete log of this run/i.test(l) && !/^npm (error|ERR!)\s*(code|errno|syscall|path|command|signal)\b/i.test(l) && !/^npm (error|ERR!)\s*$/i.test(l));
  const line = said.length ? said[said.length - 1].replace(/^npm (error|ERR!)\s+/i, '').slice(0, 200) : '';
  return `exit ${r.code}${line ? `: ${line}` : ''}`;
}
/** Why the sidecar did not build: csc's first error (file, line, code, words), else the build's last line. */
function buildWhy(r) {
  const err = String((r && r.out) || '').split('\n').map((x) => x.trim()).find((l) => /\berror CS\d+\b/.test(l));
  const said = err ? err.replace(/^.*[\\/](?=[^\\/]+\.cs\()/, '').slice(0, 200) : lastLine(r && r.out);
  if (!r || r.code === null) return said || 'the build did not start';
  return `exit ${r.code}${said ? `: ${said}` : ''}`;
}
/** npm's lifecycle variables (a Mantle started by `npm run live` inherits them) are left out of a child npm. */
function cleanEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base || process.env)) if (!/^npm_/i.test(k) && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  return env;
}
function gitEnv(base) {
  // never a credential window or prompt from a background check; plain English output
  return Object.assign(cleanEnv(base), { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', LANG: 'C', LC_ALL: 'C' });
}

/** A tag name we are willing to hand to git (refname rules, and never an option). */
function safeTag(t) {
  const s = String(t || '');
  return /^[A-Za-z0-9][A-Za-z0-9._+\-/]{0,99}$/.test(s) && !s.includes('..') && !s.endsWith('.lock') && !s.endsWith('/') && !s.endsWith('.');
}
/** Comparable form of a git remote: host/path, lower case, no scheme, user, .git or trailing slash. */
function normRemote(u) {
  let s = String(u || '').trim().replace(/\\/g, '/');
  s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  s = s.replace(/^([^/:]+):(?!\/)/, '$1/');   // git@github.com:owner/repo -> github.com/owner/repo
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return s.toLowerCase();
}
function short(sha) { return String(sha || '').slice(0, 7); }

/** Why a parsed failed-release record is not one, or null. The watcher and the updater both write it. */
function recordWhy(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'it is not a record';
  if (typeof j.tag !== 'string' || !safeTag(j.tag)) return 'it has no usable release tag';
  if (j.sha != null && !(typeof j.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(j.sha))) return 'its commit is not a commit id';
  if (j.skipped != null && typeof j.skipped !== 'boolean') return 'its "skipped" is not true or false';
  return null;
}
/** The record of a failed start, from the watcher's update-failed.json (which an older watcher wrote alone). */
function recordFrom(f, at) {
  return { id: f.id || null, tag: f.tag, sha: typeof f.to === 'string' && /^[0-9a-f]{7,64}$/i.test(f.to) ? f.to : null, from: f.from || null,
    at: typeof f.at === 'number' ? f.at : at, reason: typeof f.reason === 'string' && f.reason ? f.reason : 'it did not finish starting after the update',
    log: f.log || null, skipped: false };
}
function hhmm(ms) { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/** Words for a failed fetch. Every one starts so it reads after "Couldn't check for updates: ". */
function netWords(err, host) {
  const c = (err && (err.code || (err.cause && err.cause.code))) || '';
  const name = (err && err.name) || '';
  if (/ENOTFOUND|EAI_AGAIN/.test(c)) return `no internet connection (${host} could not be found)`;
  if (name === 'TimeoutError' || name === 'AbortError' || /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(c)) return `no answer from ${host} within 20 s (no internet connection, or it is slow)`;
  if (/ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENETDOWN/.test(c)) return `no internet connection (${host} could not be reached: ${c})`;
  return `${host} could not be reached (${(err && err.message) || 'no reason given'}${c ? `, ${c}` : ''})`;
}

/**
 * o: {
 *   root            the app folder (a git clone)
 *   userData        where the log, the pending record and the watcher's copy go
 *   owner, repo, apiBase, webBase, cloneUrl, originUrl   the release source (defaults: the public repo)
 *   test            a --test run: off unless testSource is true (a test's own fake release source)
 *   testSource      true when owner/apiBase/cloneUrl come from a test's fake
 *   live            a live run: the watcher may run the restore script if the relaunch fails
 *   fetch           (url, init) -> Response-like { status, headers.get(), json() }   (default global fetch)
 *   run             (file, args, opt) -> {code, out}   (default: execFile, above)
 *   commands        { install(): {code,out}, build(): {code,out} }   (default: npm through cmd.exe)
 *   store           { get(): object|null, set(object) }  the ETag + release cache
 *   restart         async (why) -> {ok, reason}: the host's restore-then-relaunch (main.js)
 *   spawnWatcher    (cfgFile) -> {ok, pid, reason}   (default: this Electron as node, detached)
 *   now, log
 * }
 */
function createUpdater(o) {
  const opt = o || {};
  const root = path.resolve(opt.root);
  const owner = opt.owner || DEFAULTS.owner;
  const repo = opt.repo || DEFAULTS.repo;
  const apiBase = String(opt.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
  const webBase = String(opt.webBase || DEFAULTS.webBase).replace(/\/+$/, '');
  const cloneUrl = opt.cloneUrl || `${webBase}/${owner}/${repo}.git`;
  const originWant = normRemote(opt.originUrl || `${webBase}/${owner}/${repo}`);
  const apiHost = (() => { try { return new URL(apiBase).host; } catch (_) { return apiBase; } })();
  const fetchFn = opt.fetch || ((...a) => globalThis.fetch(...a));
  const runFn = opt.run || run;
  const now = opt.now || Date.now;
  const log = opt.log || (() => {});
  const userData = opt.userData ? path.resolve(opt.userData) : root;
  const store = opt.store || { get: () => null, set: () => {} };
  const logPath = path.join(userData, LOG_FILE);
  const files = { pending: path.join(userData, PENDING_FILE), done: path.join(userData, DONE_FILE), failed: path.join(userData, FAILED_FILE),
    release: path.join(userData, RELEASE_FILE) };
  // The watcher as it is NOW: after the merge, lib/update-watch.js on disk is the next version's.
  let watcherSource = null;
  try { watcherSource = fs.readFileSync(path.join(__dirname, 'update-watch.js'), 'utf8'); } catch (err) { log(`the restart watcher could not be read (${err.message}); an update will refuse to restart`); }

  const git = (args, ms) => runFn('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, env: gitEnv(opt.env), timeoutMs: ms || 60000 });
  const cmdExe = process.env.ComSpec || 'cmd.exe';
  const commands = Object.assign({
    install: () => runFn(cmdExe, ['/d', '/s', '/c', INSTALL_CMD], { cwd: root, env: cleanEnv(opt.env), timeoutMs: 15 * 60 * 1000 }),
    build: () => runFn(cmdExe, ['/d', '/s', '/c', `npm run build:sidecar -- -Out ${SIDECAR_NEXT.replace(/\\/g, '/')}`], { cwd: root, env: cleanEnv(opt.env), timeoutMs: 10 * 60 * 1000 }),
  }, opt.commands || {});

  /**
   * npm leaves the tracked package files exactly as the commit has them (--no-save should already: this is
   * for an npm that writes them anyway). -> null, or why they could not be put back.
   */
  async function keepPackageFiles(when) {
    // names only: run() trims its output, which would eat the leading space of a porcelain status line
    const st = await git(['diff', '--name-only', 'HEAD', '--', ...PACKAGE_FILES]);
    if (st.code !== 0) return `git could not read the package files after ${when} (${lastLine(st.out)})`;
    const changed = st.out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!changed.length) return null;
    const r = await git(['checkout', 'HEAD', '--', ...changed]);
    say(`npm changed ${changed.join(', ')} during ${when}; put back as committed: exit ${r.code}${r.out ? `\n${r.out}` : ''}`);
    return r.code === 0 ? null : `git could not put back ${changed.join(', ')}, which npm changed (${lastLine(r.out) || `exit ${r.code}`})`;
  }

  let busy = null;          // the running apply's promise
  let last = null;          // the last check's view
  let recordProblem = null; // why the failed-release record could not be read or written last time, or null

  // ---------------------------------------------------------------- the log
  function say(line) {
    const text = `${new Date(now()).toISOString()} ${line}\n`;
    try { fs.mkdirSync(userData, { recursive: true }); fs.appendFileSync(logPath, text); } catch (_) { /* the result still carries the reason */ }
    log(line);
  }

  // ---------------------------------------------------------------- the release that did not start
  /** -> { ok: true, rec: object|null } or { ok: false, reason, why }. Sets recordProblem either way. */
  function readRecord() {
    let text;
    try { text = fs.readFileSync(files.release, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') { recordProblem = null; return { ok: true, rec: null }; }
      return recordFault('read', `it could not be opened (${err.code || err.message})`);
    }
    let j;
    try { j = JSON.parse(text); } catch (err) { return recordFault('read', `it is not valid JSON (${err.message})`); }
    const why = recordWhy(j);
    if (why) return recordFault('read', why);
    recordProblem = null;
    return { ok: true, rec: j };
  }
  function recordFault(what, why) {
    recordProblem = `Mantle could not ${what} its record of the update that did not start (${files.release}): ${why}.` +
      (what === 'read' ? ' Delete that file to start a new record.' : '');
    say(recordProblem);
    return { ok: false, reason: recordProblem, why };
  }
  /** -> { ok: true } or { ok: false, reason, why } */
  function writeRecord(rec) {
    try { fs.mkdirSync(userData, { recursive: true }); writeDurable(files.release, rec); } catch (err) {
      return recordFault('save', `${err.code || err.message}`);
    }
    recordProblem = null;
    return { ok: true };
  }
  /** Forget the record (why: for the log). -> { ok: true } or { ok: false, reason, why } */
  function clearRecord(why) {
    try { fs.rmSync(files.release, { force: true }); } catch (err) { return recordFault('remove', `${err.code || err.message}`); }
    say(`the record of the update that did not start was removed: ${why}`);
    return { ok: true };
  }
  /** The watcher gave up on update f (update-failed.json): keep that durably, unless it already is. */
  function noteFailedStart(f) {
    const mem = readRecord();
    if (mem.ok && mem.rec && f.id && mem.rec.id === f.id) return { ok: true, rec: mem.rec, already: true };
    const rec = recordFrom(f, now());
    const w = writeRecord(rec);
    if (!w.ok) return w;
    say(`recorded that ${rec.tag} did not start${mem.ok ? '' : ' (in place of the record that could not be read)'}: ${rec.reason}`);
    return { ok: true, rec };
  }
  function skippedWords(tag) { return `Mantle ${tag} is skipped because it did not start last time. Mantle offers the next newer version.`; }
  /**
   * Skip this version (the warning banner's choice): kept until a different release is the latest.
   * -> { ok: true, view, rec } or { ok: false, reason, why }
   */
  function skipRelease(tag) {
    const mem = readRecord();
    if (!mem.ok) return mem;
    if (!mem.rec || mem.rec.tag !== tag) return { ok: false, reason: `Mantle has no record that ${tag} did not start, so there is nothing to skip`, why: 'there is no record of it' };
    const rec = Object.assign({}, mem.rec, { skipped: true, skippedAt: now() });
    const w = writeRecord(rec);
    if (!w.ok) return w;
    say(`${tag} skipped by the user (it did not start last time); the next newer release will be offered`);
    if (last && last.release && last.release.tag === tag && last.status === 'available') {
      last = Object.assign({}, last, { status: 'skipped', reason: skippedWords(tag), canUpdate: false, failedBefore: rec, recordError: null });
    }
    return { ok: true, view: last, rec };
  }

  // ---------------------------------------------------------------- off?
  /** Why this folder never checks, or null. Reads files only. */
  function offWhy() {
    if (opt.test && !opt.testSource) return 'this is a --test run, which never checks for updates';
    if (fs.existsSync(path.join(root, OPT_OUT_FILE))) return `updates are turned off for this folder (${OPT_OUT_FILE} is in it)`;
    let st = null;
    try { st = fs.statSync(path.join(root, '.git')); } catch (_) { /* none */ }
    if (!st) return 'this folder is not a git clone, so Mantle cannot update it (download Mantle with git clone to get updates)';
    if (!st.isDirectory()) return 'this folder is a linked git worktree, which never checks for updates';
    return null;
  }

  // ---------------------------------------------------------------- the release
  async function latest() {
    const url = `${apiBase}/repos/${owner}/${repo}/releases/latest`;
    const cache = store.get() || {};
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' };
    if (cache.etag && cache.release !== undefined) headers['If-None-Match'] = cache.etag;
    let res;
    try {
      res = await fetchFn(url, { headers, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      return { ok: false, kind: 'network', reason: `Couldn't check for updates: ${netWords(err, apiHost)}` };
    }
    const h = (k) => { try { return res.headers && res.headers.get ? res.headers.get(k) : null; } catch (_) { return null; } };
    if (res.status === 304 && cache.release !== undefined) return { ok: true, release: cache.release, cached: true };
    if (res.status === 404) {
      store.set({ etag: null, release: null, at: now() });
      return { ok: true, release: null };
    }
    const remaining = h('x-ratelimit-remaining');
    const retryAfter = Number(h('retry-after'));
    if (res.status === 429 || ((res.status === 403) && (remaining === '0' || retryAfter > 0))) {
      const reset = Number(h('x-ratelimit-reset'));
      const at = retryAfter > 0 ? now() + retryAfter * 1000 : (reset > 0 ? reset * 1000 : now() + 60 * 60 * 1000);
      return { ok: false, kind: 'rate', retryAt: at, reason: `Couldn't check for updates: GitHub's limit on checks without an account was reached; Mantle tries again at ${hhmm(at)}` };
    }
    if (res.status !== 200) return { ok: false, kind: 'http', reason: `Couldn't check for updates: GitHub answered ${res.status}` };
    let j;
    try { j = await res.json(); } catch (err) { return { ok: false, kind: 'http', reason: `Couldn't check for updates: GitHub's answer was not readable (${err.message})` }; }
    if (!j || typeof j.tag_name !== 'string') return { ok: false, kind: 'http', reason: 'Couldn\'t check for updates: GitHub\'s answer had no release tag' };
    if (!safeTag(j.tag_name)) return { ok: false, kind: 'http', reason: `Couldn't check for updates: the release's tag "${String(j.tag_name).slice(0, 60)}" is not a tag name Mantle will use` };
    const release = {
      tag: j.tag_name,
      name: typeof j.name === 'string' && j.name.trim() ? j.name.trim().slice(0, 120) : j.tag_name,
      url: typeof j.html_url === 'string' && /^https:\/\//.test(j.html_url) ? j.html_url : `${webBase}/${owner}/${repo}/releases/tag/${encodeURIComponent(j.tag_name)}`,
      publishedAt: j.published_at || null,
      target: typeof j.target_commitish === 'string' ? j.target_commitish : null,
    };
    store.set({ etag: h('etag') || null, release, at: now() });
    return { ok: true, release };
  }

  // ---------------------------------------------------------------- git
  async function tagCommit(tag) {
    const r = await git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
    return r.code === 0 ? r.out.trim().split('\n')[0] : null;
  }
  /** The tag's commit, fetched from the release's own repo if this clone does not have it yet. */
  async function fetchTag(tag) {
    let sha = await tagCommit(tag);
    if (sha) return { ok: true, sha };
    const f = await git(['fetch', '--no-tags', '--quiet', cloneUrl, `refs/tags/${tag}:refs/tags/${tag}`], 120000);
    if (f.code !== 0) {
      const why = /could not resolve host|unable to access|could not read from remote|failed to connect|timed out/i.test(f.out) ? `no internet connection (${lastLine(f.out)})` : (lastLine(f.out) || 'git gave no reason');
      return { ok: false, reason: `the release's tag ${tag} could not be fetched: ${why}` };
    }
    sha = await tagCommit(tag);
    return sha ? { ok: true, sha } : { ok: false, reason: `git fetched ${tag} but it does not name a commit` };
  }
  async function head() {
    const r = await git(['rev-parse', 'HEAD']);
    return r.code === 0 ? r.out.trim() : null;
  }
  /** 0 = yes, 1 = no, null = git could not tell (the reason in .why) */
  async function isAncestor(a, b) {
    const r = await git(['merge-base', '--is-ancestor', a, b]);
    if (r.code === 0) return { yes: true };
    if (r.code === 1) return { yes: false };
    return { yes: null, why: lastLine(r.out) || 'git gave no reason' };
  }
  async function defaultBranch(release) {
    const r = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
    if (r.code === 0 && r.out.trim()) return r.out.trim().replace(/^origin\//, '');
    const t = release && release.target;
    if (t && !/^[0-9a-f]{40}$/i.test(t) && safeTag(t)) return t;
    return null;
  }
  function depVersions(lockText) {
    const out = {};
    try {
      const j = JSON.parse(lockText);
      for (const d of RUNNING_DEPS) {
        const p = (j.packages && j.packages[`node_modules/${d}`]) || (j.dependencies && j.dependencies[d]);
        out[d] = p && p.version ? String(p.version) : null;
      }
    } catch (_) { /* unreadable: treated as unchanged below */ }
    return out;
  }

  /** Can the Update button be offered for this tag commit? -> { canUpdate, why, blocks[] } */
  async function eligibility(release, sha) {
    const blocks = [];
    let st = null;
    try { st = fs.statSync(path.join(root, '.git')); } catch (_) { /* none */ }
    if (!st || !st.isDirectory()) blocks.push(st ? 'this folder is a linked git worktree' : 'this folder is not a git clone');
    const origin = await git(['remote', 'get-url', 'origin']);
    if (origin.code !== 0) blocks.push('this clone has no "origin" remote');
    else if (normRemote(origin.out.trim()) !== originWant) blocks.push(`its origin is ${origin.out.trim()}, not the public Mantle repo`);
    const branch = await git(['symbolic-ref', '-q', '--short', 'HEAD']);
    const def = await defaultBranch(release);
    if (branch.code !== 0 || !branch.out.trim()) blocks.push('it is not on a branch (detached HEAD)');
    else if (!def) blocks.push('Mantle could not tell the default branch (origin/HEAD is not set)');
    else if (branch.out.trim() !== def) blocks.push(`it is on branch ${branch.out.trim()}, not ${def}`);
    const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty.code !== 0) blocks.push(`git could not read its changes (${lastLine(dirty.out)})`);
    else if (dirty.out.trim()) {
      const n = dirty.out.trim().split('\n').length;
      blocks.push(`${n} tracked ${n === 1 ? 'file has' : 'files have'} changes that are not committed`);
    }
    const ff = await isAncestor('HEAD', sha);
    if (ff.yes === false) blocks.push('this folder has commits the release does not have, so a fast-forward is not possible');
    else if (ff.yes === null) blocks.push(`git could not compare it with the release (${ff.why})`);
    const a = await git(['show', 'HEAD:package-lock.json']);
    const b = await git(['show', `${sha}:package-lock.json`]);
    if (a.code === 0 && b.code === 0) {
      const va = depVersions(a.out), vb = depVersions(b.out);
      for (const d of RUNNING_DEPS) {
        if (va[d] && vb[d] && va[d] !== vb[d]) blocks.push(`the release changes ${d} (${va[d]} to ${vb[d]}), which the running Mantle is using, so it cannot be replaced from inside Mantle`);
      }
    }
    return { canUpdate: blocks.length === 0, why: blocks.length ? blocks.join('; ') : null, blocks, branch: def };
  }

  /** The commands to update by hand, for when there is no button (and for a failure). */
  function manual(release, ff) {
    const tag = release.tag;
    return [
      'Quit Mantle (tray > Quit Mantle), then in a terminal:',
      `cd "${root}"`,
      `git fetch ${cloneUrl} tag ${tag}`,
      ff === false ? `git merge ${tag}` : `git merge --ff-only ${tag}`,
      'npm install',
      'npm run build:sidecar',
      opt.live === false ? 'npm test' : 'npm run live',
    ].join('\n');
  }

  // ---------------------------------------------------------------- check
  /**
   * -> view { status: 'off'|'none'|'current'|'available'|'error', reason, release, canUpdate, why, manual,
   *          checkedAt, retryAt, head }
   */
  async function check() {
    const at = now();
    // recordError is read when the view is made: a record fault found during this check is on it
    const done = (v) => { last = Object.assign({ checkedAt: at, release: null, canUpdate: false, why: null, manual: null, retryAt: null, head: null, failedBefore: null, recordUnread: false, recordError: recordProblem }, v); return last; };
    const off = offWhy();
    if (off) return done({ status: 'off', reason: off, recordError: null });
    const ver = await git(['--version']);
    if (ver.code !== 0) return done({ status: 'error', reason: `Couldn't check for updates: ${ver.code === null ? 'git is not installed or not on PATH' : lastLine(ver.out)}` });
    const rel = await latest();
    if (!rel.ok) return done({ status: 'error', reason: rel.reason, kind: rel.kind, retryAt: rel.retryAt || null });
    if (!rel.release) return done({ status: 'none', reason: 'No release of Mantle has been published yet' });
    const release = rel.release;
    // the release that did not start last time: a different latest release means a newer one is out
    const mem = readRecord();
    let failed = mem.ok ? mem.rec : null;
    if (failed && failed.tag !== release.tag) { clearRecord(`a different release is out now (${release.tag}, not ${failed.tag})`); failed = null; }
    const tag = await fetchTag(release.tag);
    if (!tag.ok) return done({ status: 'error', release, reason: `Couldn't check for updates: ${tag.reason}` });
    const h = await head();
    const inHead = await isAncestor(tag.sha, 'HEAD');
    if (inHead.yes === null) return done({ status: 'error', release, reason: `Couldn't check for updates: git could not compare this folder with ${release.tag} (${inHead.why})` });
    if (inHead.yes) {
      if (failed) clearRecord(`this Mantle is running ${release.tag} now, so it started`);
      return done({ status: 'current', release, head: h,
        reason: h === tag.sha ? `Mantle is up to date (${release.tag})` : `Mantle is up to date: this folder already has ${release.tag} and more` });
    }
    if (failed && failed.sha && failed.sha !== tag.sha) { clearRecord(`${release.tag} now names another commit (${short(tag.sha)}, not ${short(failed.sha)})`); failed = null; }
    if (failed && failed.skipped) {
      return done({ status: 'skipped', release, head: h, sha: tag.sha, failedBefore: failed, reason: skippedWords(release.tag) });
    }
    const el = await eligibility(release, tag.sha);
    const ff = await isAncestor('HEAD', tag.sha);
    return done({ status: 'available', release, head: h, sha: tag.sha, canUpdate: el.canUpdate, why: el.why, failedBefore: failed, recordUnread: !mem.ok,
      reason: failed ? `Mantle ${release.tag} is out; it did not start last time` : `Mantle ${release.tag} is out`, manual: manual(release, ff.yes) });
  }

  // ---------------------------------------------------------------- the sidecar swap
  const exePath = path.join(root, SIDECAR_EXE);
  const nextPath = path.join(root, SIDECAR_NEXT);
  /** Put the staged sidecar in place by renames. -> { ok, reason, old } (old = where the previous exe went) */
  function swapIn() {
    if (!fs.existsSync(nextPath)) return { ok: false, reason: `the new sidecar is missing (${SIDECAR_NEXT})` };
    let old = null;
    try {
      if (fs.existsSync(exePath)) {
        old = `${exePath}.old-${now()}`;
        fs.renameSync(exePath, old);   // allowed while it runs; overwriting it is not
      } else fs.mkdirSync(path.dirname(exePath), { recursive: true });
      fs.renameSync(nextPath, exePath);
      return { ok: true, old };
    } catch (err) {
      if (old && !fs.existsSync(exePath)) { try { fs.renameSync(old, exePath); } catch (_) { /* said below */ } }
      return { ok: false, reason: `the new sidecar could not be put in place (${err.code || err.message})` };
    }
  }
  function swapBack(old) {
    try {
      if (fs.existsSync(exePath)) fs.renameSync(exePath, nextPath);
      if (old) fs.renameSync(old, exePath);
      return { ok: true };
    } catch (err) { return { ok: false, reason: err.code || err.message }; }
  }
  /** Old sidecars left by earlier updates (in use then, free now). */
  function sweepOld() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(path.dirname(exePath))) {
        if (/^Mantle\.Sidecar\.exe\.old-\d+$/.test(f)) { try { fs.unlinkSync(path.join(path.dirname(exePath), f)); n++; } catch (_) { /* still running: next start */ } }
      }
    } catch (_) { /* no bin folder */ }
    return n;
  }

  // ---------------------------------------------------------------- the watcher
  function defaultSpawnWatcher(script, cfgFile) {
    try {
      const child = spawn(process.execPath, [script, cfgFile], { detached: true, stdio: 'ignore', windowsHide: true,
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
      child.on('error', () => { /* the pid check below says it */ });
      child.unref();
      return child.pid ? { ok: true, pid: child.pid } : { ok: false, reason: 'it did not start' };
    } catch (err) { return { ok: false, reason: err.message }; }
  }
  function startWatcher(rec) {
    if (!watcherSource) return { ok: false, reason: 'the restart watcher could not be read when Mantle started' };
    const script = path.join(userData, 'update-watch.js');
    const cfgFile = path.join(userData, 'update-watch.json');
    const cfg = {
      id: rec.id, oldPid: opt.pid || process.pid, pendingFile: files.pending, doneFile: files.done, failedFile: files.failed,
      releaseFile: files.release, logFile: logPath, confirmMs: opt.confirmMs || CONFIRM_MS, live: !!opt.live,
      restoreScript: path.join(root, 'tools', 'restore-windows.ps1'),
      from: rec.from, to: rec.to, tag: rec.tag, how: rec.how,
    };
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(script, watcherSource);
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    } catch (err) { return { ok: false, reason: `the restart watcher could not be written (${err.message})` }; }
    return (opt.spawnWatcher || defaultSpawnWatcher)(script, cfgFile);
  }
  /** How to start Mantle again, for the watcher's message if the new one never comes up. */
  function howToStart(oldSha) {
    return [
      `cd "${root}"`,
      opt.live === false ? 'npm test' : 'npm run live',
      `To go back to the version you had: git reset --keep ${short(oldSha)}, then npm install and npm run build:sidecar`,
    ].join('\n');
  }

  // ---------------------------------------------------------------- apply
  /**
   * The Update button. onStep({ step, text, pct }) for the banner's progress.
   * -> { ok: true, restarting: true, from, to } or { ok: false, reason, log, rolledBack }
   */
  function apply(onStep) {
    if (busy) return Promise.resolve({ ok: false, reason: 'an update is already running', log: logPath });
    busy = applyNow(typeof onStep === 'function' ? onStep : () => {}).finally(() => { busy = null; });
    return busy;
  }
  async function applyNow(step) {
    const tell = (s, text, pct) => { say(`${s}: ${text}`); try { step({ step: s, text, pct }); } catch (_) { /* the banner is not the update */ } };
    const off = offWhy();
    if (off) return { ok: false, reason: off, log: logPath };
    const view = last && last.status === 'available' ? last : await check();
    if (view.status !== 'available') return { ok: false, reason: view.status === 'current' ? view.reason : `there is no update to install (${view.reason})`, log: logPath };
    const release = view.release;
    tell('fetch', `Getting ${release.tag}`, 5);
    const tag = await fetchTag(release.tag);
    if (!tag.ok) return fail(`Mantle was not updated: ${tag.reason}`, null);
    const el = await eligibility(release, tag.sha);
    if (!el.canUpdate) return fail(`Mantle was not updated: ${el.why}`, null);
    const old = await head();
    if (!old) return fail('Mantle was not updated: git could not read the current commit', null);
    say(`update ${short(old)} -> ${release.tag} (${short(tag.sha)}) in ${root}`);
    const did = { merged: false, installed: false, built: false, swapped: false, old: null };

    tell('merge', `Moving to ${release.tag}`, 15);
    const m = await git(['merge', '--ff-only', '--no-edit', tag.sha], 120000);
    say(`git merge --ff-only ${short(tag.sha)}: exit ${m.code}\n${m.out}`);
    if (m.code !== 0) return fail(`Mantle was not updated: git could not fast-forward to ${release.tag} (${lastLine(m.out) || `exit ${m.code}`})`, old, did);
    did.merged = true;
    const diff = await git(['diff', '--name-only', old, tag.sha]);
    const changed = diff.code === 0 ? diff.out.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : null;
    // git could not list the changes: do every step, which is what a by-hand update would do
    const needInstall = !changed || changed.includes('package.json') || changed.includes('package-lock.json');
    const needBuild = !changed || changed.some((f) => /^sidecar\/(.+\.(cs|manifest|resx|rc|ico)|build\.ps1)$/i.test(f));
    say(`changed: ${changed ? changed.length : 'unknown'} files; npm install ${needInstall ? 'needed' : 'not needed'}; sidecar build ${needBuild ? 'needed' : 'not needed'}`);

    if (needInstall) {
      tell('install', 'Installing packages (npm install)', 35);
      did.installed = true;
      const r = await commands.install();
      say(`npm install: exit ${r.code}\n${r.out}`);
      // before any rollback: a package file npm rewrote would make git reset --keep refuse to go back
      const kept = await keepPackageFiles('npm install');
      if (r.code !== 0) return fail(`Mantle was not updated: npm install failed (${npmWhy(r)})`, old, did);
      if (kept) return fail(`Mantle was not updated: ${kept}`, old, did);
    }
    if (needBuild) {
      tell('build', 'Building the link to Windows (sidecar)', 65);
      try { fs.rmSync(nextPath, { force: true }); } catch (_) { /* the build overwrites it */ }
      did.built = true;
      const r = await commands.build();
      say(`sidecar build: exit ${r.code}\n${r.out}`);
      if (r.code !== 0 || !fs.existsSync(nextPath)) return fail(`Mantle was not updated: the sidecar did not build (${r.code !== 0 ? buildWhy(r) : `no ${SIDECAR_NEXT} was made`})`, old, did);
    }

    tell('restart', `Restarting Mantle on ${release.tag}`, 90);
    if (did.built) {
      const s = swapIn();
      if (!s.ok) return fail(`Mantle was not updated: ${s.reason}`, old, did);
      did.swapped = true; did.old = s.old;
    }
    const rec = { id: `${now()}-${process.pid}`, at: now(), from: old, to: tag.sha, tag: release.tag, root, log: logPath, how: howToStart(old) };
    try { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(files.pending, JSON.stringify(rec, null, 2)); } catch (err) {
      return fail(`Mantle was not updated: the restart record could not be written (${err.message})`, old, did);
    }
    try { fs.rmSync(files.done, { force: true }); fs.rmSync(files.failed, { force: true }); } catch (_) { /* the id tells them apart */ }
    const w = startWatcher(rec);
    if (!w.ok) return fail(`Mantle was not updated: the watcher that makes sure Mantle comes back would not start (${w.reason})`, old, did);
    say(`restart watcher pid ${w.pid}`);
    let r;
    try { r = opt.restart ? await opt.restart(`Mantle was updated to ${release.tag}`) : { ok: false, reason: 'this Mantle has no restart road' }; } catch (err) { r = { ok: false, reason: err.message }; }
    if (!r || !r.ok) {
      try { fs.rmSync(files.pending, { force: true }); } catch (_) { /* the watcher also stops when the old pid lives on */ }
      return fail(`Mantle was not updated: it could not restart (${(r && r.reason) || 'no reason given'})`, old, did);
    }
    say(`restarting (via ${r.via || 'the restart road'})`);
    return { ok: true, restarting: true, from: old, to: tag.sha, tag: release.tag, log: logPath };
  }

  /** Put everything back and keep the old version running. */
  async function fail(reason, old, did) {
    say(`FAILED: ${reason}`);
    const notes = [];
    const d = did || {};
    if (d.swapped) { const b = swapBack(d.old); if (!b.ok) notes.push(`the previous sidecar could not be put back (${b.reason})`); }
    if (d.built) { try { fs.rmSync(nextPath, { force: true }); } catch (_) { /* harmless: the next build overwrites it */ } }
    const now2 = old ? await head() : null;
    if (old && (d.merged || (now2 && now2 !== old))) {
      const r = await git(['reset', '--keep', old], 120000);
      say(`git reset --keep ${short(old)}: exit ${r.code}\n${r.out}`);
      if (r.code !== 0) notes.push(`git could not go back to ${short(old)} (${lastLine(r.out)}): run git reset --keep ${short(old)} in the Mantle folder`);
    }
    if (d.installed && old) {
      const r = await commands.install();
      say(`npm install (putting the old packages back): exit ${r.code}\n${r.out}`);
      const kept = await keepPackageFiles('npm install for the old version');
      if (r.code !== 0) notes.push(`npm install for the old version failed too (${npmWhy(r)}): run npm install in the Mantle folder before Mantle next starts`);
      if (kept) notes.push(kept);
    }
    const kept = old ? ` Mantle is still on ${short(old)} and keeps running.` : ' Nothing was changed.';
    const full = `${reason}.${kept}${notes.length ? ` But: ${notes.join('; ')}.` : ''}`;
    say(full);
    return { ok: false, reason: full, log: logPath, rolledBack: !notes.length };
  }

  // ---------------------------------------------------------------- after a restart
  function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
  /**
   * The new Mantle is up: tell the watcher (done file), and say what happened.
   * -> { updated: rec | null, failed: rec | null, swept, record: null | { ok, reason?, rec?, cleared? } }
   * record: what became of the failed-release record on this start (kept from the watcher's failed record,
   * or cleared because the update to that release has now started); null when there was nothing to do.
   */
  function confirmStart() {
    const out = { updated: null, failed: null, swept: sweepOld(), record: null };
    const p = readJson(files.pending);
    const f = readJson(files.failed);
    if (p && p.id && f && f.id === p.id) {
      // the watcher already gave up on THIS update (the new Mantle never said it was up): this start is the
      // user's own, by hand, maybe after going back. It is not "updated"; the failed record says what happened.
      try { fs.rmSync(files.pending, { force: true }); } catch (_) { /* the failed record wins either way */ }
      say(`started again (pid ${process.pid}) after the restart watcher gave up on the update to ${p.tag}`);
    } else if (p && p.id) {
      try {
        fs.writeFileSync(files.done, JSON.stringify({ id: p.id, at: now(), pid: process.pid }, null, 2));
        fs.rmSync(files.pending, { force: true });
        out.updated = p;
        say(`up again after the update to ${p.tag} (pid ${process.pid})`);
      } catch (err) { say(`could not tell the watcher Mantle is up (${err.message})`); }
    }
    if (f && f.id) out.failed = f;
    if (out.updated) {
      // "Try again" worked: the release that did not start before has started now
      const mem = readRecord();
      if (!mem.ok) out.record = mem;
      else if (mem.rec && mem.rec.tag === out.updated.tag) out.record = Object.assign(clearRecord(`${out.updated.tag} started after the update`), { cleared: true });
    } else if (f && f.id && safeTag(f.tag)) {
      // the watcher gave up: keep it past this start (an older watcher wrote only update-failed.json)
      out.record = noteFailedStart(f);
    }
    return out;
  }
  function clearFailed() { try { fs.rmSync(files.failed, { force: true }); return true; } catch (_) { return false; } }

  return {
    check, apply, confirmStart, clearFailed, offWhy, eligibility, swapIn, swapBack, sweepOld,
    readRecord, skipRelease,
    get last() { return last; }, get busy() { return !!busy; }, get recordError() { return recordProblem; }, logPath, files, cloneUrl,
  };
}

module.exports = {
  createUpdater, run, safeTag, normRemote, netWords, cleanEnv, npmWhy, buildWhy, recordWhy, recordFrom,
  DEFAULTS, INSTALL_CMD, OPT_OUT_FILE, CHECK_EVERY_MS, FIRST_CHECK_MS, RUNNING_DEPS, SIDECAR_EXE, SIDECAR_NEXT, CONFIRM_MS, RELEASE_FILE,
};
