'use strict';
/*
 * lib/updater-packaged.test.js -- the updater in a copy installed with Mantle-Setup.exe (option `packaged`,
 * lane inst-mantle-updater, 2026-10-29), and the updates feature's side of it (lib/features/updates.js: the
 * Download banner, the link it opens, a link that cannot be opened).
 *
 * Pure node: a fake GitHub releases API through the injectable fetch, a `run` that only RECORDS (a packaged
 * check must make no git or npm call at all), throwaway folders in %TEMP%, electron replaced by a stub.
 * Nothing here touches git, the network, a window or the real Mantle.
 *
 *   node lib/updater-packaged.test.js   -> "UPDATER PACKAGED TEST: n passed, m failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ` -- ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''));
  return ok;
}
const tick = () => new Promise((r) => setImmediate(r));

// electron, for lib/features/updates.js: isPackaged / getVersion / shell.openExternal are the test's to set
const opened = [];
const EL = {
  app: { getPath: () => os.tmpdir(), isPackaged: true, getVersion: () => '0.1.1' },
  shell: { fail: null, openExternal: async (u) => { opened.push(u); if (EL.shell.fail) throw new Error(EL.shell.fail); } },
};
const realLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return EL;
  return realLoad.apply(this, arguments);
};
const F = require('./features/updates');
const U = require('./updater');
Module._load = realLoad;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-upd-pkg-test-'));
let nDir = 0;
const dir = (name) => { const d = path.join(T, `${name}${++nDir}`); fs.mkdirSync(d, { recursive: true }); return d; };
function memStore(init) { let v = init ? JSON.parse(JSON.stringify(init)) : null; return { get: () => v, set: (x) => { v = JSON.parse(JSON.stringify(x)); }, peek: () => v }; }

const SETUP = 'Mantle-Setup.exe';
const assetsWith = (tag, extra) => [{ name: `Mantle-${tag}.zip`, browser_download_url: `https://example.invalid/dl/${tag}/Mantle.zip` },
  { name: SETUP, browser_download_url: `https://example.invalid/dl/${tag}/${SETUP}` }].concat(extra || []);
/** A fake GitHub: latest = o.tag (null = 404) with o.assets; o.status / o.throw / o.force304 for the faults. */
function fakeApi(o) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: Object.assign({}, init && init.headers) });
    if (o.throw) throw o.throw;
    if (o.status) return { status: o.status, headers: new Map(Object.entries(o.headers || {})), json: async () => ({}) };
    if (o.force304) return { status: 304, headers: new Map(), json: async () => { throw new Error('no body'); } };
    if (!o.tag) return { status: 404, headers: new Map(), json: async () => ({ message: 'Not Found' }) };
    const inm = init && init.headers && init.headers['If-None-Match'];
    if (inm && inm === `"etag-${o.tag}"`) return { status: 304, headers: new Map([['etag', inm]]), json: async () => { throw new Error('no body'); } };
    return { status: 200, headers: new Map([['etag', `"etag-${o.tag}"`]]),
      json: async () => ({ tag_name: o.tag, name: `Mantle ${o.tag}`, html_url: `https://example.invalid/releases/${o.tag}`, target_commitish: 'master',
        published_at: '2026-10-29T00:00:00Z', assets: o.assets === undefined ? assetsWith(o.tag) : o.assets }) };
  };
  fn.calls = calls;
  return fn;
}
/** A run() that only records: a packaged copy must never call it. Answers like a clone at `sha` for the smoke. */
function recorder(sha) {
  const runs = [];
  const fn = async (file, args) => {
    runs.push([file, ...args]);
    const a = args.slice(2);   // past -c core.quotepath=off
    if (a[0] === '--version') return { code: 0, out: 'git version 2.47.0.windows.1' };
    if (a[0] === 'rev-parse') return { code: 0, out: sha };
    if (a[0] === 'merge-base') return { code: 0, out: '' };
    return { code: 1, out: 'not answered by the fake' };
  };
  fn.runs = runs;
  return fn;
}
function updater(over) {
  const root = dir('app'), ud = dir('ud');
  const run = recorder('a'.repeat(40));
  const commands = { n: 0, install: async () => { commands.n++; return { code: 0, out: '' }; }, build: async () => { commands.n++; return { code: 0, out: '' }; } };
  const o = Object.assign({ root, userData: ud, owner: 'o', repo: 'r', apiBase: 'http://127.0.0.1:9', test: false, testSource: true,
    packaged: { version: '0.1.1', asset: SETUP }, fetch: fakeApi({ tag: 'v0.2.0' }), store: memStore(), run, commands,
    spawnWatcher: () => { commands.n++; return { ok: true, pid: 1 }; }, restart: async () => { commands.n++; return { ok: true }; } }, over || {});
  return { up: U.createUpdater(o), o, root, ud, run: o.run, commands };
}
const WHY = 'this copy of Mantle was installed with Mantle-Setup.exe, so it updates by running the new installer';

