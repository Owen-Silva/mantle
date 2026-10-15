'use strict';
/*
 * sidecar/test-lane-load.js - LANE HOLDS UNDER LOAD (lane mantle-m1, 2026-10-15), against a real PASSIVE
 * sidecar exe: no Electron, nothing on screen, nothing written outside this run's own %TEMP% burners.
 *
 * The live log (10-12..10-14): the scan lane held up to 7,013 ms by gamemode.scan, the top bar's 3 s game
 * check timing out, 11 answers dropped after their caller's deadline. test-lane-latency.js proves each
 * mechanism once; THIS test puts them under load and times every hold:
 *   (a) MANY PROCESSES: --procs idle processes (ping.exe, no console) plus a churn of short-lived ones
 *       (a new pid every ~40 ms), so every read meets processes it has never seen;
 *   (b) THE CALLERS, all at once for --secs: the top bar's game check (3 s deadline, every 250 ms), the hot
 *       corner's (1.5 s, every 500 ms), game mode's detail scan (10 s, every 1 s), and a probe queued on the
 *       scan lane itself every 100 ms (how long a caller waits behind whatever holds the lane);
 *   (c) A STALLED READ part-way (a passive-only 3 s stall inside "listing the processes"; a build without
 *       the scan worker ignores it);
 *   (d) THE BOOST'S TRIM on the shared slow lane: --burners processes holding memory, trimmed in ONE call
 *       (what 4f1b5e0 sent) and split by trimCalls (what gamemode.js sends now), with a probe on the
 *       slow lane every 50 ms.
 * Every hold is counted by the sidecar itself (ping load.lanes[].held, Lanes.CountHeld); a build without
 * those counts is measured by the probes alone. Passes when no lane was held 500 ms or more by a game
 * check or a trim call, and no caller got its answer after its deadline (= the answer was never dropped).
 *
 *   node sidecar/test-lane-load.js [--exe=<sidecar>] [--procs=150] [--secs=10] [--burners=16] [--json=<file>]
 *   -> "LANE LOAD TEST: n passed, m failed" (exit 1 on any failure)
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./test-lib');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const PROCS = Math.max(0, Number(arg('procs', 150)));
const SECS = Math.max(4, Number(arg('secs', 10)));
const BURNERS = Math.max(0, Number(arg('burners', 16)));
const JSON_OUT = arg('json', '');
const GOAL_MS = 500;

const t = T.checker('LANE LOAD');
const ms = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? Math.max(...a) : 0 });
const PING_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE');
const CMD_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

const mine = [];   // every process this test started, killed by PID at the end (never by name)
function startIdle(lifeS) {
  const p = spawn(PING_EXE, ['-n', String(lifeS), '127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => {});
  p.unref();
  if (p.pid) mine.push(p.pid);
  return p;
}
function churnOne() {
  const p = spawn(CMD_EXE, ['/d', '/c', 'exit'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => {});
  p.unref();
}
function killMine() { for (const pid of mine) { try { process.kill(pid); } catch (_) { /* already gone */ } } }

