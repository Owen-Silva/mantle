'use strict';
/*
 * _taskmgr-perf.test.js - the pure Performance shaper (lib/features/_taskmgr-perf.js) on made-up samples
 * (lane tm-perf, 2026-10-28). No sidecar, no Electron, no real numbers.
 *
 *   node lib/features/_taskmgr-perf.test.js
 *
 * Prints one summary line, "TASKMGR PERF LIB: n passed, m failed"; exits 1 if anything failed.
 */
const P = require('./_taskmgr-perf.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + detail : '')); }
const show = (x) => JSON.stringify(x);
const last = (a) => a[a.length - 1];
const nulls = (a, n) => a.slice(0, n).every((v) => v === null);

const GB = 1024 ** 3;
function full(over) {
  const o = over || {};
  return {
    cpu: { pct: 20, kernelPct: 5, speedGHz: 2.6, perCore: o.perCore || [10, 20, 30, 40], procs: 200, threads: 3000, handles: 100000, uptimeSec: 3600 },
    mem: { total: 16 * GB, avail: 6 * GB, used: 10 * GB, committed: 12 * GB, commitLimit: 20 * GB, pagedPool: 1e8, nonPagedPool: 2e8, cached: 3 * GB,
      composition: { inUse: 9 * GB, modified: GB / 4, standby: 3 * GB, free: 3 * GB }, compressed: 5e8 },
    disks: o.disks !== undefined ? o.disks : [{ id: 'disk0', name: 'Disk 0 (C:)', activePct: 7, respMs: 0.5, readBps: 1000, writeBps: 2000, model: 'M', type: 'SSD',
      bus: 'NVMe', removable: false, capacity: 512e9, formatted: 500e9, systemDisk: true, pageFile: true, why: {} }],
    nets: o.nets !== undefined ? o.nets : [{ id: '{W}', name: 'Wi-Fi', adapter: 'Card', kind: 'Wi-Fi', sendBps: 100, recvBps: 1000, ssid: null, connType: '802.11ax',
      ipv4: '192.0.2.10', ipv6: null, signal: 80, linkBps: 1.2e9, why: { ssid: 'hidden by Windows: location is off', ipv6: 'the adapter has no IPv6 address' } }],
    totals: { disk: 7, net: 0 },
    static: o.static !== undefined ? o.static : { cpu: { name: 'CPU X', baseGHz: 1.2, sockets: 1, cores: 6, logical: 8, l1KB: 544, l2KB: 4608, l3KB: 10240, virtualization: null },
      mem: { speedMTs: 3200, slotsUsed: 2, slotsTotal: 2, formFactor: 'SODIMM', hardwareReserved: 3e8 }, why: { 'cpu.virtualization': 'could not ask' } },
    staticPending: false,
    why: o.why || {},
  };
}

// ---- history basics
{
  const h = P.makeHistory();
  check('makeHistory: cpu ring is 60 nulls', h.cpu.length === 60 && h.cpu.every((v) => v === null));
  check('makeHistory: mem/kernel rings are 60 long', h.mem.length === 60 && h.kernel.length === 60);
  check('makeHistory: no cores, no devices yet', h.cores.length === 0 && h.disks.size === 0 && h.nets.size === 0);
  check('HIST is 60', P.HIST === 60);
}

// ---- one full sample
{
  const h = P.makeHistory();
  const r = P.shape(full(), h, {});
  check('shape returns cpu, mem, disks, nets', r.cpu && r.mem && Array.isArray(r.disks) && Array.isArray(r.nets), Object.keys(r).join());
  check('cpu.hist: 60 long, 59 nulls then pct', r.cpu.hist.length === 60 && nulls(r.cpu.hist, 59) && last(r.cpu.hist) === 20, show(r.cpu.hist.slice(-3)));
  check('cpu.kernelHist ends with kernelPct', last(r.cpu.kernelHist) === 5 && r.cpu.kernelHist.length === 60);
  check('cpu.perCore: one 60-ring per logical processor', r.cpu.perCore.length === 4 && r.cpu.perCore.every((x) => x.length === 60) && last(r.cpu.perCore[2]) === 30);
  check('cpu live fields copied', r.cpu.pct === 20 && r.cpu.speedGHz === 2.6 && r.cpu.procs === 200 && r.cpu.threads === 3000 && r.cpu.handles === 100000 && r.cpu.uptimeSec === 3600);
  check('cpu static fields merged', r.cpu.name === 'CPU X' && r.cpu.baseGHz === 1.2 && r.cpu.cores === 6 && r.cpu.logical === 8 && r.cpu.l3KB === 10240);
  check('a null static field carries the static reason', r.cpu.virtualization === null && r.cpu.why.virtualization === 'could not ask', show(r.cpu.why));
  check('mem.hist = used/total %', last(r.mem.hist) === 62.5, show(last(r.mem.hist)));
  check('mem fields copied', r.mem.total === 16 * GB && r.mem.cached === 3 * GB && r.mem.compressed === 5e8 && r.mem.composition.standby === 3 * GB);
  check('mem static merged', r.mem.speedMTs === 3200 && r.mem.slotsUsed === 2 && r.mem.formFactor === 'SODIMM' && r.mem.hardwareReserved === 3e8);
  const d = r.disks[0];
  check('disk: spec fields', d.id === 'disk0' && d.name === 'Disk 0 (C:)' && d.type === 'SSD' && d.model === 'M' && d.capacity === 512e9 && d.formatted === 500e9 && d.systemDisk === true && d.pageFile === true, show(d));
  check('disk: hist/readHist/writeHist end with this sample', last(d.hist) === 7 && last(d.readHist) === 1000 && last(d.writeHist) === 2000 && d.hist.length === 60);
  const n = r.nets[0];
  check('net: sendHist/recvHist are bits per second', last(n.sendHist) === 800 && last(n.recvHist) === 8000, show([last(n.sendHist), last(n.recvHist)]));
  check('net: sendBps stays bytes per second', n.sendBps === 100 && n.recvBps === 1000);
  check('net: null ssid keeps its reason', n.ssid === null && /location/.test(n.why.ssid), show(n.why));
  check('net: fields copied', n.kind === 'Wi-Fi' && n.connType === '802.11ax' && n.signal === 80 && n.ipv4 === '192.0.2.10' && n.linkBps === 1.2e9 && n.adapter === 'Card');
  check('no reason for fields that have values', !('pct' in r.cpu.why) && !('total' in r.mem.why) && !('activePct' in d.why));
  check('listWhy empty when both lists came', r.listWhy.disks === null && r.listWhy.nets === null);
}

// ---- opts.cpuPct overrides
{
  const h = P.makeHistory();
  const r = P.shape(full({ why: { 'cpu.pct': 'baseline' } }), h, { cpuPct: 33.3 });
  check('opts.cpuPct overrides cpu.pct', r.cpu.pct === 33.3);
  check('opts.cpuPct feeds cpu.hist', last(r.cpu.hist) === 33.3);
  check('an overridden pct carries no null reason', !('pct' in r.cpu.why), show(r.cpu.why));
  const s = full(); s.cpu.pct = null;
  const r2 = P.shape(s, h, { cpuPct: 'x' });
  check('a non-number cpuPct is ignored (raw null -> null in hist)', r2.cpu.pct === null && last(r2.cpu.hist) === null && r2.cpu.hist[58] === 33.3);
}

// ---- one push per call, ring stays 60, oldest drops
{
  const h = P.makeHistory();
  for (let i = 1; i <= 70; i++) { const s = full(); s.cpu.pct = i; s.disks[0].activePct = i; P.shape(s, h, {}); }
  const r = P.shape(Object.assign(full(), {}), h, { cpuPct: 71 });
  check('cpu.hist stays 60 and drops the oldest', r.cpu.hist.length === 60 && r.cpu.hist[0] === 12 && last(r.cpu.hist) === 71, show([r.cpu.hist[0], last(r.cpu.hist)]));
  check('disk hist stays 60', r.disks[0].hist.length === 60 && r.disks[0].hist[0] === 12);
  check('perCore rings stay 60', r.cpu.perCore.every((x) => x.length === 60));
}

// ---- devices that disappear drop their history; a null list pads
{
  const h = P.makeHistory();
  const two = [{ id: 'disk0', name: 'Disk 0 (C:)', activePct: 5 }, { id: 'disk1', name: 'Disk 1 (E:)', activePct: 50 }];
  P.shape(full({ disks: two }), h, {});
  P.shape(full({ disks: two }), h, {});
  let r = P.shape(full({ disks: [two[0]] }), h, {});
  check('a disk that left is not listed', r.disks.length === 1 && r.disks[0].id === 'disk0');
  check('its history is dropped', !h.disks.has('disk1'), [...h.disks.keys()].join());
  r = P.shape(full({ disks: two }), h, {});
  const back = r.disks.find((d) => d.id === 'disk1');
  check('a disk that comes back starts empty', back && nulls(back.hist, 59) && last(back.hist) === 50, show(back && back.hist.slice(-3)));
  const kept = r.disks.find((d) => d.id === 'disk0');
  check('the disk that stayed kept its history', kept.hist.slice(-4).join() === '5,5,5,5', show(kept.hist.slice(-4)));
  r = P.shape(full({ disks: null, nets: null, why: { disks: 'Windows gave no disk counters this time' } }), h, {});
  check('a null disk list -> [] with listWhy', r.disks.length === 0 && /no disk counters/.test(r.listWhy.disks), show(r.listWhy));
  check('a null net list -> [] with a listWhy fallback', r.nets.length === 0 && typeof r.listWhy.nets === 'string');
  check('a null list keeps the histories', h.disks.has('disk0') && h.disks.has('disk1'));
  r = P.shape(full({ disks: two }), h, {});
  const d0 = r.disks.find((d) => d.id === 'disk0');
  check('the null tick is a null in the history (time stays aligned)', d0.hist.slice(-3).join() === '5,,5', show(d0.hist.slice(-3)));
}

// ---- nulls: rates on a baseline sample, static pending
{
  const h = P.makeHistory();
  const s = full({ static: null, why: { 'cpu.pct': 'baseline', 'cpu.speedGHz': 'baseline', static: 'still reading (once, on a background thread)' } });
  s.cpu.pct = null; s.cpu.speedGHz = null; s.staticPending = true;
  s.disks[0].respMs = null; s.disks[0].why = { respMs: 'baseline' };
  const r = P.shape(s, h, {});
  check('baseline: pct null with "baseline"', r.cpu.pct === null && r.cpu.why.pct === 'baseline' && last(r.cpu.hist) === null);
  check('baseline: speedGHz null with its reason', r.cpu.speedGHz === null && r.cpu.why.speedGHz === 'baseline');
  check('static pending: every static field null with the reason', r.cpu.name === null && /still reading/.test(r.cpu.why.name) && r.mem.speedMTs === null && /still reading/.test(r.mem.why.speedMTs), show([r.cpu.why.name, r.mem.why.speedMTs]));
  check('per-disk null reason carried', r.disks[0].respMs === null && r.disks[0].why.respMs === 'baseline');
  const s2 = full({ static: null }); s2.staticPending = true; s2.why = {};
  check('static pending without a sidecar reason still has one', /still reading/.test(P.shape(s2, h, {}).cpu.why.name));
}

// ---- per-core count changes, cores not asked
{
  const h = P.makeHistory();
  P.shape(full({ perCore: [1, 2] }), h, {});
  let r = P.shape(full({ perCore: [1, 2, 3, 4] }), h, {});
  check('a new processor count restarts the per-core rings', r.cpu.perCore.length === 4 && nulls(r.cpu.perCore[0], 59));
  const s = full(); s.cpu.perCore = null; s.why = { 'cpu.perCore': 'not asked (cores:false)' };
  r = P.shape(s, h, {});
  check('perCore not asked: rings kept and padded with null', r.cpu.perCore.length === 4 && last(r.cpu.perCore[0]) === null && r.cpu.perCore[0][58] === 1);
  check('perCore not asked: reason given', r.cpu.why.perCore === 'not asked (cores:false)');
}

// ---- robustness
{
  let threw = null;
  let r = null;
  try { r = P.shape(undefined, undefined, undefined); } catch (e) { threw = e; }
  check('shape(undefined) does not throw', !threw, threw && threw.message);
  check('shape(undefined) gives empty lists and null fields with reasons', r && r.disks.length === 0 && r.cpu.pct === null && typeof r.cpu.why.pct === 'string' && typeof r.mem.why.total === 'string');
  const h = P.makeHistory();
  r = P.shape(full({ disks: [{ id: 'disk0', activePct: 1 }, { id: 'disk0', activePct: 2 }, null, { name: 'no id' }] }), h, {});
  check('duplicate / null / id-less devices are skipped', r.disks.length === 1 && last(r.disks[0].hist) === 1);
  const s = full(); s.mem.total = 0;
  r = P.shape(s, h, {});
  check('a zero total gives a null mem.hist point, not Infinity', last(r.mem.hist) === null);
  const s3 = full(); s3.cpu.pct = NaN; s3.disks[0].activePct = Infinity;
  r = P.shape(s3, h, {});
  check('NaN/Infinity never reach a history', last(r.cpu.hist) === null && last(r.disks[0].hist) === null);
}

console.log(`TASKMGR PERF LIB: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);
