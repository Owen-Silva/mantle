// test-taskmgr-gpu.js - sidecar/PerfGpu.cs (`taskmgr.gpu`) against a PASSIVE sidecar (lane tm-gpu, 2026-10-28).
//
//   node sidecar/test-taskmgr-gpu.js [--exe=<Mantle.Sidecar.exe>] [--quick]     (or MANTLE_SIDECAR_EXE)
//
// READ ONLY: taskmgr.gpu only reads performance counters, DXGI, D3DKMT, SetupAPI and the registry; nothing
// is changed anywhere. typeperf -qx lists the PDH instances for the cross-check (read only). --quick skips
// the 76 s wait that proves the queries close after a minute idle. Prints counts, pids and ms only (no
// names, paths or command lines). Prints "TASKMGR GPU TEST: n passed, m failed".
'use strict';
const cp = require('child_process');
const T = require('./test-lib');

const QUICK = process.argv.includes('--quick');
const LUID = /^luid_0x[0-9A-F]{8}_0x[0-9A-F]{8}$/;
const ENGINE_TEXT = /^GPU (\d+)(?: \(Link \d+\))? - (.+)$/;
const isPct = (v) => typeof v === 'number' && v >= 0 && v <= 100;
const isBytes = (v) => typeof v === 'number' && v >= 0 && Number.isInteger(v);
const GPU_FIELDS = ['id', 'kind', 'index', 'name', 'pct', 'engines', 'dedicatedUsed', 'sharedUsed', 'dedicatedTotal', 'sharedTotal',
  'driverVersion', 'driverDate', 'directX', 'location', 'reserved', 'why'];
