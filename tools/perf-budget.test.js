'use strict';
/*
 * tools/perf-budget.test.js - the budget gate's own logic, plain node, no Electron (the gate itself is the
 * Electron run: `node tools/perf-budget.js`, opt-in in tools/run-suite.js as perf:budget).
 * Prints "PERF-BUDGET TEST: N passed, M failed".
 */
const fs = require('fs');
const path = require('path');
const P = require('./perf-budget');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? ': ' + detail : ''}`); }
}

// ---- quantile / stats (nearest rank, as speed-work/measure.js)
check('quantile p50 of 1..10', P.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5) === 6, P.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5));
check('quantile p95 of 1..10 is the max', P.quantile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 0.95) === 10);
check('quantile skips null and NaN', P.quantile([null, 5, NaN, 7], 0.5) === 7);
check('quantile of nothing is null', P.quantile([], 0.5) === null);
const st = P.stats([30, null, 40, 50]);
check('stats counts numbers only', st.n === 3 && st.max === 50, JSON.stringify(st));

// ---- budgets: slack scales the time budgets only
const b1 = P.budgets(1), b15 = P.budgets(1.5);
check('slack 1: warm p95 100', b1.warmPaintedP95 === 100);
check('slack 1.5: warm p50 75, p95 150, interactive 225, cold p95 600', b15.warmPaintedP50 === 75 && b15.warmPaintedP95 === 150 && b15.warmInteractiveP95 === 225 && b15.coldPaintedP95 === 600, JSON.stringify(b15));
check('slack never scales the 1 s ceiling', b15.coldCeiling === 1000 && P.budgets(3).coldCeiling === 1000);
check('slack never scales RAM', b15.totalPrivateMB === b1.totalPrivateMB && b15.keptHiddenPrivateMB === 45 && b15.openPrivateMB === 80);
check('bad slack falls back to 1', P.budgets('x').warmPaintedP95 === 100 && P.budgets(-2).warmPaintedP95 === 100);

// ---- the R7 line
const l1 = P.parseOpenLine('mantle: settings: opened (cold) via Win+I: shown 120, painted 180, interactive 240 ms');
check('R7 parses with the mantle prefix', l1 && l1.surface === 'settings' && l1.kind === 'cold' && l1.via === 'Win+I' && l1.shown === 120 && l1.painted === 180 && l1.interactive === 240, JSON.stringify(l1));
const l2 = P.parseOpenLine('files: opened (warm) via the bar pin: shown 12 ms, painted 30 ms, interactive 41.5 ms');
check('R7 parses "ms" after each number and decimals', l2 && l2.surface === 'files' && l2.kind === 'warm' && l2.via === 'the bar pin' && l2.interactive === 41.5, JSON.stringify(l2));
const l3 = P.parseOpenLine('mantle: taskmgr: opened (warm): shown -, painted 20, interactive 35 ms');
check('R7 without "via" and a "-" (not shown in --test)', l3 && l3.via === null && l3.shown === null && l3.painted === 20, JSON.stringify(l3));
check('the old Files label is NOT an R7 line', P.parseOpenLine('mantle: files: open #2 (warm): shown 40 ms, page asked 3 ms, first view 90 ms') === null);
check('Settings\' current line is NOT an R7 line', P.parseOpenLine('mantle: settings: opened by Win+I at home (new window) (test: not shown)') === null);
check('a line with no numbers is not an R7 line', P.parseOpenLine('mantle: notes: opened (warm) via Win+Alt+N: ok') === null);

// ---- judging
const B = P.budgets(1);
const warmR7 = Array.from({ length: 10 }, (_, i) => ({ created: false, painted: 999, r7: { kind: 'warm', painted: 20 + i, interactive: 60 } }));
const jw = P.judgeOpens('warm', warmR7, B);
check('R7 is the source when the lines are there (probe numbers ignored)', jw.source === 'r7' && !jw.noinstr && jw.status === 'pass', JSON.stringify(jw.checks));
const slowWarm = warmR7.map((s, i) => Object.assign({}, s, { r7: { kind: 'warm', painted: i === 9 ? 160 : 30, interactive: 60 } }));
const jsw = P.judgeOpens('warm', slowWarm, B);
check('a warm p95 over 100 fails', jsw.status === 'fail' && jsw.checks.some((c) => c.what === 'painted p95' && !c.ok), JSON.stringify(jsw.checks));
const lying = warmR7.map((s) => Object.assign({}, s, { created: true }));
check('a "warm" R7 line on a NEW window fails (R7 must be truthful)', P.judgeOpens('warm', lying, B).checks.some((c) => !c.ok && /new window was made/.test(c.what)));
const probeOnly = Array.from({ length: 10 }, () => ({ created: true, painted: 300, r7: null }));
const jp = P.judgeOpens('cold', probeOnly, B);
check('no R7 lines: "not instrumented yet", judged on the probe', jp.source === 'probe' && jp.noinstr && jp.status === 'pass' && jp.painted.p95 === 300, JSON.stringify(jp));
const ceil = probeOnly.map((s, i) => Object.assign({}, s, { painted: i === 0 ? 1200 : 200 }));
const jc = P.judgeOpens('cold', ceil, B);
check('one cold open past 1 s fails the ceiling even with p95 inside', jc.checks.some((c) => c.what === 'painted max' && !c.ok), JSON.stringify(jc.checks));
check('the ceiling is still 1 s at slack 3', P.judgeOpens('cold', ceil, P.budgets(3)).status === 'fail');
const coldInter = Array.from({ length: 10 }, () => ({ created: true, painted: 200, r7: { kind: 'cold', painted: 200, interactive: 1100 } }));
check('a cold open usable after 1 s fails', P.judgeOpens('cold', coldInter, B).checks.some((c) => c.what === 'interactive max' && !c.ok));
const nothing = Array.from({ length: 5 }, () => ({ created: false, painted: null, r7: null }));
check('no numbers at all is "no data", not a pass', P.judgeOpens('warm', nothing, B).status === 'nodata');
const refused = Array.from({ length: 3 }, () => ({ created: false, painted: null, r7: null, refused: 'mantle: Win+I from a second instance: {"ok":false}' }));
check('a surface that never opened fails', P.judgeOpens('warm', refused, B).status === 'fail');

// ---- CPU from two metric snapshots
const pct = P.cpuPct({ at: 0, procs: [{ pid: 1, cpuSec: 1.0 }, { pid: 2, cpuSec: null }] }, { at: 10000, procs: [{ pid: 1, cpuSec: 1.01 }, { pid: 2, cpuSec: 3 }, { pid: 3, cpuSec: 1 }] });
check('cpu % of a core over 10 s', pct[1] === 0.1 && !(2 in pct) && !(3 in pct), JSON.stringify(pct));

// ---- the summary line: one line, and run-suite's verdict regex reads it
const r = { checks: [{ scope: 'settings cold', what: 'painted p95', value: 700, limit: 600, ok: false }, { scope: 'x', what: 'y', value: 1, limit: 2, ok: true }],
  noinstr: ['settings cold', 'files warm'], nodata: [], slack: 1.5, n: 10, cpuBefore: 21.5 };
const line = P.summaryLine(r);
check('summary is one line', !/\n/.test(line), line);
const SUM_RE = /(\d+)\s+passed[,;]?\s+(\d+)\s+failed/i;
const m = SUM_RE.exec(line);
check('run-suite reads "1 passed, 1 failed"', m && m[1] === '1' && m[2] === '1', line);
check('summary names what broke', /settings cold painted p95 700 > 600/.test(line), line);
check('summary says what is not instrumented when nothing broke', /not instrumented: settings cold, files warm/.test(P.summaryLine(Object.assign({}, r, { checks: [r.checks[1]] }))));

// ---- the browser lock: an exclusive JSON file; a live holder blocks, a dead pid's lock is taken over
const os = require('os');
const lf = path.join(os.tmpdir(), `perf-budget-test-lock-${process.pid}.lock`);
try { fs.rmSync(lf, { force: true }); } catch (_) { /* fresh */ }
check('lock: free -> taken', P.takeFileLock(lf, 'test') === true);
const held = JSON.parse(fs.readFileSync(lf, 'utf8'));
check('lock: holds {pid,time,label}', held.pid === process.pid && typeof held.time === 'number' && held.label === 'test', JSON.stringify(held));
check('lock: held by a live pid -> not taken', P.takeFileLock(lf, 'again') === false);
P.dropFileLock(lf);
check('lock: dropped by its owner', !fs.existsSync(lf));
fs.writeFileSync(lf, JSON.stringify({ pid: 4000000, time: 1, label: 'gone' }));
check('lock: a dead pid\'s lock is taken over', P.takeFileLock(lf, 'test') === true && JSON.parse(fs.readFileSync(lf, 'utf8')).pid === process.pid);
fs.writeFileSync(lf, JSON.stringify({ pid: process.ppid || 4, time: 1, label: 'someone' }));
P.dropFileLock(lf);
check('lock: never drops someone else\'s', fs.existsSync(lf));
try { fs.rmSync(lf, { force: true }); } catch (_) { /* done */ }

// ---- arguments
const a = P.parseArgs(['--n=5', '--slack=2', '--surfaces=settings,Files', '--no-lock', '--strict']);
check('args', a.n === 5 && a.slack === 2 && a.only.join() === 'settings,files' && a.lock === false && a.strict === true && a.rerun === true, JSON.stringify(a));
const d = P.parseArgs([]);
check('defaults: n 10, slack 1.5, locks on', d.n === 10 && d.slack === 1.5 && d.lock === true && d.strict === false, JSON.stringify(d));

// ---- the surfaces table: every chord is one main.js routes, every cold surface is a no-preload one
const features = fs.readFileSync(path.join(__dirname, '..', 'lib', 'features.js'), 'utf8');
for (const s of P.SURFACES) {
  if (s.trigger.chord) check(`${s.name}: ${s.trigger.chord} is a chord lib/features.js knows`, features.includes(`'${s.trigger.chord}'`));
  check(`${s.name}: its page exists (${s.match})`, fs.existsSync(path.join(__dirname, '..', s.match.replace(/^\/|\/$/g, ''))));
}
check('settings, taskmgr, files are the no-preload surfaces', P.SURFACES.filter((s) => s.noPreload).map((s) => s.name).join() === 'settings,taskmgr,files');

// ---- the gate is opt-in in run-suite (never in a plain suite run)
const suite = fs.readFileSync(path.join(__dirname, 'run-suite.js'), 'utf8');
check('run-suite registers perf:budget', /perf:budget/.test(suite) && /tools[\\/'", ]+perf-budget\.js|'perf-budget\.js'/.test(suite));
check('run-suite keeps it opt-in', /optIn/.test(suite));

console.log(`PERF-BUDGET TEST: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
