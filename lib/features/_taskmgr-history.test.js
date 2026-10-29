'use strict';
/* node lib/features/_taskmgr-history.test.js - Mantle's own App history record (lane tm-data, 10-28). Pure: temp files only. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_taskmgr-history.js');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(name + (detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`)); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-tm-history-'));
const file = path.join(dir, 'taskmgr-history.json');
let t = Date.UTC(2026, 9, 28, 12, 0, 0);
const now = () => t;
const ft = (ms) => String((ms + 11644473600000) * 10000);   // ms since 1970 -> FILETIME decimal
const SEC = 1e7;                                            // 100 ns units per second
const T0 = t - 3600e3;
const proc = (pid, file2, cpuSec, o) => Object.assign({ pid, created: ft(T0), session: 1, file: file2, path: `C:\\Apps\\${file2}`, desc: null, cpu: cpuSec * SEC, windows: 0 }, o || {});

try {
  const h = H.create({ file, now });
  check('a new record starts empty, source mantle, since now', h.model({}).rows.length === 0 && h.model({}).source === 'mantle' && h.model({}).since === new Date(t).toISOString() && h.model({}).error === null);
  // first record: the baseline (what ran before Mantle saw it is not counted)
  h.record({ procs: [proc(100, 'chrome.exe', 50, { windows: 2 }), proc(200, 'svc.exe', 10), proc(4, 'System', 999, { session: 0 })] });
  check('the first record only sets the baseline', h.model({ allProcesses: true }).rows.length === 0);
  t += 60e3;
  const newer = proc(300, 'notepad.exe', 3, { created: ft(t - 10e3), windows: 1 });
  h.record({ procs: [proc(100, 'chrome.exe', 62, { windows: 2 }), proc(200, 'svc.exe', 10.5), proc(4, 'System', 1200, { session: 0 }), newer] });
  let m = h.model({});
  const chrome = m.rows.find((r) => /chrome/.test(r.identity));
  check('a process seen twice adds the difference (seconds)', chrome && chrome.cpuTimeSec === 12, m.rows);
  check('a process started since the last record adds all of its CPU time', m.rows.some((r) => /notepad/.test(r.identity) && r.cpuTimeSec === 3), m.rows);
  check('by default only apps (a window at least once)', m.rows.length === 2 && !m.rows.some((r) => /svc/.test(r.identity)), m.rows.map((r) => r.identity));
  check('allProcesses adds the rest; session 0 never counted', h.model({ allProcesses: true }).rows.length === 3 && !h.model({ allProcesses: true }).rows.some((r) => /System/.test(r.identity)));
  check('heaviest first', m.rows[0].cpuTimeSec >= m.rows[1].cpuTimeSec);
  check('network / tiles fields are null with a reason', ['net', 'metered', 'tiles', 'nonMetered', 'downloads', 'uploads'].every((k) => chrome[k] === null) && /administrator/.test(chrome.why.net) && /tile/.test(chrome.why.tiles) && /administrator access/.test(m.note));
  // a pid reused by another process (different created) is a new process, never a negative or a carry-over
  t += 60e3;
  h.record({ procs: [proc(100, 'chrome.exe', 1, { created: ft(t - 5e3), windows: 2 })] });
  check('a reused pid with a new creation time counts as a new process', h.model({}).rows.find((r) => /chrome/.test(r.identity)).cpuTimeSec === 13);
  // persisted and reloaded
  const h2 = H.create({ file, now });
  check('the record survives a restart', h2.model({}).rows.find((r) => /chrome/.test(r.identity)).cpuTimeSec === 13 && h2.since === h.since);
  // Delete usage history
  t += 60e3;
  h2.clear();
  check('clear empties it and restarts since', h2.model({ allProcesses: true }).rows.length === 0 && h2.model({}).since === new Date(t).toISOString());
  t += 60e3;
  h2.record({ procs: [proc(100, 'chrome.exe', 4, { created: ft(t - 125e3), windows: 2 })] });
  check('after clear, a running process counts only from then', h2.model({}).rows[0].cpuTimeSec === 3, h2.model({}).rows);
  // a damaged file starts again and says so
  fs.writeFileSync(file, '{"v":1,"since":"evil"');
  const h3 = H.create({ file, now });
  check('a damaged file starts again from now and says so', h3.model({}).rows.length === 0 && /damaged/.test(h3.model({}).error));
  // injected junk is dropped on load
  fs.writeFileSync(file, JSON.stringify({ v: 1, since: t - 1000, lastAt: t - 1000, apps: { a: { name: 'A', cpuSec: -5 }, b: { name: 'B', cpuSec: 2, app: true }, c: 'x' }, seen: { 'bad key': 3, '7|8': 9 } }));
  const h4 = H.create({ file, now });
  check('only well-formed entries load', h4.model({ allProcesses: true }).rows.length === 1 && h4.model({}).rows[0].name === 'B');
  check('createdMs converts FILETIME', H.createdMs(ft(1000)) === 1000 && H.createdMs('x') === null);
} catch (e) { check('no exception', false, e.stack); }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
for (const f of failures) console.log('  FAIL ' + f);
console.log(`TASKMGR HISTORY: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