async function updaterTests() {
  // ---- the version words (pure)
  {
    const p = U.parseVersion('v1.2.3');
    check('parseVersion: v1.2.3 -> numbers, no prerelease', p && p.nums.join() === '1,2,3' && p.pre === null, p);
    check('parseVersion: 0.1.1 (no v) and 1.0.0-beta.2 (prerelease) and 1.0.0+build.5 (metadata)', !!U.parseVersion('0.1.1') && U.parseVersion('1.0.0-beta.2').pre.join() === 'beta,2' && U.parseVersion('1.0.0+build.5').pre === null);
    check('parseVersion: not a version -> null (nightly, 1.2, v1.2.3.4, empty, null)', ['nightly', '1.2', 'v1.2.3.4', '', null, 'v1.2.x'].every((s) => U.parseVersion(s) === null));
    const c = (a, b) => U.compareVersions(U.parseVersion(a), U.parseVersion(b));
    check('compareVersions: numbers compare as numbers (0.10.0 > 0.9.0)', c('0.10.0', '0.9.0') === 1 && c('0.9.0', '0.10.0') === -1);
    check('compareVersions: same -> 0, a leading v does not count', c('v0.1.1', '0.1.1') === 0);
    check('compareVersions: a prerelease sorts below the same numbers without one', c('0.2.0-beta.1', '0.2.0') === -1 && c('0.2.0', '0.2.0-rc.1') === 1);
    check('compareVersions: prerelease against prerelease (semver: alpha < alpha.1 < alpha.beta < beta.2 < beta.11 < rc.1)',
      c('1.0.0-alpha', '1.0.0-alpha.1') === -1 && c('1.0.0-alpha.1', '1.0.0-alpha.beta') === -1 && c('1.0.0-beta.2', '1.0.0-beta.11') === -1 && c('1.0.0-beta.11', '1.0.0-rc.1') === -1);
    check('compareVersions: a prerelease of a newer version is newer than an older release', c('0.3.0-beta.1', '0.2.9') === 1);
  }
  {
    const a = U.setupAsset(assetsWith('v0.2.0'), SETUP, 'v0.2.0');
    check('setupAsset: the asset named exactly Mantle-Setup.exe, https', a.url === `https://example.invalid/dl/v0.2.0/${SETUP}` && a.why === null, a);
    const none = U.setupAsset([{ name: 'Mantle-Setup-0.2.0.exe', browser_download_url: 'https://x.invalid/a.exe' }], SETUP, 'v0.2.0');
    check('setupAsset: a different name does not count; the reason says the release has none yet', none.url === null && none.why === 'the v0.2.0 release has no Mantle-Setup.exe yet', none);
    const http = U.setupAsset([{ name: SETUP, browser_download_url: 'http://x.invalid/a.exe' }], SETUP, 'v0.2.0');
    check('setupAsset: a link that is not https is not used, and the reason says so with the link', http.url === null && /not an https link \(http:\/\/x\.invalid\/a\.exe\)/.test(http.why), http);
    check('setupAsset: no assets list at all -> none yet', U.setupAsset(undefined, SETUP, 'v1.0.0').why === 'the v1.0.0 release has no Mantle-Setup.exe yet');
  }

  // ---- offWhy
  {
    const t = updater({ test: true, testSource: false });
    check('offWhy packaged: a --test run still never checks', /--test run/.test(t.up.offWhy() || ''), t.up.offWhy());
    const p = updater();
    fs.writeFileSync(path.join(p.root, U.OPT_OUT_FILE), '');
    check('offWhy packaged: the opt-out file still turns checks off', /no-updates\.local is in it/.test(p.up.offWhy() || ''), p.up.offWhy());
    const q = updater();
    check('offWhy packaged: no .git folder is not a reason to stay off', q.up.offWhy() === null, q.up.offWhy());
    const c = updater({ packaged: null });
    check('offWhy clone mode: no .git folder still says "not a git clone" (unchanged)', /not a git clone/.test(c.up.offWhy() || ''), c.up.offWhy());
    check('the updater says it is packaged (and a clone that it is not)', q.up.packaged && q.up.packaged.version === '0.1.1' && q.up.packaged.asset === SETUP && c.up.packaged === null, { q: q.up.packaged, c: c.up.packaged });
    const v = await t.up.check();
    check('check packaged in a --test run without a source: off, nothing asked', v.status === 'off' && t.o.fetch.calls.length === 0 && t.run.runs.length === 0, v);
  }

  // ---- newer, with the installer
  {
    const u = updater();
    const v = await u.up.check();
    check('newer: status available, no Update button, the reason it updates by installer', v.status === 'available' && v.canUpdate === false && v.why === WHY && v.reason === 'Mantle v0.2.0 is out', v);
    check('newer: download = the release asset Mantle-Setup.exe; page = the release page', v.download === `https://example.invalid/dl/v0.2.0/${SETUP}` && v.page === 'https://example.invalid/releases/v0.2.0' && v.downloadWhy === null, v);
    check('newer: manual says download it from that link, then run it (Windows back, quit, install, start again)',
      /^1\. Download Mantle-Setup\.exe from https:\/\/example\.invalid\/dl\/v0\.2\.0\/Mantle-Setup\.exe\n2\. Run it: it asks Mantle to put Windows back and quit, installs the update, and starts Mantle again\.$/.test(v.manual || ''), v.manual);
    check('newer: the view says packaged, with this copy\'s version; no failed-release state', v.packaged === true && v.version === '0.1.1' && v.failedBefore === null && v.recordError === null && v.head === null, v);
    check('newer: ZERO git or npm calls (run, install, build, watcher, restart)', u.run.runs.length === 0 && u.commands.n === 0, { runs: u.run.runs, n: u.commands.n });
    check('newer: up.last is the view', u.up.last === v);
  }
  // ---- same, older, prerelease, unparseable
  {
    const same = updater({ fetch: fakeApi({ tag: 'v0.1.1' }) });
    const v = await same.up.check();
    check('same version: current, "Mantle is up to date (v0.1.1)", no git', v.status === 'current' && v.reason === 'Mantle is up to date (v0.1.1)' && same.run.runs.length === 0, v);
    const older = updater({ fetch: fakeApi({ tag: 'v0.1.1' }), packaged: { version: '0.1.2', asset: SETUP } });
    const o = await older.up.check();
    check('this copy is newer: current, "this copy (0.1.2) is newer than the latest release (v0.1.1)"', o.status === 'current' && /this copy \(0\.1\.2\) is newer than the latest release \(v0\.1\.1\)/.test(o.reason), o);
    const preTag = updater({ fetch: fakeApi({ tag: 'v0.1.1-beta.1' }) });
    const p1 = await preTag.up.check();
    check('a prerelease tag of the installed numbers (v0.1.1-beta.1 vs 0.1.1): current, not offered', p1.status === 'current' && /newer than the latest release \(v0\.1\.1-beta\.1\)/.test(p1.reason), p1);
    const preHave = updater({ fetch: fakeApi({ tag: 'v0.1.1' }), packaged: { version: '0.1.1-beta.1', asset: SETUP } });
    const p2 = await preHave.up.check();
    check('a prerelease installed, the release out (0.1.1-beta.1 -> v0.1.1): available', p2.status === 'available' && p2.release.tag === 'v0.1.1', p2);
    const preBoth = updater({ fetch: fakeApi({ tag: 'v0.1.1-beta.2' }), packaged: { version: '0.1.1-beta.1', asset: SETUP } });
    check('beta.1 installed, beta.2 out: available', (await preBoth.up.check()).status === 'available');
    const badTag = updater({ fetch: fakeApi({ tag: 'nightly' }) });
    const b = await badTag.up.check();
    check('a tag that is not a version: error naming the tag and this copy\'s version', b.status === 'error' && /tag "nightly"/.test(b.reason) && /version "0\.1\.1"/.test(b.reason) && /the tag is not a version number/.test(b.reason) && badTag.run.runs.length === 0, b);
    const badVer = updater({ packaged: { version: 'dev', asset: SETUP } });
    const bv = await badVer.up.check();
    check('a version that is not one: error naming both', bv.status === 'error' && /tag "v0\.2\.0"/.test(bv.reason) && /version "dev"/.test(bv.reason) && /the version is not/.test(bv.reason), bv);
    const both = updater({ fetch: fakeApi({ tag: 'latest' }), packaged: { version: '', asset: SETUP } });
    check('neither one a version: says neither is', /neither is a version number/.test((await both.up.check()).reason));
  }
  // ---- the asset absent / not https
  {
    const none = updater({ fetch: fakeApi({ tag: 'v0.2.0', assets: [] }) });
    const v = await none.up.check();
    check('no Mantle-Setup.exe on the release: available, download null, the reason, manual points at the release page',
      v.status === 'available' && v.download === null && v.downloadWhy === 'the v0.2.0 release has no Mantle-Setup.exe yet' && /from the release page: https:\/\/example\.invalid\/releases\/v0\.2\.0/.test(v.manual), v);
    const http = updater({ fetch: fakeApi({ tag: 'v0.2.0', assets: [{ name: SETUP, browser_download_url: 'http://example.invalid/Mantle-Setup.exe' }] }) });
    const h = await http.up.check();
    check('an http (not https) asset link: not used, the reason says so', h.download === null && /not an https link/.test(h.downloadWhy || ''), h);
    check('...the packaged release cache keeps the link and its reason', none.o.store.peek().release.setup === null && /no Mantle-Setup\.exe yet/.test(none.o.store.peek().release.setupWhy));
  }
  // ---- the cache: 304, a cached release without the field
  {
    const u = updater();
    await u.up.check();
    const v2 = await u.up.check();
    check('second check: If-None-Match sent, a 304 reuses the cached release WITH its link', u.o.fetch.calls[1].headers['If-None-Match'] === '"etag-v0.2.0"' && v2.status === 'available' && v2.download === `https://example.invalid/dl/v0.2.0/${SETUP}`, { calls: u.o.fetch.calls, v2 });
    const cloneCache = { etag: '"etag-v0.2.0"', release: { tag: 'v0.2.0', name: 'Mantle v0.2.0', url: 'https://example.invalid/releases/v0.2.0', publishedAt: null, target: 'master' }, at: 1 };
    const s = updater({ store: memStore(cloneCache) });
    const v = await s.up.check();
    check('a cached release without the link (a clone\'s or an older Mantle\'s cache): asked for in full (no If-None-Match), so the link comes back',
      s.o.fetch.calls[0].headers['If-None-Match'] === undefined && v.download === `https://example.invalid/dl/v0.2.0/${SETUP}`, { h: s.o.fetch.calls[0].headers, v });
    const f = updater({ store: memStore(cloneCache), fetch: fakeApi({ force304: true }) });
    const w = await f.up.check();
    check('a 304 that hands back a cached release without the field anyway: no link, the release page instead, and it says why',
      w.status === 'available' && w.download === null && w.page === 'https://example.invalid/releases/v0.2.0' && /saved copy of the v0\.2\.0 release has no link to its Mantle-Setup\.exe/.test(w.downloadWhy || ''), w);
  }
  // ---- network, rate limit, no release
  {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const n = updater({ fetch: fakeApi({ throw: err }) });
    const v = await n.up.check();
    check('no internet: error with the reason, no git', v.status === 'error' && /^Couldn't check for updates: no internet connection/.test(v.reason) && v.kind === 'network' && n.run.runs.length === 0, v);
    const r = updater({ fetch: fakeApi({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } }) });
    const rv = await r.up.check();
    check('rate limit: error, kind rate, retryAt from GitHub, the reason says the limit', rv.status === 'error' && rv.kind === 'rate' && rv.retryAt === 2000000000 * 1000 && /limit on checks/.test(rv.reason), rv);
    const h = updater({ fetch: fakeApi({ status: 500 }) });
    check('GitHub answers 500: error "GitHub answered 500"', /GitHub answered 500/.test((await h.up.check()).reason));
    const z = updater({ fetch: fakeApi({ tag: null }) });
    const zv = await z.up.check();
    check('no release yet (404): none, with the reason', zv.status === 'none' && /No release of Mantle has been published yet/.test(zv.reason) && z.run.runs.length === 0, zv);
  }
  // ---- apply refuses
  {
    const u = updater();
    await u.up.check();
    let steps = 0;
    const r = await u.up.apply(() => { steps++; });
    check('apply packaged: refuses with the installer words, the log path, no step, no git/npm', r.ok === false &&
      r.reason === 'Mantle was not updated: this copy was installed with Mantle-Setup.exe; download the new installer instead' && r.log === u.up.logPath &&
      steps === 0 && u.run.runs.length === 0 && u.commands.n === 0 && u.up.busy === false, { r, steps, runs: u.run.runs, n: u.commands.n });
  }
  // ---- the failed-release record is not used
  {
    const u = updater();
    const rec = JSON.stringify({ id: 'x1', tag: 'v0.1.9', sha: 'b'.repeat(40), from: 'c'.repeat(40), at: 1, reason: 'it did not start' });
    fs.writeFileSync(path.join(u.ud, U.RELEASE_FILE), rec);   // a clone would clear this (a different release is out)
    const v = await u.up.check();
    check('packaged check: a record on disk is neither read into the view nor cleared nor rewritten', v.failedBefore === null && v.recordError === null &&
      fs.readFileSync(path.join(u.ud, U.RELEASE_FILE), 'utf8') === rec, v);
    const n = updater();
    await n.up.check();
    check('packaged check: no record file is created', !fs.existsSync(path.join(n.ud, U.RELEASE_FILE)));
  }
  // ---- clone mode: unchanged (one smoke)
  {
    const sha = 'd'.repeat(40);
    const root = dir('clone'); fs.mkdirSync(path.join(root, '.git'));
    const run = recorder(sha);
    const store = memStore();
    const u = U.createUpdater({ root, userData: dir('ud'), owner: 'o', repo: 'r', apiBase: 'http://127.0.0.1:9', test: false, testSource: true,
      fetch: fakeApi({ tag: 'v0.2.0' }), store, run, commands: { install: async () => ({ code: 0 }), build: async () => ({ code: 0 }) } });
    const v = await u.check();
    const got = run.runs.map((r) => r.join(' '));
    const want = ['git -c core.quotepath=off --version', 'git -c core.quotepath=off rev-parse -q --verify refs/tags/v0.2.0^{commit}',
      'git -c core.quotepath=off rev-parse HEAD', `git -c core.quotepath=off merge-base --is-ancestor ${sha} HEAD`];
    check('clone mode: check still asks git exactly as before (version, the tag, HEAD, is-ancestor) and says current', JSON.stringify(got) === JSON.stringify(want) && v.status === 'current' && v.packaged === undefined, { got, v });
    check('clone mode: the cached release is the same object as before (no setup / setupWhy fields)', JSON.stringify(Object.keys(store.peek().release)) === JSON.stringify(['tag', 'name', 'url', 'publishedAt', 'target']), store.peek());
    const a = await u.apply();
    check('clone mode: apply does not give the installer refusal', !/installed with Mantle-Setup\.exe/.test(a.reason || ''), a);
  }
}

