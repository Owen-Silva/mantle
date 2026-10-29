'use strict';
/* launcher-extras.test.js — the launcher's power rows and file search, in plain node.
 *
 * NOTHING HERE MAY LOCK, SLEEP, RESTART, SHUT DOWN OR SIGN OUT THIS MACHINE. Two locks make sure:
 *
 *   1. Every power call is a DRY RUN (dryRun:true, or MANTLE_POWER_DRYRUN=1 for the env path).
 *   2. Belt and braces: child_process is patched BEFORE lib/launcher-index.js is loaded, so any
 *      attempt to start shutdown.exe, rundll32.exe, explorer.exe or cmd.exe throws and is
 *      counted. The last check is that the count is zero. powercfg.exe (read-only) is allowed.
 *
 * The sidecar half (Sleep, file search) runs against a REAL sidecar exe when
 * MANTLE_SIDECAR_EXE names one that has the search/session commands (started --passive, which
 * also refuses a real sleep); otherwise those checks use a stub and say so.
 *
 *   node lib/launcher-extras.test.js
 *   MANTLE_SIDECAR_EXE=%TEMP%\mantle-launch\Mantle.Sidecar.exe node lib/launcher-extras.test.js
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const blocked = [];
const DANGEROUS = /(^|[\\/])(shutdown|rundll32|explorer|cmd)(\.exe)?$/i;
for (const fn of ['spawn', 'execFile', 'exec', 'spawnSync', 'execFileSync', 'execSync']) {
  const real = cp[fn];
  cp[fn] = function (file, ...rest) {
    const cmdline = String(file) + ' ' + (Array.isArray(rest[0]) ? rest[0].join(' ') : '');
    if (DANGEROUS.test(String(file).trim().split(/\s+/)[0]) || /LockWorkStation|shutdown/i.test(cmdline)) {
      blocked.push(fn + ': ' + cmdline);
      throw new Error('BLOCKED by launcher-extras.test.js: ' + cmdline);
    }
    return real.call(this, file, ...rest);
  };
}

const idx = require('./launcher-index');
const { build, search, launch, power, files, openFile, _internals } = idx;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; failures.push(label); }
}

/* ---- a minimal JSON-lines client for a real sidecar ---------------------- */
function startSidecar(exe) {
  const proc = cp.spawn(exe, ['--passive', '--parent-pid=' + process.pid], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id == null || !pending.has(msg.id)) continue;
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'no error text'));
    }
  });
  const call = (cmd, args, timeoutMs = 8000) => new Promise((resolve, reject) => {
    if (cmd === 'session' && args && args.action === 'sleep' && args.dryRun !== true) {
      reject(new Error('the test refuses to send a non-dry sleep')); return;
    }
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + cmd)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    proc.stdin.write(JSON.stringify(Object.assign({ id, cmd }, args || {})) + '\n');
  });
  return { call, stop: () => { try { proc.stdin.end(); } catch (_) { /* gone */ } } };
}

