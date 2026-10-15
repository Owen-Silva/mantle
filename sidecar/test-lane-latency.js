'use strict';
/*
 * sidecar/test-lane-latency.js - no caller waits behind a slow read (lane mantle-lanes, 2026-10-15),
 * against a real PASSIVE sidecar exe (no Electron, nothing on screen, nothing written).
 *
 * The live log (10-12..10-14): the scan lane held up to 7,013 ms by gamemode.scan, the top bar's 3 s
 * game check timing out 9 times, the slow lane held 1.6-3.7 s by notifications 10 times, 11 answers
 * dropped after their timeout, and one "held 20,895,388 ms" across a sleep. Proved here:
 *   (a) a game check answers in well under 0.5 s while the read behind it is stalled for 3 s (a
 *       passive-only test stall inside "listing the processes"): the last finished list, marked
 *       stale with its age and the step the read is stuck on;
 *   (b) the scan lane itself is never busy for more than ~0.5 s meanwhile (ping's lane snapshot),
 *       and no "lane was held" line is written for it;
 *   (c) once the read finishes, answers are fresh again, and ONE log line names the slow step with
 *       its ms (step names and counts only: no exe name, no path, no title);
 *   (d) a read stuck past 10 s is not passed off as current: an error that names the step;
 *   (e) incremental: a steady process table opens nothing and asks Windows about almost no session;
 *       a process that starts is opened ONCE (path, start time, priority) and never again;
 *   (f) notifications run on their own lane: answered while the slow lane is held 3 s;
 *   (g) a watched notification list is served at once while the notifications thread is busy 2.5 s;
 *   (h) the held-lane line still works (now from 1 s, in awake time).
 *   node sidecar/test-lane-latency.js   -> "LANE LATENCY TEST: n passed, m failed" (exit 1 on any failure)
 */
const { spawn } = require('child_process');
const T = require('./test-lib');

const t = T.checker('LANE LATENCY');
const ms = () => Number(process.hrtime.bigint() / 1000000n);

