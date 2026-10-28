// test-taskmgr-details.js - sidecar/ProcDetails.cs against a PASSIVE sidecar (lane tm-details, 2026-10-28).
//
//   node sidecar/test-taskmgr-details.js [--exe=<Mantle.Sidecar.exe>]     (or MANTLE_SIDECAR_EXE)
//
// READ ONLY: taskmgr.details and taskmgr.procextra only read; nothing is changed on any process. The one
// process this test starts (an idle node child) ends on its own timer. Prints counts, pids and ms only
// (no names, paths or command lines). Prints "TASKMGR DETAILS TEST: n passed, m failed".
'use strict';
const cp = require('child_process');
const os = require('os');
const T = require('./test-lib');
const L = require('../lib/features/_taskmgr-details.js');

const MARK = 'tm-details-probe-' + process.pid;
const STR = 'string', NUM = 'number', BOOL = 'boolean';
// field -> allowed types (null allowed where Windows may refuse the read)
const FIELDS = {
  pid: [NUM], created: [STR], name: [STR], status: [STR], user: [STR, null], userFull: [STR, null], sessionId: [NUM],
  jobId: [NUM, null], cpuTime100ns: [NUM], cycles: [NUM], ws: [NUM], wsPeak: [NUM], privateWs: [NUM], sharedWs: [NUM],
  commit: [NUM], pagedPool: [NUM], npPool: [NUM], pageFaults: [NUM], basePriority: [STR, null], handles: [NUM], threads: [NUM],
  userObjects: [NUM, null], gdiObjects: [NUM, null], ioReads: [NUM], ioWrites: [NUM], ioOther: [NUM], ioReadBytes: [NUM],
  ioWriteBytes: [NUM], ioOtherBytes: [NUM], path: [STR, null], cmdline: [STR, null], osContext: [STR, null],
  platform: [STR, null], arch: [STR, null], elevated: [BOOL, null], uacVirt: [STR, null], desc: [STR, null], dep: [STR, null],
  enterprise: [STR, null], powerThrottling: [STR, null], shadowStack: [STR, null], packageName: [STR, null],
  efficiency: [BOOL, null], needsAdmin: [BOOL], why: [STR, null], unread: ['array'],
};
const typeOf = (v) => (v === null ? null : Array.isArray(v) ? 'array' : typeof v);
const badFields = (r) => Object.keys(FIELDS).filter((k) => !(k in r) || !FIELDS[k].includes(typeOf(r[k])));
const WORDS = {
  status: ['Running', 'Suspended', 'Not responding'],
  basePriority: ['Realtime', 'High', 'Above normal', 'Normal', 'Below normal', 'Low', 'N/A'],
  platform: ['64 bit', '32 bit'], arch: ['x64', 'x86', 'ARM64', 'ARM'], uacVirt: ['Not allowed', 'Disabled', 'Enabled'],
  dep: ['Enabled', 'Disabled'], powerThrottling: ['Allowed', 'Disallowed'],
  shadowStack: ['Disabled', 'Compatible modules only', 'All modules', 'Compatible modules only (audit mode)', 'All modules (audit mode)'],
  osContext: ['Windows Vista', 'Windows 7', 'Windows 8', 'Windows 8.1', 'Windows 10'],
};
const badWords = (r) => Object.keys(WORDS).filter((k) => r[k] !== null && !WORDS[k].includes(r[k]));