(async () => {
  /* ---- the power source ------------------------------------------------- */
  const { items, sources } = await build({ icon: async () => null });
  const powerSrc = sources.find(s => s.name === 'power');
  console.log('  power source: ' + JSON.stringify(powerSrc));
  ok(powerSrc && powerSrc.status === 'ok', 'power source is ok');
  const prow = items.filter(i => i.kind === 'power');
  console.log('  power rows: ' + prow.map(r => r.name + (r.confirm ? ' (asks first)' : '')).join(', '));
  ok(['Lock', 'Sleep', 'Restart', 'Shut down', 'Sign out'].every(n => prow.some(r => r.name === n)), 'the five always-on rows are indexed');
  ok(prow.filter(r => r.confirm).map(r => r.name).sort().join() === 'Restart,Shut down,Sign out', 'exactly Restart, Shut down, Sign out ask first');

  /* ---- powercfg /a parsing ---------------------------------------------- */
  const P = _internals.parseSleepStates;
  const REAL = 'The following sleep states are available on this system:\r\n    Standby (S0 Low Power Idle) Network Connected\r\n    Hibernate\r\n    Fast Startup\r\n\r\nThe following sleep states are not available on this system:\r\n    Standby (S1)\r\n\tThe system firmware does not support this standby state.\r\n';
  const r1 = P(REAL);
  ok(r1.ok && r1.hibernate && r1.sleep && /S0/.test(r1.sleepMode), 'parses this machine\'s powercfg /a (S0 + Hibernate)');
  const r2 = P('The following sleep states are available on this system:\r\n    Standby (S3)\r\n\r\nThe following sleep states are not available on this system:\r\n    Hibernate\r\n\tHibernation has not been enabled.\r\n');
  ok(r2.ok && !r2.hibernate && r2.hibernateWhy === 'Hibernation has not been enabled.', 'hibernate off: left out WITH Windows\' reason (' + r2.hibernateWhy + ')');
  /* Shut down follows Fast Startup the way Start does: /hybrid only while powercfg lists it. */
  const SA = _internals.shutdownArgs;
  ok(r1.fastStartup === true && SA(r1).join(' ') === '/s /hybrid /t 0', 'Fast Startup listed: Shut down is hybrid, like Start (' + SA(r1).join(' ') + ')');
  ok(r2.fastStartup === false && SA(r2).join(' ') === '/s /t 0', 'no Fast Startup: Shut down is a full /s /t 0');
  ok(SA({ ok: false, reason: 'x' }).join(' ') === '/s /t 0' && SA(null).join(' ') === '/s /t 0', 'unreadable sleep states: the always-valid full shutdown');
  const r3 = P('Die folgenden Standbymodi sind auf diesem System verfügbar:\r\n    Ruhezustand\r\n');
  ok(!r3.ok && /layout/.test(r3.reason), 'a localised powercfg is reported, not guessed at');

  /* ---- ranking: found by the words people type, never by one letter ------ */
  const top = (q) => search(q, items)[0] || {};
  const names = (q) => search(q, items).map(i => i.name);
  const cases = [
    ['sleep', 'Sleep'], ['restart', 'Restart'], ['reboot', 'Restart'], ['lock', 'Lock'],
    ['log out', 'Sign out'], ['logout', 'Sign out'], ['sign out', 'Sign out'], ['shutdown', 'Shut down'],
    ['shut down', 'Shut down'], ['turn off', 'Shut down'],
  ];
  for (const [q, want] of cases) ok(top(q).name === want, '"' + q + '" -> ' + want + ' first (got ' + top(q).name + ')');
  ok(names('shut').includes('Shut down'), '"shut" finds Shut down (' + names('shut').slice(0, 4).join(', ') + ')');
  ok(names('rebo').includes('Restart'), '"rebo" finds Restart');
  ok(names('hibernate').includes('Hibernate') === prow.some(r => r.name === 'Hibernate'), '"hibernate" finds Hibernate exactly when it is indexed');
  for (const q of ['s', 'sl', 'l', 'lo', 'r', 're']) {
    ok(!search(q, items).some(i => i.kind === 'power'), '"' + q + '" shows NO power row (Enter must not sleep/lock on a stray letter)');
  }
  ok(!search('', items).some(i => i.kind === 'power'), 'the empty launcher shows no power row');
  const pw = search('power', items);
  console.log('  "power" -> ' + pw.map(i => i.name + ':' + i.score).join(', '));
  /* Every row of the Power group this machine indexed (Sleep, Restart, Shut down, and Hibernate only where
     powercfg /a offers it: a "reduced" hiberfile leaves it out), not a fixed count that assumed Hibernate. */
  const groupRows = (word) => prow.filter(r => String(r.subtitle || '').toLowerCase().split(/[^a-z]+/)[0] === word).map(r => r.name);
  const shown = (rows) => rows.filter(i => i.kind === 'power').map(i => i.name);
  const powerGroup = groupRows('power');
  ok(powerGroup.length >= 3 && powerGroup.every(n => shown(pw).includes(n)),
    '"power" lists the power rows (' + powerGroup.join(', ') + '; got ' + shown(pw).join(', ') + ')');
  const sessionGroup = groupRows('session');
  const ses = search('session', items);
  ok(sessionGroup.length === 2 && sessionGroup.every(n => shown(ses).includes(n)),
    '"session" lists the session rows (' + sessionGroup.join(', ') + '; got ' + shown(ses).join(', ') + ')');
  const firstPowerRow = pw.findIndex(i => i.kind === 'power');
  ok(pw.slice(0, firstPowerRow).every(i => i.score > pw[firstPowerRow].score || i.kind !== 'power'), '"power": anything NAMED power-something stays above the rows');
  ok(search('sleep', items).every(i => typeof i.score === 'number'), 'search() rows carry a score for the merge');
  ok(items.every(i => i.score === undefined), 'the cached index objects are not mutated by search()');

  /* ---- power(): confirm, refusal paths, dry runs ------------------------- */
  const shutdownItem = prow.find(r => r.path === 'shutdown');
  const viaLaunch = await launch(shutdownItem, {});
  ok(!viaLaunch.ok && /launcher\.power/.test(viaLaunch.reason), 'apps.launch refuses a power row: ' + viaLaunch.reason);
  const noConfirm = await power({ action: 'shutdown' }, { dryRun: true });
  ok(!noConfirm.ok && /asks first/.test(noConfirm.reason), 'Shut down without confirmed:true is refused: ' + noConfirm.reason);
  const noConfirmR = await power({ action: 'restart', confirmed: 'yes' }, { dryRun: true });
  ok(!noConfirmR.ok, 'confirmed must be the boolean true, not a truthy string');
  const unknown = await power({ action: 'nap' }, { dryRun: true });
  ok(!unknown.ok && /no power action/.test(unknown.reason), 'an unknown action is refused by name');

  const exe = process.env.MANTLE_SIDECAR_EXE;
  let side = null;
  if (exe && fs.existsSync(exe)) side = startSidecar(exe);
  const stubSidecar = async (cmd, args) => {
    if (cmd === 'session' && args.dryRun === true) return { ok: true, dryRun: true, wouldCall: 'SetSuspendState(FALSE, FALSE, FALSE)', afterMs: 400, mode: '(stub)' };
    throw new Error('stub sidecar: ' + cmd + ' is not stubbed');
  };
  const sidecar = side ? side.call : stubSidecar;
  console.log('\n  DRY RUNS (' + (side ? 'real sidecar ' + exe : 'STUB sidecar: set MANTLE_SIDECAR_EXE for the real one') + ')');
  for (const p of _internals.POWER) {
    const r = await power({ action: p.action, confirmed: !!p.confirm }, { sidecar, dryRun: true });
    console.log('    ' + p.name.padEnd(10) + ' -> ' + JSON.stringify(r));
    ok(r.ok && r.dryRun === true && /^dry run: would (run|call) /.test(r.reason), p.name + ': dry run answers what it would run');
  }
  process.env.MANTLE_POWER_DRYRUN = '1';
  const envDry = await power({ action: 'lock' }, { sidecar });
  delete process.env.MANTLE_POWER_DRYRUN;
  ok(envDry.ok && envDry.dryRun === true, 'MANTLE_POWER_DRYRUN=1 alone makes it a dry run: ' + envDry.reason);
  const oldSidecar = await power({ action: 'sleep' }, { sidecar: async () => { throw new Error('unknown command: session'); }, dryRun: true });
  ok(!oldSidecar.ok && /newer Mantle helper: restart Mantle/.test(oldSidecar.reason) && !/sidecar/i.test(oldSidecar.reason), 'Sleep on a sidecar without "session" says, in plain words, to restart Mantle');
  const noSidecar = await power({ action: 'sleep' }, { dryRun: true });
  ok(!noSidecar.ok && /Mantle helper is not connected/.test(noSidecar.reason) && !/sidecar/i.test(noSidecar.reason), 'Sleep with no sidecar says so, in plain words');

  /* ---- files(): ranking, supersede, failures ---------------------------- */
  const home = os.homedir();
  const fixture = [
    { path: home + '\\browser-dist\\app\\report-builder.js', name: 'report-builder.js', folder: home + '\\browser-dist\\app', isDir: false, match: 'prefix' },
    { path: home + '\\Documents\\report.docx', name: 'report.docx', folder: home + '\\Documents', isDir: false, match: 'prefix' },
    { path: home + '\\Downloads\\final report.pdf', name: 'final report.pdf', folder: home + '\\Downloads', isDir: false, match: 'word' },
    { path: home + '\\repos', name: 'repos', folder: home, isDir: true, match: 'prefix' },
  ];
  const f1 = await files({ q: 'report' }, { sidecar: async () => ({ ok: true, items: fixture, ms: 42 }) });
  console.log('\n  files("report") -> ' + f1.items.map(i => i.name + ':' + i.score + ' [' + i.subtitle + ']').join(', '));
  ok(f1.ok && f1.items[0].name === 'report.docx', 'the exact name (extension aside) ranks first');
  ok(f1.items.every(i => i.score <= 700), 'no file outranks an app that starts with the query (files cap at 700)');
  ok(f1.items.find(i => i.name === 'repos').glyph === 'folder', 'a folder row gets the folder glyph');
  ok(f1.items[0].subtitle === '~\\Documents', 'the subtitle is the folder, with ~ for the profile');
  const short = await files({ q: 'a' }, { sidecar: async () => { throw new Error('should not be called'); } });
  ok(short.ok && short.items.length === 0, 'one letter never reaches the index');
  const sup = await files({ q: 'rep' }, { sidecar: async () => { throw new Error('cancelled'); } });
  ok(sup.ok && sup.superseded === true, 'a superseded query comes back marked superseded, not as a failure');
  const oldF = await files({ q: 'rep' }, { sidecar: async () => { throw new Error('unknown command: search'); } });
  ok(!oldF.ok && /newer Mantle helper: restart Mantle/.test(oldF.reason) && !/sidecar/i.test(oldF.reason), 'a sidecar without "search" says, in plain words, to restart Mantle');
  const down = await files({ q: 'rep' }, { sidecar: async () => ({ ok: false, reason: 'the Windows Search service (WSearch) is Stopped' }) });
  ok(!down.ok && /WSearch/.test(down.reason), 'the index being unavailable comes back with its reason');

  /* ---- openFile(): checked, not trusted --------------------------------- */
  const outside = await openFile({ path: 'C:\\Windows\\System32\\notepad.exe' }, { dryRun: true });
  ok(!outside.ok && /only opens files inside/.test(outside.reason), 'a path outside the profile is refused');
  const rel = await openFile({ path: 'relative\\x.txt' }, { dryRun: true });
  ok(!rel.ok, 'a relative path is refused');
  const gone = await openFile({ path: home + '\\definitely-not-here-' + Date.now() + '.txt' }, { dryRun: true });
  ok(!gone.ok && /gone from disk/.test(gone.reason), 'a vanished file says so');
  const real = path.join(__dirname, 'launcher-index.js');
  const o1 = await openFile({ path: real }, { dryRun: true });
  const o2 = await openFile({ path: real, reveal: true }, { dryRun: true });
  ok(o1.ok && o1.dryRun, 'open, dry run: ' + o1.reason);
  ok(o2.ok && o2.dryRun && /select|showItemInFolder/.test(o2.reason), 'show in folder, dry run: ' + o2.reason);

  /* ---- the real index, when a real sidecar is here ----------------------- */
  if (side) {
    const st = await side.call('search', { status: true, fresh: true });
    console.log('\n  index status: service ' + st.service + ' (' + st.startType + '), profile indexed: ' + st.scopeIndexed +
      ', roots ' + JSON.stringify(st.indexedRoots) + ', ' + st.excludedUnderProfile + ' exclusions under the profile');
    ok(st.serviceOk === true && st.scopeIndexed === true, 'WSearch is running and the profile is indexed');
    const caps = await side.call('session', { action: 'caps' });
    console.log('  power caps: ' + JSON.stringify(caps));
    for (const q of ['budget', 'notes', 'resume', 'mantle']) {
      const t0 = Date.now();
      const r = await files({ q }, { sidecar: side.call });
      const ms = Date.now() - t0;
      console.log('  files("' + q + '") ' + ms + ' ms round trip (' + r.ms + ' in the index): ' +
        r.items.slice(0, 4).map(i => i.name + ' [' + i.subtitle + ']').join(', '));
      ok(r.ok, 'real query "' + q + '" answered');
    }
    side.stop();
  }

  /* ---- lane launch-ui (2026-09-29): Store apps, caches that outlive a re-require, a fresh index ---- */
  {
    const I = _internals;
    // parse: tab lines, a BOM, junk, a path-shaped or quoted "AUMID" is dropped
    const parsed = I.parseStartApps('﻿Calculator\tMicrosoft.WindowsCalculator_8wekyb3d8bbwe!App\r\nNotepad\tMicrosoft.WindowsNotepad_8wekyb3d8bbwe!App\n' +
      'Evil\tC:\\Windows\\System32\\cmd.exe\nEvil2\tX_8wekyb3d8bbwe!App" & calc\nno tab here\nCalculator again\tMicrosoft.WindowsCalculator_8wekyb3d8bbwe!App\n');
    ok(parsed.length === 2 && parsed[0].name === 'Calculator' && parsed[1].aumid === 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App',
      'Get-StartApps lines parse to name + AUMID, junk / paths / quotes / duplicates dropped (' + JSON.stringify(parsed) + ')');
    ok(/Get-StartApps/.test(I.STORE_PS) && /\*!\*/.test(I.STORE_PS), 'the Store read is Get-StartApps, packaged ids only');

    // a temp Start Menu fixture, so nothing depends on (or touches) the real folders
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launchui-sm-'));
    const smAll = path.join(tmp, 'all'), smYou = path.join(tmp, 'you');
    fs.mkdirSync(path.join(smAll, 'Tools'), { recursive: true }); fs.mkdirSync(smYou, { recursive: true });
    fs.writeFileSync(path.join(smAll, 'Tools', 'Alpha Tool.lnk'), 'x');
    fs.writeFileSync(path.join(smYou, 'Notepad.lnk'), 'x');          // a desktop shortcut named like a Store app
    const oldRoots = idx._setStartMenuRootsForTest([{ dir: smAll, scope: 'all users' }, { dir: smYou, scope: 'you' }]);
    let storeCalls = 0;
    const oldRunner = idx._setStoreRunnerForTest(async () => { storeCalls++; return { ok: true, list: parsed.concat([{ name: 'Settings', aumid: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' }]), reason: '' }; });
    const iconAsked = [];
    const icon = async (p) => { iconAsked.push(p); return 'data:image/png;base64,AAAA'; };
    const b1 = await build({ icon });
    const appsOf = (b) => b.items.filter(i => i.kind === 'app');
    const calcRow = appsOf(b1).find(i => i.name === 'Calculator');
    ok(!!calcRow && calcRow.aumid === 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' && calcRow.subtitle === 'Microsoft Store app',
      'a Store app (Calculator) is in the index');
    ok(appsOf(b1).filter(i => i.name === 'Notepad').length === 1 && !appsOf(b1).find(i => i.name === 'Notepad').aumid, 'a desktop shortcut of the same name wins over the Store app');
    ok(!appsOf(b1).some(i => /immersivecontrolpanel/i.test(i.aumid || '')), 'Windows\' Settings app is not listed twice (it is the Windows Settings row)');
    ok(search('calc', b1.items)[0] && search('calc', b1.items)[0].name === 'Calculator', '"calc" finds Calculator first');
    const lr = await launch(calcRow, { dryRun: true });
    ok(lr.ok && /explorer\.exe shell:AppsFolder\\Microsoft\.WindowsCalculator_8wekyb3d8bbwe!App/.test(lr.reason), 'a Store app opens through shell:AppsFolder (dry run: ' + lr.reason + ')');
    const bad = await launch(Object.assign({}, calcRow, { aumid: 'x_8wekyb3d8bbwe!App" & calc' }), { dryRun: true });
    ok(!bad.ok, 'a tampered AUMID is refused, even in a dry run');
    ok(iconAsked.some(p => /^shell:AppsFolder\\/.test(p)), 'Store icons are asked through the same resolver (shell:AppsFolder path)');

    // index freshness: a shortcut added to the Start Menu is in the next build; one removed is gone
    fs.writeFileSync(path.join(smYou, 'Brand New App.lnk'), 'x');
    fs.unlinkSync(path.join(smAll, 'Tools', 'Alpha Tool.lnk'));
    const askedBefore = iconAsked.length;
    const t0 = Date.now();
    const b2 = await build({ icon });
    const rebuildMs = Date.now() - t0;
    ok(appsOf(b2).some(i => i.name === 'Brand New App') && !appsOf(b2).some(i => i.name === 'Alpha Tool'), 'an app installed / removed since the last build is in / out of the next one');
    ok(iconAsked.length - askedBefore === 1, 'a rebuild asks only the NEW app\'s icon (asked ' + (iconAsked.length - askedBefore) + ')');
    ok(storeCalls === 1, 'the Store list is read once and cached (reads: ' + storeCalls + ')');
    console.log('  rebuild with warm caches: ' + rebuildMs + ' ms');

    // the caches survive lib/apps.js's re-require (it deletes the module from require.cache)
    const p = require.resolve('./launcher-index');
    delete require.cache[p];
    const fresh = require('./launcher-index');
    fresh._setStartMenuRootsForTest([{ dir: smAll, scope: 'all users' }, { dir: smYou, scope: 'you' }]);
    const tC = process.hrtime.bigint();
    fresh._internals.coverOf('ms-settings:display');
    const coverMs = Number(process.hrtime.bigint() - tC) / 1e6;
    ok(coverMs < 60, 'after a re-require, a Settings row\'s Enter does not re-run every section file (' + coverMs.toFixed(1) + ' ms, was 200-440)');
    const askedB3 = iconAsked.length;
    const b3 = await fresh.build({ icon });
    ok(iconAsked.length === askedB3 && appsOf(b3).some(i => i.name === 'Calculator' && i.icon), 'after a re-require, icons and the Store list come from the shared cache');
    fresh._setStartMenuRootsForTest(oldRoots);
    idx._setStartMenuRootsForTest(oldRoots);
    idx._setStoreRunnerForTest(oldRunner);
    fs.rmSync(tmp, { recursive: true, force: true });

    // a failing Store read says so, in words
    idx._setStoreRunnerForTest(async () => ({ ok: false, list: [], reason: 'Windows did not list its Store apps in time' }));
    const bF = await build({ icon: async () => null });
    const appsSrc = bF.sources.find(s => s.name === 'apps');
    ok(/Store apps are missing: Windows did not list its Store apps in time/.test(appsSrc.reason || ''), 'a failed Store read is reported in the apps source (' + appsSrc.reason + ')');
    // the Store list landing AFTER the build that missed it is searchable at once (no ten-minute wait)
    const savedStore = I.state.store;
    I.state.store = { at: Date.now(), list: parsed, ok: true, reason: '', pending: null };
    const late = search('notepad', bF.items.filter(i => !i.aumid));
    ok(late.some(r => r.aumid === 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'), 'a Store list that arrived after the build is searched straight away');
    I.state.store = savedStore;
    idx._setStoreRunnerForTest(oldRunner);

    /* A SLOW Store list (start-up load): the first build finishes without it, and the list lands
       later. The build must not wait longer than it did, and the Store rows must join THAT build's
       arrays (the ones lib/apps.js keeps) the moment the list lands - not ten minutes later. */
    {
      const tmpS = fs.mkdtempSync(path.join(os.tmpdir(), 'launchui-slow-'));
      fs.writeFileSync(path.join(tmpS, 'Notepad.lnk'), 'x');          // a shortcut named like a Store app
      fs.writeFileSync(path.join(tmpS, 'Zeta Tool.lnk'), 'x');
      const oldR = idx._setStartMenuRootsForTest([{ dir: tmpS, scope: 'you' }]);
      const tick = () => new Promise(r => setImmediate(r));
      const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
      const keepAlive = setInterval(() => {}, 1000);   // the index's own timers are unref'd; a fake read holds no handle

      // 1. slow, then it arrives
      let reads = 0, land;
      idx._setStoreRunnerForTest(() => { reads++; return new Promise(r => { land = r; }); });
      const asked = [];
      const iconFn = async (p) => { asked.push(p); return 'data:image/png;base64,AAAA'; };
      const tS = Date.now();
      const bS = await build({ icon: iconFn });
      const slowMs = Date.now() - tS;
      const kept = { items: bS.items, sources: bS.sources };           // what lib/apps.js caches
      const srcS = () => kept.sources.find(s => s.name === 'apps');
      const appsCount0 = srcS().count;
      ok(slowMs < 4000 + 1500, 'a slow Store list does not hold the first build past the icon cap (' + slowMs + ' ms)');
      ok(!kept.items.some(i => i.aumid) && /Store apps are still loading/.test(srcS().reason || ''), 'the build that missed the Store list says it is still loading (' + srcS().reason + ')');
      ok(search('calc', kept.items).every(r => r.name !== 'Calculator'), 'before the list lands, "calc" has no Calculator (nothing to find yet)');
      land({ ok: true, list: parsed, reason: '' });
      await settle();
      const calcL = kept.items.find(i => i.name === 'Calculator');
      ok(!!calcL && calcL.aumid === 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'the Store list that landed after the build is IN that build\'s items (no rebuild)');
      ok(srcS().count === appsCount0 + 1 && srcS().status === 'ok', 'the apps count grew by the Store rows (' + appsCount0 + ' -> ' + srcS().count + ')');
      ok(!/Store apps/.test(srcS().reason || ''), 'the "still loading" words are gone once the list is in (' + JSON.stringify(srcS().reason) + ')');
      ok(kept.items.filter(i => i.name === 'Notepad').length === 1 && !kept.items.find(i => i.name === 'Notepad').aumid, 'late or not, the desktop shortcut of the same name still wins');
      const kinds = kept.items.map(i => i.kind);
      const firstOther = kinds.findIndex(k => k !== 'app');
      const appNames = kept.items.slice(0, firstOther).map(i => i.name);
      ok(firstOther > 0 && kinds.lastIndexOf('app') < firstOther && appNames.join('|') === appNames.slice().sort((a, b) => a.localeCompare(b)).join('|'),
        'the late rows join the apps block in name order, ahead of commands/settings/power');
      const hit = search('calc', kept.items)[0];
      ok(hit && calcL && hit.name === 'Calculator' && hit.id === calcL.id, '"calc" finds Calculator from the kept build, with the build\'s own id (apps.launch finds it)');
      const lrL = calcL ? await launch(calcL, { dryRun: true }) : { ok: false, reason: 'no row' };
      ok(lrL.ok && /shell:AppsFolder\\Microsoft\.WindowsCalculator/.test(lrL.reason), 'the late Calculator row opens (dry run)');
      ok(asked.some(p => /^shell:AppsFolder\\/.test(p)) && !!calcL && calcL.icon === 'data:image/png;base64,AAAA', 'the late rows get their icons in the background, in place');
      const n0 = kept.items.length;
      await settle();
      ok(reads === 1 && kept.items.length === n0, 'one Store read, merged once: no rebuild, no loop (reads ' + reads + ')');

      // 2. slow, then it FAILS: the words say so, nothing is retried until the next build
      reads = 0;
      idx._setStoreRunnerForTest(() => { reads++; return new Promise(r => { land = r; }); });
      const bX = await build({ icon: iconFn });
      land({ ok: false, list: [], reason: 'Windows did not list its Store apps in time' });
      await settle();
      const srcX = bX.sources.find(s => s.name === 'apps');
      ok(!bX.items.some(i => i.aumid) && /Store apps are missing: Windows did not list its Store apps in time/.test(srcX.reason || ''),
        'a late FAILED read turns "still loading" into the plain reason (' + srcX.reason + ')');
      ok(reads === 1, 'a failed read is not retried in a loop (reads ' + reads + ')');

      // 3. a read that NEVER answers: the guard ends it, in words; the next build asks once more
      reads = 0;
      const oldGuard = idx._setStoreGuardForTest(300);
      idx._setStoreRunnerForTest(() => { reads++; return new Promise(() => {}); });
      const bH = await build({ icon: iconFn });
      await settle();
      const srcH = bH.sources.find(s => s.name === 'apps');
      ok(/Store apps are missing: Windows did not list its Store apps in time/.test(srcH.reason || ''), 'a Store read that never answers says so in plain words (' + srcH.reason + ')');
      await new Promise(r => setTimeout(r, 400));
      ok(reads === 1, 'nothing re-asks on its own while it hangs (reads ' + reads + ')');
      await build({ icon: iconFn });
      ok(reads === 2, 'the NEXT build asks once more (reads ' + reads + ')');
      idx._setStoreGuardForTest(oldGuard);
      idx._setStoreRunnerForTest(oldRunner);
      idx._setStartMenuRootsForTest(oldR);
      clearInterval(keepAlive);
      fs.rmSync(tmpS, { recursive: true, force: true });
    }

    // no PowerShell profile is normal: no warning line
    ok(bF.sources.find(s => s.name === 'commands').status === 'ok', 'the commands source is ok (a missing profile is not an error)');
  }

  ok(blocked.length === 0, 'NOTHING tried to start shutdown/rundll32/explorer/cmd (' + blocked.join(' | ') + ')');

  console.log('\nLAUNCHER EXTRAS TEST: ' + passed + ' passed, ' + failed + ' failed');
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('launcher-extras.test.js crashed: ' + (err && err.stack || err));
  process.exit(1);
});
