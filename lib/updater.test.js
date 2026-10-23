'use strict';
/*
 * lib/updater.test.js -- the in-app updater (lib/updater.js) and its restart watcher (lib/update-watch.js),
 * against REAL git: throwaway repos in %TEMP% (a local bare "origin" with release tags, clones of it), a fake
 * GitHub releases API through the injectable fetch, and fake npm install / sidecar build steps that can be
 * told to fail. Nothing here touches the network, the real Mantle or Windows' shell.
 *
 * tools/restore-windows.ps1 is only parsed and read here, never run (it would touch the real taskbar).
 *
 *   node lib/updater.test.js     -> "UPDATER TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const U = require('./updater');
const { watch } = require('./update-watch');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ` -- ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-upd-test-'));
const GENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
});
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'init.defaultBranch=master', ...args], { cwd, env: GENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}
function write(root, rel, text) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
const lock = (electron, koffi, extra) => JSON.stringify({ name: 'mantle', lockfileVersion: 3, packages: Object.assign({ '': { name: 'mantle' },
  'node_modules/electron': { version: electron }, 'node_modules/koffi': { version: koffi } }, extra || {}) }, null, 2);

// ---- the release history, in a seed repo pushed to a bare origin
const SEED = path.join(T, 'seed');
const ORIGIN = path.join(T, 'origin.git');
fs.mkdirSync(SEED);
git(SEED, 'init', '-q', '-b', 'master');
write(SEED, 'package.json', '{ "name": "mantle", "version": "0.1.0" }\n');
write(SEED, 'package-lock.json', lock('44.3.0', '3.3.1'));
write(SEED, 'main.js', '// v0.1.0\n');
write(SEED, 'sidecar/Program.cs', '// sidecar 1\n');
write(SEED, 'tools/restore-windows.ps1', '# stand-in\n');
write(SEED, '.gitignore', 'node_modules/\nsidecar/bin/\nsidecar/bin-next/\n*.local\n');
git(SEED, 'add', '-A'); git(SEED, 'commit', '-q', '-m', 'v0.1.0'); git(SEED, 'tag', 'v0.1.0');
git(T, 'clone', '-q', '--bare', SEED, ORIGIN);
const SHA = { 'v0.1.0': git(SEED, 'rev-parse', 'HEAD') };
/** A release: change files in the seed, commit, tag, push. */
function release(tag, files) {
  for (const [rel, text] of Object.entries(files)) write(SEED, rel, text);
  git(SEED, 'add', '-A'); git(SEED, 'commit', '-q', '-m', tag); git(SEED, 'tag', tag);
  git(SEED, 'push', '-q', ORIGIN, 'master', `refs/tags/${tag}`);
  SHA[tag] = git(SEED, 'rev-parse', 'HEAD');
  return SHA[tag];
}

let nApp = 0;
/** A user's clone at `at` (a tag), on master, origin = the bare repo, the way `git clone` leaves it. */
function clone(at) {
  const dir = path.join(T, `app${++nApp}`);
  git(T, 'clone', '-q', ORIGIN, dir);
  if (at) git(dir, 'reset', '-q', '--hard', at);
  return dir;
}
function memStore() { let v = null; return { get: () => v, set: (x) => { v = JSON.parse(JSON.stringify(x)); }, peek: () => v }; }
/** A fake GitHub: answers latest = `tag` (null = 404), records the requests. */
function fakeApi(tag, extra) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: Object.assign({}, init && init.headers) });
    if (extra && extra.throw) throw extra.throw;
    if (extra && extra.status) return { status: extra.status, headers: new Map(Object.entries(extra.headers || {})), json: async () => ({}) };
    if (!tag) return { status: 404, headers: new Map(), json: async () => ({ message: 'Not Found' }) };
    const inm = init && init.headers && init.headers['If-None-Match'];
    if (inm && inm === `"etag-${tag}"`) return { status: 304, headers: new Map([['etag', `"etag-${tag}"`]]), json: async () => { throw new Error('no body'); } };
    return { status: 200, headers: new Map([['etag', `"etag-${tag}"`]]),
      json: async () => ({ tag_name: tag, name: `Mantle ${tag}`, html_url: `https://example.invalid/releases/${tag}`, target_commitish: 'master', published_at: '2026-10-22T00:00:00Z' }) };
  };
  fn.calls = calls;
  return fn;
}
/** Fake npm install / sidecar build: record, optionally fail; the build writes the staged exe like build.ps1 -Out. */
function fakeCommands(root, o) {
  const c = { installs: 0, builds: 0 };
  c.install = async () => { c.installs++; return o && o.installFails && c.installs === 1 ? { code: 1, out: 'npm ERR! code EBUSY\nnpm ERR! resource busy or locked' } : { code: 0, out: 'added 0 packages' }; };
  c.build = async () => {
    c.builds++;
    if (o && o.buildFails) return { code: 1, out: 'sidecar build FAILED: Program.cs(1,1): error CS1001' };
    write(root, 'sidecar/bin-next/Mantle.Sidecar.exe', 'NEW-SIDECAR');
    return { code: 0, out: 'sidecar built' };
  };
  return c;
}
function updater(root, over) {
  const ud = path.join(T, `ud-${path.basename(root)}`);
  const o = Object.assign({
    root, userData: ud, owner: 'o', repo: 'r', apiBase: 'http://127.0.0.1:9', cloneUrl: ORIGIN, originUrl: ORIGIN,
    test: false, testSource: true, live: false, fetch: fakeApi(null), store: memStore(),
    restart: async () => ({ ok: true, via: 'relaunch' }),
    spawnWatcher: () => ({ ok: true, pid: 4242 }),
  }, over || {});
  if (!o.commands) o.commands = fakeCommands(root);
  return { up: U.createUpdater(o), o, ud };
}
const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');

