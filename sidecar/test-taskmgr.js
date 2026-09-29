// test-taskmgr.js - sidecar/TaskMgr.cs against a PASSIVE sidecar (lane taskmgr, 2026-09-28).
//
//   node sidecar/test-taskmgr.js [--exe=<Mantle.Sidecar.exe>]     (or MANTLE_SIDECAR_EXE)
//
// NOTHING IS CLOSED, KILLED OR TRIMMED: every close/trim here is a dryRun, and the one real
// request is sent to a passive sidecar (which must refuse it before looking at anything) and
// aimed at this test's OWN child (which the guard refuses as "Mantle itself" anyway). The only
// targets a dry run is allowed to plan are two idle node processes this test starts and ends.
// Reads the real process table (counts and numbers only are printed; no names, paths or titles).
//
// Prints "TASKMGR SIDECAR: n passed, m failed".
'use strict';
const cp = require('child_process');
const T = require('./test-lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (snap, pid) => snap.procs.find((p) => p.pid === pid);

(async () => {
  const t = T.checker('TASKMGR SIDECAR');
  const s = await T.startPassive();
  // A child under this test (= under the sidecar's parent: "Mantle itself" to the guard) and an
  // ORPHAN (its cmd parent exits), which the guard has no reason to refuse.
  const mine = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  const starter = cp.spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
  const starterPid = starter.pid;
  await sleep(900);
  try {
    const a = await s.call('taskmgr.snapshot', {}, 8000);
    t.check('snapshot: a process table', Array.isArray(a.procs) && a.procs.length > 20, String(a.procs && a.procs.length));
    t.check('snapshot: says its memory method', /WorkingSetPrivateSize/.test(a.method), a.method);
    t.check('snapshot: RAM total/avail/used', a.mem && a.mem.total > 0 && a.mem.avail > 0 && a.mem.used === a.mem.total - a.mem.avail, JSON.stringify(a.mem));
    t.check('snapshot: cpus and a clock', a.cpus > 0 && a.t > 0, `${a.cpus} ${a.t}`);
    const self = pick(a, s.ready.pid);
    t.check('snapshot: the sidecar itself is in it with a private working set', self && self.pws > 0 && typeof self.created === 'string' && /^\d+$/.test(self.created), JSON.stringify(self && { pws: self.pws, created: self.created }));
    t.check('snapshot: parentPid is this test', a.parentPid === process.pid, String(a.parentPid));
    const withWin = a.procs.filter((p) => p.windows > 0).length;
    t.check('snapshot: some processes own app windows', withWin > 0, String(withWin));
    t.check('snapshot: paths read for most processes', a.procs.filter((p) => p.path).length > a.procs.length / 3, `${a.noPath} unread of ${a.procs.length}`);
    console.log(`  (read-only) ${a.procs.length} processes, ${withWin} with app windows, ${a.noPath} paths unreadable, ${a.ms} ms`);

    const b = await s.call('taskmgr.snapshot', {}, 8000);
    console.log(`  (read-only) second snapshot ${b.ms} ms`);
    t.check('snapshot: CPU time only grows for the same process', b.procs.every((p) => { const q = pick(a, p.pid); return !q || q.created !== p.created || p.cpu >= q.cpu; }));

    // The method check: the snapshot's number vs PROCESS_MEMORY_COUNTERS_EX2 for the same pids.
    const v = await s.call('taskmgr.verify', { pids: [s.ready.pid, mine.pid] }, 4000);
    const ex2 = v.rows.find((r) => r.pid === s.ready.pid);
    const self2 = pick(b, s.ready.pid);
    t.check('verify: EX2 PrivateWorkingSetSize within 4 MB of the snapshot for the sidecar', ex2 && self2 && Math.abs(ex2.pws - self2.pws) < 4 * 1048576, `${ex2 && ex2.pws} vs ${self2 && self2.pws}`);

    const kid = pick(b, mine.pid);
    const orphan = b.procs.find((p) => p.ppid === starterPid && /node/i.test(p.file));
    t.check('the test child is in the table', !!kid);
    t.check('the orphan test child is in the table', !!orphan, 'none with ppid ' + starterPid);

    // Refusals (dry runs: nothing would happen even if the guard were wrong).
    const r1 = await s.call('taskmgr.close', { procs: [{ pid: kid.pid, created: kid.created }], root: kid.pid, dryRun: true }, 4000);
    t.check('guard: a process under Mantle is refused as Mantle itself', r1.done === false && r1.refused.length === 1 && /Mantle itself/.test(r1.refused[0].why), JSON.stringify(r1));
    const sys = b.procs.find((p) => /^(csrss|wininit|services|lsass)\.exe$/i.test(p.file));
    const r2 = await s.call('taskmgr.trim', { procs: [{ pid: sys.pid, created: sys.created }], dryRun: true }, 4000);
    t.check('guard: a Windows system process is refused', r2.trimmed === 0 && r2.refused.length === 1 && /refused/.test(r2.refused[0].why), JSON.stringify(r2.refused));
    const r3 = await s.call('taskmgr.close', { procs: [{ pid: kid.pid, created: '1' }], root: kid.pid, dryRun: true }, 4000);
    t.check('guard: a wrong creation time (reused pid) is refused', /different process/.test(r3.refused[0].why), JSON.stringify(r3.refused));
    const r4 = await s.send('taskmgr.close', { procs: [{ pid: kid.pid, created: kid.created }], root: kid.pid }, 4000);
    t.check('passive: a real close is refused before anything', r4.ok === false && r4.error === T.PASSIVE_REFUSAL, JSON.stringify(r4));
    const r5 = await s.send('taskmgr.trim', { procs: [{ pid: kid.pid, created: kid.created }] }, 4000);
    t.check('passive: a real trim is refused before anything', r5.ok === false && r5.error === T.PASSIVE_REFUSAL, JSON.stringify(r5));
    const r6 = await s.send('taskmgr.close', { procs: [], dryRun: true }, 4000);
    t.check('close: no procs is a plain-words error', r6.ok === false && /needs procs/.test(r6.error), JSON.stringify(r6));

    // taskmgr.frame (lane taskmgrfx): only ever Mantle's OWN window. Asked READ-ONLY here (no
    // `light`), so even a broken guard could not change anybody's window.
    const f0 = await s.send('taskmgr.frame', { hwnd: 0 }, 4000);
    t.check('frame: no hwnd is a plain-words error', f0.ok === false && /needs the window's hwnd/.test(f0.error), JSON.stringify(f0));
    const wl = await s.send('windows', {}, 6000);
    const list = wl.ok && wl.result ? (Array.isArray(wl.result) ? wl.result : wl.result.windows || []) : [];
    const foreign = list.map((w) => Number(w && w.hwnd)).find((h) => h > 0);
    if (foreign) {
      const f1 = await s.send('taskmgr.frame', { hwnd: foreign }, 4000);
      t.check('frame: a window that is not Mantle\'s own is refused (this test\'s parent has none)', f1.ok === false && /not a window of Mantle's own Electron/.test(f1.error), JSON.stringify(f1));
    } else t.check('frame: a foreign window to be refused was found', false, `windows answered ${JSON.stringify(wl).slice(0, 120)}`);

    if (orphan) {
      const d1 =await s.call('taskmgr.close', { procs: [{ pid: orphan.pid, created: orphan.created }], root: orphan.pid, dryRun: true }, 4000);
      t.check('dry close: a windowless process -> taskkill /PID n /T without /F', d1.done && d1.how === 'taskkill' && d1.command === `taskkill /PID ${orphan.pid} /T` && d1.dryRun, JSON.stringify(d1));
      const d2 = await s.call('taskmgr.close', { procs: [{ pid: orphan.pid, created: orphan.created }], root: orphan.pid, force: true, dryRun: true }, 4000);
      t.check('dry force: taskkill /F', d2.how === 'taskkill_force' && / \/F$/.test(d2.command), JSON.stringify(d2));
      const d3 = await s.call('taskmgr.trim', { procs: [{ pid: orphan.pid, created: orphan.created }], dryRun: true }, 4000);
      t.check('dry trim: before read, nothing trimmed', d3.dryRun && d3.trimmed === 0 && d3.rows.length === 1 && d3.rows[0].before > 0, JSON.stringify(d3));
      const c = await s.call('taskmgr.cmdline', { pid: orphan.pid, created: orphan.created }, 4000);
      t.check('cmdline: path and command line of a same-user process', c.ok && /node/i.test(c.path) && /setTimeout/.test(c.cmdline || ''), JSON.stringify(c).slice(0, 80));
      const c2 = await s.call('taskmgr.cmdline', { pid: orphan.pid, created: '1' }, 4000);
      t.check('cmdline: a reused pid is refused', c2.ok === false && /different process/.test(c2.why), JSON.stringify(c2));
    }
  } catch (e) {
    t.check('no exception', false, e.stack);
  } finally {
    // The two idle children end on their own (20 s); this test ends nothing.
    await s.stop();
  }
  process.exit(t.summary());
})();