// ---------------------------------------------------------------- the feature (lib/features/updates.js)
const availView = (o) => Object.assign({ status: 'available', release: { tag: 'v0.2.0', name: 'Mantle v0.2.0' }, packaged: true, version: '0.1.1', canUpdate: false, why: WHY,
  download: `https://example.invalid/dl/v0.2.0/${SETUP}`, downloadWhy: null, page: 'https://example.invalid/releases/v0.2.0', asset: SETUP,
  manual: '1. Download ...\n2. Run it ...', failedBefore: null, recordError: null, reason: 'Mantle v0.2.0 is out' }, o || {});
const BODY = 'This copy was installed with Mantle-Setup.exe. Download the new installer and run it: it asks Mantle to put Windows back and quit, installs the update and starts Mantle again.';

function harness(o) {
  const H = { posted: [], drops: 0, health: [], trays: [], cmds: {}, settings: new Map(), logs: [], cur: null, opts: null, onEnabled: null };
  const fake = H.up = {
    view: null, applied: 0, recordError: null, offWhy: () => null,
    confirmStart: () => ({ swept: 0, updated: null, failed: null, record: null }),
    check: async () => fake.view, skipRelease: () => ({ ok: false, reason: 'no' }),
    apply: async () => { fake.applied++; return { ok: false, reason: 'Mantle was not updated: this copy was installed with Mantle-Setup.exe; download the new installer instead' }; },
    clearFailed: () => true, logPath: 'D:\\data\\update.log', files: {},
  };
  const ctx = {
    flags: (o && o.flags) || { test: false },
    host: {
      ownBanners: { post: (key, b, onAction) => { H.posted.push(b); H.cur = { b, onAction }; return H.posted.length; }, drop: () => { H.drops++; H.cur = null; } },
      updates: { tray: (label) => H.trays.push(label) },
    },
    settings: { get: (k, d) => (H.settings.has(k) ? H.settings.get(k) : d), set: (k, v) => H.settings.set(k, v) },
    log: (l) => H.logs.push(l), health: (ok, why) => H.health.push({ ok, why: why || null }),
    command: (name, fn) => { H.cmds[name] = fn; }, enabled: () => true, onEnabled: (fn) => { H.onEnabled = fn; },
  };
  const real = U.createUpdater;
  U.createUpdater = (opts) => { H.opts = opts; return fake; };
  try { H.inst = F.install(ctx); } finally { U.createUpdater = real; }
  return H;
}

