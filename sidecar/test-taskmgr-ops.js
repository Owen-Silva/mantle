// test-taskmgr-ops.js - sidecar/ProcOps.cs against a PASSIVE sidecar (lane tm-ops, 2026-10-28).
//
//   node sidecar/test-taskmgr-ops.js [--exe=<Mantle.Sidecar.exe>]     (or MANTLE_SIDECAR_EXE)
//
// NOTHING IS CHANGED, DUMPED, STARTED OR RESTARTED. Every write here is either a dryRun or a real request
// to a PASSIVE sidecar, which must refuse it with the passive words before reading anything; real
// requests name only this test's own orphan child. Dry runs aim at this test's OWN idle node children
// (one orphan, one under this test = part of Mantle to the guard) or, for the confirm-gate checks, at
// csrss/wininit (DRY writes only: a dry run opens handles and reads, never writes). Restart (Windows
// Explorer) is ONLY ever a dryRun or a passive refusal. The two children end by themselves (45 s
// timers); this test ends nothing.
// Prints counts and milliseconds only (no names, paths or command lines), then
// "TASKMGR OPS TEST: n passed, m failed".
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const T = require('./test-lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (snap, pid) => snap.procs.find((p) => p.pid === pid);
const short = (o) => JSON.stringify(o).slice(0, 260);

(async () => {
  const t = T.checker('TASKMGR OPS');
  const s = await T.startPassive();
  const mine = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 45000)'], { stdio: 'ignore', windowsHide: true });
  const starter = cp.spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, '-e', 'setTimeout(() => {}, 45000)'], { stdio: 'ignore', windowsHide: true });
  const starterPid = starter.pid;
  await sleep(900);

  const ms = {};
  const timed = async (label, cmd, args) => {
    const t0 = process.hrtime.bigint();
    const r = await s.send(cmd, args, 20000);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    (ms[label] = ms[label] || []).push(dt);
    return r;
  };
  // A reply the command itself answered (transport ok) -> its result.
  const res = (r) => (r && r.ok && r.result) || { transport: r };

  try {
    const snap = await s.call('taskmgr.snapshot', {}, 8000);
    const kid = pick(snap, mine.pid);
    const orphan = snap.procs.find((p) => p.ppid === starterPid && /node/i.test(p.file));
    const sys = snap.procs.find((p) => /^(csrss|wininit)\.exe$/i.test(p.file));
    t.check('setup: the child under the test is in the table', !!kid);
    t.check('setup: the orphan test child is in the table', !!orphan, 'none with ppid ' + starterPid);
    t.check('setup: a Windows system process is in the table', !!sys);
    if (!kid || !orphan || !sys) throw new Error('setup failed: no targets');
    const O = { pid: orphan.pid, created: orphan.created };
    const K = { pid: kid.pid, created: kid.created };
    const S = { pid: sys.pid, created: sys.created };
    const W = { pid: orphan.pid, created: '1' };

    // ---- the shared refusals, for every process command
    const procCmds = [
      ['efficiency', 'taskmgr.efficiency', { on: true }, true],
      ['priority', 'taskmgr.priority', { cls: 'high' }, true],
      ['affinity', 'taskmgr.affinity', { mask: '1' }, true],
      ['affinityget', 'taskmgr.affinityget', {}, false],
      ['dump', 'taskmgr.dump', {}, true],
      ['waitchain', 'taskmgr.waitchain', {}, false],
      ['uacvirt', 'taskmgr.uacvirt', { on: true }, true],
    ];
    // Guard policy (coordinator 10-28, like Windows): writes = GUARD_USER (a critical/Windows/Mantle process
    // needs confirmed:true; without it needsConfirm + Windows' warning text), reads = GUARD_READ (no guard).
    // Writes to the system process are ONLY ever dry runs here; real calls go to the orphan only.
    const isConfirm = (x, kind) => x.ok === false && x.needsConfirm === true && x.kind === kind && x.confirm && typeof x.confirm.title === 'string' && x.confirm.title.length > 0 && typeof x.confirm.button === 'string' && x.needsAdmin === false;
    const passedGate = (x) => x.needsConfirm !== true && x.unavailable !== true && (x.ok === true || x.needsAdmin === true || /less than 2 GB/.test(x.reason || ''));
    for (const [name, cmd, extra, writes] of procCmds) {
      const dry = writes ? { dryRun: true } : {};
      const w = res(await s.send(cmd, Object.assign({}, extra, W, dry), 8000));
      t.check(name + ': a wrong creation time (reused pid) is refused', w.ok === false && /different process/.test(w.reason || ''), short(w));
      const w2 = res(await s.send(cmd, Object.assign({}, extra, W, dry, { confirmed: true }), 8000));
      t.check(name + ': a wrong creation time is refused even when confirmed', w2.ok === false && /different process/.test(w2.reason || ''), short(w2));
      const n = res(await s.send(cmd, Object.assign({}, extra, dry), 8000));
      t.check(name + ': no pid/created is a plain-words refusal', n.ok === false && /needs pid and created/.test(n.reason || ''), short(n));
      const g = res(await s.send(cmd, Object.assign({}, extra, S, dry), 8000));
      const m = res(await s.send(cmd, Object.assign({}, extra, K, dry), 8000));
      if (!writes) {
        t.check(name + ': a critical system process is answered (or needsAdmin from Windows), never refused by a guard', g.needsConfirm === undefined && g.guard === undefined && (g.ok === true || (g.ok === false && g.needsAdmin === true)), short(g));
        t.check(name + ': the process under the test (Mantle\'s own tree) is answered', m.ok === true && m.needsConfirm === undefined, short(m));
        continue;
      }
      if (name === 'efficiency') {
        t.check('efficiency: a critical system process is unavailable (Windows greys the item out), not a confirm', g.ok === false && g.unavailable === true && /greys Efficiency mode out/.test(g.reason || '') && g.needsConfirm === undefined, short(g));
        const gc = res(await s.send(cmd, Object.assign({}, extra, S, dry, { confirmed: true }), 8000));
        t.check('efficiency: still unavailable on a critical process when confirmed', gc.ok === false && gc.unavailable === true, short(gc));
      } else {
        t.check(name + ': unconfirmed dry write on a critical system process -> needsConfirm + Windows\' warning, nothing touched', isConfirm(g, 'critical') && g.dryRun === true, short(g));
        const gc = res(await s.send(cmd, Object.assign({}, extra, S, dry, { confirmed: true }), 8000));
        t.check(name + ': confirmed DRY write on it passes the gate (then ok or needsAdmin)', passedGate(gc) && gc.dryRun === true, short(gc));
      }
      t.check(name + ': unconfirmed dry write on the process under the test -> needsConfirm kind mantle', isConfirm(m, 'mantle'), short(m));
      const mc = res(await s.send(cmd, Object.assign({}, extra, K, dry, { confirmed: true }), 8000));
      t.check(name + ': confirmed dry write on the process under the test passes the gate', passedGate(mc) && mc.dryRun === true, short(mc));
      const p = await s.send(cmd, Object.assign({}, extra, O), 8000);
      t.check(name + ': a real call (on the test\'s own orphan) is refused by the passive sidecar before anything', p.ok === false && p.error === T.PASSIVE_REFUSAL, short(p));
      const p2 = await s.send(cmd, Object.assign({}, extra, O, { confirmed: true }), 8000);
      t.check(name + ': a confirmed real call is refused by the passive sidecar too', p2.ok === false && p2.error === T.PASSIVE_REFUSAL, short(p2));
    }

    // ---- efficiency
    for (let i = 0; i < 2; i++) {
      const e = res(await timed('efficiency dry', 'taskmgr.efficiency', Object.assign({ on: true, dryRun: true }, O)));
      if (i) continue;
      t.check('efficiency: dryRun on the orphan says what it would do and reads the state', e.ok === true && e.dryRun === true && e.on === true && /Idle/.test(e.would || '') && e.before && e.before.priority === 'normal' && e.before.efficiency === false && typeof e.before.throttled === 'boolean', short(e));
    }
    const eOff = res(await s.send('taskmgr.efficiency', Object.assign({ on: false, dryRun: true }, O), 8000));
    t.check('efficiency: dryRun off says Normal', eOff.ok === true && /Normal/.test(eOff.would || ''), short(eOff));
    const eNo = res(await s.send('taskmgr.efficiency', Object.assign({ dryRun: true }, O), 8000));
    t.check('efficiency: no `on` is a plain-words refusal', eNo.ok === false && /needs on/.test(eNo.reason || ''), short(eNo));

    // ---- priority
    for (let i = 0; i < 2; i++) {
      const p = res(await timed('priority dry', 'taskmgr.priority', Object.assign({ cls: 'high', dryRun: true }, O)));
      if (i) continue;
      t.check('priority: dryRun High on the orphan', p.ok === true && p.dryRun === true && p.before === 'normal' && p.wouldBecome === 'high', short(p));
    }
    const rt = res(await s.send('taskmgr.priority', Object.assign({ cls: 'realtime', dryRun: true }, O), 8000));
    t.check('priority: dryRun Realtime says honestly whether Windows would make it High', (rt.ok === true && rt.wouldBecome === 'realtime') || (rt.ok === false && rt.needsAdmin === true && rt.wouldBecome === 'high' && /High instead/.test(rt.reason || '')), short(rt));
    console.log(`  realtime without elevation: ${rt.ok ? 'allowed (this sidecar holds the privilege)' : 'would become High, needsAdmin'}`);
    const bad = res(await s.send('taskmgr.priority', Object.assign({ cls: 'turbo', dryRun: true }, O), 8000));
    t.check('priority: an unknown class is refused in plain words', bad.ok === false && /cls must be one of/.test(bad.reason || ''), short(bad));
    const spaced = res(await s.send('taskmgr.priority', Object.assign({ cls: 'Below normal', dryRun: true }, O), 8000));
    t.check('priority: "Below normal" (the menu words) is accepted', spaced.ok === true && spaced.cls === 'belownormal', short(spaced));

    // ---- affinity
    let ag = null;
    for (let i = 0; i < 2; i++) {
      const a = res(await timed('affinityget', 'taskmgr.affinityget', O));
      if (i) continue;
      ag = a;
      const sysMask = a.systemMask ? BigInt(a.systemMask) : 0n;
      const mask = a.mask ? BigInt(a.mask) : 0n;
      t.check('affinityget: sane masks on the orphan (non-zero, inside the system mask, logical = this PC\'s processors)', a.ok === true && mask > 0n && (mask & ~sysMask) === 0n && a.logical === os.cpus().length && Array.isArray(a.cpus) && a.cpus.length === a.logical, short(a));
      t.check('affinityget: answered by the passive sidecar (read-only) with no dryRun field', a.dryRun === undefined, short(a));
    }
    if (ag && ag.ok) {
      const logical = ag.logical;
      for (let i = 0; i < 2; i++) {
        const a = res(await timed('affinity dry', 'taskmgr.affinity', Object.assign({ mask: ag.systemMask, dryRun: true }, O)));
        if (i) continue;
        t.check('affinity: dryRun with every processor', a.ok === true && a.dryRun === true && a.asked === ag.systemMask && a.before === ag.mask && a.cpus.length === logical, short(a));
      }
      const hx = res(await s.send('taskmgr.affinity', Object.assign({ mask: '0x1', dryRun: true }, O), 8000));
      t.check('affinity: a hex mask string is read', hx.ok === true && hx.asked === '1' && hx.cpus.length === 1 && hx.cpus[0] === 0, short(hx));
      const num = res(await s.send('taskmgr.affinity', Object.assign({ mask: 3, dryRun: true }, O), 8000));
      t.check('affinity: a plain number mask is read', (logical >= 2 ? num.ok === true && num.asked === '3' : num.ok === false), short(num));
      const zero = res(await s.send('taskmgr.affinity', Object.assign({ mask: '0', dryRun: true }, O), 8000));
      t.check('affinity: a zero mask is refused', zero.ok === false && /no processor/.test(zero.reason || ''), short(zero));
      const over = (1n << BigInt(logical)).toString();
      const big = res(await s.send('taskmgr.affinity', Object.assign({ mask: over, dryRun: true }, O), 8000));
      t.check('affinity: a mask outside the system mask is refused', big.ok === false && /does not have/.test(big.reason || ''), short(big));
      const junk = res(await s.send('taskmgr.affinity', Object.assign({ mask: 'all', dryRun: true }, O), 8000));
      t.check('affinity: a mask that is not a number is refused', junk.ok === false && /needs mask/.test(junk.reason || ''), short(junk));
    }

    // ---- dump (dryRun: a path, the free space and the process's size; no file)
    for (let i = 0; i < 2; i++) {
      const d = res(await timed('dump dry', 'taskmgr.dump', Object.assign({ dryRun: true }, O)));
      if (i) continue;
      const tmp = os.tmpdir().toLowerCase().replace(/[\\/]+$/, '');
      const p = String(d.path || '');
      t.check('dump: dryRun path is %TEMP%\\<exe name>.DMP', p.toLowerCase().startsWith(tmp + '\\') && /\\node( \(\d+\))?\.DMP$/.test(p), 'path shape ' + (p ? p.slice(tmp.length) : 'none'));
      t.check('dump: dryRun reports free disk space and the process\'s private bytes', d.freeBytes > 0 && d.privateBytes > 0 && d.minFreeAfter === 2147483648, short({ free: d.freeBytes, priv: d.privateBytes }));
      const enough = d.freeBytes - d.privateBytes >= 2147483648;
      t.check('dump: ok exactly when 2 GB would stay free', d.ok === enough && (enough || /less than 2 GB/.test(d.reason || '')), short({ ok: d.ok, reason: d.reason }));
      t.check('dump: dryRun wrote no file', p && !fs.existsSync(p));
      console.log(`  dump dryRun: free ${(d.freeBytes / 1073741824).toFixed(1)} GB, process ${(d.privateBytes / 1048576).toFixed(0)} MB private, ok ${d.ok}`);
    }

    // ---- wait chain (read-only)
    for (let i = 0; i < 2; i++) {
      const w = res(await timed('waitchain', 'taskmgr.waitchain', O));
      if (i) continue;
      const good = w.ok === true && Array.isArray(w.threads) && w.threads.length > 0 && w.threads.every((th) => Number.isInteger(th.tid) && Array.isArray(th.chain) && typeof th.deadlock === 'boolean');
      t.check('waitchain: the orphan\'s threads, each with a chain and a deadlock flag', good, short(w));
      const nodesOk = (w.threads || []).every((th) => th.chain.every((n) => typeof n.type === 'string' && typeof n.status === 'string'));
      t.check('waitchain: every node has a type and a status word', nodesOk, short((w.threads || [])[0]));
      t.check('waitchain: no deadlock in an idle node', w.deadlocks === 0, String(w.deadlocks));
      console.log(`  waitchain: ${w.threadCount} threads, ${w.blocked} waiting, ${w.deadlocks} deadlocks`);
    }

    // ---- UAC virtualization
    for (let i = 0; i < 2; i++) {
      const u = res(await timed('uacvirt dry', 'taskmgr.uacvirt', Object.assign({ on: true, dryRun: true }, O)));
      if (i) continue;
      const states = ['Enabled', 'Disabled', 'Not allowed'];
      t.check('uacvirt: dryRun reads the token honestly (Not allowed -> ok:false with that reason)', u.dryRun === true && typeof u.allowed === 'boolean' && states.includes(u.before) && (u.allowed ? u.ok === true : (u.ok === false && /^Not allowed/.test(u.reason || ''))), short(u));
      console.log(`  uacvirt on the orphan: ${u.before}`);
    }

    // ---- Restart (Windows Explorer): dryRun and the passive refusal ONLY
    for (let i = 0; i < 2; i++) {
      const x = res(await timed('restartexplorer dry', 'taskmgr.restartexplorer', { dryRun: true }));
      if (i) continue;
      const snap2 = await s.call('taskmgr.snapshot', {}, 8000);
      const verified = Array.isArray(x.pids) && x.pids.length > 0 && x.pids.every((e) => {
        const p = pick(snap2, e.pid);
        return !!p && /^explorer\.exe$/i.test(p.file) && p.created === e.created && e.pid !== s.ready.pid && e.pid !== process.pid;
      });
      t.check('restartexplorer: dryRun lists verified Explorer pids (name + creation time match the table)', x.ok === true && x.dryRun === true && verified, short(x));
      t.check('restartexplorer: dryRun lists the steps (end, wait, start only if Windows did not)', Array.isArray(x.steps) && x.steps.length === x.pids.length + 2 && /winlogon/.test(x.steps[x.steps.length - 2]), short(x.steps));
      t.check('restartexplorer: the shell window\'s process is among them', x.shellPid == null || x.pids.some((e) => e.pid === x.shellPid && e.shell === true), short({ shell: x.shellPid, n: x.pids.length }));
      console.log(`  restartexplorer dryRun: ${x.pids.length} Explorer process(es) verified, ${x.skipped.length} skipped`);
    }
    const xr = await s.send('taskmgr.restartexplorer', {}, 8000);
    t.check('restartexplorer: a real restart is refused by the passive sidecar', xr.ok === false && xr.error === T.PASSIVE_REFUSAL, short(xr));
    const xr2 = await s.send('taskmgr.restartexplorer', { dryRun: false }, 8000);
    t.check('restartexplorer: dryRun:false is refused by the passive sidecar too', xr2.ok === false && xr2.error === T.PASSIVE_REFUSAL, short(xr2));

    // ---- Run new task: dryRun only
    for (let i = 0; i < 2; i++) {
      const n = res(await timed('runtask dry', 'taskmgr.runtask', { line: 'notepad', dryRun: true }));
      if (i) continue;
      t.check('runtask: dryRun resolves "notepad" on PATH like the Run dialog', n.ok === true && n.dryRun === true && n.file === 'notepad' && n.args === '' && n.verb === 'open' && n.resolved === true && /\\notepad\.exe$/i.test(n.resolvedPath || ''), short(n));
    }
    const q = res(await s.send('taskmgr.runtask', { line: '"C:/Program Files/x/y.exe" -a b', dryRun: true }, 8000));
    t.check('runtask: a quoted path splits into file + args', q.ok === true && q.file === 'C:/Program Files/x/y.exe' && q.args === '-a b' && q.resolved === false, short(q));
    const adm = res(await s.send('taskmgr.runtask', { line: 'cmd /k echo hi', admin: true, dryRun: true }, 8000));
    t.check('runtask: admin -> runas, a bare name + its arguments', adm.ok === true && adm.verb === 'runas' && adm.file === 'cmd' && adm.args === '/k echo hi' && adm.resolved === true, short(adm));
    const env = res(await s.send('taskmgr.runtask', { line: '%WINDIR%\\explorer.exe', dryRun: true }, 8000));
    t.check('runtask: environment variables are expanded', env.ok === true && !/%/.test(env.file) && /\\explorer\.exe$/i.test(env.file) && env.resolved === true, short(env));
    if (/ /.test(process.execPath)) {
      const uq = res(await s.send('taskmgr.runtask', { line: process.execPath + ' -v', dryRun: true }, 8000));
      t.check('runtask: an UNQUOTED path with spaces takes the longest existing prefix', uq.ok === true && uq.file === process.execPath && uq.args === '-v' && uq.resolved === true, short(uq));
    }
    const url = res(await s.send('taskmgr.runtask', { line: 'https://example.com', dryRun: true }, 8000));
    t.check('runtask: a URL is passed whole', url.ok === true && url.kind === 'url' && url.file === 'https://example.com' && url.args === '', short(url));
    const empty = res(await s.send('taskmgr.runtask', { line: '  ', dryRun: true }, 8000));
    t.check('runtask: an empty command is refused in plain words', empty.ok === false && /type the name/.test(empty.reason || ''), short(empty));
    const rr = await s.send('taskmgr.runtask', { line: 'notepad' }, 8000);
    t.check('runtask: a real run is refused by the passive sidecar', rr.ok === false && rr.error === T.PASSIVE_REFUSAL, short(rr));
    const rra = await s.send('taskmgr.runtask', { line: 'notepad', admin: true }, 8000);
    t.check('runtask: a real admin run is refused by the passive sidecar', rra.ok === false && rra.error === T.PASSIVE_REFUSAL, short(rra));

    // ---- Properties: dryRun only
    for (let i = 0; i < 2; i++) {
      const pr = res(await timed('properties dry', 'taskmgr.properties', { path: process.execPath, dryRun: true }));
      if (i) continue;
      t.check('properties: dryRun on an existing file', pr.ok === true && pr.dryRun === true && pr.reason === null, short(pr));
    }
    const pm = res(await s.send('taskmgr.properties', { path: process.execPath + '.missing', dryRun: true }, 8000));
    t.check('properties: a missing file is refused', pm.ok === false && /not an existing file/.test(pm.reason || ''), short(pm));
    const pd = res(await s.send('taskmgr.properties', { path: os.tmpdir(), dryRun: true }, 8000));
    t.check('properties: a folder is refused (files only)', pd.ok === false && /not an existing file/.test(pd.reason || ''), short(pd));
    const pp = await s.send('taskmgr.properties', { path: process.execPath }, 8000);
    t.check('properties: a real call is refused by the passive sidecar', pp.ok === false && pp.error === T.PASSIVE_REFUSAL, short(pp));

    // The children were never touched: still running with the same creation time.
    const after = await s.call('taskmgr.snapshot', {}, 8000);
    const o2 = pick(after, orphan.pid), k2 = pick(after, kid.pid);
    t.check('afterwards: the orphan is untouched (same creation time, still normal priority by dry run)', o2 && o2.created === orphan.created);
    t.check('afterwards: the child under the test is untouched', k2 && k2.created === kid.created);

    console.log('  ms per call (first / repeat):');
    for (const [k, v] of Object.entries(ms)) console.log(`    ${k.padEnd(22)} ${v.map((x) => x.toFixed(1)).join(' / ')}`);
  } catch (e) {
    t.check('no exception', false, e.stack);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
