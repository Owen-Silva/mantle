// test-apppower.js - App power's sidecar half (sidecar/AppPower*.cs; lane mantle-power-sidecar, 2026-10-14).
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-apppower.js
//
// NEVER ON THE USER'S APPS. Every write goes to a throwaway burner (sidecar/apppower-burner.js) compiled
// under a unique name in %TEMP%\mantle-apppower-test, and every match carries pids. The passive test
// sidecar itself refuses a real write to anything that is not that burner (checked below with a decoy).
// Windows' own processes are only ever named in dry runs. The graphics preference writes go to
// HKCU\Software\Mantle-test\... (MANTLE_APPPOWER_TEST_REGROOT), deleted at the end. Every burner is
// killed by pid in a finally.
//
// READ BACK twice where Windows allows it: apppower.read (the sidecar) AND the burner's own report of
// itself from inside (sidecar/apppower-burner.js), plus PowerShell's Get-Process for the priority, the
// session and the working set.
//
// MEASURES (printed): the burner with 2 spinning threads, ~8 s windows, its CPU share of the whole
// machine from its process times, and the work it got done: baseline, Efficiency mode, CPU limit 25%,
// CPU limit 10%.
//
// Prints one summary line, "APPPOWER TEST: n passed, m failed".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('./test-lib');
const B = require('./apppower-burner');

const REGROOT = 'Software\\Mantle-test\\apppower-' + process.pid;
process.env.MANTLE_APPPOWER_TEST_REGROOT = REGROOT;   // the sidecars below inherit it
const MB = 1048576;
const NCPU = os.cpus().length;

function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').trim();
}
function psProc(pid) {
  try { return JSON.parse(ps(`Get-Process -Id ${pid} | Select-Object SessionId,WorkingSet64,@{n='P';e={[string]$_.PriorityClass}} | ConvertTo-Json -Compress`)); } catch (_) { return null; }
}
function reg(args) { return spawnSync('reg', args, { encoding: 'utf8', windowsHide: true }); }
function regGet(name) {
  const r = reg(['query', 'HKCU\\' + REGROOT, '/v', name]);
  if (r.status !== 0) return null;
  const m = /REG_SZ\s+(.*)$/m.exec(r.stdout || '');
  return m ? m[1].trim() : null;
}

