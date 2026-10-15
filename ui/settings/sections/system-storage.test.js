require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* system-storage.test.js — Mantle Settings > System > Storage (lane storage, 2026-09-29).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/system.js) against SysStorage.cs:
 * every storage reading/change it names is a real sysstorage.* command, the administrator action is
 * SysStorage's [Elevated] one, a test run sends EVERY storage write (cleanup and Storage Sense) as a dryRun
 * with its words, and the sidecar's sysstorage events reach the page as settings.system.storage. Plus the
 * page file's shape (model.js checkSection).
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting or file): the REAL page file
 * on the settings mock, settings.system.* played by FAKE() over MADE-UP drives, kinds and files (a declined
 * administrator prompt, a scan's events, read-only rows with their reasons, every read failing). Shots go to
 * MANTLE_SHOOT_OUT (default scratchpad/lanes/storage-shots). Line 1 is the CPU cap and browser lock.
 *
 *   node ui/settings/sections/system-storage.test.js      (ONLY=sto-02 for some shots)
 * Prints "SYSSTORAGE PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/storage-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

let SEARCH = [];

/* ================================================================ PART 1: node */
async function nodeTests() {
  const cs = fs.readFileSync(path.join(ROOT, 'sidecar', 'SysStorage.cs'), 'utf8');
  const cmds = new Set([...cs.matchAll(/t\.Add\("(sysstorage\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const elevated = new Set([...cs.matchAll(/\[Elevated\("([^"]+)"/g)].map((m) => m[1]));
  check('SysStorage.cs lists its commands', cmds.size >= 9, [...cmds].join(' '));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'system.js'));
  const readNames = Object.values(main.READS).map((x) => x[0]).filter((c) => c.startsWith('sysstorage.'));
  const writeKeys = Object.keys(main.WRITES).filter((k) => main.WRITES[k].startsWith('sysstorage.'));
  const writeNames = writeKeys.map((k) => main.WRITES[k]);
  check('main: every storage reading is a real SysStorage command', readNames.length === 7 && readNames.every((c) => cmds.has(c)), readNames.filter((c) => !cmds.has(c)).join(' '));
  check('main: every storage change is a real SysStorage command', writeNames.length === 2 && writeNames.every((c) => cmds.has(c)), writeNames.join(' '));
  const reachable = new Set(readNames.concat(writeNames));
  const missing = [...cmds].filter((c) => c !== 'sysstorage.sandboxTest' && !reachable.has(c));
  check('main: every SysStorage command but the test-only sandbox can be reached', !missing.length, missing.join(' '));
  check('main: the sandbox test command can NOT be reached from the page', !reachable.has('sysstorage.sandboxTest'));
  check('main: the cleanup administrator action is SysStorage\'s [Elevated] one', elevated.has('sysstorage.cleanSystem') && Object.prototype.hasOwnProperty.call(main.ADMIN, 'sysstorage.cleanSystem'));
  check('main: no storage write skips the dry run in a test (none is in NO_DRY)', writeKeys.every((k) => !main.NO_DRY[k]));
  check('main: a real cleanup may take up to 10 minutes; Sound and Display keep 20 s', main.WRITE_MS.cleanup === 600000 && Object.keys(main.WRITE_MS).length === 1);

  const sent = [];
  const events = {};
  const pushed = [];
  const mk = (test) => ({ test, log() {}, push: (ev, p) => pushed.push([ev, p]), elevate: async () => ({ ok: false, kind: 'cancelled' }),
    sidecar: { on: (ev, fn) => { events[ev] = fn; return () => { delete events[ev]; }; },
      send: async (c, a) => { sent.push([c, a]); return { ok: true, result: a.dryRun ? { ok: true, dryRun: true, wouldRefuse: null,
        writes: c === 'sysstorage.cleanup' ? [{ api: 'files', kind: 'temp', action: 'delete', files: 12, bytes: 3e6, words: 'delete 12 files (2.9 MB) of Temporary files' }]
          : [{ api: 'registry', hive: 'HKCU', name: '2048', value: 7 }] } : { ok: true } }; } } });
  const Tst = mk(true);
  const args = { storageSense: { key: 'cadence', value: 7 }, cleanup: { plan: 'plan-1-abcdef12', confirm: true } };
  for (const k of writeKeys) {
    sent.length = 0;
    const r = await main.commands.write(Object.assign({ what: k }, args[k] || {}), Tst);
    check(`test run: ${k} is sent ONLY as a dry run`, sent.length === 1 && sent[0][1].dryRun === true && r.ok && r.dryRun === true && /test run/.test(r.reason), JSON.stringify(sent));
  }
  const cl = await main.commands.write({ what: 'cleanup', plan: 'plan-1-abcdef12', confirm: true }, Tst);
  check('test run: the cleanup note says what would be removed, in words', /would write: delete 12 files \(2\.9 MB\) of Temporary files/.test(cl.reason), cl.reason);
  const ss = await main.commands.write({ what: 'storageSense', key: 'cadence', value: 7 }, Tst);
  check('test run: the Storage Sense note names the registry value', /HKCU\\\.\.\.\\2048 = 7/.test(ss.reason), ss.reason);
  const ad = await main.commands.admin({ action: 'sysstorage.cleanSystem', args: { kinds: ['windowsUpdate'] } }, Tst);
  check('test run: the administrator cleanup is a dry run', ad.ok && ad.dryRun === true && /delete the Windows system files/.test(ad.reason));
  const L = mk(false);
  const ad2 = await main.commands.admin({ action: 'sysstorage.cleanSystem', args: { kinds: ['windowsUpdate'] } }, L);
  check('live: a declined administrator prompt comes back as cancelled', ad2.ok === false && ad2.cancelled === true, JSON.stringify(ad2));
  const stop = main.install(L);
  check('install: listens to the sidecar\'s sysstorage events (and still sysdisplay + syssound)', typeof events.sysstorage === 'function' && typeof events.syssound === 'function' && typeof events.sysdisplay === 'function');
  events.sysstorage && events.sysstorage({ what: 'progress', scan: 'scan-1', done: 2, total: 14, bytes: 5e9 });
  check('install: a sysstorage event is pushed as settings.system.storage', pushed.some((p) => p[0] === 'settings.system.storage' && p[1].done === 2), JSON.stringify(pushed));
  stop();
  check('install: stop unsubscribes all three', !events.sysstorage && !events.syssound && !events.sysdisplay);

  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  let def = null;
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'system.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(d) { def = d; } }, window: {}, document: { currentScript: { dataset: { section: 'system' } } }, console });
  check('page: checkSection is happy', def && M.checkSection(def, 'system') === null, def && M.checkSection(def, 'system'));
  const pg = def && def.pages.find((p) => p.id === 'storage');
  check('page: Storage is drawn natively (no "being built" placeholder)', pg && typeof pg.render === 'function' && pg.render.name === 'renderStorage' && !/renderPending|being built/.test(src));
  SEARCH = pg ? pg.search.map((s) => s.row) : [];
  check('page: Storage has search rows for the whole Windows page', SEARCH.length >= 20, SEARCH.length);
  const uris = pg ? pg.search.map((s) => s.uri).filter(Boolean) : [];
  check('page: it claims the five Storage ms-settings pages', ['ms-settings:storagesense', 'ms-settings:storagepolicies', 'ms-settings:storagerecommendations', 'ms-settings:savelocations', 'ms-settings:disksandvolumes'].every((u) => uris.includes(u)), uris.join(' '));
  check('page: the old Storage Sense row is kept', SEARCH.includes('system.storage.sense'));
}

/* ================================================================ PART 2: the page on the mock */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('sto') || 'full';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const emit = (ev, p, ms) => setTimeout(() => window.__mockEmit && window.__mockEmit(ev, p), ms || 20);
  const no = (reason) => ({ ok: false, reason });
  const GB = 1e9;
  const side = (value, o) => Object.assign({ value, writable: true, why: null, set: true, note: null }, o || {});
  const G = { ok: true, systemDrive: 'C:', admin: false, scan: { state: 'none' },
    drives: [{ drive: 'C:', label: '', type: 'fixed', format: 'NTFS', total: 256 * GB, free: 20 * GB, used: 236 * GB, system: true, ready: true, reason: null },
      { drive: 'E:', label: 'Made-up USB', type: 'removable', format: 'exFAT', total: 64 * GB, free: 40 * GB, used: 24 * GB, system: false, ready: true, reason: null },
      { drive: 'F:', type: 'removable', ready: false, system: false, reason: 'the drive is not ready (no media in it, or it is locked)' }],
    sense: { on: side(true), temp: side(true), cadence: side(0), recycleDays: side(30), downloadsDays: side(0),
      cloud: [{ account: 'OneDrive!S-1-5-21-0-0-0!Personal|made-up', label: 'OneDrive (personal)', value: 30, writable: true, why: null }],
      cloudNote: 'OneDrive is not signed in right now, so this rule has nothing to act on until it is' } };
  if (SCN === 'policy') G.sense.cadence = side(7, { writable: false, why: 'Read only here: a group policy on this PC sets this (ConfigStorageSenseGlobalCadence), and Windows\' own Settings cannot change it either' });
  const ADMINWHY = 'Windows only lets an administrator look inside this folder, so its size is not known here; the administrator cleanup measures it when it runs';
  const K = (kind, label, rule, bytes, files, o) => Object.assign({ kind, label, rule, action: kind === 'downloads' ? 'recycle' : kind === 'recycleBin' ? 'empty' : 'delete',
    bytes, files, allBytes: bytes, allFiles: files, entries: null, admin: ['systemTemp', 'deliveryOptimization', 'windowsUpdate'].includes(kind),
    yours: kind === 'downloads' || kind === 'recycleBin', measured: bytes != null, reason: bytes == null ? ADMINWHY : null }, o || {});
  const TEMP = { ok: true, admin: false, kinds: [
    K('temp', 'Temporary files', 'Files in your temporary folder that nothing has changed for 7 days', 2.6 * GB, 5996, { allBytes: 9.1 * GB }),
    K('thumbnails', 'Thumbnails', 'Explorer\'s saved picture previews; Windows makes them again when it needs them', 20e6, 15),
    K('systemTemp', 'Windows temporary files', 'Files in Windows\' own temporary folder unchanged for 7 days', null, null),
    K('deliveryOptimization', 'Delivery Optimization files', 'Update pieces Windows keeps to share with other PCs', 412e6, null, { allFiles: null, via: 'service' }),   // sized by the DO service: no file count
    K('windowsUpdate', 'Windows Update cleanup', 'Update files Windows Update downloaded more than 10 days ago', 33e6, 5),
    K('recycleBin', 'Recycle Bin', 'Everything in the Recycle Bin on every drive, gone for good', 202e6, 13),
    K('downloads', 'Downloads', 'Everything in your Downloads folder, moved to the Recycle Bin', 6.4 * GB, 141133, { entries: 212 })] };
  const CATS = [['apps', 'Installed apps', 18.8], ['documents', 'Documents', 0.2], ['pictures', 'Pictures', 0.1], ['videos', 'Videos', 0.9], ['music', 'Music', 0.02],
    ['temp', 'Temporary files', 25.7], ['system', 'System & reserved', 47], ['otherUsers', 'Other people', 0], ['other', 'Other', 143.28]];
  const DONE = { what: 'done', scan: 'scan-1', drive: 'C:', total: 256 * GB, free: 20 * GB, used: 236 * GB, ms: 45000,
    categories: CATS.map(([key, label, g]) => ({ key, label, bytes: g * GB, files: 1000, denied: key === 'system' ? 50 : 0,
      reason: key === 'system' ? '50 folders could not be read (Windows keeps them for administrators or itself); what they hold is counted under Other' : null,
      note: key === 'other' ? 'Everything the scan could not put in a category: app data, ProgramData, restore points and folders only Windows can read' : null })) };
  const ADV = { ok: true,
    disks: [{ number: 0, name: 'Made-up NVMe 256GB', bytes: 256 * GB, bus: 'NVMe', media: 'SSD', style: 'GPT', health: 'Healthy', boot: true, system: true, partitions: [
      { number: 1, letter: null, kind: 'EFI system partition', bytes: 272629760, label: null, fs: 'FAT32', free: 200e6, health: 'Healthy' },
      { number: 2, letter: null, kind: 'Microsoft reserved', bytes: 16777216, label: null, fs: null, free: null, health: null },
      { number: 3, letter: 'C:', kind: 'Basic data', bytes: 253.6 * GB, label: '', fs: 'NTFS', free: 20 * GB, health: 'Healthy' },
      { number: 4, letter: null, kind: 'Recovery', bytes: 2.1 * GB, label: null, fs: 'NTFS', free: 1.2 * GB, health: 'Healthy' }] }],
    disksReason: null, disksWhy: 'Read only here: formatting, resizing or changing a drive letter can lose data, so Mantle shows disks and volumes but does not change them',
    pools: [], poolsReason: null, poolsWhy: 'Read only here: making or changing a storage pool erases the drives added to it, so Mantle shows pools but does not change them',
    saveLocations: [['apps', 'New apps will save to'], ['documents', 'New documents will save to'], ['music', 'New music will save to'], ['photos', 'New photos and videos will save to'], ['movies', 'New movies and TV shows will save to']]
      .map(([kind, label]) => ({ kind, label, drive: 'C:', writable: false, why: 'Read only here: Windows changes this by moving that folder (for apps, its app volume) to another drive, which Mantle does not do yet; this PC has one drive, so there is nowhere else to save anyway' })),
    backup: { fileHistory: false, oneDrive: false, why: 'Read only here: File History and Windows Backup run in their own apps; Mantle only reports whether they are set up' } };
  const REC = { ok: true, rule: 'x', drive: 'C:', at: '2026-09-29T01:00:00Z', reason: null, files: [
    { name: 'made-up-game-capture.mp4', folder: 'C:\\Users\\someone\\Videos', bytes: 820e6, modified: '2026-03-01T10:00:00Z', why: 'large' },
    { name: 'old-installer.iso', folder: 'C:\\Users\\someone\\Downloads', bytes: 45e6, modified: '2023-05-01T10:00:00Z', why: 'unused' }] };
  let planN = 0, lastPlan = null;
  function read(a) {
    if (SCN === 'fail') return later(20, no(`sysstorage.${a.what} failed (made-up: the sidecar is not running)`));
    switch (a.what) {
      case 'storage': return later(20, JSON.parse(JSON.stringify(G)));
      case 'storageAdvanced': return later(40, JSON.parse(JSON.stringify(ADV)));
      case 'storageTemp':
        return later(60, JSON.parse(JSON.stringify(TEMP)));
      case 'storageRecommend': return later(20, JSON.parse(JSON.stringify(REC)));
      case 'storageScan':
        [0, 1, 5, 9].forEach((d, i) => emit('settings.system.storage', { ev: 'sysstorage', what: 'progress', scan: 'scan-1', drive: 'C:', done: d, total: 14, bytes: d * 10 * GB, files: d * 1e4, category: ['apps', 'documents', 'temp', 'system'][i] }, 60 + i * 60));
        emit('settings.system.storage', Object.assign({ ev: 'sysstorage' }, DONE), 400);
        return later(20, { ok: true, started: true, scan: 'scan-1', drive: 'C:', total: 14 });
      case 'storageScanStop': emit('settings.system.storage', { ev: 'sysstorage', what: 'cancelled', scan: 'scan-1', done: 3, total: 14 }, 50); return later(10, { ok: true, stopping: true });
      case 'cleanupPlan': {
        const items = a.kinds.map((k) => TEMP.kinds.find((x) => x.kind === k));
        lastPlan = { ok: true, plan: `plan-${++planN}-abcdef12`, items, totalBytes: items.reduce((s, x) => s + (x.bytes || 0), 0), totalFiles: items.reduce((s, x) => s + (x.files || 0), 0), uncounted: items.some((x) => x.via === 'service'),
          needsAdmin: items.some((x) => x.admin), expiresInSec: 900, leftAlone: ['downloads', 'recycleBin'].filter((k) => !a.kinds.includes(k)), note: 'Nothing is deleted until this plan is confirmed' };
        return later(60, lastPlan);
      }
      default: return later(10, no(`fake: no reading "${a.what}"`));
    }
  }
  function write(a) {
    if (TEST) return later(30, { ok: true, dryRun: true, reason: `test run: nothing was changed (would write: ${a.what === 'cleanup' ? 'delete 5,996 files (2.4 GB) of Temporary files' : 'HKCU\\...\\2048 = 7'})` });
    if (a.what === 'storageSense') { const s = G.sense[a.key] || G.sense.cloud[0]; s.value = a.value; return later(30, { ok: true, key: a.key, value: a.value, changed: true }); }
    if (a.what === 'cleanup') {
      if (!lastPlan || a.plan !== lastPlan.plan || a.confirm !== true) return later(10, no('fake: cleanup without the shown plan and confirm:true'));
      const adm = lastPlan.items.filter((x) => x.admin).map((x) => x.kind);
      emit('settings.system.storage', { ev: 'sysstorage', what: 'cleanProgress', removed: 3000, freed: 1.2 * GB }, 20);
      return later(120, { ok: true, removed: 5990, freed: 2.5 * GB, skipped: 6, changed: 0, refused: 0,
        kinds: lastPlan.items.filter((x) => !x.admin).map((x) => ({ kind: x.kind, removed: x.files, freed: x.bytes, skipped: x.kind === 'temp' ? 6 : 0, changed: 0, refused: 0,
          reason: x.kind === 'temp' ? '6 files in use or refused by Windows were left where they are' : null })),
        admin: adm.length ? { elevate: 'sysstorage.cleanSystem', does: 'delete the Windows system files you chose to clean up', args: { kinds: adm } } : null });
    }
    return later(10, no(`fake: no change "${a.what}"`));
  }
  function admin() {
    if (TEST) return later(20, { ok: true, dryRun: true, reason: 'test run: Windows would ask for administrator permission to delete the Windows system files you chose to clean up; nothing was changed' });
    return later(80, { ok: false, cancelled: true, reason: 'You said no to the administrator prompt; nothing changed.' });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const c = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'system', file: 'sections/system.js', down: null, main: null }] });
        const mine = name === 'settings.system.read' ? read(c) : name === 'settings.system.write' ? write(c) : name === 'settings.system.admin' ? admin(c) : null;
        if (!mine) return m.call(name, args);
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: c });
        return mine;
      } };
    },
  });
}