(async () => {
  const t = T.checker('TASKMGR DETAILS');
  const s = await T.startPassive();
  const child = cp.spawn(process.execPath, ['-e', `setTimeout(() => {}, 25000) /* ${MARK} */`], { stdio: 'ignore', windowsHide: true });
  await T.sleep(700);
  const me = os.userInfo().username.toLowerCase();
  try {
    // ---------------- procextra on a COLD second sidecar (nothing cached yet): its true first-call cost
    {
      const s2 = await T.startPassive();
      try {
        const snap = await s2.call('taskmgr.snapshot', {}, 8000);
        const list = snap.procs.map((p) => ({ pid: p.pid, created: p.created }));
        const x1 = await s2.call('taskmgr.procextra', { procs: list }, 15000);
        const x2 = await s2.call('taskmgr.procextra', { procs: list }, 15000);
        console.log(`  procextra cold sidecar: ${list.length} asked, first ${x1.ms} ms, repeat ${x2.ms} ms`);
        t.check('procextra cold: answers every live asked pid', x1.rows.length + x1.skipped.length === list.length && x1.rows.length > list.length * 0.9, `${x1.rows.length}+${x1.skipped.length}/${list.length}`);
      } finally { await s2.stop(); }
    }
    // ---------------- taskmgr.details
    const a = await s.call('taskmgr.details', {}, 15000);
    const b = await s.call('taskmgr.details', {}, 15000);
    const c = await s.call('taskmgr.details', {}, 15000);
    console.log(`  details: ${a.rows.length} rows, ${a.readable} readable, ${a.denied} need admin, ${a.raced} raced; first ${a.ms} ms (table ${a.msTable}, windows ${a.msWindows}), repeat ${b.ms} ms, ${c.ms} ms`);
    t.check('details: a process table', Array.isArray(a.rows) && a.rows.length > 20, String(a.rows && a.rows.length));
    t.check('details: cpus and a clock', a.cpus > 0 && b.t > a.t, `${a.cpus} ${a.t} ${b.t}`);
    const badRows = b.rows.map((r) => ({ pid: r.pid, bad: badFields(r) })).filter((x) => x.bad.length);
    t.check('details: every row has every field with the right type', badRows.length === 0, JSON.stringify(badRows.slice(0, 3)));
    const wordRows = b.rows.map((r) => ({ pid: r.pid, bad: badWords(r).map((k) => k + '=' + r[k]) })).filter((x) => x.bad.length);
    t.check('details: every word field uses Windows\' words', wordRows.length === 0, JSON.stringify(wordRows.slice(0, 3)));
    const keys = new Set(b.rows.map((r) => `${r.pid}|${r.created}`));
    t.check('details: one row per process (pid|created unique)', keys.size === b.rows.length);
    t.check('details: sharedWs = ws - privateWs, never negative', b.rows.every((r) => r.sharedWs === Math.max(0, r.ws - r.privateWs)));
    t.check('details: CPU time and cycles only grow for the same process', c.rows.every((r) => {
      const q = b.rows.find((x) => x.pid === r.pid && x.created === r.created);
      return !q || (r.cpuTime100ns >= q.cpuTime100ns && r.cycles >= q.cycles);
    }));
    t.check('details: Job object ID and Power usage say why they are null', a.fieldWhy && /administrator/.test(a.fieldWhy.jobId) && typeof a.fieldWhy.power === 'string');

    // the sidecar's own row
    const self = b.rows.find((r) => r.pid === s.ready.pid);
    t.check('self: in the table', !!self);
    if (self) {
      t.check('self: user = the current user, userFull DOMAIN\\name', (self.user || '').toLowerCase() === me && /\\/.test(self.userFull || '') && self.userFull.toLowerCase().endsWith('\\' + me), `${self.user ? 'set' : 'null'}`);
      t.check('self: x64, 64 bit, not elevated, not needsAdmin', self.arch === 'x64' && self.platform === '64 bit' && self.elevated === false && self.needsAdmin === false, `${self.arch} ${self.platform} ${self.elevated} ${self.needsAdmin}`);
      t.check('self: its exe path and command line (passive flag)', /Mantle\.Sidecar\.exe$/i.test(self.path || '') && /--passive/.test(self.cmdline || ''));
      t.check('self: Running, Normal priority, not in Efficiency mode, throttling Allowed', self.status === 'Running' && self.basePriority === 'Normal' && self.efficiency === false && self.powerThrottling === 'Allowed', `${self.status} ${self.basePriority} ${self.efficiency} ${self.powerThrottling}`);
      t.check('self: counters non-zero (ws, commit, threads, handles, cycles)', self.ws > 0 && self.wsPeak >= self.ws && self.commit > 0 && self.threads > 0 && self.handles > 0 && self.cycles > 0 && self.privateWs > 0);
      t.check('self: session = a user session (not 0)', self.sessionId > 0, String(self.sessionId));
      t.check('self: not a package (""), DEP on, every token field read', self.packageName === '' && self.dep === 'Enabled' && self.uacVirt !== null && self.unread.length === 0, `${JSON.stringify(self.packageName)} ${self.dep} ${self.uacVirt} unread=${self.unread.join(',')}`);
      t.check('self: User / GDI objects read', typeof self.userObjects === 'number' && typeof self.gdiObjects === 'number', `${self.userObjects} ${self.gdiObjects}`);
      t.check('self: enterprise context and OS context read', typeof self.enterprise === 'string' && typeof self.osContext === 'string', `${self.enterprise} ${self.osContext}`);
    }
    // the node child
    const kid = b.rows.find((r) => r.pid === child.pid);
    t.check('child: in the table', !!kid);
    if (kid) {
      t.check('child: user = the current user', (kid.user || '').toLowerCase() === me);
      t.check('child: x64, 64 bit, not elevated', kid.arch === 'x64' && kid.platform === '64 bit' && kid.elevated === false, `${kid.arch} ${kid.platform} ${kid.elevated}`);
      t.check('child: command line contains its script text', (kid.cmdline || '').includes(MARK));
      t.check('child: node.exe path, a description', /node\.exe$/i.test(kid.path || '') && typeof kid.desc === 'string');
      t.check('child: needsAdmin false, no unread fields', kid.needsAdmin === false && kid.unread.length === 0, kid.unread.join(','));
    }
    // processes Windows will not open for a non-administrator
    const needs = b.rows.filter((r) => r.needsAdmin);
    const denied = needs.filter((r) => /open this process/.test(r.why || ''));
    const tokenOnly = needs.filter((r) => !/open this process/.test(r.why || ''));
    t.check('admin-only rows: some exist (Mantle is not elevated)', denied.length > 0, String(denied.length));
    t.check('admin-only rows: why + unread, user/cmdline/efficiency null, counters still read', denied.length > 0 && denied.every((r) =>
      /administrator/.test(r.why || '') && r.unread.includes('cmdline') && r.cmdline === null && (r.user === null || r.pid === 4) && r.efficiency === null
      && r.ws >= 0 && r.handles >= 0 && typeof r.cpuTime100ns === 'number'));
    t.check('token-only rows (opened, token refused): user null + unread + an administrator why', tokenOnly.every((r) =>
      r.user === null && r.unread.includes('user') && /administrator/.test(r.why || '')), JSON.stringify(tokenOnly.slice(0, 2).map((r) => ({ pid: r.pid, unread: r.unread }))));
    t.check('every row with a null access field says why', b.rows.every((r) => r.unread.length === 0 || r.pid === 0 || (typeof r.why === 'string' && r.why.length > 10)),
      JSON.stringify(b.rows.filter((r) => r.unread.length && r.pid > 0 && !r.why).slice(0, 3).map((r) => ({ pid: r.pid, unread: r.unread }))));
    console.log(`  rows needing admin: ${needs.length} (${denied.length} not openable, ${tokenOnly.length} token refused)`);
    const withPath = denied.filter((r) => r.path).length;
    console.log(`  admin-only rows: ${denied.length}; image path still read for ${withPath} (SystemProcessIdInformation), arch for ${denied.filter((r) => r.arch).length}`);
    const sys = b.rows.find((r) => r.pid === 4);
    t.check('System (pid 4): a row, counters, user SYSTEM, needsAdmin + why (not elevated), never throws', sys && sys.threads > 0 && typeof sys.user === 'string' && sys.handles > 0 && sys.needsAdmin === true && /administrator/.test(sys.why || ''), sys && `${sys.threads} ${sys.user ? 'user' : 'null'}`);
    const idle = b.rows.find((r) => r.pid === 0);
    t.check('System Idle Process (pid 0): a row, priority N/A', idle && idle.basePriority === 'N/A' && idle.cpuTime100ns > 0);
    const readable = b.rows.filter((r) => !r.needsAdmin && r.pid > 4);
    const throttled = readable.filter((r) => r.powerThrottling !== null).length;
    t.check('readable rows: power throttling read for (almost) all', throttled >= readable.length - 3, `${throttled}/${readable.length}`);
    console.log(`  readable rows: ${readable.length}; efficiency mode ${b.rows.filter((r) => r.efficiency === true).length}, packages ${b.rows.filter((r) => r.packageName).length}, elevated ${b.rows.filter((r) => r.elevated === true).length}, not responding ${b.rows.filter((r) => r.status === 'Not responding').length}, suspended ${b.rows.filter((r) => r.status === 'Suspended').length}`);

    // the pure JS over two real samples: CPU % over every row (Idle included) adds to ~100 % of the machine
    await T.sleep(1000);   // a tick-sized interval: CPU times move in clock-interrupt steps, so 10 ms apart is noise
    const d1 = await s.call('taskmgr.details', {}, 15000);
    const rows = L.rowsFrom(d1, c);
    const sum = rows.reduce((x, r) => x + (r.cpu || 0), 0);
    t.check('rowsFrom over real samples: CPU % incl. Idle sums to ~100', sum > 80 && sum < 120, sum.toFixed(1));
    t.check('rowsFrom over real samples: wsDelta/pfDelta numbers for surviving rows', rows.filter((r) => r.wsDelta !== null && r.pfDelta !== null).length > rows.length * 0.9);

    // ---------------- taskmgr.procextra (the Processes page asks for every process)
    const all = c.rows.filter((r) => r.pid > 0).map((r) => ({ pid: r.pid, created: r.created }));
    const e1 = await s.call('taskmgr.procextra', { procs: all }, 15000);
    const e2 = await s.call('taskmgr.procextra', { procs: all }, 15000);
    const e3 = await s.call('taskmgr.procextra', { procs: all }, 15000);
    console.log(`  procextra: ${all.length} asked, ${e2.rows.length} rows, ${e2.skipped.length} skipped; repeat ${e2.ms} ms, ${e3.ms} ms (first call after details ${e1.ms} ms)`);
    t.check('procextra: power null with a reason', e2.power === null && e2.powerTrend === null && typeof e2.powerWhy === 'string' && e2.powerWhy.length > 20);
    const ek = e2.rows.find((r) => r.pid === child.pid);
    t.check('procextra: the child: publisher, command line with its script text, efficiency false', ek && typeof ek.publisher === 'string' && (ek.cmdline || '').includes(MARK) && ek.efficiency === false && ek.status === null, ek && `${ek.publisher ? 'pub' : 'null'} ${ek.efficiency}`);
    const es = e2.rows.find((r) => r.pid === s.ready.pid);
    t.check('procextra: the sidecar row has the right shape', es && 'publisher' in es && /--passive/.test(es.cmdline || '') && es.efficiency === false && es.needsAdmin === false);
    t.check('procextra: rows Windows will not open say needsAdmin + why, efficiency null', e2.rows.filter((r) => r.needsAdmin).every((r) => r.efficiency === null && /administrator/.test(r.why || '')) && e2.rows.some((r) => r.needsAdmin));
    t.check('procextra: publishers read for most rows', e2.rows.filter((r) => r.publisher).length > e2.rows.length / 2, `${e2.rows.filter((r) => r.publisher).length}/${e2.rows.length}`);
    const wrong = await s.call('taskmgr.procextra', { procs: [{ pid: child.pid, created: '1' }, { pid: s.ready.pid, created: self ? self.created : '0' }] }, 4000);
    t.check('procextra: a wrong created is skipped (reused pid), the right one answered', wrong.rows.length === 1 && wrong.rows[0].pid === s.ready.pid && wrong.skipped.length === 1 && wrong.skipped[0].pid === child.pid && /different process/.test(wrong.skipped[0].why), JSON.stringify(wrong.skipped));
    const gone = await s.call('taskmgr.procextra', { procs: [{ pid: 3, created: '1' }] }, 4000);
    t.check('procextra: a pid that is not running is skipped', gone.rows.length === 0 && gone.skipped.length === 1);
    let refusedEmpty = false;
    try { await s.call('taskmgr.procextra', {}, 4000); } catch (e) { refusedEmpty = /procs/.test(e.message); }
    t.check('procextra: no procs -> a plain-words error', refusedEmpty);
    // procExtraFor over the real reply: a one-process group of the child
    const g = L.procExtraFor({ root: child.pid, created: (kid || {}).created, procs: [{ pid: child.pid, created: (kid || {}).created }] }, L.extraMapFrom(e2));
    t.check('procExtraFor over the real reply', g.cmdline && g.cmdline.includes(MARK) && g.efficiency === false && g.status === null);

    // ---------------- cost budget (~30 ms per repeat call)
    const repDetails = Math.min(b.ms, c.ms), repExtra = Math.min(e2.ms, e3.ms);
    t.check('cost: details repeat under 30 ms', repDetails < 30, `${b.ms} / ${c.ms} ms`);
    t.check('cost: procextra repeat under 30 ms', repExtra < 30, `${e2.ms} / ${e3.ms} ms`);

    // read only: the child is still running and untouched
    t.check('read only: the child is still running', child.exitCode === null && !child.killed);
  } catch (e) {
    t.check('no exception', false, e.stack);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