(async () => {
  const out = { exe: '', procs: PROCS, secs: SECS };
  let s = null, B = null, run = null;
  const burners = [];
  try {
    s = await T.startPassive();
    out.exe = s.exe;
    const ping = async (reset) => (await s.send('ping', reset ? { resetHeld: true } : {}, 6000)).result || {};
    const p0 = await ping(true);
    const lanesOf = (p) => (p.load && p.load.lanes) || [];
    const hasHeld = lanesOf(p0).some((l) => l.held);
    // feature-table commands are not in ping's list: ask with nothing to trim
    const tq = await s.send('gamemode.trimbg', { items: [] }, 8000).catch(() => ({ ok: false, error: 'no answer' }));
    const hasTrim = !!(tq.ok || !/unknown|not a command|no such/i.test(String(tq.error || '')));
    out.build = { heldCounts: hasHeld, trimbg: hasTrim, scanLane: lanesOf(p0).some((l) => l.name === 'scan') };
    console.log(`exe: ${s.exe}\nbuild: hold counts ${hasHeld ? 'yes' : 'no (probes only)'}, trimbg ${hasTrim ? 'yes' : 'no'}`);

    // ---- (a) the load
    const base = await s.send('gamemode.scan', { procs: true, ttl: 12000 }, 15000);
    const baseCount = base.ok && base.result.procs ? base.result.procs.length : 0;
    for (let i = 0; i < PROCS; i++) startIdle(SECS + 40);
    let churned = 0;
    const churn = setInterval(() => { churnOne(); churned++; }, 40);
    await sleep(1500);
    const warm = await s.send('gamemode.scan', { procs: true, detail: true, ttl: 12000 }, 15000);
    const loadCount = warm.ok && warm.result.procs ? warm.result.procs.length : 0;
    console.log(`processes: ${baseCount} before the load, ${loadCount} with it (+${PROCS} idle, a new pid every ~40 ms)`);
    await ping(true);

    // ---- (b) + (c) the callers
    const rec = { topbar: [], corners: [], gamemode: [], probe: [] };
    const late = [], errors = [];
    let staleSeen = 0, stallFresh = null, inflight = 0;
    const call = (who, cmd, args, deadline) => {
      inflight++;
      const t0 = ms();
      return s.send(cmd, Object.assign({ ttl: deadline }, args), deadline + 20000).then((r) => {
        const wall = ms() - t0;
        rec[who].push(wall);
        if (wall > deadline) late.push(`${who} ${wall} ms > ${deadline}`);
        if (!r.ok) errors.push(`${who}: ${r.error}`);
        else if (r.result && r.result.stale) staleSeen++;
        return r;
      }, (e) => { errors.push(`${who}: ${e.message}`); }).finally(() => { inflight--; });
    };
    const end = ms() + SECS * 1000;
    const every = (n, fn) => { const h = setInterval(() => { if (ms() < end) fn(); }, n); return h; };
    const timers = [
      every(250, () => call('topbar', 'gamemode.scan', { procs: true }, 3000)),
      every(500, () => call('corners', 'gamemode.scan', { procs: true }, 1500)),
      every(1000, () => call('gamemode', 'gamemode.scan', { procs: true, detail: true }, 10000)),
      every(100, () => call('probe', 'sleep', { lane: 'scan', ms: 0 }, 3000)),
    ];
    const stallAt = setTimeout(() => {
      const t0 = ms();
      s.send('gamemode.scan', { procs: true, testStallMs: 3000, ttl: 3000 }, 25000).then((r) => { stallFresh = { wall: ms() - t0, stale: !!(r.result && r.result.stale), ok: r.ok }; }, () => {});
    }, Math.round(SECS * 300));
    while (ms() < end) await sleep(100);
    timers.forEach(clearInterval);
    clearTimeout(stallAt);
    clearInterval(churn);
    for (let i = 0; i < 300 && inflight > 0; i++) await sleep(100);
    const p1 = await ping(false);
    const scanHeld = (lanesOf(p1).find((l) => l.name === 'scan') || {}).held || null;
    out.scan = { callers: {}, late: late.length, errors: errors.length, stale: staleSeen, held: scanHeld, churned };
    for (const k of Object.keys(rec)) out.scan.callers[k] = stat(rec[k]);
    console.log('\nSCAN LANE, ' + SECS + ' s under load (wall ms per answer: n / p50 / p95 / max):');
    for (const k of Object.keys(rec)) { const v = out.scan.callers[k]; console.log(`  ${k.padEnd(9)} ${v.n} / ${v.p50} / ${v.p95} / ${v.max}`); }
    console.log(`  answers after their deadline (dropped in Mantle): ${late.length}; errors: ${errors.length}; stale answers: ${staleSeen}`);
    console.log(`  the sidecar's own count: ${scanHeld ? `${scanHeld.runs} requests, longest hold ${scanHeld.maxMs} ms (${scanHeld.maxCmd}), ${scanHeld.over500} held ${GOAL_MS} ms or more` : 'not in this build'}`);
    if (stallFresh) console.log(`  the stalled read's own caller: ${stallFresh.wall} ms, ${stallFresh.stale ? 'answered stale (last finished read)' : 'answered fresh (no stall in this build, or it waited)'}`);

    t.check('the load was real: the scan listed the extra processes', loadCount >= baseCount + PROCS * 0.8, `${baseCount} -> ${loadCount}`);
    t.check('every caller was answered', errors.length === 0, errors.slice(0, 3).join('; '));
    t.check('no answer came after its caller\'s deadline (none would be dropped)', late.length === 0, late.slice(0, 5).join('; '));
    t.check(`a caller queued on the scan lane never waited ${GOAL_MS} ms or more`, out.scan.callers.probe.max < GOAL_MS, `max ${out.scan.callers.probe.max} ms`);
    t.check(`the top bar's game check always answered in under ${GOAL_MS} ms`, out.scan.callers.topbar.max < GOAL_MS, `max ${out.scan.callers.topbar.max} ms`);
    if (scanHeld) t.check(`the sidecar's own count: no scan-lane hold of ${GOAL_MS} ms or more`, scanHeld.over500 === 0 && scanHeld.maxMs < GOAL_MS, JSON.stringify(scanHeld));
    else t.fail(`the sidecar's own count: no scan-lane hold of ${GOAL_MS} ms or more`, 'this build does not count holds (probes only)');
    t.check('the stalled read was answered from the last finished read meanwhile', !!(stallFresh && stallFresh.ok && stallFresh.stale && stallFresh.wall < GOAL_MS), JSON.stringify(stallFresh));
    killMine();

    // ---- (d) the boost's trim on the shared slow lane
    if (!hasTrim) {
      t.fail('the boost\'s trim keeps the slow lane free', 'this build has no gamemode.trimbg');
    } else if (BURNERS < 2) {
      console.log('\ntrim: skipped (--burners < 2)');
    } else {
      B = require('./apppower-burner');
      const { TRIM_CHUNK, trimCalls } = require('../lib/features/_gamemode-plan');
      run = B.runDir();
      const exe = B.build(run.dir, run.name);
      for (let i = 0; i < BURNERS; i++) burners.push(B.start(exe, ['touch', '64'], { life: 180 }));
      const t0 = ms();
      while (ms() - t0 < 30000 && !burners.every((b) => { const i = b.info(); return i && i.ws > 48 * 1048576; })) await sleep(250);
      const scan = await s.send('gamemode.scan', { procs: true, detail: true, ttl: 10000 }, 12000);
      const rows = new Map(((scan.result && scan.result.procs) || []).map((r) => [r.pid, r]));
      const item = (b) => { const r = rows.get(b.pid) || {}; return { pid: b.pid, created: r.created || '', file: r.file || path.basename(exe) }; };
      const half = Math.floor(burners.length / 2);
      const trimRound = async (label, calls) => {
        const group = [].concat(...calls);
        await ping(true);
        const waits = [];
        let stop = false;
        const probe = (async () => { while (!stop) { const a = ms(); await s.send('sleep', { lane: 'slow', ms: 0, ttl: 8000 }, 20000).catch(() => {}); waits.push(ms() - a); await sleep(50); } })();
        const a = ms();
        let trimmed = 0, freed = 0, sent = 0;
        const why = [];
        for (const part of calls) {
          const r = await s.send('gamemode.trimbg', { items: part.map((x) => item(x.b)) }, 20000);
          sent++;
          if (r.ok) { trimmed += r.result.trimmed || 0; freed += r.result.freed || 0; for (const x of r.result.results || []) if (!x.ok) why.push(x.why); } else why.push(r.error);
        }
        const wall = ms() - a;
        await sleep(120);
        stop = true; await probe;
        const held = (lanesOf(await ping(false)).find((l) => l.name === 'slow') || {}).held || null;
        const res = { items: group.length, calls: sent, wall, trimmed, freedMb: Math.round(freed / 1048576), probe: stat(waits), held, notTrimmed: [...new Set(why)].slice(0, 3) };
        console.log(`  ${label.padEnd(22)} ${group.length} processes in ${sent} call(s), ${wall} ms in all; trimmed ${trimmed} (${res.freedMb} MB); ` +
          `slow-lane longest hold ${held ? held.maxMs + ' ms (' + held.maxCmd + ')' : '?'}; a slow-lane caller waited p50 ${res.probe.p50} / max ${res.probe.max} ms` +
          (res.notTrimmed.length ? `; not trimmed: ${res.notTrimmed.join(' | ')}` : ''));
        return res;
      };
      console.log(`\nTHE BOOST'S TRIM on the slow lane (${BURNERS} processes holding 64 MB each):`);
      const withWs = (bs) => bs.map((b) => ({ b, ws: (b.info() || {}).ws || 0 }));
      out.trimOne = await trimRound('one call (4f1b5e0):', [withWs(burners.slice(0, half))]);
      out.trimChunked = await trimRound(`calls of <=${TRIM_CHUNK} (now):`, trimCalls(withWs(burners.slice(half))));
      const c = out.trimChunked;
      t.check(`chunked trim: no slow-lane hold of ${GOAL_MS} ms or more`, !!(c.held && c.held.over500 === 0 && c.held.maxMs < GOAL_MS), JSON.stringify(c.held));
      t.check(`chunked trim: a caller on the slow lane never waited ${GOAL_MS} ms or more`, c.probe.max < GOAL_MS, `max ${c.probe.max} ms`);
      t.check('chunked trim: as many processes handed memory back as in one call', c.trimmed === out.trimOne.trimmed, `${c.trimmed} vs ${out.trimOne.trimmed}`);
    }
  } catch (e) {
    t.fail('the run itself', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    killMine();
    for (const b of burners) { try { B.kill(b.pid); } catch (_) { /* gone */ } }
    if (B && run) { try { await B.cleanup(run.dir); } catch (_) { /* best effort */ } }
    if (s) await s.stop();
  }
  if (JSON_OUT) { try { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); } catch (_) { /* best effort */ } }
  process.exit(t.summary());
})();