(async () => {
  const t = T.checker('APPPOWER');
  const pids = new Set();
  let s = null, runDir = null;
  try {
    const run = B.runDir();
    runDir = run.dir;
    const exe = B.build(run.dir, run.name);
    const EXE = run.name;
    s = await T.startPassive();
    const start = (args, life) => { const b = B.start(exe, args, { life: life || 240 }); pids.add(b.pid); return b; };
    const rule = (key, ps2, set) => ({ key, label: 'burner', match: { exe: EXE, pids: ps2 }, set });
    const rules = (list, extra) => s.send('apppower.rules', Object.assign({ rules: list }, extra || {}), 10000);
    const read = async (pid) => { const r = await s.send('apppower.read', { pid }, 8000); return r.ok ? r.result : { error: r.error }; };
    const until = async (fn, ms) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await T.sleep(150); } return v; };
    const self = (b, pred, ms) => until(() => { const i = b.info(); return i && pred(i) ? i : null; }, ms || 2500);
    const st = (r, key) => r && r.ok && (r.result.status || []).find((x) => x.key === key);
    const den = (row, code) => ((row && row.denied) || []).filter((d) => d.access === code).reduce((a, d) => a + d.n, 0);

    // ---------------------------------------------------------------- caps
    const caps = (await s.send('apppower.caps', {}, 15000)).result || {};
    t.check('caps: at least one hardware GPU, gpuPref only with 2+', caps.gpus >= 1 && caps.gpuPref === (caps.gpus >= 2), JSON.stringify(caps));
    t.check('caps: gpuLow is a yes/no with plain words when no', typeof caps.gpuLow === 'boolean' && (caps.gpuLow ? caps.gpuLowWhy == null : /\w+ \w+/.test(caps.gpuLowWhy || '')), JSON.stringify(caps));

    // ---------------------------------------------------------------- the burner, as Windows lists it
    const A = start(['spin', '2']);
    await self(A, (i) => i.rate > 0, 4000);
    const r0 = await read(A.pid);
    const p0 = psProc(A.pid);
    t.check('read: the burner as the process list sees it (exe, normal priority, Windows-managed throttling)', r0.exe === EXE && r0.priority === 'normal' && r0.eco === null && r0.memPriority === 5 && r0.access === 'ok', JSON.stringify(r0));
    t.check('read: session and working set match PowerShell (offsets 0x64 and 0x90)', p0 && r0.session === p0.SessionId && Math.abs(r0.workingSet - p0.WorkingSet64) < 8 * MB, JSON.stringify({ r: [r0.session, r0.workingSet], ps: p0 }));

    // CPU share of the whole machine from the process times, and the work done (loop blocks a second)
    async function measure(label, ms) {
      const a = await read(A.pid), t0 = Date.now();
      const rates = [];
      while (Date.now() - t0 < ms) { await T.sleep(1000); const i = A.info(); if (i) rates.push(i.rate); }
      const b = await read(A.pid), t1 = Date.now();
      const pct = (100 * (b.cpuMs - a.cpuMs)) / ((t1 - t0) * NCPU);
      const rate = rates.slice(1).reduce((x, y) => x + y, 0) / Math.max(1, rates.length - 1);
      const m = { label, pct: +pct.toFixed(1), rate: Math.round(rate) };
      console.log(`  measure: ${label}: ${m.pct}% of the whole CPU (${NCPU} logical), ${m.rate} work units/s`);
      return m;
    }
    await T.sleep(1000);
    const mBase = await measure('baseline (2 spinning threads)', 8000);

    // ---------------------------------------------------------------- Efficiency mode
    let r = await rules([rule('a', [A.pid], { eco: true })]);
    t.check('eco: applied to the one burner', st(r, 'a') && st(r, 'a').applied === 1 && st(r, 'a').shared === null, JSON.stringify(r));
    let ra = await read(A.pid);
    let ia = await self(A, (i) => i.thrCtl === 1);
    let pa = psProc(A.pid);
    t.check('eco: read says Efficiency mode on + low priority', ra.eco === true && ra.priority === 'low', JSON.stringify(ra));
    t.check('eco: the burner sees EXECUTION_SPEED throttling and IDLE priority itself', ia && ia.thrCtl === 1 && ia.thrState === 1 && ia.prio === 0x40, JSON.stringify(ia));
    t.check('eco: PowerShell says Idle', pa && pa.P === 'Idle', JSON.stringify(pa));
    const mEco = await measure('Efficiency mode', 8000);

    // ---------------------------------------------------------------- CPU limit 25 / 10 (eco off at the same time)
    r = await rules([rule('a', [A.pid], { cpuCap: 25 })]);
    ra = await read(A.pid);
    ia = await self(A, (i) => i.cpuRate === 2500);
    t.check('cpu limit: one job covers the burner (shared)', st(r, 'a') && st(r, 'a').applied === 1 && st(r, 'a').shared === true, JSON.stringify(r));
    t.check('cpu limit 25: read says 25% in a Mantle job', ra.jobCpuRate === 25 && ra.mantleJob === true && ra.inJob === true, JSON.stringify(ra));
    t.check('cpu limit 25: the burner sees ENABLE|HARD_CAP at 2500 in its own job', ia && ia.cpuFlags === 5 && ia.cpuRate === 2500, JSON.stringify(ia));
    t.check('eco off: Windows-managed again, priority back to normal', ra.eco === null && ra.priority === 'normal', JSON.stringify(ra));
    const m25 = await measure('CPU limit 25%', 8000);
    r = await rules([rule('a', [A.pid], { cpuCap: 10 })]);
    ia = await self(A, (i) => i.cpuRate === 1000);
    t.check('cpu limit 10: the same job now 1000', ia && ia.cpuFlags === 5 && ia.cpuRate === 1000 && (await read(A.pid)).jobCpuRate === 10, JSON.stringify(ia));
    const m10 = await measure('CPU limit 10%', 8000);
    t.check('cpu limit 10: enforced (<= 11.5% of the machine)', m10.pct <= 11.5, JSON.stringify(m10));
    t.check('cpu limit 25: at or under 25% (2 threads = 25% unlimited)', m25.pct <= 26.5, JSON.stringify(m25));

    // ---------------------------------------------------------------- priority, memory priority, graphics priority
    r = await rules([rule('a', [A.pid], { priority: 'belownormal', memLow: true, gpuLow: true })]);
    ra = await read(A.pid);
    ia = await self(A, (i) => i.memPrio === 2 && i.cpuFlags === 0);
    pa = psProc(A.pid);
    t.check('priority belownormal: read + PowerShell agree', ra.priority === 'belownormal' && pa && pa.P === 'BelowNormal', JSON.stringify([ra.priority, pa]));
    t.check('memory priority low: read 2 and the burner sees 2', ra.memPriority === 2 && ia && ia.memPrio === 2, JSON.stringify([ra.memPriority, ia && ia.memPrio]));
    t.check('cpu limit 0: the job limit is cleared (the undo)', ia && ia.cpuFlags === 0 && ra.jobCpuRate === null, JSON.stringify([ra.jobCpuRate, ia && ia.cpuFlags]));
    if (caps.gpuLow) t.check('graphics priority: below normal without admin', ra.gpuPriority === 'belownormal', JSON.stringify([ra.gpuPriority, ra.gpuWhy]));
    console.log(`  gpu: caps.gpuLow=${caps.gpuLow}; burner graphics priority read back "${ra.gpuPriority}"${ra.gpuWhy ? ' (' + ra.gpuWhy + ')' : ''}`);
    r = await rules([rule('a', [A.pid], { priority: 'abovenormal' })]);
    pa = psProc(A.pid);
    t.check('priority abovenormal: read + PowerShell agree', (await read(A.pid)).priority === 'abovenormal' && pa && pa.P === 'AboveNormal', JSON.stringify(pa));
    for (const bad of ['high', 'realtime']) {
      r = await rules([rule('a', [A.pid], { priority: bad })]);
      t.check(`priority ${bad}: refused, nothing changed`, !r.ok && /never/.test(r.error) && (await read(A.pid)).priority === 'abovenormal', JSON.stringify(r).slice(0, 200));
    }

    // ---------------------------------------------------------------- removal restores everything
    r = await rules([]);
    ra = await read(A.pid);
    ia = await self(A, (i) => i.memPrio === 5 && i.prio === 0x20);
    pa = psProc(A.pid);
    t.check('removed: priority normal, throttling Windows-managed, memory priority 5', ra.priority === 'normal' && ra.eco === null && ra.memPriority === 5 && pa && pa.P === 'Normal', JSON.stringify(ra));
    t.check('removed: the burner sees itself back to normal, no job limit', ia && ia.thrCtl === 0 && ia.cpuFlags === 0, JSON.stringify(ia));
    if (caps.gpuLow) t.check('removed: graphics priority normal', ra.gpuPriority === 'normal', ra.gpuPriority);
    const evs = s.collect('apppower');
    t.check('event: "apppower" pushed with each change, the last one empty', evs.length >= 3 && Array.isArray(evs[evs.length - 1].status) && evs[evs.length - 1].status.length === 0, `${evs.length} events`);

    // ---------------------------------------------------------------- dryRun writes nothing
    r = await rules([rule('d', [A.pid], { eco: true, priority: 'low', cpuCap: 30, memLow: true })], { dryRun: true });
    await T.sleep(400);
    ra = await read(A.pid);
    ia = await self(A, () => true);
    const stNow = (await s.send('apppower.status', {})).result;
    t.check('dryRun: answers the status it would produce', r.ok && r.result.dryRun === true && st(r, 'd') && st(r, 'd').applied === 1, JSON.stringify(r));
    t.check('dryRun: nothing written (read + the burner itself)', ra.priority === 'normal' && ra.eco === null && ra.memPriority === 5 && ia.cpuFlags === 0 && ia.prio === 0x20, JSON.stringify([ra, ia]));
    t.check('dryRun: the enforced table is untouched', stNow.rules === 0 && stNow.status.length === 0, JSON.stringify(stNow));

    // ---------------------------------------------------------------- NEVER list, session 0, the passive guard
    const svc = +ps('(Get-Process svchost | Select-Object -First 1).Id');
    r = await rules([{ key: 'n', match: { exe: 'svchost', pids: [svc] }, set: { eco: true } }], { dryRun: true });
    t.check('NEVER list: svchost refused as protected (dry run)', st(r, 'n') && st(r, 'n').applied === 0 && den(st(r, 'n'), 'protected') === 1, JSON.stringify(r));
    const never = 'System|Idle|Registry|smss|csrss|wininit|winlogon|services|lsass|lsaiso|svchost|dwm|fontdrvhost|audiodg|MsMpEng|NisSrv|MpDefenderCoreService|SecurityHealthService|SgrmBroker|Memory Compression|Secure System';
    const s0 = (ps(`Get-Process | Where-Object { $_.SessionId -eq 0 -and $_.Id -gt 4 -and $_.Name -notmatch '^(${never})$' } | Select-Object -First 1 | ForEach-Object { '' + $_.Id + ' ' + $_.Name }`) || '').split(' ');
    if (+s0[0] > 0) {
      r = await rules([{ key: 'z', match: { exe: s0.slice(1).join(' '), pids: [+s0[0]] }, set: { eco: true } }], { dryRun: true });
      const rz = await read(+s0[0]);
      t.check('session 0: a Windows service process is "system" (dry run + read only)', st(r, 'z') && den(st(r, 'z'), 'system') === 1 && rz.session === 0 && rz.access === 'system', JSON.stringify([r, rz]).slice(0, 300));
    } else t.fail('session 0: no session-0 process found to name');
    const decoyExe = path.join(run.dir, 'mpdecoy-' + run.name.slice(7) + '.exe');
    fs.copyFileSync(exe, decoyExe);
    const D = B.start(decoyExe, ['idle'], { life: 120 }); pids.add(D.pid);
    await T.sleep(600);
    const decoyName = path.basename(decoyExe, '.exe');
    r = await s.send('apppower.rules', { rules: [{ key: 'x', match: { exe: decoyName, pids: [D.pid] }, set: { eco: true } }] }, 8000);
    const rd = await read(D.pid);
    t.check('passive: a real write to anything but the burner is refused', !r.ok && r.error.indexOf(T.PASSIVE_REFUSAL) === 0 && rd.priority === 'normal' && rd.eco === null, JSON.stringify([r, rd.priority]).slice(0, 300));
    r = await s.send('apppower.rules', { rules: [{ key: 'x', match: { exe: decoyName, pids: [D.pid] }, set: { eco: true } }], dryRun: true }, 8000);
    t.check('passive: the same as a dry run is answered', st(r, 'x') && st(r, 'x').applied === 1, JSON.stringify(r));
    B.kill(D.pid);

    // ---------------------------------------------------------------- free up memory
    const W = start(['touch', '160']);
    await self(W, (i) => i.alloc === 160 && i.ws > 150 * MB, 8000);
    let tr = await s.send('apppower.trim', { match: { exe: EXE, pids: [W.pid] }, dryRun: true }, 8000);
    t.check('trim dryRun: counts, frees nothing', tr.ok && tr.result.n === 1 && tr.result.dryRun === true && tr.result.before === tr.result.after && tr.result.before > 150 * MB, JSON.stringify(tr));
    tr = await s.send('apppower.trim', { match: { exe: EXE, pids: [W.pid] } }, 8000);
    const pw = psProc(W.pid);
    t.check('trim: the working set drops (before/after summed over the matched pids)', tr.ok && tr.result.n === 1 && tr.result.before > 150 * MB && tr.result.after < tr.result.before - 100 * MB, JSON.stringify(tr));
    t.check('trim: PowerShell agrees the working set dropped', pw && pw.WorkingSet64 < 60 * MB, JSON.stringify(pw));
    console.log(`  trim: ${Math.round(tr.result.before / MB)} MB -> ${Math.round(tr.result.after / MB)} MB`);
    B.kill(W.pid);

    // ---------------------------------------------------------------- memory limit, enforced
    const M = start(['alloc', '16', '1024']);
    await self(M, () => true, 3000);
    r = await rules([rule('m', [M.pid], { memCap: 192 * MB })]);
    const im = await self(M, (i) => (i.limFlags & 0x200) !== 0, 3000);
    t.check('memory limit: the burner sees JOB_MEMORY at 192 MB in its own job', im && im.jobMem === 192 * MB && (await read(M.pid)).jobMemLimit === 192 * MB, JSON.stringify(im));
    M.send('go');
    let stop = null;
    try { stop = await M.waitLine(/^STOP /, 15000); } catch (_) { /* below */ }
    const got = stop ? +stop.split(' ')[1] : -1;
    t.check('memory limit: enforced - the allocating burner stops near the cap', stop && !/ max$/.test(stop) && got >= 96 && got <= 192, stop || 'no STOP line');
    console.log(`  memory limit 192 MB: the burner stopped at ${got} MB committed (${stop})`);
    await rules([]);
    B.kill(M.pid);

    // ---------------------------------------------------------------- a child started AFTER the rule
    const P = start(['parent']);
    await self(P, () => true, 3000);
    r = await rules([rule('c', [P.pid], { eco: true, cpuCap: 30 })]);
    t.check('child: the rule holds the parent first', st(r, 'c') && st(r, 'c').applied === 1, JSON.stringify(r));
    const childInfo = path.join(run.dir, 'child-info.json');
    P.send(`spawn idle --info ${childInfo} --life 120`);
    const line = await P.waitLine(/^CHILD \d+/, 5000).catch(() => null);
    const cpid = line ? +line.split(' ')[1] : 0;
    if (cpid) pids.add(cpid);
    const first = await until(() => B.readInfo(childInfo), 1500);
    const born = !!(first && first.cpuRate === 3000);
    const rc = await until(async () => { const x = await read(cpid); return x.eco === true ? x : null; }, 8000);
    const ic = await until(() => { const x = B.readInfo(childInfo); return x && x.cpuRate === 3000 ? x : null; }, 2500);
    t.check('child: Efficiency mode reaches a child started after the rule (the watcher)', rc && rc.eco === true && rc.priority === 'low', JSON.stringify(rc));
    t.check('child: it runs under the app\'s CPU limit (30%)', rc && rc.mantleJob === true && rc.jobCpuRate === 30 && ic && ic.cpuFlags === 5 && ic.cpuRate === 3000, JSON.stringify([rc && rc.jobCpuRate, ic]));
    console.log(`  child: ${born ? 'born inside the app\'s job (inherited at start)' : 'put in the app\'s job by the watcher (this shell\'s own job lets children break away)'}; first self-report ${JSON.stringify(first && { inJob: first.inJob, cpuRate: first.cpuRate, eco: first.thrCtl })}`);
    const ev = await s.waitEvent('apppower', 6000, (e) => (e.status || []).some((x) => x.key === 'c' && x.applied === 2)).catch(() => null);
    t.check('child: an "apppower" event says 2 processes now', !!ev, JSON.stringify(s.collect('apppower').slice(-2)));
    await rules([]);
    const rc2 = await read(cpid);
    await until(() => { const x = B.readInfo(childInfo); return x && x.cpuFlags === 0; }, 2500);
    t.check('child: removal restores the child too', rc2.eco === null && rc2.priority === 'normal' && (B.readInfo(childInfo) || {}).cpuFlags === 0, JSON.stringify(rc2));

    // ---------------------------------------------------------------- graphics preference (test registry root only)
    const fake = 'C:\\Mantle-test\\apppower\\' + run.name + '.exe', fake2 = fake.replace('.exe', '-2.exe');
    reg(['add', 'HKCU\\' + REGROOT, '/v', fake, '/t', 'REG_SZ', '/d', 'SwapEffectUpgradeEnable=1;', '/f']);
    const gp = (pref, p2, dry) => s.send('apppower.gpupref', { path: p2 || fake, pref, dryRun: dry }, 8000);
    let g = await gp('saving');
    t.check('gpupref saving: GpuPreference=1 added, the other setting kept', g.ok && regGet(fake) === 'SwapEffectUpgradeEnable=1;GpuPreference=1;', regGet(fake));
    g = await gp('performance', null, true);
    t.check('gpupref dryRun: nothing written', g.ok && g.result.dryRun === true && g.result.before === 'saving' && regGet(fake) === 'SwapEffectUpgradeEnable=1;GpuPreference=1;', regGet(fake));
    g = await gp('performance');
    t.check('gpupref performance: GpuPreference=2', g.ok && regGet(fake) === 'SwapEffectUpgradeEnable=1;GpuPreference=2;', regGet(fake));
    g = await gp('default');
    t.check('gpupref default: only GpuPreference removed', g.ok && regGet(fake) === 'SwapEffectUpgradeEnable=1;', regGet(fake));
    await gp('saving', fake2);
    const had = regGet(fake2);
    await gp('default', fake2);
    t.check('gpupref default: a value with nothing else left is deleted', had === 'GpuPreference=1;' && regGet(fake2) === null, `${had} -> ${regGet(fake2)}`);
    const real = reg(['query', 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences', '/v', fake]);
    t.check('gpupref: the real Windows key never saw the test path', real.status !== 0);

    // ---------------------------------------------------------------- a restarted sidecar reopens its jobs
    // A (2 spinning threads) is done: it would only compete with R for the CPU these checks measure
    B.kill(A.pid);
    const R = start(['spin', '2']);
    await self(R, (i) => i.rate > 0, 3000);
    async function cpuOf(pid, ms) { const a = await read(pid), t0 = Date.now(); await T.sleep(ms); const b = await read(pid); return (100 * (b.cpuMs - a.cpuMs)) / ((Date.now() - t0) * NCPU); }
    const freeR = await cpuOf(R.pid, 3000);
    r = await rules([rule('r', [R.pid], { cpuCap: 4 })]);
    let ir = await self(R, (i) => i.cpuRate === 400);
    const capped = await cpuOf(R.pid, 4000);
    t.check('restart: before, the burner runs under its 4% limit', !!ir && capped <= 5.5, capped.toFixed(1) + '% ' + JSON.stringify(R.info()));
    await s.stop();
    s = await T.startPassive();
    r = await rules([rule('r', [R.pid], { cpuCap: 15 })]);
    ir = await self(R, (i) => i.cpuRate === 1500);
    const rr = await read(R.pid);
    t.check('restart: the new sidecar reopens the SAME named job (not a new one nested under it) and sets 15%', st(r, 'r') && st(r, 'r').applied === 1 && st(r, 'r').shared === true && !!ir && rr.jobCpuRate === 15 && rr.jobExisted === true, JSON.stringify([r, rr.jobCpuRate]).slice(0, 300));
    r = await rules([rule('r', [R.pid], { eco: false, cpuCap: 0, memLow: false })]);
    ir = await self(R, (i) => i.cpuFlags === 0);
    let pr = await cpuOf(R.pid, 4000);
    t.check('restart: cap 0 lifts the old 4% limit (no stale job left above it: well over 4% again)', !!ir && pr > Math.max(2.5 * capped, capped + 4), `${pr.toFixed(1)}% (free ${freeR.toFixed(1)}%, capped ${capped.toFixed(1)}%) ${JSON.stringify(R.info())}`);
    r = await rules([rule('r', [R.pid], { cpuCap: 4 })]);
    await self(R, (i) => i.cpuRate === 400);
    await s.stop();
    s = await T.startPassive();
    r = await rules([]);   // the rule is gone while the sidecar was down: the sweep clears its job
    ir = await self(R, (i) => i.cpuFlags === 0, 3000);
    pr = await cpuOf(R.pid, 4000);
    t.check('restart: a limit whose rule is gone is cleared by the next table', !!ir && pr > Math.max(2.5 * capped, capped + 4), `${pr.toFixed(1)}% (free ${freeR.toFixed(1)}%, capped ${capped.toFixed(1)}%) ${JSON.stringify(R.info())}`);

    console.log(`  MEASURED (CPU share of the whole machine / work units a second): baseline ${mBase.pct}% / ${mBase.rate}; ` +
      `Efficiency mode ${mEco.pct}% / ${mEco.rate}; CPU limit 25% ${m25.pct}% / ${m25.rate}; CPU limit 10% ${m10.pct}% / ${m10.rate}`);
  } catch (e) {
    t.fail('the test itself threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    for (const p of pids) B.kill(p);
    if (s) { try { await s.send('apppower.rules', { rules: [] }, 4000); } catch (_) { /* gone */ } await s.stop(); }
    if (runDir) await B.cleanup(runDir);
    reg(['delete', 'HKCU\\' + REGROOT, '/f']);
    // the parent key too, when no other test left anything in it
    const left = reg(['query', 'HKCU\\Software\\Mantle-test']);
    if (left.status === 0 && !/HKEY_CURRENT_USER\\Software\\Mantle-test\\|REG_/.test(left.stdout || '')) reg(['delete', 'HKCU\\Software\\Mantle-test', '/f']);
  }
  process.exit(t.summary());
})();
