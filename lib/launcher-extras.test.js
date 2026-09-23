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
  ok(pw.filter(i => i.kind === 'power').length >= 4, '"power" lists the power rows');
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
  ok(!oldSidecar.ok && /rebuild the sidecar/.test(oldSidecar.reason), 'Sleep on a sidecar without "session" says to rebuild it');
  const noSidecar = await power({ action: 'sleep' }, { dryRun: true });
  ok(!noSidecar.ok && /sidecar/.test(noSidecar.reason), 'Sleep with no sidecar says so');

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
  ok(!oldF.ok && /rebuild the sidecar/.test(oldF.reason), 'a sidecar without "search" says to rebuild it');
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
    for (const q of ['work', 'notes', 'resume', 'mantle']) {
      const t0 = Date.now();
      const r = await files({ q }, { sidecar: side.call });
      const ms = Date.now() - t0;
      console.log('  files("' + q + '") ' + ms + ' ms round trip (' + r.ms + ' in the index): ' +
        r.items.slice(0, 4).map(i => i.name + ' [' + i.subtitle + ']').join(', '));
      ok(r.ok, 'real query "' + q + '" answered');
    }
    side.stop();
  }

  ok(blocked.length === 0, 'NOTHING tried to start shutdown/rundll32/explorer/cmd (' + blocked.join(' | ') + ')');

  console.log('\nLAUNCHER EXTRAS TEST: ' + passed + ' passed, ' + failed + ' failed');
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('launcher-extras.test.js crashed: ' + (err && err.stack || err));
  process.exit(1);
});