async function main() {
  // ---------------------------------------------------------------- pure helpers
  check('safeTag: v0.2.0', U.safeTag('v0.2.0'));
  check('safeTag: refuses an option, .., spaces', !U.safeTag('-x') && !U.safeTag('v1..2') && !U.safeTag('v 1') && !U.safeTag('') && !U.safeTag('a.lock'));
  check('normRemote: https and ssh forms of one repo are equal',
    U.normRemote('https://github.com/Owen-Silva/mantle.git') === U.normRemote('git@github.com:owen-silva/Mantle') &&
    U.normRemote('ssh://git@github.com/Owen-Silva/mantle/') === U.normRemote('https://github.com/Owen-Silva/mantle'));
  check('normRemote: a fork is not the repo', U.normRemote('https://github.com/someone/mantle.git') !== U.normRemote('https://github.com/Owen-Silva/mantle'));
  check('cleanEnv drops npm lifecycle variables', !('npm_lifecycle_event' in U.cleanEnv({ npm_lifecycle_event: 'live', PATH: 'x' })) && U.cleanEnv({ PATH: 'x' }).PATH === 'x');

  // ---------------------------------------------------------------- check: release states
  {
    const app = clone();
    const { up, o } = updater(app, { fetch: fakeApi(null) });
    const v = await up.check();
    check('no release: status none', v.status === 'none' && /No release/.test(v.reason), v);
    check('no release: one API call to releases/latest', o.fetch.calls.length === 1 && /\/repos\/o\/r\/releases\/latest$/.test(o.fetch.calls[0].url), o.fetch.calls);
  }
  {
    const app = clone();
    const { up } = updater(app, { fetch: fakeApi('v0.1.0') });
    const v = await up.check();
    check('up to date: status current, never available', v.status === 'current' && /up to date \(v0\.1\.0\)/.test(v.reason), v);
  }
  {
    const app = clone();
    write(app, 'main.js', '// my own change\n');
    git(app, 'commit', '-q', '-am', 'mine');
    const { up } = updater(app, { fetch: fakeApi('v0.1.0') });
    const v = await up.check();
    check('ahead of the release: status current (never prompted)', v.status === 'current' && /already has v0\.1\.0 and more/.test(v.reason), v);
  }

  release('v0.2.0', { 'main.js': '// v0.2.0\n', 'docs/notes.md': 'notes\n' });

  {
    const app = clone('v0.1.0');
    const { up, o } = updater(app, { fetch: fakeApi('v0.2.0') });
    const v = await up.check();
    check('available: status available with the Update button', v.status === 'available' && v.canUpdate === true && v.why === null && v.release.tag === 'v0.2.0', v);
    check('available: the tag was fetched from the release repo', git(app, 'rev-parse', 'refs/tags/v0.2.0^{commit}') === SHA['v0.2.0']);
    check('available: manual steps name the tag and a fast-forward', /git merge --ff-only v0\.2\.0/.test(v.manual) && /npm install/.test(v.manual) && /build:sidecar/.test(v.manual), v.manual);
    const v2 = await up.check();
    check('ETag: the second check sends If-None-Match and a 304 keeps the release', o.fetch.calls[1].headers['If-None-Match'] === '"etag-v0.2.0"' && v2.status === 'available' && v2.release.tag === 'v0.2.0', o.fetch.calls[1]);
  }
  {
    const app = clone('v0.2.0');
    const { up } = updater(app, { fetch: fakeApi('v0.2.0') });
    const v = await up.check();
    check('a clone already on the release: current', v.status === 'current', v);
  }

  // ---------------------------------------------------------------- check: no button, and why
  {
    const app = clone('v0.1.0');
    write(app, 'main.js', '// edited, not committed\n');
    const v = await updater(app, { fetch: fakeApi('v0.2.0') }).up.check();
    check('dirty: available, no button, says the tracked file', v.status === 'available' && !v.canUpdate && /1 tracked file has changes/.test(v.why), v);
  }
  {
    const app = clone('v0.1.0');
    write(app, 'scratch.txt', 'untracked\n');
    const v = await updater(app, { fetch: fakeApi('v0.2.0') }).up.check();
    check('untracked files alone do not block the button', v.status === 'available' && v.canUpdate === true, v);
  }
  {
    const app = clone('v0.1.0');
    git(app, 'checkout', '-q', '-b', 'my-branch');
    const v = await updater(app, { fetch: fakeApi('v0.2.0') }).up.check();
    check('off-branch: no button, names both branches', v.status === 'available' && !v.canUpdate && /on branch my-branch, not master/.test(v.why), v);
  }
  {
    const app = clone('v0.1.0');
    write(app, 'main.js', '// diverged\n');
    git(app, 'commit', '-q', '-am', 'local work');
    const v = await updater(app, { fetch: fakeApi('v0.2.0') }).up.check();
    check('diverged: available, no button, fast-forward impossible', v.status === 'available' && !v.canUpdate && /fast-forward is not possible/.test(v.why), v);
    check('diverged: the manual steps merge without --ff-only', /git merge v0\.2\.0/.test(v.manual) && !/--ff-only/.test(v.manual), v.manual);
  }
  {
    const app = clone('v0.1.0');
    const v = await updater(app, { fetch: fakeApi('v0.2.0'), originUrl: 'https://github.com/Owen-Silva/mantle' }).up.check();
    check('origin is not the public repo: no button, says the origin', v.status === 'available' && !v.canUpdate && /not the public Mantle repo/.test(v.why), v);
  }
  {
    const app = clone('v0.1.0');
    const wt = path.join(T, 'linked-wt');
    git(app, 'worktree', 'add', '-q', wt, 'HEAD');
    const fetch = fakeApi('v0.2.0');
    const v = await updater(wt, { fetch }).up.check();
    check('linked worktree: off, never asks GitHub', v.status === 'off' && /linked git worktree/.test(v.reason) && fetch.calls.length === 0, v);
  }
  {
    const app = clone('v0.1.0');
    write(app, U.OPT_OUT_FILE, 'The in-app updater is off for this folder.\n');
    const fetch = fakeApi('v0.2.0');
    const v = await updater(app, { fetch }).up.check();
    check('opt-out file: off, never asks GitHub', v.status === 'off' && v.reason.includes(U.OPT_OUT_FILE) && fetch.calls.length === 0, v);
    check('opt-out file is gitignored (*.local), so the tree stays clean', git(app, 'status', '--porcelain') === '', git(app, 'status', '--porcelain'));
    const r = await updater(app, { fetch }).up.apply();
    check('opt-out file: Update refuses too', r.ok === false && r.reason.includes(U.OPT_OUT_FILE), r);
  }
  {
    const app = clone('v0.1.0');
    const fetch = fakeApi('v0.2.0');
    const v = await updater(app, { fetch, test: true, testSource: false }).up.check();
    check('--test run: off, never asks GitHub', v.status === 'off' && /--test run/.test(v.reason) && fetch.calls.length === 0, v);
  }
  {
    const dir = path.join(T, 'zip-download');
    fs.mkdirSync(dir);
    const v = await updater(dir, { fetch: fakeApi('v0.2.0') }).up.check();
    check('not a git clone: off, with the reason', v.status === 'off' && /not a git clone/.test(v.reason), v);
  }

  // ---------------------------------------------------------------- check: errors
  {
    const app = clone('v0.1.0');
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const v = await updater(app, { fetch: fakeApi('v0.2.0', { throw: err }), apiBase: 'https://api.github.com' }).up.check();
    check('network error: error with "no internet"', v.status === 'error' && /^Couldn't check for updates: no internet connection \(api\.github\.com could not be found\)/.test(v.reason), v);
  }
  {
    const app = clone('v0.1.0');
    const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const v = await updater(app, { fetch: fakeApi('v0.2.0', { throw: err }) }).up.check();
    check('timeout: error that says it waited', v.status === 'error' && /no answer from .* within 20 s/.test(v.reason), v);
  }
  {
    const app = clone('v0.1.0');
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const v = await updater(app, { fetch: fakeApi('v0.2.0', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }) }).up.check();
    check('rate-limited (403, remaining 0): error kind rate, retry at the reset', v.status === 'error' && v.kind === 'rate' && v.retryAt === reset * 1000 && /limit .* tries again at \d\d:\d\d/.test(v.reason), v);
    const v2 = await updater(app, { fetch: fakeApi('v0.2.0', { status: 429, headers: { 'retry-after': '120' } }) }).up.check();
    check('rate-limited (429, retry-after): retry about 2 minutes out', v2.kind === 'rate' && Math.abs(v2.retryAt - (Date.now() + 120000)) < 5000, v2);
    const v3 = await updater(app, { fetch: fakeApi('v0.2.0', { status: 500 }) }).up.check();
    check('a server error: error with the status', v3.status === 'error' && /GitHub answered 500/.test(v3.reason), v3);
  }
  {
    const app = clone('v0.1.0');
    const v = await updater(app, { fetch: fakeApi('v9.9.9') }).up.check();
    check('a release whose tag is not in the repo: error, the tag could not be fetched', v.status === 'error' && /tag v9\.9\.9 could not be fetched/.test(v.reason), v);
  }
  {
    const app = clone('v0.1.0');
    const v = await updater(app, { fetch: fakeApi('--upload-pack=evil') }).up.check();
    check('a tag that is an option: refused before git sees it', v.status === 'error' && /not a tag name Mantle will use/.test(v.reason), v);
  }

  // ---------------------------------------------------------------- apply: success
  {
    const app = clone('v0.1.0');
    const steps = [];
    let restarted = 0;
    const cmds = fakeCommands(app);
    const { up, ud } = updater(app, { fetch: fakeApi('v0.2.0'), commands: cmds, restart: async () => { restarted++; return { ok: true, via: 'relaunch' }; } });
    await up.check();
    const r = await up.apply((s) => steps.push(s.step));
    check('apply: ok and restarting', r.ok === true && r.restarting === true && r.tag === 'v0.2.0', r);
    check('apply: fast-forwarded to the tag', headOf(app) === SHA['v0.2.0']);
    check('apply: no package change = no npm install, no sidecar change = no build', cmds.installs === 0 && cmds.builds === 0, cmds);
    check('apply: restarted once, through the host road', restarted === 1);
    check('apply: progress steps in order', steps.join(',') === 'fetch,merge,restart', steps);
    const pend = JSON.parse(fs.readFileSync(path.join(ud, 'update-pending.json'), 'utf8'));
    check('apply: the pending record names from, to and how to start again', pend.from === SHA['v0.1.0'] && pend.to === SHA['v0.2.0'] && /npm test/.test(pend.how) && /git reset --keep/.test(pend.how), pend);
    check('apply: the watcher config and its own copy are in userData', fs.existsSync(path.join(ud, 'update-watch.json')) && fs.readFileSync(path.join(ud, 'update-watch.js'), 'utf8').includes('function watch('));
    check('apply: the log says what ran', /git merge --ff-only/.test(fs.readFileSync(r.log, 'utf8')));
    // the new Mantle starts and confirms
    const next = updater(app).up;
    const c = next.confirmStart();
    check('confirmStart: the new Mantle reports the update and tells the watcher', c.updated && c.updated.tag === 'v0.2.0' && JSON.parse(fs.readFileSync(path.join(ud, 'update-done.json'), 'utf8')).id === pend.id && !fs.existsSync(path.join(ud, 'update-pending.json')), c);
    check('confirmStart: a second start has nothing to report', next.confirmStart().updated === null);
  }

  release('v0.3.0', { 'package.json': '{ "name": "mantle", "version": "0.3.0" }\n', 'package-lock.json': lock('44.3.0', '3.3.1', { 'node_modules/left-pad': { version: '1.3.0' } }) });
  {
    const app = clone('v0.2.0');
    const cmds = fakeCommands(app);
    const { up } = updater(app, { fetch: fakeApi('v0.3.0'), commands: cmds });
    const r = await up.apply();
    check('apply with package changes: npm install once, no build', r.ok && cmds.installs === 1 && cmds.builds === 0 && headOf(app) === SHA['v0.3.0'], { r, cmds });
  }

  release('v0.4.0', { 'sidecar/Program.cs': '// sidecar 2\n' });
  {
    const app = clone('v0.3.0');
    write(app, 'sidecar/bin/Mantle.Sidecar.exe', 'OLD-SIDECAR');
    const cmds = fakeCommands(app);
    const { up } = updater(app, { fetch: fakeApi('v0.4.0'), commands: cmds });
    const r = await up.apply();
    const bin = path.join(app, 'sidecar', 'bin');
    const olds = fs.readdirSync(bin).filter((f) => /\.old-\d+$/.test(f));
    check('apply with sidecar changes: built once, no npm install', r.ok && cmds.builds === 1 && cmds.installs === 0, { r, cmds });
    check('apply with sidecar changes: the new exe is in place, the old one renamed beside it', fs.readFileSync(path.join(bin, 'Mantle.Sidecar.exe'), 'utf8') === 'NEW-SIDECAR' && olds.length === 1 && !fs.existsSync(path.join(app, 'sidecar', 'bin-next', 'Mantle.Sidecar.exe')), fs.readdirSync(bin));
    check('the next start sweeps the old sidecar away', updater(app).up.sweepOld() === 1 && fs.readdirSync(bin).length === 1);
  }

  release('v0.5.0', { 'package-lock.json': lock('45.0.0', '3.3.2') });
  {
    const app = clone('v0.4.0');
    const v = await updater(app, { fetch: fakeApi('v0.5.0') }).up.check();
    check('a release that changes electron: no button (it cannot be replaced while running)', v.status === 'available' && !v.canUpdate && /changes electron \(44\.3\.0 to 45\.0\.0\)/.test(v.why), v);
    check('a release that changes koffi (a native module the running Mantle loaded): no button either', /changes koffi \(3\.3\.1 to 3\.3\.2\)/.test(v.why), v.why);
  }

  // ---------------------------------------------------------------- apply: failures roll back
  release('v0.6.0', { 'new-file.txt': 'from the release\n' });
  {
    const app = clone('v0.4.0');
    git(app, 'reset', '-q', '--hard', 'v0.5.0');
    write(app, 'new-file.txt', 'mine, untracked\n');   // a fast-forward would overwrite it
    const cmds = fakeCommands(app);
    const old = headOf(app);
    const { up } = updater(app, { fetch: fakeApi('v0.6.0'), commands: cmds });
    const r = await up.apply();
    check('merge failure: not ok, says git could not fast-forward', r.ok === false && /could not fast-forward to v0\.6\.0/.test(r.reason) && /still on/.test(r.reason), r);
    check('merge failure: HEAD unchanged, the user\'s file untouched, nothing installed', headOf(app) === old && fs.readFileSync(path.join(app, 'new-file.txt'), 'utf8') === 'mine, untracked\n' && cmds.installs === 0, cmds);
    check('merge failure: the reason carries the log path', typeof r.log === 'string' && fs.existsSync(r.log), r.log);
  }
  release('v0.7.0', { 'package.json': '{ "name": "mantle", "version": "0.7.0" }\n' });
  {
    const app = clone('v0.6.0');
    const cmds = fakeCommands(app, { installFails: true });
    const old = headOf(app);
    const { up } = updater(app, { fetch: fakeApi('v0.7.0'), commands: cmds });
    const r = await up.apply();
    check('install failure: not ok, says npm install failed (EBUSY)', r.ok === false && /npm install failed/.test(r.reason) && /resource busy/.test(r.reason), r);
    check('install failure: back on the old commit, install run again for the old packages', headOf(app) === old && cmds.installs === 2 && r.rolledBack === true, { head: headOf(app), cmds });
    check('install failure: tracked files clean again', git(app, 'status', '--porcelain', '--untracked-files=no') === '', git(app, 'status', '--porcelain', '--untracked-files=no') + ' / '+ git(app, 'diff'));
  }
  release('v0.8.0', { 'package.json': '{ "name": "mantle", "version": "0.8.0" }\n', 'sidecar/Program.cs': '// sidecar 3, broken\n' });
  {
    const app = clone('v0.7.0');
    write(app, 'sidecar/bin/Mantle.Sidecar.exe', 'OLD-SIDECAR');
    const cmds = fakeCommands(app, { buildFails: true });
    const old = headOf(app);
    const { up } = updater(app, { fetch: fakeApi('v0.8.0'), commands: cmds });
    const r = await up.apply();
    check('sidecar build failure: not ok, says the sidecar did not build', r.ok === false && /sidecar did not build/.test(r.reason) && /CS1001/.test(r.reason), r);
    check('sidecar build failure: old commit, npm install redone, old sidecar untouched, nothing staged', headOf(app) === old && cmds.installs === 2 &&
      fs.readFileSync(path.join(app, 'sidecar/bin/Mantle.Sidecar.exe'), 'utf8') === 'OLD-SIDECAR' && !fs.existsSync(path.join(app, 'sidecar/bin-next/Mantle.Sidecar.exe')), cmds);
  }
  release('v0.9.0', { 'sidecar/Program.cs': '// sidecar 4\n' });
  {
    const app = clone('v0.8.0');
    write(app, 'sidecar/bin/Mantle.Sidecar.exe', 'OLD-SIDECAR');
    const cmds = fakeCommands(app);
    const old = headOf(app);
    const { up, ud } = updater(app, { fetch: fakeApi('v0.9.0'), commands: cmds, restart: async () => ({ ok: false, reason: 'Electron would not arrange the relaunch (test)' }) });
    const r = await up.apply();
    check('restart could not be arranged: not ok, with the host\'s reason', r.ok === false && /could not restart \(Electron would not arrange the relaunch/.test(r.reason), r);
    check('restart could not be arranged: old commit, the old sidecar swapped back, the pending record gone', headOf(app) === old &&
      fs.readFileSync(path.join(app, 'sidecar/bin/Mantle.Sidecar.exe'), 'utf8') === 'OLD-SIDECAR' && !fs.existsSync(path.join(ud, 'update-pending.json')), fs.readdirSync(path.join(app, 'sidecar/bin')));
  }
  {
    const app = clone('v0.8.0');
    const { up } = updater(app, { fetch: fakeApi('v0.9.0'), spawnWatcher: () => ({ ok: false, reason: 'spawn EPERM' }) });
    const r = await up.apply();
    check('the watcher would not start: no restart at all, rolled back', r.ok === false && /watcher .* would not start \(spawn EPERM\)/.test(r.reason) && headOf(app) === SHA['v0.8.0'], r);
  }
  {
    const app = clone('v0.8.0');
    let release1;
    const gate = new Promise((r) => { release1 = r; });
    const cmds = { install: async () => ({ code: 0, out: '' }), build: async () => { await gate; write(app, 'sidecar/bin-next/Mantle.Sidecar.exe', 'N'); return { code: 0, out: '' }; } };
    const { up } = updater(app, { fetch: fakeApi('v0.9.0'), commands: cmds });
    const first = up.apply();
    await sleep(300);
    const second = await up.apply();
    release1();
    const r1 = await first;
    check('a second Update while one runs: refused, the first finishes', second.ok === false && /already running/.test(second.reason) && r1.ok === true, { second, r1 });
  }

  // ---------------------------------------------------------------- the sidecar swap on a RUNNING exe
  {
    const bin = path.join(T, 'running', 'sidecar', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), path.join(bin, 'Mantle.Sidecar.exe'));
    write(path.join(T, 'running'), 'sidecar/bin-next/Mantle.Sidecar.exe', 'NEXT');
    const p = spawn(path.join(bin, 'Mantle.Sidecar.exe'), ['-n', '8', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    await sleep(400);
    const up = U.createUpdater({ root: path.join(T, 'running'), userData: path.join(T, 'ud-running'), log: () => {} });
    const s = up.swapIn();
    check('swapIn on a running exe: Windows allows the rename, the new exe is in place', s.ok === true && fs.readFileSync(path.join(bin, 'Mantle.Sidecar.exe'), 'utf8') === 'NEXT' && fs.existsSync(s.old), s);
    check('the running old exe cannot be swept while it runs', up.sweepOld() === 0);
    try { p.kill(); } catch (_) { /* gone */ }
    await sleep(500);
  }

  // ---------------------------------------------------------------- the watcher spares itself
  {
    const { restoreArgs } = require('./update-watch');
    const a = restoreArgs('C:\\m\\tools\\restore-windows.ps1', 4321);
    check('the watcher runs the restore script with -SparePid <its own pid>', a.includes('-File') && a[a.indexOf('-SparePid') + 1] === '4321', a);
    const script = path.join(__dirname, '..', 'tools', 'restore-windows.ps1');
    const text = fs.readFileSync(script, 'utf8');
    check('restore-windows.ps1 declares -SparePid and leaves that pid out of the electron.exe it stops',
      /\[int\]\$SparePid = 0/.test(text) && /Contains\(\$needle\) -and \$_\.ProcessId -ne \$SparePid/.test(text));
    // parsed, never run: running it would touch the real taskbar
    const p = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8', timeout: 60000 });
    check('restore-windows.ps1 still parses (0 errors)', (p.stdout || '').trim() === '0', p.stdout || p.stderr);
  }

  // ---------------------------------------------------------------- the watcher: relaunch failure
  {
    const events = [];
    const ud = path.join(T, 'w1'); fs.mkdirSync(ud);
    const cfg = { id: 'a1', oldPid: 1, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'),
      logFile: path.join(ud, 'u.log'), confirmMs: 1200, exitMs: 3000, live: true, restoreScript: 'restore-windows.ps1', from: 'aaa', to: 'bbb', tag: 'v0.2.0', how: 'cd "X"\nnpm run live' };
    fs.writeFileSync(cfg.pendingFile, '{}');
    let alive = 3;
    const deps = {
      alive: () => (alive-- > 0), exists: (f) => fs.existsSync(f), readJson: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } },
      writeJson: (f, v) => { events.push('failed-record'); fs.writeFileSync(f, JSON.stringify(v)); }, sleep: (ms) => sleep(Math.min(ms, 50)), now: Date.now, log: () => {},
      restore: async () => { events.push('restore'); return { ok: true, code: 0, out: 'verified' }; },
      tell: async (title, text) => { events.push(`tell:${text}`); return true; },
    };
    const r = await watch(cfg, deps);
    check('relaunch failure (live): the watcher puts Windows back BEFORE telling the user', r.result === 'failed' && events[0] === 'restore' && events[1] === 'failed-record' && /^tell:/.test(events[2] || ''), events);
    check('relaunch failure (live): the message says how to start Mantle again and where the log is', /To start Mantle again/.test(events[2]) && /npm run live/.test(events[2]) && events[2].includes(cfg.logFile) && /taskbar is back/.test(events[2]), events[2]);
    const rec = JSON.parse(fs.readFileSync(cfg.failedFile, 'utf8'));
    check('relaunch failure: the failed record says the restore ran and was verified', rec.restore.ran === true && rec.restore.ok === true && rec.tag === 'v0.2.0', rec);
  }
  {
    const events = [];
    const ud = path.join(T, 'w2'); fs.mkdirSync(ud);
    const cfg = { id: 'a2', oldPid: 1, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'),
      logFile: path.join(ud, 'u.log'), confirmMs: 600, live: false, restoreScript: 'x', tag: 'v0.2.0', how: 'npm test' };
    const deps = { alive: () => false, exists: (f) => fs.existsSync(f), readJson: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } },
      writeJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v)), sleep: (ms) => sleep(Math.min(ms, 50)), now: Date.now, log: () => {},
      restore: async () => { events.push('restore'); return { ok: true }; }, tell: async () => { events.push('tell'); return true; } };
    const r = await watch(cfg, deps);
    check('relaunch failure (--test): never the restore script (it would stop the real Mantle), no message box, the record says why', r.result === 'failed' && events.length === 0 &&
      JSON.parse(fs.readFileSync(cfg.failedFile, 'utf8')).restore.ran === false, events);
  }
  {
    const ud = path.join(T, 'w3'); fs.mkdirSync(ud);
    const cfg = { id: 'a3', oldPid: 1, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'), logFile: path.join(ud, 'u.log'), confirmMs: 5000, live: true };
    let calls = 0;
    const deps = { alive: () => false, exists: (f) => fs.existsSync(f), readJson: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } },
      writeJson: () => {}, sleep: async (ms) => { if (++calls === 3) fs.writeFileSync(cfg.doneFile, JSON.stringify({ id: 'a3' })); await sleep(Math.min(ms, 30)); }, now: Date.now, log: () => {},
      restore: async () => { throw new Error('must not run'); }, tell: async () => { throw new Error('must not run'); } };
    const r = await watch(cfg, deps);
    check('the new Mantle confirms: the watcher stops, no restore, no message', r.result === 'up', r);
  }
  {
    const ud = path.join(T, 'w4'); fs.mkdirSync(ud);
    const cfg = { id: 'a4', oldPid: 1, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'), logFile: path.join(ud, 'u.log'), confirmMs: 5000, live: true };
    const deps = { alive: () => true, exists: (f) => fs.existsSync(f), readJson: () => null, writeJson: () => {}, sleep: (ms) => sleep(Math.min(ms, 30)), now: Date.now, log: () => {},
      restore: async () => { throw new Error('must not run'); }, tell: async () => { throw new Error('must not run'); } };
    const r = await watch(cfg, deps);
    check('the update was called off (pending record gone, old Mantle alive): the watcher exits quietly', r.result === 'called-off', r);
  }
  {
    // the real script, as a real detached-style process: a dead old pid, no confirmation, a test run
    const ud = path.join(T, 'w5'); fs.mkdirSync(ud);
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    const cfg = { id: 'a5', oldPid: dead, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'),
      logFile: path.join(ud, 'u.log'), confirmMs: 800, live: false, tag: 'v0.2.0', how: 'npm test' };
    fs.writeFileSync(path.join(ud, 'cfg.json'), JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'update-watch.js'), path.join(ud, 'cfg.json')], { encoding: 'utf8', timeout: 20000 });
    check('the watcher script itself: exit 1, a failed record, a log line', r.status === 1 && fs.existsSync(cfg.failedFile) && /did not say it was up/.test(fs.readFileSync(cfg.logFile, 'utf8')), { status: r.status, err: r.stderr });
    fs.writeFileSync(cfg.doneFile, JSON.stringify({ id: 'a5' }));
    const r2 = spawnSync(process.execPath, [path.join(__dirname, 'update-watch.js'), path.join(ud, 'cfg.json')], { encoding: 'utf8', timeout: 20000 });
    check('the watcher script itself: a confirmed start exits 0', r2.status === 0, { status: r2.status, err: r2.stderr });
  }
  {
    // apply with the REAL watcher spawn (plain node here, Electron-as-node in Mantle), then the new start confirms
    const app = clone('v0.8.0');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    const { up, ud } = updater(app, { fetch: fakeApi('v0.9.0'), spawnWatcher: undefined, pid: dead, confirmMs: 20000 });
    const r = await up.apply();
    await sleep(800);
    updater(app).up.confirmStart();
    const log = path.join(ud, 'update.log');
    const ok = await (async () => { for (let i = 0; i < 40; i++) { if (/the new Mantle is up/.test(fs.readFileSync(log, 'utf8'))) return true; await sleep(250); } return false; })();
    check('apply + the real watcher process + confirmStart: the watcher sees the new Mantle up', r.ok && ok, { r, log: fs.readFileSync(log, 'utf8').slice(-400) });
  }
  {
    const app = clone('v0.8.0');
    const { up, ud } = updater(app);
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'update-failed.json'), JSON.stringify({ id: 'x', tag: 'v0.9.0', restore: { ran: true, ok: true } }));
    const c = up.confirmStart();
    check('confirmStart: a failed record from the watcher is reported, and clearFailed removes it', c.failed && c.failed.tag === 'v0.9.0' && up.clearFailed() && !fs.existsSync(path.join(ud, 'update-failed.json')), c);
  }

  {
    // the watcher gave up on this update (failed record, same id), then the user started Mantle by hand
    const app = clone('v0.8.0');
    const { up, ud } = updater(app);
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'update-pending.json'), JSON.stringify({ id: 'g1', tag: 'v0.9.0', from: 'aaa', to: 'bbb' }));
    fs.writeFileSync(path.join(ud, 'update-failed.json'), JSON.stringify({ id: 'g1', tag: 'v0.9.0', restore: { ran: false, ok: null } }));
    const c = up.confirmStart();
    check('confirmStart after the watcher gave up: NOT "updated", the failed record reported, the pending one gone, no done record',
      c.updated === null && c.failed && c.failed.id === 'g1' && !fs.existsSync(path.join(ud, 'update-pending.json')) && !fs.existsSync(path.join(ud, 'update-done.json')), c);
    fs.writeFileSync(path.join(ud, 'update-pending.json'), JSON.stringify({ id: 'g2', tag: 'v0.9.0' }));
    const c2 = up.confirmStart();
    check('confirmStart: a pending record of a NEWER update than the failed one is still "updated"', c2.updated && c2.updated.id === 'g2' && fs.existsSync(path.join(ud, 'update-done.json')), c2);
  }

  // ---------------------------------------------------------------- npm and the tracked package files (lane mantle-verify)
  {
    const real = 'npm error code 7\nnpm error path C:\\m\\e2e-bad\nnpm error command failed\nnpm error command C:\\WINDOWS\\system32\\cmd.exe /d /s /c node -e "process.exit(7)"\n' +
      'npm error updater e2e: this package fails to install on purpose\nnpm error A complete log of this run can be found in: C:\\x\\_logs\\debug-0.log';
    check('npmWhy: the line that says what failed, not "A complete log of this run"', U.npmWhy({ code: 7, out: real }) === 'exit 7: updater e2e: this package fails to install on purpose', U.npmWhy({ code: 7, out: real }));
    check('npmWhy: an old npm\'s ERR! lines too', U.npmWhy({ code: 1, out: 'npm ERR! code EBUSY\nnpm ERR! resource busy or locked' }) === 'exit 1: resource busy or locked');
    check('npmWhy: npm that did not start says why', U.npmWhy({ code: null, out: 'cmd.exe is not installed or not on PATH' }) === 'cmd.exe is not installed or not on PATH');
    check('npmWhy: nothing said is still an exit code', U.npmWhy({ code: 3, out: '' }) === 'exit 3');
    const csc = 'sidecar build note: bluetooth and media use in-process WinRT\nC:\\Users\\x\\app\\sidecar\\UpdaterE2eBroken.cs(2,63): error CS1519: Invalid token \'is\' in class, struct, or interface member declaration\n' +
      'C:\\Users\\x\\app\\sidecar\\UpdaterE2eBroken.cs(2,70): error CS1519: Invalid token \'C\' in class\nsidecar build FAILED (csc exit 1)';
    check('buildWhy: csc\'s first error, file name without its folder, not "sidecar build FAILED (csc exit 1)"', U.buildWhy({ code: 1, out: csc }) === 'exit 1: UpdaterE2eBroken.cs(2,63): error CS1519: Invalid token \'is\' in class, struct, or interface member declaration', U.buildWhy({ code: 1, out: csc }));
    check('buildWhy: no csc error line: the build\'s last line', U.buildWhy({ code: 1, out: 'x\nsidecar build FAILED: no .cs files in C:\\m' }) === 'exit 1: sidecar build FAILED: no .cs files in C:\\m');
  }
  {
    // the default install command, as the updater really runs it (cmd.exe recorded, git real)
    const app = clone('v0.6.0');
    const seen = [];
    const up = U.createUpdater({ root: app, userData: path.join(T, 'ud-cmd'), owner: 'o', repo: 'r', apiBase: 'http://127.0.0.1:9', cloneUrl: ORIGIN, originUrl: ORIGIN,
      testSource: true, fetch: fakeApi('v0.7.0'), store: memStore(), restart: async () => ({ ok: true, via: 'relaunch' }), spawnWatcher: () => ({ ok: true, pid: 4242 }),
      run: (file, args, o) => (/cmd(\.exe)?$/i.test(file) ? (seen.push(args.join(' ')), Promise.resolve({ code: 0, out: 'up to date' })) : U.run(file, args, o)) });
    const r = await up.apply();
    check('the install Update runs is npm install --no-save (npm never rewrites the tracked package files)', r.ok && seen.length === 1 && seen[0].endsWith(U.INSTALL_CMD) && /--no-save/.test(U.INSTALL_CMD), { r, seen });
  }
  /** a fake npm that rewrites package-lock.json the way npm 11 did to 0.1.0's lock (one added line) */
  function rewritingCommands(root, o) {
    const c = fakeCommands(root, o);
    const inner = c.install;
    c.install = async () => {
      const f = path.join(root, 'package-lock.json');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"name": "mantle"', '"name": "mantle", "license": "added by npm"'));
      return inner();
    };
    return c;
  }
  release('v0.10.0', { 'package.json': '{ "name": "mantle", "version": "0.10.0" }\n', 'package-lock.json': lock('45.0.0', '3.3.2', { 'node_modules/left-pad': { version: '1.3.1' } }), 'sidecar/Program.cs': '// sidecar 5, broken\n' });
  {
    const app = clone('v0.9.0');
    write(app, 'sidecar/bin/Mantle.Sidecar.exe', 'OLD-SIDECAR');
    const cmds = rewritingCommands(app, { buildFails: true });
    const old = headOf(app);
    const { up, ud } = updater(app, { fetch: fakeApi('v0.10.0'), commands: cmds });
    const r = await up.apply();
    const status = git(app, 'status', '--porcelain', '--untracked-files=no');
    const log = fs.readFileSync(path.join(ud, 'update.log'), 'utf8');
    check('npm rewrote the lock, then the build failed: rolled back all the way (git reset --keep was not refused)', r.ok === false && r.rolledBack === true && headOf(app) === old && !/could not go back/.test(r.reason), { r, head: headOf(app), old });
    check('...and the clone is clean, the old sidecar untouched', status === '' && fs.readFileSync(path.join(app, 'sidecar/bin/Mantle.Sidecar.exe'), 'utf8') === 'OLD-SIDECAR', status);
    check('...and the log says the package file npm changed was put back', /npm changed package-lock\.json during npm install; put back as committed: exit 0/.test(log), log.slice(-600));
  }
  release('v0.11.0', { 'package.json': '{ "name": "mantle", "version": "0.11.0" }\n' });
  {
    const app = clone('v0.10.0');
    const cmds = rewritingCommands(app);
    const { up } = updater(app, { fetch: fakeApi('v0.11.0'), commands: cmds });
    const r = await up.apply();
    const status = git(app, 'status', '--porcelain', '--untracked-files=no');
    check('npm rewrote the lock during a good update: the clone is still clean (the next release keeps its Update button)', r.ok && headOf(app) === SHA['v0.11.0'] && status === '', { r, status });
  }

  await failedRelease();
}

