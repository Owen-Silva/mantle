'use strict';
/*
 * _taskmgr-details.test.js - lib/features/_taskmgr-details.js in plain node: no Electron, no sidecar, no
 * real process (lane tm-details, 2026-10-28). Prints "TASKMGR DETAILS JS TEST: n passed, m failed".
 *
 *   node lib/features/_taskmgr-details.test.js
 */
const D = require('./_taskmgr-details.js');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${detail})` : name); };

const row = (o) => Object.assign({
  pid: 100, created: '133000000000000000', name: 'a.exe', status: 'Running', user: 'owen', userFull: 'PC\\owen',
  sessionId: 1, jobId: null, cpuTime100ns: 0, cycles: 10, ws: 1000, wsPeak: 2000, privateWs: 600, sharedWs: 400,
  commit: 700, pagedPool: 50, npPool: 5, pageFaults: 10, basePriority: 'Normal', handles: 20, threads: 3,
  userObjects: 1, gdiObjects: 2, ioReads: 1, ioWrites: 2, ioOther: 3, ioReadBytes: 4, ioWriteBytes: 5, ioOtherBytes: 6,
  path: 'C:\\a.exe', cmdline: '"C:\\a.exe" -x', osContext: 'Windows 10', platform: '64 bit', arch: 'x64', elevated: false,
  uacVirt: 'Disabled', desc: 'A', dep: 'Enabled', enterprise: 'Personal', powerThrottling: 'Allowed',
  shadowStack: 'Compatible modules only', packageName: '', efficiency: false, needsAdmin: false, why: null, unread: [],
}, o);

// --- rowsFrom: CPU % from cpuTime deltas over elapsed x logical CPUs
{
  const prev = { t: 1000, cpus: 4, rows: [row({ cpuTime100ns: 0 }), row({ pid: 200, cpuTime100ns: 5e6 })] };
  // 1 s later: pid 100 used 1 s of CPU (1e7 x 100 ns) of 4 s available = 25 %; pid 200 used 0.2 s = 5 %
  const cur = { t: 2000, cpus: 4, rows: [row({ cpuTime100ns: 1e7, ws: 1500, pageFaults: 25 }), row({ pid: 200, cpuTime100ns: 7e6 })] };
  const out = D.rowsFrom(cur, prev);
  check('cpu: 1 s of CPU in 1 s on 4 CPUs = 25 %', out[0].cpu === 25, out[0].cpu);
  check('cpu: 0.2 s of CPU = 5 %', out[1].cpu === 5, out[1].cpu);
  check('wsDelta = ws - last ws', out[0].wsDelta === 500, out[0].wsDelta);
  check('pfDelta = pageFaults - last pageFaults', out[0].pfDelta === 15, out[0].pfDelta);
  check('unchanged ws: wsDelta 0', out[1].wsDelta === 0, out[1].wsDelta);
  check('mem = privateWs', out[0].mem === 600);
  check('cpuTimeSec from 100-ns units', out[0].cpuTimeSec === 1, out[0].cpuTimeSec);
  check('key is pid|created', out[0].key === '100|133000000000000000');
}
{
  // first sample: nothing to compare with
  const out = D.rowsFrom({ t: 5, cpus: 8, rows: [row({})] }, null);
  check('first sample: cpu null, deltas null', out[0].cpu === null && out[0].wsDelta === null && out[0].pfDelta === null);
  check('no rows -> []', Array.isArray(D.rowsFrom(null, null)) && D.rowsFrom({}, null).length === 0);
}
{
  // a reused pid (same number, different creation time) starts fresh
  const prev = { t: 0, cpus: 1, rows: [row({ created: '1', cpuTime100ns: 0 })] };
  const out = D.rowsFrom({ t: 1000, cpus: 1, rows: [row({ created: '2', cpuTime100ns: 5e6 })] }, prev);
  check('reused pid: no CPU or delta from the other process', out[0].cpu === null && out[0].wsDelta === null);
}
{
  // clock went backwards or same t: no division
  const prev = { t: 1000, cpus: 2, rows: [row({ cpuTime100ns: 0 })] };
  const out = D.rowsFrom({ t: 1000, cpus: 2, rows: [row({ cpuTime100ns: 9e9 })] }, prev);
  check('zero elapsed: cpu null, never Infinity', out[0].cpu === null);
  const out2 = D.rowsFrom({ t: 2000, cpus: 1, rows: [row({ cpuTime100ns: 9e9 })] }, prev);
  check('cpu clamps at 100', out2[0].cpu === 100, out2[0].cpu);
  const out3 = D.rowsFrom({ t: 2000, cpus: 1, rows: [row({ cpuTime100ns: -5 })] }, prev);
  check('cpu never negative', out3[0].cpu === 0, out3[0].cpu);
}
{
  // user name and full account name
  const a = D.rowsFrom({ t: 1, cpus: 1, rows: [row({})] }, null)[0];
  const b = D.rowsFrom({ t: 1, cpus: 1, rows: [row({})] }, null, { fullAccountName: true })[0];
  check('user: account name by default', a.user === 'owen');
  check('user: DOMAIN\\name with fullAccountName', b.user === 'PC\\owen', b.user);
  const c = D.rowsFrom({ t: 1, cpus: 1, rows: [row({ user: null, userFull: null })] }, null, { fullAccountName: true })[0];
  check('user: unreadable stays null', c.user === null);
}
{
  // every Select-columns field in camelCase, as TM-SPEC names them
  const out = D.rowsFrom({ t: 1, cpus: 1, rows: [row({})] }, null)[0];
  const spec = ['pid', 'name', 'status', 'user', 'cpu', 'mem', 'arch', 'desc', 'path', 'sessionId', 'jobId', 'cpuTimeSec',
    'cycles', 'ws', 'wsPeak', 'wsDelta', 'privateWs', 'sharedWs', 'commit', 'pagedPool', 'npPool', 'pageFaults', 'pfDelta',
    'basePriority', 'handles', 'threads', 'userObjects', 'gdiObjects', 'ioReads', 'ioWrites', 'ioOther', 'ioReadBytes',
    'ioWriteBytes', 'ioOtherBytes', 'cmdline', 'osContext', 'platform', 'elevated', 'uacVirt', 'dep', 'enterprise',
    'powerThrottling', 'shadowStack', 'packageName'];
  const missing = spec.filter((k) => !(k in out));
  check('every TM-SPEC Details field is present', missing.length === 0, missing.join(','));
  check('packageName "" (not a package) is kept, not nulled', out.packageName === '');
  check('elevated false stays false', out.elevated === false);
}
{
  // an unreadable (administrator-only) row keeps its counters, nulls, needsAdmin and why
  const r = row({ user: null, userFull: null, cmdline: null, elevated: null, uacVirt: null, userObjects: null, gdiObjects: null,
    efficiency: null, powerThrottling: null, packageName: null, needsAdmin: true, why: 'Windows lets only an administrator open this process (access denied)',
    unread: ['user', 'cmdline'] });
  const out = D.rowsFrom({ t: 1, cpus: 1, rows: [r] }, null)[0];
  check('admin row: needsAdmin + why + unread carried', out.needsAdmin === true && /administrator/.test(out.why) && out.unread.length === 2);
  check('admin row: unread fields are null, never 0 or ""', out.user === null && out.cmdline === null && out.userObjects === null && out.elevated === null && out.packageName === null && out.efficiency === null);
  check('admin row: counters still numbers', out.ws === 1000 && out.handles === 20 && out.commit === 700);
}

// --- procExtraFor
{
  const reply = { rows: [
    { pid: 10, created: '1', publisher: 'Google LLC', cmdline: '"chrome.exe"', efficiency: false, status: null },
    { pid: 11, created: '2', publisher: 'Google LLC', cmdline: '"chrome.exe" --type=renderer', efficiency: true, status: 'Efficiency mode' },
    { pid: 12, created: '3', publisher: null, cmdline: null, efficiency: null, status: null, needsAdmin: true },
  ] };
  const m = D.extraMapFrom(reply);
  check('extraMapFrom keys pid|created', m.size === 3 && m.get('11|2').efficiency === true);
  const g = { root: 10, created: '1', procs: [{ pid: 10, created: '1' }, { pid: 11, created: '2' }, { pid: 12, created: '3' }] };
  const e = D.procExtraFor(g, m);
  check('group: publisher and command line of the root', e.publisher === 'Google LLC' && e.cmdline === '"chrome.exe"', JSON.stringify(e));
  check('group: not every member in Efficiency mode -> false, no status', e.efficiency === false && e.status === null);
  const all = D.procExtraFor({ root: 11, created: '2', procs: [{ pid: 11, created: '2' }, { pid: 12, created: '3' }] }, m);
  check('group: every readable member efficient (unreadable ignored) -> Efficiency mode', all.efficiency === true && all.status === 'Efficiency mode', JSON.stringify(all));
  const unk = D.procExtraFor({ root: 12, created: '3', procs: [{ pid: 12, created: '3' }] }, m);
  check('group: nothing readable -> efficiency null, never false', unk.efficiency === null && unk.status === null && unk.publisher === null);
  const stale = D.procExtraFor({ root: 10, created: '999', procs: [{ pid: 10, created: '999' }] }, m);
  check('group: a reused pid (other created) gets nothing', stale.publisher === null && stale.cmdline === null && stale.efficiency === null);
  const noProcs = D.procExtraFor({ root: 11, created: '2' }, m);
  check('group without procs uses its root', noProcs.efficiency === true && noProcs.cmdline === '"chrome.exe" --type=renderer');
  const obj = D.procExtraFor(g, { '10|1': reply.rows[0] });
  check('plain object map works too', obj.publisher === 'Google LLC');
  const pubFromChild = D.procExtraFor({ root: 12, created: '3', procs: [{ pid: 12, created: '3' }, { pid: 10, created: '1' }] }, m);
  check('group: root unreadable -> publisher from a member; command line stays the root\'s (null)', pubFromChild.publisher === 'Google LLC' && pubFromChild.cmdline === null, JSON.stringify(pubFromChild));
  check('null group / null map are safe', D.procExtraFor(null, m).publisher === null && D.procExtraFor(g, null).efficiency === null);
}

console.log(`TASKMGR DETAILS JS TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);