(async () => {
  const s = await T.startPassive();
  const logs = () => s.events.filter((e) => e.ev === 'log').map((e) => String(e.message || ''));
  const timed = async (cmd, args, to) => { const t0 = ms(); const r = await s.send(cmd, args, to || 15000); return { r, wall: ms() - t0 }; };
  const lanes = async () => { const p = await s.send('ping', {}, 6000); return (p.result && p.result.load && p.result.load.lanes) || []; };
  try {
    // warm: the sidecar starts a read at start. The FIRST answer waits for it (cold: ~0.1 s here,
    // ~4 s on a CI runner) rather than failing; then one fresh answer, so the stall below lands on a
    // read of its own and not on that first one
    const w0 = await timed('gamemode.scan', { procs: true }, 12000);
    t.check('warm: the first game check after start is answered, not an error, even while the first read is cold',
      w0.r.ok && Array.isArray(w0.r.result.procs), `${w0.wall} ms ${JSON.stringify(w0.r).slice(0, 200)}`);
    let w = w0;
    for (let i = 0; i < 20 && !(w.r.ok && !w.r.result.stale); i++) { await T.sleep(250); w = await timed('gamemode.scan', { procs: true }, 3000); }
    t.check('warm: a game check answers, fresh', w.r.ok && !w.r.result.stale && Array.isArray(w.r.result.procs), JSON.stringify(w.r).slice(0, 200));
    const nProcs = w.r.ok ? w.r.result.procs.length : 0;

    // ---- (a) (b) a 3 s stall in the read
    const stall = timed('gamemode.scan', { procs: true, testStallMs: 3000 }, 15000);
    const checks = [], busy = [];
    for (let i = 0; i < 8; i++) {
      await T.sleep(250);
      checks.push(await timed('gamemode.scan', { procs: true }, 3000));
      const sc = (await lanes()).find((l) => l.name === 'scan');
      if (sc) busy.push(sc.busyMs || 0);
    }
    const first = await stall;
    t.check('a: the request that started the stalled read answers within 0.5 s', first.r.ok && first.wall < 500, `${first.wall} ms, ${JSON.stringify(first.r).slice(0, 160)}`);
    t.check('a: ... marked stale, with its age and the step it is stuck on',
      first.r.ok && first.r.result.stale === true && typeof first.r.result.ageMs === 'number' && /listing the processes/.test(first.r.result.staleWhy || ''),
      first.r.result && first.r.result.staleWhy);
    t.check('a: ... and still carries the last finished process list', first.r.ok && Array.isArray(first.r.result.procs) && first.r.result.procs.length > nProcs / 2);
    const walls = checks.map((c) => c.wall);
    t.check('a: 8 top-bar game checks during the stall all answer, each within 0.5 s (the 3 s timeout is never reached)',
      checks.every((c) => c.r.ok && c.wall < 500), walls.join(','));
    t.check('a: ... all of them stale (the read really was stalled)', checks.slice(0, 4).every((c) => c.r.ok && c.r.result.stale), checks.map((c) => c.r.result && c.r.result.stale).join(','));
    console.log('  stalled 3 s read: first answer ' + first.wall + ' ms; game checks ' + walls.join(',') + ' ms; scan lane busyMs samples ' + busy.join(','));
    t.check('b: the scan lane was never busy for more than 0.5 s', busy.length >= 6 && busy.every((b) => b < 500), busy.join(','));

    // ---- (c) the read finishes: fresh again, one slow-read line naming the step
    await T.sleep(800);
    const after = await timed('gamemode.scan', { procs: true }, 3000);
    t.check('c: after the stall, answers are fresh again', after.r.ok && !after.r.result.stale && after.wall < 500, `${after.wall} ms stale=${after.r.result && after.r.result.stale}`);
    const slow = logs().filter((l) => /^gamemode\.scan: one read took \d+ ms/.test(l));
    const sl = slow[0] || '';
    const listMs = Number((/the process list (\d+) ms/.exec(sl) || [])[1]);
    t.check('c: ONE log line for the slow read, naming the slow step with its ms', slow.length === 1 && listMs >= 2900, slow.join(' / '));
    t.check('c: ... step names and counts only (no exe name, path or title)', sl && !/\.exe|[\\/]|"/.test(sl), sl);
    t.check('b: no "scan lane was held" line', !logs().some((l) => /the scan lane was held/.test(l)), logs().filter((l) => /held/.test(l)).join(' / '));

    // ---- (d) a read stuck past 10 s is an error, not a 10 s old answer
    s.send('gamemode.scan', { procs: true, testStallMs: 11500 }, 20000).catch(() => {});
    await T.sleep(10600);
    const stuck = await timed('gamemode.scan', { procs: true }, 3000);
    t.check('d: a read stuck past 10 s is an error that names the step, answered at once',
      !stuck.r.ok && /stuck for 1\d s \(listing the processes/.test(stuck.r.error || '') && stuck.wall < 500, `${stuck.wall} ms ${stuck.r.error}`);
    await T.sleep(1500);
    const back = await timed('gamemode.scan', { procs: true }, 3000);
    t.check('d: ... and fresh again once it finishes', back.r.ok && !back.r.result.stale, JSON.stringify(back.r).slice(0, 160));
    // after a quiet 10.5 s the last answer is OLD, but one slow read then is only slow, not stuck
    await T.sleep(10500);
    const quiet = await timed('gamemode.scan', { procs: true, testStallMs: 1500 }, 3000);
    t.check('d: after a quiet spell, a slow (not stuck) read is answered stale with its age, not as an error',
      quiet.r.ok && quiet.r.result.stale === true && quiet.r.result.ageMs >= 10000 && quiet.wall < 500, `${quiet.wall} ms ${JSON.stringify(quiet.r).slice(0, 160)}`);
    await T.sleep(1600);

    // ---- (e) incremental: a steady table opens nothing; a new process is opened once
    await s.send('gamemode.scan', { procs: true, detail: true }, 3000);
    const steady = [];
    for (let i = 0; i < 4; i++) { const r = (await s.send('gamemode.scan', { procs: true, detail: true }, 3000)).result || {}; steady.push(r); await T.sleep(60); }
    t.check('e: a steady table: 4 detail scans open (almost) nothing new', steady.every((r) => typeof r.opened === 'number' && r.opened <= 5), steady.map((r) => r.opened).join(','));
    t.check('e: ... and ask Windows about almost no session', steady.every((r) => r.sessionAsks <= 5), steady.map((r) => r.sessionAsks).join(','));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { windowsHide: true, stdio: 'ignore' });
    await T.sleep(400);
    const seen = (await s.send('gamemode.scan', { procs: true, detail: true }, 3000)).result || {};
    const row = (seen.procs || []).find((p) => p.pid === child.pid);
    t.check('e: a process that started is opened (opened >= 1) and read in detail: path, start time, priority, CPU time',
      seen.opened >= 1 && row && row.path && row.created && typeof row.prio === 'string' && typeof row.cpuMs === 'number', JSON.stringify(row));
    // the priority now comes from the list's base priority, not GetPriorityClass: it must say what
    // Windows says (os.getPriority reads GetPriorityClass). A CI runner starts tests below normal.
    const PRIO = { 19: 'idle', 10: 'belownormal', 0: 'normal', [-7]: 'abovenormal', [-14]: 'high', [-20]: 'realtime' };
    let osPrio = null;
    try { osPrio = PRIO[require('os').getPriority(child.pid)]; } catch (_) { /* gone */ }
    t.check('e: ... its priority is the one Windows reports for it (GetPriorityClass)', row && osPrio && row.prio === osPrio, `${row && row.prio} vs ${osPrio}`);
    const again = (await s.send('gamemode.scan', { procs: true, detail: true }, 3000)).result || {};
    const row2 = (again.procs || []).find((p) => p.pid === child.pid);
    t.check('e: ... the next scan does not open it again, and gives the same detail', again.opened <= 5 && row2 && row2.path === row.path && row2.created === row.created, `opened ${again.opened}`);
    try { child.kill(); } catch (_) { /* gone */ }

    // ---- (f) notifications on their own lane
    t.check('f: ping lists the notif lane', (await lanes()).some((l) => l.name === 'notif'));
    // warm first: the first list of a sidecar's life starts WinRT and the shell (0.5-5 s here, on its
    // own lane); what is measured is the lane, not that one-time start
    await s.send('notifications', { op: 'list' }, 15000);
    const hold = s.send('sleep', { lane: 'slow', ms: 3000 }, 10000);
    await T.sleep(150);
    const nl = await timed('notifications', { op: 'list' }, 8000);
    t.check('f: a notification list answers while the slow lane is held 3 s', nl.r.ok && nl.wall < 1500, `${nl.wall} ms`);
    await hold;
    console.log('  notification list while the slow lane is held 3 s: ' + nl.wall + ' ms');

    // ---- (g) a watched list does not wait for the notifications thread
    const wa = await timed('notifications', { op: 'watch', on: true }, 8000);
    t.check('g: the watch turns on', wa.r.ok && wa.r.result && wa.r.result.watching === true, JSON.stringify(wa.r).slice(0, 200));
    const st = await s.send('notifications', { op: 'stall', ms: 2500 }, 3000);
    t.check('g: (test stall accepted)', st.ok && st.result && st.result.stalledMs === 2500, JSON.stringify(st));
    await T.sleep(100);
    const fast = await timed('notifications', { op: 'list' }, 8000);
    t.check('g: a watched list answers within 0.5 s while the notifications thread is busy 2.5 s', fast.r.ok && fast.wall < 500 && fast.r.result && Array.isArray(fast.r.result.toasts), `${fast.wall} ms`);
    console.log('  watched list while the notifications thread is busy 2.5 s: ' + fast.wall + ' ms');
    const fr = await timed('notifications', { op: 'list', fresh: true }, 8000);
    t.check('g: a fresh list still goes to the thread (waits for it, then answers)', fr.r.ok && fr.wall >= 1500, `${fr.wall} ms`);
    await s.send('notifications', { op: 'watch', on: false }, 8000);

    // ---- (h) the held-lane line, from 1 s
    const n0 = logs().filter((l) => /lane was held/.test(l)).length;
    await s.send('sleep', { lane: 'capture', ms: 1200 }, 6000);
    await T.sleep(150);
    const held = logs().filter((l) => /lane was held/.test(l));
    t.check('h: a 1.2 s hold writes one line (the threshold is 1 s)', held.length === n0 + 1 && /^the capture lane was held 1[12]\d\d ms by "sleep"/.test(held[held.length - 1]), held.join(' / '));
    await s.send('sleep', { lane: 'qs', ms: 600 }, 6000);
    await T.sleep(100);
    t.check('h: a 0.6 s hold writes nothing', logs().filter((l) => /lane was held/.test(l)).length === n0 + 1);
  } catch (e) {
    t.fail('the test itself threw', e.stack || e.message);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