// ---------------------------------------------------------------- a release that did not start (lane mantle-failed-release)
const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeRec(ud, rec) { fs.mkdirSync(ud, { recursive: true }); fs.writeFileSync(path.join(ud, U.RELEASE_FILE), JSON.stringify(rec)); }
/** Hold a file open the way another program can: readable, but not deletable, until release(). */
function holdOpen(file) {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); Write-Output held; Start-Sleep -Seconds 30; $f.Close()`], { windowsHide: true });
  const held = new Promise((resolve) => { ps.stdout.on('data', (b) => { if (/held/.test(String(b))) resolve(true); }); ps.on('exit', () => resolve(false)); setTimeout(() => resolve(false), 15000); });
  return { held, release: () => { try { ps.kill(); } catch (_) { /* gone */ } } };
}

async function failedRelease() {
  const { durWords } = require('./update-watch');
  check('durWords: 3 minutes, 1 minute, 20 seconds, 90 seconds, 1 second', durWords(180000) === '3 minutes' && durWords(60000) === '1 minute' && durWords(20000) === '20 seconds' && durWords(90000) === '90 seconds' && durWords(600) === '1 second',
    [durWords(180000), durWords(60000), durWords(20000), durWords(90000), durWords(600)]);
  check('recordWhy: a good record is null; no tag, a bad tag, a bad commit, a bad "skipped" each say why',
    U.recordWhy({ tag: 'v1.0.0', sha: 'abcdef1', skipped: false }) === null && /not a record/.test(U.recordWhy([])) && /release tag/.test(U.recordWhy({})) &&
    /release tag/.test(U.recordWhy({ tag: '-x' })) && /commit id/.test(U.recordWhy({ tag: 'v1', sha: 'nope' })) && /skipped/.test(U.recordWhy({ tag: 'v1', skipped: 'yes' })));
  const ff = U.recordFrom({ id: 'i1', tag: 'v1.0.0', to: 'a'.repeat(40), from: 'b'.repeat(40), at: 5, log: 'L' }, 9);
  check('recordFrom: an older watcher\'s failed record (no reason) becomes a record with a plain default reason, not skipped',
    ff.tag === 'v1.0.0' && ff.sha === 'a'.repeat(40) && ff.from === 'b'.repeat(40) && ff.at === 5 && ff.skipped === false && /did not finish starting/.test(ff.reason) && U.recordWhy(ff) === null, ff);

  // ---- the watcher records it, durably
  {
    const ud = path.join(T, 'fr-w1'); fs.mkdirSync(ud);
    const cfg = { id: 'fr1', oldPid: 1, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'),
      releaseFile: path.join(ud, U.RELEASE_FILE), logFile: path.join(ud, 'u.log'), confirmMs: 600, live: false, from: 'c'.repeat(40), to: 'd'.repeat(40), tag: 'v0.2.0', how: 'npm test' };
    const lines = [];
    let durable = 0;
    const real = require('./update-watch').realDeps(cfg);
    const deps = { alive: () => false, exists: (f) => fs.existsSync(f), readJson: (f) => { try { return readJsonFile(f); } catch (_) { return null; } },
      writeJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v)), writeDurable: (f, v) => { durable++; real.writeDurable(f, v); },
      sleep: (ms) => sleep(Math.min(ms, 50)), now: Date.now, log: (l) => lines.push(l), restore: async () => ({ ok: true }), tell: async () => true };
    const r = await watch(cfg, deps);
    const rec = fs.existsSync(cfg.releaseFile) ? readJsonFile(cfg.releaseFile) : null;
    check('watcher gives up: it records the release that did not start (tag, commit, from, time, reason), through the durable write',
      r.result === 'failed' && durable === 1 && rec && rec.tag === 'v0.2.0' && rec.sha === cfg.to && rec.from === cfg.from && typeof rec.at === 'number' && rec.skipped === false &&
      rec.reason === 'it did not finish starting within 1 second' && rec.id === 'fr1' && U.recordWhy(rec) === null, { r: r.result, durable, rec });
    check('...the failed record carries the same reason, and the log says the next check warns',
      readJsonFile(cfg.failedFile).reason === rec.reason && lines.some((l) => /recorded that v0\.2\.0 did not start/.test(l)), lines);
    check('...no temp file is left beside it', fs.readdirSync(ud).every((f) => !/\.tmp-/.test(f)), fs.readdirSync(ud));
  }
  {
    // the record cannot be written: the watcher goes on, and its log says where it will be kept instead
    const ud = path.join(T, 'fr-w2'); fs.mkdirSync(ud);
    const lines = [];
    const cfg = { id: 'fr2', oldPid: 1, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'),
      releaseFile: path.join(ud, 'no-such-folder', U.RELEASE_FILE), logFile: path.join(ud, 'u.log'), confirmMs: 300, live: false, to: 'e'.repeat(40), tag: 'v0.2.0' };
    const deps = Object.assign(require('./update-watch').realDeps(cfg), { alive: () => false, sleep: (ms) => sleep(Math.min(ms, 30)), log: (l) => lines.push(l), tell: async () => true });
    const r = await watch(cfg, deps);
    check('watcher: a record it cannot write is said in its log (with the cause), and the failed record is still written',
      r.result === 'failed' && fs.existsSync(cfg.failedFile) && lines.some((l) => /could not be written \(ENOENT\); the next start keeps it from update-failed\.json/.test(l)), lines.slice(-3));
  }
  {
    // the real watcher script, as Mantle runs it: the record is on disk after it exits
    const ud = path.join(T, 'fr-w3'); fs.mkdirSync(ud);
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    const cfg = { id: 'fr3', oldPid: dead, pendingFile: path.join(ud, 'p.json'), doneFile: path.join(ud, 'd.json'), failedFile: path.join(ud, 'f.json'),
      releaseFile: path.join(ud, U.RELEASE_FILE), logFile: path.join(ud, 'u.log'), confirmMs: 700, live: false, to: 'f'.repeat(40), from: '1'.repeat(40), tag: 'v0.3.0', how: 'npm test' };
    fs.writeFileSync(path.join(ud, 'cfg.json'), JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'update-watch.js'), path.join(ud, 'cfg.json')], { encoding: 'utf8', timeout: 20000 });
    const rec = fs.existsSync(cfg.releaseFile) ? readJsonFile(cfg.releaseFile) : null;
    check('the watcher script itself: after it exits, the release record is on disk and valid', r.status === 1 && rec && rec.tag === 'v0.3.0' && rec.sha === cfg.to && U.recordWhy(rec) === null, { status: r.status, rec });
  }
  {
    // apply hands the watcher the record's path
    const app = clone('v0.10.0');
    let cfgFile = null;
    const { up, ud } = updater(app, { fetch: fakeApi('v0.11.0'), spawnWatcher: (s, c) => { cfgFile = c; return { ok: true, pid: 4243 }; } });
    const r = await up.apply();
    check('apply: the watcher\'s config names the release record in the user\'s data folder', r.ok && cfgFile && readJsonFile(cfgFile).releaseFile === path.join(ud, U.RELEASE_FILE) && up.files.release === path.join(ud, U.RELEASE_FILE), cfgFile && readJsonFile(cfgFile));
  }

  // ---- confirmStart keeps it (an older watcher wrote update-failed.json only)
  {
    const app = clone('v0.10.0');
    const { up, ud } = updater(app);
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'update-pending.json'), JSON.stringify({ id: 'k1', tag: 'v0.11.0', from: SHA['v0.10.0'], to: SHA['v0.11.0'] }));
    fs.writeFileSync(path.join(ud, 'update-failed.json'), JSON.stringify({ id: 'k1', at: 1000, tag: 'v0.11.0', from: SHA['v0.10.0'], to: SHA['v0.11.0'], restore: { ran: false } }));
    const c = up.confirmStart();
    const rec = fs.existsSync(up.files.release) ? readJsonFile(up.files.release) : null;
    check('confirmStart after the watcher gave up: the release record is kept from update-failed.json (tag, commit, reason)',
      c.failed && c.record && c.record.ok && rec && rec.tag === 'v0.11.0' && rec.sha === SHA['v0.11.0'] && rec.id === 'k1' && /did not finish starting/.test(rec.reason), { c, rec });
    fs.writeFileSync(up.files.release, JSON.stringify(Object.assign({}, rec, { skipped: true })));
    const c2 = up.confirmStart();
    check('confirmStart again with the same failed update: the record is not rewritten (a skip stays a skip)', c2.record && c2.record.already === true && readJsonFile(up.files.release).skipped === true, c2.record);
  }

  // ---- the next check warns; skip; a newer release clears it
  const r12 = release('v0.12.0', { 'docs/v12.md': 'v0.12.0\n' });
  {
    const app = clone('v0.11.0');
    const { up, ud } = updater(app, { fetch: fakeApi('v0.12.0') });
    writeRec(ud, { id: 'w12', tag: 'v0.12.0', sha: r12, from: SHA['v0.11.0'], at: 1234, reason: 'it did not finish starting within 3 minutes', log: 'L', skipped: false });
    const v = await up.check();
    check('check: the same tag again is still offered (available, Update allowed) with the record on the view (failedBefore)',
      v.status === 'available' && v.canUpdate === true && v.failedBefore && v.failedBefore.tag === 'v0.12.0' && v.failedBefore.reason === 'it did not finish starting within 3 minutes' &&
      v.head === SHA['v0.11.0'] && /did not start last time/.test(v.reason) && v.recordError === null && v.recordUnread === false, v);
    const bad = up.skipRelease('v0.99.0');
    check('skipRelease: a tag with no record is refused, and says so', bad.ok === false && /no record that v0\.99\.0 did not start/.test(bad.reason), bad);
    const s = up.skipRelease('v0.12.0');
    const rec = readJsonFile(up.files.release);
    check('skipRelease: kept on disk (skipped, when), and the view is now "skipped"', s.ok && rec.skipped === true && typeof rec.skippedAt === 'number' && rec.tag === 'v0.12.0' &&
      s.view && s.view.status === 'skipped' && up.last.status === 'skipped' && /skipped because it did not start last time/.test(s.view.reason), { s, rec });
    const v2 = await up.check();
    check('check after skip: "skipped", nothing offered', v2.status === 'skipped' && v2.canUpdate === false && v2.release.tag === 'v0.12.0', v2);
    const fresh = updater(app, { fetch: fakeApi('v0.12.0') }).up;
    const v3 = await fresh.check();
    check('skip is remembered by a new Mantle (the record on disk)', v3.status === 'skipped', v3);
    const a = await fresh.apply();
    check('apply refuses a skipped release (nothing changed)', a.ok === false && /no update to install/.test(a.reason) && headOf(app) === SHA['v0.11.0'], a);
    // a newer release clears it
    const r13 = release('v0.13.0', { 'docs/v13.md': 'v0.13.0\n' });
    const { up: up13 } = updater(app, { fetch: fakeApi('v0.13.0') });
    const v4 = await up13.check();
    const log = fs.readFileSync(path.join(ud, 'update.log'), 'utf8');
    check('a newer release clears the record and is offered plainly', v4.status === 'available' && v4.sha === r13 && v4.failedBefore === null && !fs.existsSync(up13.files.release) &&
      /record of the update that did not start was removed: a different release is out now \(v0\.13\.0, not v0\.12\.0\)/.test(log), { v4, log: log.slice(-400) });
  }
  {
    // the user started that same release and it runs: it started, so the record goes
    const app = clone('v0.13.0');
    const { up, ud } = updater(app, { fetch: fakeApi('v0.13.0') });
    writeRec(ud, { tag: 'v0.13.0', sha: SHA['v0.13.0'], from: SHA['v0.12.0'], at: 1, reason: 'x', skipped: false });
    const v = await up.check();
    check('check on a folder running that release: current, and the record is gone (it started)', v.status === 'current' && !fs.existsSync(up.files.release), v);
  }
  {
    // the tag names another commit now: a different release, so the old record does not apply
    const app = clone('v0.12.0');
    const { up, ud } = updater(app, { fetch: fakeApi('v0.13.0') });
    writeRec(ud, { tag: 'v0.13.0', sha: 'abcdef1234567', from: SHA['v0.12.0'], at: 1, reason: 'x', skipped: true });
    const v = await up.check();
    check('the tag now names another commit: the record is removed and the release is offered plainly (even if it was skipped)', v.status === 'available' && v.failedBefore === null && !fs.existsSync(up.files.release), v);
  }

  // ---- Try again: the update to that release, and its start clears the record
  {
    const app = clone('v0.12.0');
    const { up, ud } = updater(app, { fetch: fakeApi('v0.13.0') });
    writeRec(ud, { id: 'old', tag: 'v0.13.0', sha: SHA['v0.13.0'], from: SHA['v0.12.0'], at: 1, reason: 'it did not finish starting within 3 minutes', skipped: false });
    const v = await up.check();
    const r = v.failedBefore ? await up.apply() : null;
    check('Try again = the same update: it applies (the record stays until the start is confirmed)', r && r.ok && headOf(app) === SHA['v0.13.0'] && fs.existsSync(up.files.release), r);
    const c = updater(app).up.confirmStart();
    check('the start after Try again confirms: "updated", and the record is cleared', c.updated && c.updated.tag === 'v0.13.0' && c.record && c.record.ok && c.record.cleared === true && !fs.existsSync(path.join(ud, U.RELEASE_FILE)), c);
  }
  {
    // an update to a DIFFERENT tag than the record's starts: the record is not this one's to clear
    const app = clone('v0.12.0');
    const { up, ud } = updater(app);
    writeRec(ud, { tag: 'v0.12.0', sha: SHA['v0.12.0'], at: 1, reason: 'x', skipped: true });
    fs.writeFileSync(path.join(ud, 'update-pending.json'), JSON.stringify({ id: 'p9', tag: 'v0.13.0' }));
    const c = up.confirmStart();
    check('confirmStart for another tag leaves the record alone', c.updated && c.record === null && readJsonFile(up.files.release).skipped === true, c);
  }

  // ---- a record that cannot be read or written: said, never ignored
  {
    const app = clone('v0.12.0');
    const { up, ud } = updater(app, { fetch: fakeApi('v0.13.0') });
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, U.RELEASE_FILE), '{ "tag": "v0.13.0", ');
    const v = await up.check();
    check('an unreadable record: the release is still offered, and the view says the record could not be read, where, and why',
      v.status === 'available' && v.failedBefore === null && v.recordUnread === true && /could not read its record of the update that did not start/.test(v.recordError) &&
      v.recordError.includes(path.join(ud, U.RELEASE_FILE)) && /not valid JSON/.test(v.recordError) && /Delete that file/.test(v.recordError) && up.recordError === v.recordError, v);
    check('...the file is left as it was (nothing is thrown away quietly), and the log says it', fs.readFileSync(path.join(ud, U.RELEASE_FILE), 'utf8') === '{ "tag": "v0.13.0", ' &&
      /could not read its record/.test(fs.readFileSync(path.join(ud, 'update.log'), 'utf8')));
    const s = up.skipRelease('v0.13.0');
    check('skipRelease on an unreadable record: refused, with the reason', s.ok === false && /could not read its record/.test(s.reason), s);
    fs.writeFileSync(path.join(ud, U.RELEASE_FILE), JSON.stringify({ tag: '--upload-pack=x' }));
    const v2 = await up.check();
    check('a record whose tag is not a usable tag is unreadable too', v2.recordUnread === true && /no usable release tag/.test(v2.recordError), v2.recordError);
    fs.rmSync(path.join(ud, U.RELEASE_FILE));
    fs.mkdirSync(path.join(ud, U.RELEASE_FILE));
    const v3 = await up.check();
    check('a record that cannot be opened (a folder in its place): said with the cause', v3.recordUnread === true && /could not be opened \(EISDIR\)/.test(v3.recordError), v3.recordError);
    fs.rmSync(path.join(ud, U.RELEASE_FILE), { recursive: true });
    const v4 = await up.check();
    check('once the record is gone, the fault is gone too', v4.status === 'available' && v4.recordError === null && v4.recordUnread === false && up.recordError === null, v4);
  }
  {
    // the skip cannot be saved: the record stays as it was, the reason is given
    const app = clone('v0.12.0');
    const { up, ud } = updater(app, { fetch: fakeApi('v0.13.0') });
    writeRec(ud, { tag: 'v0.13.0', sha: SHA['v0.13.0'], from: SHA['v0.12.0'], at: 1, reason: 'x', skipped: false });
    await up.check();
    const tmp = `${up.files.release}.tmp-${process.pid}`;
    fs.mkdirSync(tmp);
    const s = up.skipRelease('v0.13.0');
    fs.rmSync(tmp, { recursive: true });
    check('a skip that cannot be saved: refused with the cause, the record unchanged, the fault on the updater',
      s.ok === false && /could not save its record/.test(s.reason) && /EISDIR|EPERM|EACCES/.test(s.why) && readJsonFile(up.files.release).skipped === false && up.recordError === s.reason && up.last.status === 'available', s);
    const v = await up.check();
    check('...and the next check that reads it fine clears the fault (the warning is offered again)', v.status === 'available' && v.failedBefore && v.recordError === null, v);
  }
  {
    // the record cannot be removed (another program holds it open without delete sharing)
    const app = clone('v0.12.0');
    const { up, ud } = updater(app, { fetch: fakeApi('v0.13.0') });
    writeRec(ud, { tag: 'v0.12.0', sha: SHA['v0.12.0'], at: 1, reason: 'x', skipped: true });
    const h = holdOpen(up.files.release);
    const held = await h.held;
    const v = held ? await up.check() : null;
    h.release();
    check('a record that cannot be removed (a newer release is out): the view says so, with the cause; the newer release is still offered',
      held && v && v.status === 'available' && v.failedBefore === null && /could not remove its record/.test(v.recordError || ''), { held, v });
  }
  {
    // confirmStart cannot keep it: said on the result and the updater
    const app = clone('v0.12.0');
    const { up, ud } = updater(app);
    fs.mkdirSync(path.join(ud, U.RELEASE_FILE), { recursive: true });
    fs.writeFileSync(path.join(ud, 'update-failed.json'), JSON.stringify({ id: 'k9', tag: 'v0.13.0', to: SHA['v0.13.0'], restore: { ran: false } }));
    const c = up.confirmStart();
    check('confirmStart that cannot save the record: the result and recordError say why', c.failed && c.record && c.record.ok === false && /could not save its record/.test(c.record.reason) && up.recordError === c.record.reason, c.record);
  }
}

main().catch((err) => { failures.push(`threw: ${err && err.stack ? err.stack : err}`); }).finally(() => {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { /* a running exe can hold its folder for a moment */ }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`UPDATER TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
});