async function featureTests() {
  // ---- the banner words (pure)
  {
    const b = F.availableBanner(availView());
    check('banner packaged with the installer: kind download, title, body, Download + Later', b.kind === 'download' && b.title === 'Mantle v0.2.0 is out' &&
      b.body === `Mantle v0.2.0. ${BODY}` && JSON.stringify(b.actions) === JSON.stringify([{ id: 'download', label: 'Download', primary: true }, { id: 'later', label: 'Later' }]), b);
    const plain = F.availableBanner(availView({ release: { tag: 'v0.2.0', name: 'v0.2.0' } }));
    check('banner packaged: a release named as its tag adds no name', plain.body === BODY, plain.body);
    const n = F.availableBanner(availView({ download: null, downloadWhy: 'the v0.2.0 release has no Mantle-Setup.exe yet' }));
    check('banner packaged without the installer: says the release has none yet so it cannot link it; Open release page + Later',
      n.kind === 'download' && /has no Mantle-Setup\.exe yet, so|cannot link the installer because the v0\.2\.0 release has no Mantle-Setup\.exe yet\./.test(n.body) &&
      JSON.stringify(n.actions) === JSON.stringify([{ id: 'page', label: 'Open release page', primary: true }, { id: 'later', label: 'Later' }]), n);
    const np = F.availableBanner(availView({ download: null, downloadWhy: null, page: null }));
    check('banner packaged with no link at all: only Later, the steps in the detail, a default reason', np.actions.map((a) => a.id).join() === 'later' && np.detail === '1. Download ...\n2. Run it ...' && /has no Mantle-Setup\.exe yet/.test(np.body), np);
    const clone = F.availableBanner(availView({ packaged: undefined, canUpdate: true }));
    check('a clone\'s view (no packaged flag) keeps its Update banner', clone.kind === 'available' && clone.actions[0].id === 'update', clone);
  }
  // ---- which `packaged` the feature hands the updater
  {
    delete process.env.MANTLE_UPDATE_TEST;
    EL.app.isPackaged = true;
    const H = harness();
    check('install: a packaged app hands packaged { version: app.getVersion(), asset: Mantle-Setup.exe }', H.opts && JSON.stringify(H.opts.packaged) === JSON.stringify({ version: '0.1.1', asset: SETUP }), H.opts && H.opts.packaged);
    H.inst.stop();
    EL.app.isPackaged = false;
    const C = harness();
    check('install: a clone (not packaged) hands packaged null', C.opts && C.opts.packaged === null, C.opts && C.opts.packaged);
    C.inst.stop();
    const f = path.join(dir('src'), 'src.json');
    fs.writeFileSync(f, JSON.stringify({ apiBase: 'http://127.0.0.1:1', owner: 'o', repo: 'r', packaged: { version: '0.0.9', asset: SETUP } }));
    process.env.MANTLE_UPDATE_TEST = f;
    const S = harness({ flags: { test: true } });
    check('install: a --test source may hand in its own packaged', S.opts && JSON.stringify(S.opts.packaged) === JSON.stringify({ version: '0.0.9', asset: SETUP }), S.opts && S.opts.packaged);
    S.inst.stop();
    fs.writeFileSync(f, JSON.stringify({ apiBase: 'http://127.0.0.1:1', packaged: null }));
    EL.app.isPackaged = true;
    const N = harness({ flags: { test: true } });
    check('install: ...and packaged null in it means a clone even in a packaged app', N.opts && N.opts.packaged === null, N.opts && N.opts.packaged);
    N.inst.stop();
    delete process.env.MANTLE_UPDATE_TEST;
  }
  // ---- Download: opens the link, then counts as Later
  {
    const H = harness();
    H.up.view = availView();
    await H.cmds.check();
    check('check: the Download banner is posted; the tray row is there', H.cur && H.cur.b.kind === 'download' && H.trays[H.trays.length - 1] === 'Update Mantle to v0.2.0…', H.cur && H.cur.b);
    opened.length = 0; EL.shell.fail = null;
    const r = await H.cur.onAction('download');
    const st = await H.cmds.state();
    check('Download: opens the installer link in the browser, then is Later for that tag', opened.join() === `https://example.invalid/dl/v0.2.0/${SETUP}` && r.keep === false &&
      H.settings.get('laterTag') === 'v0.2.0' && st.posted === null, { opened, r, posted: st.posted });
    H.inst.stop();
  }
  {
    const H = harness();
    H.up.view = availView({ download: null, downloadWhy: 'the v0.2.0 release has no Mantle-Setup.exe yet' });
    await H.cmds.check();
    opened.length = 0;
    const r = await H.cur.onAction('page');
    check('Open release page: opens the release page, then Later', opened.join() === 'https://example.invalid/releases/v0.2.0' && r.keep === false && H.settings.get('laterTag') === 'v0.2.0', { opened, r });
    H.inst.stop();
  }
  {
    const H = harness();
    H.up.view = availView();
    await H.cmds.check();
    opened.length = 0; EL.shell.fail = 'no application is associated';
    const r = await H.cur.onAction('download');
    EL.shell.fail = null;
    const b = H.cur && H.cur.b;
    check('Download that Windows cannot open: an error banner with the reason, the link as its detail, kept up; not Later',
      r.keep === true && b && b.kind === 'link-failed' && b.tone === 'error' && /no application is associated/.test(b.body) && b.detail === `https://example.invalid/dl/v0.2.0/${SETUP}` &&
      !H.settings.has('laterTag') && H.logs.some((l) => /was not opened: Windows could not open the link/.test(l)), { r, b });
    const ok = await H.cur.onAction('ok');
    check('...its OK closes it', ok.keep === false && (await H.cmds.state()).posted === null, ok);
    H.inst.stop();
  }
  {
    const H = harness();
    H.up.view = availView({ download: 'http://evil.invalid/Mantle-Setup.exe' });
    await H.cmds.check();
    opened.length = 0;
    const r = await H.cur.onAction('download');
    check('Download with a link that is not https (re-checked): nothing opened, an error banner says so', opened.length === 0 && r.keep === true && H.cur.b.kind === 'link-failed' && /not an https link/.test(H.cur.b.body), { opened, b: H.cur.b });
    H.inst.stop();
  }
  // ---- the download banner is an offer like the others: dropped, OK/close = Later, turned off
  {
    const H = harness();
    H.up.view = availView();
    await H.cmds.check();
    const d0 = H.drops;
    H.up.view = { status: 'current', reason: 'Mantle is up to date (v0.2.0)', release: { tag: 'v0.2.0' }, packaged: true };
    await H.cmds.check();
    check('a Download banner is dropped when the release is no longer newer', H.drops === d0 + 1 && H.cur === null, { drops: H.drops });
    H.up.view = availView({ release: { tag: 'v0.2.1', name: 'Mantle v0.2.1' } });
    await H.cmds.check();
    const c = await H.cur.onAction('close');
    check('close on a Download banner is Later for its tag', c.keep === false && H.settings.get('laterTag') === 'v0.2.1', c);
    H.settings.set('laterUntil', 0);
    await H.cmds.check();
    const d1 = H.drops;
    H.onEnabled(false);
    check('turning update checks off drops a Download banner', H.drops === d1 + 1, { drops: H.drops });
    H.inst.stop();
  }
}

(async () => { await updaterTests(); await featureTests(); await tick(); })()
  .catch((err) => { failures.push(`threw: ${err && err.stack ? err.stack : err}`); })
  .finally(() => {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { /* a moment later */ }
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`UPDATER PACKAGED TEST: ${passed} passed, ${failures.length} failed`);
    process.exitCode = failures.length ? 1 : 0;
  });