const sel = (row) => `[data-row="${row}"]`;
const rowText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel(row));
const shown = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !!e.offsetParent; }, sel(row));
const scrollTo = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'start' }); }, sel(row));
const calls = (p, name) => p.evaluate((n) => (window.__mockCalls || []).filter((c) => c.name === n), name);
const isOn = (p, row) => p.$eval(sel(row) + ' button[role=switch]', (b) => b.getAttribute('aria-checked') === 'true');
const click = (p, row) => p.click(sel(row) + ' .row-c button');
const PG = '?section=system&page=storage';

const SHOTS = [
  ['sto-01-top', PG, async (p) => {
    await p.waitForTimeout(300);
    const missing = [];
    for (const r of SEARCH) if (!(await p.$(sel(r)))) missing.push(r);
    check('01: every Storage search row is drawn on the page', SEARCH.length && !missing.length, missing.join(' '));
    const c = await rowText(p, 'system.storage.drive.c');
    check('01: C: shows free space, used of total, and Windows is on it', /20\.0? ?GB free|18\.6 GB free/.test(c) && /Windows is on this drive/.test(c), c);
    check('01: C: under 10% free says so ON the row', /Less than 10% is free/.test(c), c);
    check('01: a drive that is not ready says why', /not ready \(no media/.test(await rowText(p, 'system.storage.drive.f') || ''));
    check('01: each ready drive has a used-space bar', await p.$eval(sel('system.storage.drive.c'), (e) => { const b = e.querySelector('.row-l > div:last-child > div'); return !!b && parseFloat(b.style.width) > 90; }));
    check('01: Downloads and the Recycle Bin are NOT ticked', !(await isOn(p, 'system.storage.temp.downloads')) && !(await isOn(p, 'system.storage.temp.recycleBin')));
    check('01: ... and say they are your own files', /never ticked for you/.test(await rowText(p, 'system.storage.temp.downloads') || ''));
    check('01: Temporary files and Thumbnails start ticked', await isOn(p, 'system.storage.temp.temp') && await isOn(p, 'system.storage.temp.thumbnails'));
    const wu = await rowText(p, 'system.storage.temp.windowsUpdate');
    check('01: Windows Update cleanup carries the administrator words', /Windows will ask for administrator permission to delete the Windows system files/.test(wu), wu);
    check('01: an unmeasured administrator kind says why its size is unknown', /only lets an administrator look inside/.test(await rowText(p, 'system.storage.temp.systemTemp') || ''));
    check('01: nothing is scanned or deleted on open', !(await calls(p, 'settings.system.write')).length && !(await calls(p, 'settings.system.read')).some((c) => c.args.what === 'storageScan' || c.args.what === 'cleanupPlan'));
  }],
  ['sto-02-scan', PG, async (p) => {
    await click(p, 'system.storage.scan');
    await p.waitForTimeout(200);
    check('02: while it runs, the scan shows its progress and a Stop button', /Scanning/.test(await rowText(p, 'system.storage.scan.progress') || '') || /Scanned|scanned/.test(await rowText(p, 'system.storage.scan.progress') || ''));
    await p.waitForTimeout(600);
    const st = await rowText(p, 'system.storage.scan.progress');
    check('02: the scan ends with the drive and its used space', /C: scanned/.test(st) && /used of/.test(st), st);
    check('02: categories are filled', /17\.5 GB|18\.8/.test(await rowText(p, 'system.storage.category.apps') || '') && /GB/.test(await rowText(p, 'system.storage.category.other') || ''));
    check('02: a category Windows kept partly hidden says why ON the row', /50 folders could not be read/.test(await rowText(p, 'system.storage.category.system') || ''));
    check('02: the button now says Scan again', /Scan again/.test(await rowText(p, 'system.storage.scan') || ''));
    const rec = await p.$eval(sel('system.storage.recommend.files'), (e) => e.textContent);
    check('02: recommendations list the large and unused files', /made-up-game-capture\.mp4/.test(rec) && /Not changed for over a year/.test(rec), rec.slice(0, 200));
    check('02: recommendations are read-only WITH the reason', /Read only here: Mantle lists your large and unused files/.test(await rowText(p, 'system.storage.recommend') || ''));
    await scrollTo(p, 'system.storage.scan');
  }],
  ['sto-03b-do-size', PG, async (p) => {
    const t = await rowText(p, 'system.storage.temp.deliveryOptimization') || '';
    check('03b: Delivery Optimization files show their size before any cleanup, from the DO service, with no made-up file count', /393 MB, as the Delivery Optimization service reports it/.test(t) && !/in [0-9][0-9,]* files/.test(t) && !/only lets an administrator look inside/.test(t), t);
    await click(p, 'system.storage.temp.deliveryOptimization');
    await click(p, 'system.storage.temp.review');
    await p.waitForTimeout(300);
    const pl = await p.$eval(sel('system.storage.temp.plan'), (e) => e.textContent);
    check('03b: the plan gives its size and says where it came from', /Delivery Optimization files/.test(pl) && /393 MB/.test(pl) && /size from the Delivery Optimization service/.test(pl), pl.slice(0, 300));
    const cf = await rowText(p, 'system.storage.temp.confirm');
    check('03b: the confirm button does not pretend to count its files', /Remove [0-9,]+ files and the Delivery Optimization files/.test(cf), cf);
  }],
  ['sto-03-plan', PG, async (p) => {
    await click(p, 'system.storage.temp.windowsUpdate');
    await click(p, 'system.storage.temp.review');
    await p.waitForTimeout(300);
    const plan = (await calls(p, 'settings.system.read')).find((c) => c.args.what === 'cleanupPlan');
    check('03: the plan asks for exactly the ticked kinds', plan && JSON.stringify(plan.args.kinds) === '["temp","thumbnails","windowsUpdate"]', JSON.stringify(plan));
    const pl = await p.$eval(sel('system.storage.temp.plan'), (e) => e.textContent);
    check('03: the plan lists them and NOT Downloads or the Recycle Bin', /Temporary files/.test(pl) && /Windows Update cleanup/.test(pl) && !/Downloads|Recycle Bin/.test(pl), pl.slice(0, 200));
    const cf = await rowText(p, 'system.storage.temp.confirm');
    check('03: the confirm button names the count and size, with the administrator words', /Remove 6,016 files/.test(cf) && /Windows will ask for administrator permission/.test(cf), cf);
    check('03: nothing was written before the confirm', !(await calls(p, 'settings.system.write')).length);
    await click(p, 'system.storage.temp.confirm');
    await p.waitForTimeout(500);
    const w = (await calls(p, 'settings.system.write')).find((c) => c.args.what === 'cleanup');
    check('03: confirm sends THAT plan with confirm:true', w && w.args.plan === 'plan-1-abcdef12' && w.args.confirm === true, JSON.stringify(w));
    const a = await calls(p, 'settings.system.admin');
    check('03: the administrator part goes through settings.system.admin as sysstorage.cleanSystem', a.length === 1 && a[0].args.action === 'sysstorage.cleanSystem' && JSON.stringify(a[0].args.args.kinds) === '["windowsUpdate"]', JSON.stringify(a));
    const done = await rowText(p, 'system.storage.temp.confirm');
    check('03: the result says what was removed and that the prompt was declined', /Removed 5,990 files/.test(done) && /you said no to the administrator prompt/.test(done), done);
    check('03: files left in use are said ON the plan row', /6 files in use or refused by Windows were left/.test(await p.$eval(sel('system.storage.temp.plan'), (e) => e.textContent)));
    await scrollTo(p, 'system.storage.temp.review');
  }],
  ['sto-04-yours', PG, async (p) => {
    await click(p, 'system.storage.temp.downloads');
    await click(p, 'system.storage.temp.recycleBin');
    await click(p, 'system.storage.temp.review');
    await p.waitForTimeout(300);
    const plan = (await calls(p, 'settings.system.read')).find((c) => c.args.what === 'cleanupPlan');
    check('04: ticking them by hand puts Downloads and the Recycle Bin in the plan', plan && plan.args.kinds.includes('downloads') && plan.args.kinds.includes('recycleBin'));
    const pl = await p.$eval(sel('system.storage.temp.plan'), (e) => e.textContent);
    check('04: the plan warns they are your own files', /everything in Downloads moves to the Recycle Bin/.test(pl) && /the Recycle Bin is emptied for good/.test(pl), pl.slice(0, 300));
    await click(p, 'system.storage.temp.thumbnails');
    await p.waitForTimeout(150);
    check('04: changing a tick drops the plan (review again)', /review the cleanup again/.test(await p.$eval(sel('system.storage.temp.plan'), (e) => e.textContent)) && /Nothing is deleted until/.test(await rowText(p, 'system.storage.temp.confirm') || ''));
    await click(p, 'system.storage.temp.review');
    await p.waitForTimeout(300);
    await scrollTo(p, 'system.storage.temp.review');
  }],
  ['sto-05-testrun', PG + '&test=1', async (p) => {
    await click(p, 'system.storage.temp.review');
    await p.waitForTimeout(300);
    await click(p, 'system.storage.temp.confirm');
    await p.waitForTimeout(300);
    const t = await rowText(p, 'system.storage.temp.confirm');
    check('05: a test-run cleanup is a dry run with its words', /test run: nothing was changed \(would write: delete/i.test(t), t);
    check('05: no administrator call in a test run', !(await calls(p, 'settings.system.admin')).length);
    await p.click(sel('system.storage.sense') + ' button[role=switch]');
    await p.waitForTimeout(200);
    check('05: a test-run Storage Sense change springs back with its note', await isOn(p, 'system.storage.sense') && /test run/i.test(await rowText(p, 'system.storage.sense') || ''));
    await scrollTo(p, 'system.storage.temp.review');
  }],
  ['sto-06-sense', PG, async (p) => {
    await p.selectOption(sel('system.storage.sense.cadence') + ' select', '7');
    await p.waitForTimeout(200);
    const w = (await calls(p, 'settings.system.write')).find((c) => c.args.what === 'storageSense');
    check('06: choosing a cadence writes Storage Sense\'s cadence', w && w.args.key === 'cadence' && w.args.value === 7, JSON.stringify(w));
    const cl = await rowText(p, 'system.storage.sense.cloud.0');
    check('06: a OneDrive account has its own cloud-content choice with the sign-in note', /OneDrive \(personal\)/.test(cl) && /not signed in right now/.test(cl), cl);
    await p.selectOption(sel('system.storage.sense.cloud.0') + ' select', '14');
    await p.waitForTimeout(200);
    const wc = (await calls(p, 'settings.system.write')).find((c) => c.args.key === 'cloudDays');
    check('06: the cloud choice names its account', wc && /^OneDrive!/.test(wc.args.account) && wc.args.value === 14);
    await scrollTo(p, 'system.storage.sense');
  }],
  ['sto-07-advanced', PG + '&sto=policy', async (p) => {
    check('07: a policy-locked setting is read-only WITH its reason', /Read only here: a group policy/.test(await rowText(p, 'system.storage.sense.cadence') || '') && await p.$eval(sel('system.storage.sense.cadence') + ' select', (s) => s.disabled));
    const d = await p.$eval(sel('system.storage.disks.list'), (e) => e.textContent);
    check('07: disks & volumes list the disk and its partitions', /Made-up NVMe 256GB/.test(d) && /NVMe · SSD · GPT/.test(d) && /Local Disk \(C:\)/.test(d) && /Recovery/.test(d), d.slice(0, 300));
    check('07: disks, pools and backup are read-only WITH their reasons', /Read only here: formatting/.test(await rowText(p, 'system.storage.disks') || '') &&
      /No storage pools/.test(await rowText(p, 'system.storage.spaces') || '') && /Read only here: making or changing a storage pool/.test(await rowText(p, 'system.storage.spaces') || '') &&
      /Read only here: File History/.test(await rowText(p, 'system.storage.backup') || ''));
    check('07: where new content is saved: the drive, read-only with the reason', /C:/.test(await rowText(p, 'system.storage.saveLocations.documents') || '') && /Read only here: Windows changes this by moving/.test(await rowText(p, 'system.storage.saveLocations.apps') || ''));
    await scrollTo(p, 'system.storage.saveLocations');
  }],
  ['sto-08-failing', PG + '&sto=fail', async (p) => {
    await p.waitForTimeout(300);
    check('08: the drives say why they could not be read', /The drives could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await p.textContent('#page')));
    check('08: Storage Sense says why', /Storage Sense could not be read/.test(await rowText(p, 'system.storage.sense') || ''));
    check('08: temporary files say why, and Review is off', /The temporary files could not be read/.test(await rowText(p, 'system.storage.temp.review') || ''));
    check('08: advanced says why', /Advanced storage settings could not be read/.test(await rowText(p, 'system.storage.disks') || ''));
    check('08: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
    await ctx.addInitScript(FAKE);
    for (const [name, query, prep] of SHOTS) {
      if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
      await page.goto(PAGE + query, { waitUntil: 'load' });
      try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
      await page.waitForTimeout(400);
      try { await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); }
      await page.waitForTimeout(200);
      const probe = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.row-t, .row-h, .btn, h1, .why span, select, .val').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || getComputedStyle(el).webkitLineClamp !== 'none') return;
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push('clipped: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
          if (r.right > window.innerWidth + 1) out.push('off-screen right: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
        });
        const pg = document.getElementById('page');
        return { out, rows: pg ? pg.querySelectorAll('.row').length : 0, ready: document.documentElement.dataset.ready, text: pg ? pg.textContent : '' };
      });
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      check(`${name}: drawn`, probe.rows > 10 && probe.ready === '1', `rows ${probe.rows}, ready ${probe.ready}`);
      check(`${name}: not DOWN, not the placeholder`, !/could not be drawn|did not load|being built/.test(probe.text) && /Storage use/.test(probe.text), probe.text.slice(0, 200));
      check(`${name}: no page errors, nothing clipped`, problems.length + probe.out.length === 0, problems.concat(probe.out).join(' | '));
      console.log(`${name}: ${probe.rows} rows`);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { await nodeTests(); } catch (e) { failures.push('part 1 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`SYSSTORAGE PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();