const NULLABLE = ['name', 'pct', 'dedicatedUsed', 'sharedUsed', 'dedicatedTotal', 'sharedTotal', 'driverVersion', 'driverDate', 'directX', 'location', 'reserved'];
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function pdhAdapterMemoryLuids() {
  try {
    const out = cp.execFileSync('typeperf', ['-qx', 'GPU Adapter Memory'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const ids = new Set();
    for (const m of out.matchAll(/\\GPU Adapter Memory\((luid_0x[0-9A-Fa-f]{8}_0x[0-9A-Fa-f]{8})_phys_\d+\)/g)) ids.add(m[1].replace(/0x([0-9a-f]{8})/gi, (x, h) => '0x' + h.toUpperCase()));
    return ids;
  } catch (e) { return null; }
}

(async () => {
  const t = T.checker('TASKMGR GPU');
  const s = await T.startPassive();
  try {
    // ---------------- cold: the first light call is a baseline
    const a = await s.call('taskmgr.gpu', {}, 20000);
    console.log(`  light first call (cold sidecar): ${a.ms} ms (engine read ${a.engMs} ms)`);
    t.check('reply shape: byPid, totals, gpus, why, ms', a && typeof a.byPid === 'object' && a.totals && 'gpu' in a.totals && 'gpus' in a && typeof a.why === 'object' && typeof a.ms === 'number', JSON.stringify(a).slice(0, 200));
    t.check('first call: totals.gpu null with a why', a.totals.gpu === null && typeof a.why['totals.gpu'] === 'string', JSON.stringify(a.why));
    t.check('first call: byPid empty with a why', Object.keys(a.byPid).length === 0 && typeof a.why.byPid === 'string');
    t.check('light: gpus null with a why', a.gpus === null && typeof a.why.gpus === 'string');
    await T.sleep(1000);

    // ---------------- light repeats, 1 s apart (the cost of one GPU Engine collection)
    const lights = [];
    for (let i = 0; i < 5; i++) { lights.push(await s.call('taskmgr.gpu', {}, 20000)); await T.sleep(1000); }
    const b = lights[lights.length - 1];
    console.log(`  light repeat: ms ${lights.map((x) => x.ms).join(' / ')}; engine read ${lights.map((x) => x.engMs).join(' / ')} ms`);
    t.check('light repeat: totals.gpu is a %', isPct(b.totals.gpu), JSON.stringify(b.totals));
    const rows = Object.entries(b.byPid);
    t.check('light repeat: some processes have a GPU context', rows.length > 0, String(rows.length));
    t.check('byPid rows: {pct 0-100, engine string|null}', rows.every(([, v]) => isPct(v.pct) && (v.engine === null || typeof v.engine === 'string')),
      JSON.stringify(rows.find(([, v]) => !isPct(v.pct) || (v.engine !== null && typeof v.engine !== 'string'))));
    t.check('byPid engine text is "GPU n - Name"', rows.every(([, v]) => v.engine === null || ENGINE_TEXT.test(v.engine)),
      JSON.stringify(rows.filter(([, v]) => v.engine !== null && !ENGINE_TEXT.test(v.engine)).slice(0, 3)));
    t.check('byPid: engine null only for 0% rows, with a why', rows.every(([, v]) => v.engine !== null || v.pct === 0) &&
      (rows.every(([, v]) => v.engine !== null) || typeof b.why['byPid.engine'] === 'string'));
    const maxPid = Math.max(0, ...rows.map(([, v]) => v.pct));
    t.check('no process is busier than the busiest adapter', maxPid <= b.totals.gpu + 0.1, `${maxPid} > ${b.totals.gpu}`);
    const snap = await s.call('taskmgr.snapshot', {}, 10000);
    const live = new Set(snap.procs.map((p) => String(p.pid)));
    const dead = rows.map(([k]) => k).filter((k) => !live.has(k));
    console.log(`  byPid: ${rows.length} processes, ${rows.filter(([, v]) => v.engine).length} busy; not in the snapshot: ${dead.length}`);
    t.check('byPid keys are live pids (<= 1 race)', rows.every(([k]) => /^\d+$/.test(k)) && dead.length <= 1, dead.join(','));

    // ---------------- full
    const f1 = await s.call('taskmgr.gpu', { full: true }, 20000);
    await T.sleep(1000);
    const f2 = await s.call('taskmgr.gpu', { full: true }, 20000);
    await T.sleep(1000);
    const f3 = await s.call('taskmgr.gpu', { full: true }, 20000);
    console.log(`  full: first ${f1.ms} ms (static facts read once), repeat ${f2.ms} / ${f3.ms} ms (engine read ${f2.engMs} / ${f3.engMs} ms)`);
    t.check('full: gpus is a non-empty array', Array.isArray(f3.gpus) && f3.gpus.length > 0, JSON.stringify(f3.why));
    const gpus = (f3.gpus || []).filter((g) => g.kind === 'gpu');
    const g = gpus[0] || {};
    t.check('full: every card has every field', (f3.gpus || []).every((x) => GPU_FIELDS.every((k) => k in x)),
      JSON.stringify((f3.gpus || []).map((x) => GPU_FIELDS.filter((k) => !(k in x)))));
    t.check('hardware adapter: name + totals', typeof g.name === 'string' && g.name.length > 0 && isBytes(g.dedicatedTotal) && isBytes(g.sharedTotal) && g.sharedTotal > 0 && g.dedicatedTotal + g.sharedTotal > 0,
      `dedicatedTotal ${g.dedicatedTotal}, sharedTotal ${g.sharedTotal}`);
    t.check('gpu indexes are 0..n-1 in order', gpus.every((x, i) => x.index === i));
    t.check('ids are PDH luid strings', (f3.gpus || []).every((x) => LUID.test(x.id)), (f3.gpus || []).map((x) => x.id).join(','));
    const pdh = pdhAdapterMemoryLuids();
    if (pdh) t.check('the hardware adapter id is a PDH GPU Adapter Memory instance', gpus.length > 0 && gpus.every((x) => pdh.has(x.id)), [...pdh].join(','));
    else t.fail('typeperf listed the GPU Adapter Memory instances');
    t.check('gpu pct is a % (not a baseline)', isPct(g.pct), JSON.stringify(g.why));
    t.check('engines: [{eng, phys, name, pct}] with a 3D engine', Array.isArray(g.engines) && g.engines.length > 0 &&
      g.engines.every((e) => typeof e.name === 'string' && e.name && isPct(e.pct) && Number.isInteger(e.eng) && Number.isInteger(e.phys)) && g.engines.some((e) => e.name === '3D'),
      JSON.stringify((g.engines || []).slice(0, 3)));
    t.check('gpu pct = its busiest engine', Math.abs(g.pct - Math.max(...(g.engines || [{ pct: -1 }]).map((e) => e.pct))) <= 0.11);
    t.check('totals.gpu = the busiest adapter', Math.abs(f3.totals.gpu - Math.max(...gpus.map((x) => x.pct))) <= 0.11, `${f3.totals.gpu} vs ${gpus.map((x) => x.pct)}`);
    t.check('memory in use: bytes', isBytes(g.dedicatedUsed) && isBytes(g.sharedUsed), `${g.dedicatedUsed} / ${g.sharedUsed}`);
    t.check('static facts: driver version, date, DirectX, location formats',
      (g.driverVersion === null || /^\d+(\.\d+){3}$/.test(g.driverVersion)) && (g.driverDate === null || /^\d{4}-\d{2}-\d{2}$/.test(g.driverDate)) &&
      (g.directX === null || /^\d+ \(FL \d+\.\d+\)$/.test(g.directX)) && (g.location === null || typeof g.location === 'string'),
      `${g.driverVersion} | ${g.driverDate} | ${g.directX} | ${g.location}`);
    console.log(`  facts present: driverVersion ${g.driverVersion !== null}, driverDate ${g.driverDate !== null}, directX ${g.directX !== null}, location ${g.location !== null}, reserved ${g.reserved !== null}; engines ${(g.engines || []).length}`);
    t.check('every null card field has a why', (f3.gpus || []).every((x) => NULLABLE.every((k) => x[k] !== null || (x.why && typeof x.why[k] === 'string'))),
      JSON.stringify((f3.gpus || []).map((x) => NULLABLE.filter((k) => x[k] === null && !(x.why && x.why[k])))));
    t.check('static facts are cached (same on every full call)', ['name', 'dedicatedTotal', 'sharedTotal', 'driverVersion', 'driverDate', 'directX', 'location']
      .every((k) => f2.gpus && f3.gpus && JSON.stringify(f2.gpus.map((x) => x[k])) === JSON.stringify(f3.gpus.map((x) => x[k]))));
    const names = new Map(gpus.map((x) => [x.index, new Set(x.engines.map((e) => e.name))]));
    const fr = Object.values(f3.byPid).filter((v) => v.engine);
    t.check('engine text names a real adapter + engine', fr.every((v) => { const m = ENGINE_TEXT.exec(v.engine); return m && names.has(+m[1]) && names.get(+m[1]).has(m[2]); }),
      JSON.stringify(fr.slice(0, 3)));

    // ---------------- reuseMs: the cadence knob
    const r1 = await s.call('taskmgr.gpu', { full: true, reuseMs: 5000 }, 20000);
    const r2 = await s.call('taskmgr.gpu', { reuseMs: 5000 }, 20000);
    t.check('reuseMs: a young reply is repeated with its age', r1.repeated === true && r1.ageMs >= 0 && r1.ageMs < 5000 && JSON.stringify(r1.byPid) === JSON.stringify(f3.byPid) && Array.isArray(r1.gpus), `${r1.repeated} ${r1.ageMs}`);
    t.check('reuseMs: a light repeat of a full read has no gpus', r2.repeated === true && r2.gpus === null && typeof r2.why.gpus === 'string');
    console.log(`  reuse: ${r1.ms} / ${r2.ms} ms`);

    // ---------------- a gap > 6 s makes the next reading a baseline
    await T.sleep(6500);
    const gap = await s.call('taskmgr.gpu', { full: true }, 20000);
    t.check('after a 6.5 s gap: % null with a why', gap.totals.gpu === null && /6 s/.test(gap.why['totals.gpu'] || '') && gap.gpus && gap.gpus.every((x) => x.pct === null && x.why.pct && x.engines.every((e) => e.pct === null)),
      JSON.stringify(gap.why));
    t.check('after a gap: memory still reads (it is not a rate)', gap.gpus && isBytes(gap.gpus[0].sharedUsed));
    await T.sleep(1000);
    const after = await s.call('taskmgr.gpu', {}, 20000);
    t.check('1 s later: % back', isPct(after.totals.gpu), JSON.stringify(after.why));

    // ---------------- the queries close after a minute without a call
    if (!QUICK) {
      await T.sleep(76000);
      const idle = await s.call('taskmgr.gpu', {}, 20000);
      t.check('after 76 s idle: the queries were closed (first reading again)', idle.totals.gpu === null && /first reading/.test(idle.why['totals.gpu'] || ''), JSON.stringify(idle.why));
      console.log(`  reopen after idle close: ${idle.ms} ms (engine read ${idle.engMs} ms)`);
    } else console.log('  --quick: idle close not checked');

    // ---------------- cost budget (light repeat is the per-tick price on Processes)
    const lightMs = med(lights.map((x) => x.ms)), fullMs = Math.min(f2.ms, f3.ms);
    console.log(`  cost: light repeat median ${lightMs} ms, full repeat min ${fullMs} ms`);
    t.check('cost: light repeat median under 30 ms', lightMs < 30, `${lightMs} ms`);
    t.check('cost: full repeat under 50 ms', fullMs < 50, `${fullMs} ms`);
  } catch (e) {
    t.check('no exception', false, e.stack);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
