'use strict';
/*
 * _taskmgr-model.test.js - the pure TM-SPEC shaping (_taskmgr-model.js) and the admin seam
 * (_taskmgr-admin.js). Plain node, fake data, nothing runs:
 *   node lib/features/_taskmgr-model.test.js     -> "TASKMGR MODEL: n passed, m failed"
 */
const M = require('./_taskmgr-model.js');
const A = require('./_taskmgr-admin.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); }

const P = (pid, o) => Object.assign({ pid, ppid: 1, file: `p${pid}.exe`, created: String(100 + pid), pws: 1048576, cpu: 0, session: 1, io: 0, path: `C:/x/p${pid}.exe` }, o || {});

function views() {
  check('normView: apps is processes', M.normView('apps') === 'processes');
  check('normView: every spec page passes', ['processes', 'performance', 'apphistory', 'startup', 'users', 'details', 'services', 'settings', 'game'].every((v) => M.normView(v) === v));
  check('normView: unknown / missing is processes', M.normView('x') === 'processes' && M.normView(undefined) === 'processes' && M.normView('__proto__') === 'processes');
}

function settings() {
  check('settings: defaults', JSON.stringify(M.settingsOf(null)) === JSON.stringify(M.DEFAULTS));
  check('settings: bad saved values fall back, unknown keys dropped', (() => { const s = M.settingsOf({ updateSpeed: 'warp', theme: 'dark', evil: 1, alwaysOnTop: 'yes' }); return s.updateSpeed === 'normal' && s.theme === 'dark' && !('evil' in s) && s.alwaysOnTop === false; })());
  check('validate: __proto__ refused', M.validateSetting('__proto__', {}).ok === false);
  check('validate: bool keys need booleans', M.validateSetting('alwaysOnTop', true).ok && !M.validateSetting('alwaysOnTop', 1).ok);
  check('validate: updateSpeed values', ['high', 'normal', 'low', 'paused'].every((v) => M.validateSetting('updateSpeed', v).ok) && !M.validateSetting('updateSpeed', 'fast').ok);
  check('validate: startPage is a page but not settings', M.validateSetting('startPage', 'performance').ok && !M.validateSetting('startPage', 'settings').ok && !M.validateSetting('startPage', 'nope').ok);
  check('validate: theme', M.validateSetting('theme', 'light').ok && !M.validateSetting('theme', 'blue').ok);
  check('tickMs: high/normal/low in front', M.tickMs({ updateSpeed: 'high' }, true, 3000) === 500 && M.tickMs({ updateSpeed: 'normal' }, true, 3000) === 1000 && M.tickMs({ updateSpeed: 'low' }, true, 3000) === 4000);
  check('tickMs: behind other windows never faster than behindMs', M.tickMs({ updateSpeed: 'high' }, false, 3000) === 3000 && M.tickMs({ updateSpeed: 'low' }, false, 3000) === 4000);
  check('tickMs: paused = 0 (no sampling)', M.tickMs({ updateSpeed: 'paused' }, true, 3000) === 0);
}

function rates() {
  const a = { t: 1000, procs: [P(10, { io: 1000 }), P(11, { io: 50 }), P(12, { io: 900 })] };
  const b = { t: 3000, procs: [P(10, { io: 5000 }), P(11, { io: 10, created: '999' }), P(12, { io: 100 }), P(13, { io: 7 })] };
  const r = M.ioRates(a, b);
  check('ioRates: bytes per second', r.get('10|110') === 2000, [...r]);
  check('ioRates: a reused pid (new created) has no rate yet', !r.has('11|999'));
  check('ioRates: a counter that went down is skipped, never negative', !r.has('12|112'));
  check('ioRates: a new process has no rate yet', !r.has('13|113'));
  check('ioRates: first sample / clock not moving -> empty', M.ioRates(null, b).size === 0 && M.ioRates(b, b).size === 0);
}

function rows() {
  const snap = { t: 1, procs: [P(20, { suspended: true }), P(21, { suspended: true }), P(30), P(31, { suspended: true })] };
  const io = new Map([['20|120', 100], ['21|121', 50], ['30|130', 7]]);
  const gpu = { byPid: { 20: { pct: 30, engine: 'GPU 0 - 3D' }, 21: { pct: 80, engine: 'GPU 0 - Video Decode' } } };
  const extra = new Map([['30|130', { publisher: 'Contoso', cmdline: '"C:/x/p30.exe" -a', efficiency: true }]]);
  const g1 = { root: 20, created: '120', kind: 'app', file: 'p20.exe', hung: false, procs: [{ pid: 20, created: '120' }, { pid: 21, created: '121' }] };
  const g2 = { root: 30, created: '130', kind: 'background', file: 'p30.exe', hung: false, procs: [{ pid: 30, created: '130' }, { pid: 31, created: '131' }] };
  const g3 = { root: 30, created: '130', kind: 'app', file: 'p30.exe', hung: true, procs: [{ pid: 30, created: '130' }] };
  const r1 = M.rowExtras(g1, { snap, io, gpu, extra });
  check('rowExtras: disk = sum of the group\'s rates', r1.disk === 150, r1.disk);
  check('rowExtras: gpu summed and capped at 100, engine of the busiest member', r1.gpu === 100 && r1.gpuEngine === 'GPU 0 - Video Decode', r1);
  check('rowExtras: every member suspended -> Suspended', r1.suspended === true && r1.status === 'Suspended');
  check('rowExtras: net is null with a reason (per-app network needs admin ETW)', r1.net === null && /administrator/.test(r1.why.net));
  check('rowExtras: pid / processName / type', r1.pid === 20 && r1.processName === 'p20.exe' && r1.type === 'app');
  const r2 = M.rowExtras(g2, { snap, io, gpu, extra });
  check('rowExtras: one running member -> not suspended; efficiency from procextra', r2.suspended === false && r2.efficiency === true && r2.status === 'Efficiency mode' && r2.publisher === 'Contoso' && /-a/.test(r2.cmdline));
  check('rowExtras: hung wins over everything', M.rowExtras(g3, { snap, io, gpu, extra }).status === 'Not responding');
  const r4 = M.rowExtras(g1, { snap, io: new Map(), gpu: null, extra: null });
  check('rowExtras: no rates yet / no gpu read -> null with reasons', r4.disk === null && r4.gpu === null && r4.why.disk && r4.why.gpu && r4.publisher === null && r4.power === null && r4.why.power);
  check('rowExtras: a member that exited is skipped', M.rowExtras({ root: 99, created: '1', kind: 'app', procs: [{ pid: 99, created: '1' }] }, { snap, io }).disk === 0);
}

function totalsAndUsers() {
  const t = M.totals({ cpu: 12.345, mem: { total: 200, used: 50 }, disk: 130, net: null, gpu: -4 });
  check('totals: rounded, clamped, null kept', t.cpu === 12.3 && t.mem === 25 && t.disk === 100 && t.net === null && t.gpu === 0, t);
  check('totals: nothing known -> nulls', JSON.stringify(M.totals({})) === JSON.stringify({ cpu: null, mem: null, disk: null, net: null, gpu: null }));
  const snap = { procs: [P(40, { session: 1, pws: 100 }), P(41, { session: 1, pws: 50 }), P(42, { session: 2, pws: 7 })] };
  const cpu = new Map([['40|140', 10], ['41|141', 5.55], ['42|142', 1]]);
  const io = new Map([['40|140', 1000]]);
  const u = M.usersRows([{ session: 1, user: 'owen', domain: 'PC', fullName: 'Owen', status: 'Active' }, { session: 2, user: 'guest', status: 'Disconnected' }], snap, cpu, io, false);
  check('usersRows: per-session sums', u[0].mem === 150 && u[0].cpu === 15.6 && u[0].disk === 1000 && u[0].procs.length === 2 && u[1].mem === 7, u);
  check('usersRows: network null; full account name on request', u[0].net === null && M.usersRows([{ session: 1, user: 'owen', domain: 'PC' }], snap, cpu, io, true)[0].user === 'PC\\owen');
}

function startup() {
  const items = [
    { item: 'run|A', name: 'A', command: '"C:/a/a.exe" -min', enabled: true, sourceLabel: 'Registry', disabledAt: null, canToggle: true },
    { item: 'run|B', name: 'B', command: 'b.exe', enabled: false, sourceLabel: 'Startup folder', disabledAt: '2026-10-01', canToggle: false, reason: 'needs administrator' },
  ];
  const meta = { rows: [{ command: '"C:/a/a.exe" -min', path: 'C:/a/a.exe', publisher: 'Acme' }] };
  const r = M.startupRows(items, meta, new Set(['c:/a/a.exe']));
  check('startupRows: publisher/path from startupmeta, running now from the snapshot', r[0].publisher === 'Acme' && r[0].path === 'C:/a/a.exe' && r[0].running === true && r[0].enabled === true, r[0]);
  check('startupRows: no meta -> nulls, impact null, disabled time kept', r[1].publisher === null && r[1].impact === null && r[1].running === false && r[1].disabledAt === '2026-10-01' && r[1].canToggle === false);
  check('runningPaths: lower-cased paths', M.runningPaths({ procs: [P(1, { path: 'C:/A/B.exe' }), P(2, { path: null })] }).has('c:/a/b.exe'));
}

async function admin() {
  const ctx = (ans) => ({ sidecar: { send: async () => ans } });
  A.setElevated(null);
  let r = await A.call(ctx({ ok: true, result: { ok: true, x: 1 } }), 'v', {});
  check('admin: a plain success', r.ok && r.result.x === 1 && r.via === 'sidecar' && !r.needsAdmin);
  r = await A.call(ctx({ ok: true, result: { ok: false, reason: 'needs administrator: open Services', needsAdmin: true } }), 'v', {});
  check('admin: needsAdmin with no elevated path -> ok false + reason', r.ok === false && r.needsAdmin === true && /administrator/.test(r.reason));
  r = await A.call(ctx({ ok: false, error: 'Access is denied' }), 'v', {});
  check('admin: access denied words become needsAdmin', r.needsAdmin === true && /needs administrator/.test(r.reason));
  r = await A.call({ sidecar: { send: async () => { throw new Error('timed out'); } } }, 'v', {});
  check('admin: a throw is a plain failure, not needsAdmin', r.ok === false && !r.needsAdmin && /timed out/.test(r.reason));
  const asked = [];
  A.setElevated({ run: async (op, args) => { asked.push(op); return { ok: true, result: { ok: true, via2: args.n } }; } });
  r = await A.call(ctx({ ok: true, result: { ok: false, needsAdmin: true, reason: 'x' } }), 'taskmgr.service', { n: 7 });
  check('admin: with an elevated runner the denied call is retried through it', r.ok && r.via === 'elevated' && r.result.via2 === 7 && asked[0] === 'taskmgr.service');
  r = await A.call(ctx({ ok: true, result: { ok: false, needsAdmin: true, reason: 'x' } }), 'v', {}, { retry: false });
  check('admin: retry:false never goes to the elevated runner', r.via === 'sidecar' && asked.length === 1);
  A.setElevated({ run: async () => { throw new Error('helper gone'); } });
  r = await A.call(ctx({ ok: true, result: { ok: false, needsAdmin: true } }), 'v', {});
  check('admin: a failing elevated runner says so', r.ok === false && /administrator helper failed/.test(r.reason));
  A.setElevated(null);
  check('admin: hasElevated follows setElevated', A.hasElevated() === false);
  check('admin: dryRun is passed up', (await A.call(ctx({ ok: true, result: { ok: true, dryRun: true } }), 'v', {})).dryRun === true);
}

(async () => {
  for (const f of [views, settings, rates, rows, totalsAndUsers, startup]) { try { f(); } catch (e) { check(`no exception (${f.name})`, false, e.stack); } }
  try { await admin(); } catch (e) { check('no exception (admin)', false, e.stack); }
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`TASKMGR MODEL: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
