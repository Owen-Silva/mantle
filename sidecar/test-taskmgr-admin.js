// test-taskmgr-admin.js - sidecar/TaskMgrDetails.cs (taskmgr.endpid) and sidecar/TaskMgrSvc.cs
// (taskmgr.services / servicesByPid / service) against a PASSIVE sidecar (lane tm-data-admin, 2026-10-28).
//
//   node sidecar/test-taskmgr-admin.js --exe=<Mantle.Sidecar.exe>     (or MANTLE_SIDECAR_EXE)
//
// NOTHING IS ENDED, STOPPED OR STARTED: every endpid / service request here is a dryRun, or is sent
// real to the passive sidecar, which must refuse it before looking at anything. The only processes a
// dry run may plan to end are the idle node processes this test spawns itself; they end on their own
// (20 s) or by this test's own child.kill() on its own child handle. No service is ever touched for real.
// Prints counts and pids only (no paths or titles).
//
// Prints "TASKMGR ADMIN SIDECAR: n passed, m failed".
'use strict';
const cp = require('child_process');
const T = require('./test-lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (snap, pid) => snap.procs.find((p) => p.pid === pid);

(async () => {
  const t = T.checker('TASKMGR ADMIN SIDECAR');
  const s = await T.startPassive();
  // mine: under this test (= under the sidecar's parent: "Mantle itself" to the guard).
  // orphan: started through cmd /c start /b, whose cmd exits, so the guard has no reason to refuse it.
  // The orphan starts ITS OWN child (the grandchild) so a tree dry run has two verified members.
  const idle = 'setTimeout(() => {}, 20000)';
  // The orphan's script goes in a temp file: cmd's start re-parses an inline -e script's quotes.
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-tmadmin-'));
  const kidJs = path.join(dir, 'orphan.js');
  fs.writeFileSync(kidJs, `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); ${idle};
`);
  const mine = cp.spawn(process.execPath, ['-e', idle], { stdio: 'ignore' });
  const starter = cp.spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, kidJs], { stdio: 'ignore', windowsHide: true });
  const starterPid = starter.pid;
  await sleep(1500);
  try {
    const snap = await s.call('taskmgr.snapshot', {}, 8000);
    const kid = pick(snap, mine.pid);
    const orphan = snap.procs.find((p) => p.ppid === starterPid && /node/i.test(p.file));
    const grand = orphan && snap.procs.find((p) => p.ppid === orphan.pid && /node/i.test(p.file));
    t.check('setup: the test child is in the table', !!kid);
    t.check('setup: the orphan and its own child are in the table', !!orphan && !!grand, `orphan ${orphan && orphan.pid} grand ${grand && grand.pid}`);

    // ---------------------------------------------------------------- endpid
    if (orphan && grand) {
      const d1 = await s.call('taskmgr.endpid', { pid: orphan.pid, created: orphan.created, dryRun: true }, 6000);
      t.check('endpid dry: a windowless orphan -> taskkill naming its pid, no /T, no /F',
        d1.done === true && d1.ok === true && d1.how === 'taskkill' && d1.dryRun === true && d1.command === `taskkill /PID ${orphan.pid}`
        && !/\/T|\/F/.test(d1.command) && d1.pids.length === 1 && d1.pids[0] === orphan.pid && /^dry run: would run/.test(d1.why) && d1.reason === d1.why,
        JSON.stringify(d1));
      const d2 = await s.call('taskmgr.endpid', { pid: orphan.pid, created: orphan.created, force: true, dryRun: true }, 6000);
      t.check('endpid dry force: TerminateProcess on the held handle', d2.done === true && d2.how === 'terminate' && d2.dryRun === true && d2.pids.length === 1 && /would end 1 process/.test(d2.why), JSON.stringify(d2));
      const d3 = await s.call('taskmgr.endpid', { pid: orphan.pid, created: orphan.created, tree: true, dryRun: true }, 6000);
      const tp = (d3.pids || []).slice().sort((a, b) => a - b);
      const want = [orphan.pid, grand.pid].sort((a, b) => a - b);
      t.check('endpid dry tree: exactly the orphan and its own child', d3.done === true && d3.how === 'taskkill' && JSON.stringify(tp) === JSON.stringify(want)
        && d3.command === `taskkill /PID ${orphan.pid} /PID ${grand.pid}`, JSON.stringify(d3));
      const d4 = await s.call('taskmgr.endpid', { pid: orphan.pid, created: '1', dryRun: true }, 6000);
      t.check('endpid: a wrong creation time is refused', d4.done === false && d4.how === 'none' && /different process/.test(d4.why), JSON.stringify(d4));
      const d4b = await s.call('taskmgr.endpid', { pid: grand.pid, created: grand.created, tree: true, force: true, dryRun: true }, 6000);
      t.check('endpid dry tree from the grandchild: only itself (never its parent)', d4b.done === true && d4b.pids.length === 1 && d4b.pids[0] === grand.pid, JSON.stringify(d4b));
    }
    const sys = snap.procs.find((p) => /^(csrss|wininit)\.exe$/i.test(p.file));
    const d5 = await s.call('taskmgr.endpid', { pid: sys.pid, created: sys.created, force: true, dryRun: true }, 6000);
    t.check('endpid: a Windows system process is refused', d5.done === false && d5.refused.length === 1 && /refused/.test(d5.why), JSON.stringify(d5));
    // wininit's tree holds services, svchost, ...: refused whole (protected members or more than 80).
    const wi = snap.procs.find((p) => /^wininit\.exe$/i.test(p.file));
    if (wi) {
      const d5b = await s.call('taskmgr.endpid', { pid: wi.pid, created: wi.created, tree: true, force: true, dryRun: true }, 6000);
      t.check('endpid: wininit\'s tree is refused whole', d5b.done === false && d5b.how === 'none' && /refused/.test(d5b.why), JSON.stringify(d5b).slice(0, 240));
    }
    const d6 = await s.call('taskmgr.endpid', { pid: kid.pid, created: kid.created, dryRun: true }, 6000);
    t.check('endpid: a process under Mantle is refused as Mantle itself', d6.done === false && d6.refused.length === 1 && /Mantle itself/.test(d6.refused[0].why), JSON.stringify(d6));
    // This test's own tree from the test process's PARENT is not available; instead: a tree rooted at
    // the sidecar's parent (this test) holds the sidecar and "mine": every member is Mantle -> refused whole.
    const me = pick(snap, process.pid);
    if (me) {
      const d7 = await s.call('taskmgr.endpid', { pid: me.pid, created: me.created, tree: true, dryRun: true }, 6000);
      t.check('endpid: a tree with protected members is refused whole, listing them', d7.done === false && d7.refused.length >= 2 && /whole tree or nothing/.test(d7.why), JSON.stringify(d7).slice(0, 240));
    } else t.check('endpid: this test is in the table', false);
    const d8 = await s.send('taskmgr.endpid', { pid: kid.pid, created: kid.created }, 4000);
    t.check('passive: a real endpid is refused before anything', d8.ok === false && d8.error === T.PASSIVE_REFUSAL, JSON.stringify(d8));
    const d8b = await s.send('taskmgr.endpid', { pid: kid.pid, created: kid.created, force: true, tree: true }, 4000);
    t.check('passive: a real forced tree endpid is refused before anything', d8b.ok === false && d8b.error === T.PASSIVE_REFUSAL, JSON.stringify(d8b));
    const d9 = await s.send('taskmgr.endpid', { pid: kid.pid, dryRun: true }, 4000);
    t.check('endpid: no created is a plain-words error', d9.ok === false && /needs pid and created/.test(d9.error), JSON.stringify(d9));
    const d10 = await s.call('taskmgr.endpid', { pid: 999999, created: '123', dryRun: true }, 4000);
    t.check('endpid: a pid that is not running -> done false, plain why', d10.done === false && /no longer running/.test(d10.why), JSON.stringify(d10));

    // ---------------------------------------------------------------- services
    let t0 = Date.now();
    const a = await s.call('taskmgr.services', {}, 20000);
    const firstWall = Date.now() - t0;
    t0 = Date.now();
    const b = await s.call('taskmgr.services', {}, 20000);
    const repeatWall = Date.now() - t0;
    console.log(`  (read-only) ${a.rows.length} services; first ${a.ms} ms (wall ${firstWall}), repeat ${b.ms} ms (wall ${repeatWall}); elevated ${a.elevated}`);
    const WORDS = ['Running', 'Stopped', 'Starting', 'Stopping', 'Paused', 'Pausing', 'Continuing'];
    t.check('services: more than 50 rows', a.rows.length > 50, String(a.rows.length));
    t.check('services: every status is a Task Manager word', a.rows.every((r) => WORDS.includes(r.status)), JSON.stringify(a.rows.find((r) => !WORDS.includes(r.status))));
    t.check('services: running ones have a pid, stopped ones null', a.rows.filter((r) => r.status === 'Stopped').every((r) => r.pid === null) && a.rows.filter((r) => r.status === 'Running').some((r) => r.pid > 0));
    t.check('services: names and display names', a.rows.every((r) => typeof r.name === 'string' && r.name && typeof r.display === 'string'));
    const withDesc = a.rows.filter((r) => r.desc).length, withGroup = a.rows.filter((r) => r.group).length;
    t.check('services: most have a description', withDesc > a.rows.length / 2, `${withDesc}/${a.rows.length}`);
    t.check('services: svchost groups (netsvcs or LocalService...)', a.rows.some((r) => /^(netsvcs|LocalService|LocalSystemNetworkRestricted|LocalServiceNetworkRestricted)$/i.test(r.group || '')), `${withGroup} with a group`);
    const ST = ['Automatic', 'Automatic (delayed)', 'Manual', 'Disabled', null];
    t.check('services: start types are the four words or null', a.rows.every((r) => ST.includes(r.startType)) && a.rows.some((r) => r.startType === 'Automatic (delayed)') && a.rows.some((r) => r.startType === 'Disabled'),
      JSON.stringify(a.rows.find((r) => !ST.includes(r.startType))));
    t.check('services: elevated is a boolean (false: Mantle is not elevated)', typeof a.elevated === 'boolean');
    t.check('services: a repeat call is no slower than the first by much (cached config)', b.ms <= a.ms + 50, `${a.ms} -> ${b.ms}`);

    const host = a.rows.find((r) => r.pid > 0 && a.rows.filter((q) => q.pid === r.pid).length >= 2);
    if (host) {
      const bp = await s.call('taskmgr.servicesByPid', { pid: host.pid }, 6000);
      const want = a.rows.filter((q) => q.pid === host.pid).map((q) => q.name).sort();
      t.check('servicesByPid: the services a shared svchost hosts', JSON.stringify(bp.names.slice().sort()) === JSON.stringify(want) || bp.names.includes(host.name), `${bp.names.length} vs ${want.length}`);
    } else t.check('servicesByPid: a shared host was found', false);
    const bp0 = await s.call('taskmgr.servicesByPid', { pid: process.pid }, 6000);
    t.check('servicesByPid: a process hosting none -> []', Array.isArray(bp0.names) && bp0.names.length === 0, JSON.stringify(bp0));
    const bp1 = await s.send('taskmgr.servicesByPid', {}, 4000);
    t.check('servicesByPid: no pid is a plain error', bp1.ok === false && /needs pid/.test(bp1.error), JSON.stringify(bp1));

    // ---------------------------------------------------------------- service (dry runs + passive only)
    const CRIT = /^(RpcSs|RpcEptMapper|DcomLaunch|LSM|BrokerInfrastructure|Power|PlugPlay|SamSs|EventLog|Winmgmt|CoreMessagingRegistrar|SystemEventsBroker|gpsvc|ProfSvc|Schedule|mpssvc|WinDefend|BFE|Dhcp|Dnscache|nsi|AudioSrv|AudioEndpointBuilder|UserManager|StateRepository|TimeBrokerSvc|camsvc|Appinfo)$/i;
    const running = a.rows.filter((r) => r.status === 'Running' && !CRIT.test(r.name));
    const pickSvc = running.find((r) => /^(Spooler|WSearch|SysMain|wuauserv|BITS)$/i.test(r.name)) || running[0];
    const v1 = await s.call('taskmgr.service', { name: pickSvc.name, op: 'stop', dryRun: true }, 6000);
    t.check('service dry stop (non-critical): ok, or exactly needs administrator + needsAdmin',
      v1.dryRun === true && v1.op === 'stop' && v1.name === pickSvc.name && v1.state === 'Running'
      && ((v1.ok === true && /^dry run: would stop /.test(v1.reason)) || (v1.ok === false && v1.reason === 'needs administrator: open Services' && v1.needsAdmin === true)),
      JSON.stringify(v1));
    console.log(`  (dry) stop ${pickSvc.name}: ok ${v1.ok}, ${v1.reason}`);
    const v1b = await s.call('taskmgr.service', { name: pickSvc.name, op: 'restart', dryRun: true }, 6000);
    t.check('service dry restart: ok, or needs administrator', v1b.ok === true || (v1b.reason === 'needs administrator: open Services' && v1b.needsAdmin === true), JSON.stringify(v1b));
    const stopped = a.rows.find((r) => r.status === 'Stopped' && r.startType === 'Manual');
    if (stopped) {
      const v1c = await s.call('taskmgr.service', { name: stopped.name, op: 'start', dryRun: true }, 6000);
      t.check('service dry start (stopped, manual): ok, or needs administrator', v1c.state === 'Stopped' && (v1c.ok === true || (v1c.reason === 'needs administrator: open Services' && v1c.needsAdmin === true)), JSON.stringify(v1c));
    }
    const v2 = await s.call('taskmgr.service', { name: 'RpcSs', op: 'stop', dryRun: true }, 6000);
    t.check('service: dry stop of RpcSs refused as critical', v2.ok === false && v2.reason === 'Windows needs it running; Mantle will not stop it', JSON.stringify(v2));
    const v2b = await s.call('taskmgr.service', { name: 'rpcss', op: 'restart', dryRun: true }, 6000);
    t.check('service: critical check ignores case', v2b.ok === false && /will not stop it/.test(v2b.reason), JSON.stringify(v2b));
    const v3 = await s.send('taskmgr.service', { name: 'NoSuchServiceMantleTest', op: 'stop', dryRun: true }, 6000);
    t.check('service: an unknown name is a plain error', v3.ok === false && /no service named/.test(v3.error), JSON.stringify(v3));
    const v4 = await s.send('taskmgr.service', { name: pickSvc.name, op: 'pause', dryRun: true }, 6000);
    t.check('service: a bad op is a plain error', v4.ok === false && /op must be start, stop or restart/.test(v4.error), JSON.stringify(v4));
    const v5 = await s.send('taskmgr.service', { name: 'x'.repeat(300), op: 'start', dryRun: true }, 6000);
    t.check('service: a name over 256 characters is a plain error', v5.ok === false && /256/.test(v5.error), JSON.stringify(v5));
    const v6 = await s.send('taskmgr.service', { name: pickSvc.name, op: 'start' }, 4000);
    t.check('passive: a real start is refused before anything', v6.ok === false && v6.error === T.PASSIVE_REFUSAL, JSON.stringify(v6));
    const v7 = await s.send('taskmgr.service', { name: pickSvc.name, op: 'stop' }, 4000);
    t.check('passive: a real stop is refused before anything', v7.ok === false && v7.error === T.PASSIVE_REFUSAL, JSON.stringify(v7));
    const c = await s.call('taskmgr.services', {}, 20000);
    t.check('services: no lastOp anywhere (nothing was ever done)', c.rows.every((r) => !('lastOp' in r)));
  } catch (e) {
    t.check('no exception', false, e.stack);
  } finally {
    // This test's own child, by its own handle; the orphan and its child end on their own (20 s).
    try { mine.kill(); } catch (_) { /* gone */ }
    await s.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* in use or gone */ }
  }
  process.exit(t.summary());
})();
