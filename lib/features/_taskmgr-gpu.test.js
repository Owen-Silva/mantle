'use strict';
/*
 * _taskmgr-gpu.test.js - lib/features/_taskmgr-gpu.js in plain node: no Electron, no sidecar (lane tm-gpu,
 * 2026-10-28). Prints "TASKMGR GPU JS TEST: n passed, m failed".
 *
 *   node lib/features/_taskmgr-gpu.test.js
 */
const G = require('./_taskmgr-gpu.js');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${detail})` : name); };

const SPEC = ['id', 'name', 'pct', 'engines', 'dedicatedUsed', 'dedicatedTotal', 'sharedUsed', 'sharedTotal', 'dedHist', 'sharedHist',
  'driverVersion', 'driverDate', 'directX', 'location', 'reserved'];
const ID0 = 'luid_0x00000000_0x00010E7D', ID1 = 'luid_0x00000000_0x00020001';

const card = (o) => Object.assign({
  id: ID0, kind: 'gpu', index: 0, name: 'Intel(R) UHD Graphics', pct: 5,
  engines: [{ eng: 0, phys: 0, name: '3D', pct: 5 }, { eng: 2, phys: 0, name: 'Copy', pct: 1 }],
  dedicatedUsed: 0, sharedUsed: 800e6, dedicatedTotal: 134217728, sharedTotal: 6298005504,
  driverVersion: '32.0.101.7088', driverDate: '2026-07-06', directX: '12 (FL 12.1)', location: 'PCI bus 0, device 2, function 0',
  reserved: null, why: { reserved: 'no documented source' },
}, o || {});
const reply = (gpus) => ({ byPid: {}, totals: { gpu: 5 }, gpus, why: {}, ms: 1 });

// ---------------- makeHistory + first sample
{
  const h = G.makeHistory();
  check('makeHistory: empty device map', h.devices instanceof Map && h.devices.size === 0);
  const out = G.shape(reply([card()]), h);
  const c = out[0];
  check('one card per raw gpu', out.length === 1);
  check('every TM-SPEC field is present', SPEC.every((k) => k in c), SPEC.filter((k) => !(k in c)).join(','));
  check('extras: kind, index, hist, why', c.kind === 'gpu' && c.index === 0 && Array.isArray(c.hist) && typeof c.why === 'object');
  check('histories are 60 long', [c.hist, c.dedHist, c.sharedHist, ...c.engines.map((e) => e.hist)].every((a) => a.length === 60));
  check('null-padded at the start, sample last', c.hist.slice(0, 59).every((v) => v === null) && c.hist[59] === 5 && c.sharedHist[59] === 800e6 && c.dedHist[59] === 0);
  check('engines: {name, pct, hist} only', c.engines.every((e) => Object.keys(e).sort().join() === 'hist,name,pct') && c.engines[0].name === '3D' && c.engines[0].hist[59] === 5);
  check('driverDate is Windows en-US short date', c.driverDate === '7/6/2026', c.driverDate);
  check('static facts pass through', c.driverVersion === '32.0.101.7088' && c.directX === '12 (FL 12.1)' && c.location === 'PCI bus 0, device 2, function 0' && c.dedicatedTotal === 134217728);
  check('reserved null keeps the sidecar why', c.reserved === null && c.why.reserved === 'no documented source');
}

// ---------------- one sample per call, rolling window, baseline samples are null
{
  const h = G.makeHistory();
  G.shape(reply([card({ pct: null, engines: [{ eng: 0, phys: 0, name: '3D', pct: null }], why: { pct: 'baseline', 'engines.pct': 'baseline' } })]), h);
  let c = G.shape(reply([card({ pct: 7, engines: [{ eng: 0, phys: 0, name: '3D', pct: 7 }] })]), h)[0];
  check('baseline sample is a null in the history', c.hist[58] === null && c.hist[59] === 7 && c.engines[0].hist[58] === null && c.engines[0].hist[59] === 7);
  for (let i = 0; i < 70; i++) c = G.shape(reply([card({ pct: i, engines: [{ eng: 0, phys: 0, name: '3D', pct: i }] })]), h)[0];
  check('window stays 60, oldest dropped', c.hist.length === 60 && c.hist[0] === 10 && c.hist[59] === 69 && c.engines[0].hist[0] === 10);
  c.hist[59] = 'x'; c.engines[0].hist[59] = 'x';
  const d = G.shape(reply([card({ pct: 1, engines: [{ eng: 0, phys: 0, name: '3D', pct: 1 }] })]), h)[0];
  check('output arrays are copies (the model cannot corrupt the history)', d.hist[58] === 69 && d.engines[0].hist[58] === 69);
}

// ---------------- engines keep their own history by ordinal, even reordered or renamed
{
  const h = G.makeHistory();
  G.shape(reply([card({ engines: [{ eng: 0, phys: 0, name: '3D', pct: 9 }, { eng: 2, phys: 0, name: 'Copy', pct: 3 }] })]), h);
  const c = G.shape(reply([card({ engines: [{ eng: 2, phys: 0, name: 'Copy', pct: 4 }, { eng: 0, phys: 0, name: '3D', pct: 8 }] })]), h)[0];
  check('reordered engines follow their ordinal', c.engines[0].name === 'Copy' && c.engines[0].hist.slice(58).join() === '3,4' && c.engines[1].hist.slice(58).join() === '9,8');
  const e = G.shape(reply([card({ engines: [{ eng: 0, phys: 0, name: '3D', pct: 1 }] })]), h)[0];
  check('an engine that vanished is dropped', h.devices.get(ID0).engines.size === 1 && e.engines.length === 1);
  const f = G.shape(reply([card({ engines: [{ eng: 0, phys: 0, name: '3D', pct: 1 }, { eng: 2, phys: 0, name: 'Copy', pct: 2 }] })]), h)[0];
  check('a returning engine starts fresh', f.engines[1].hist.slice(0, 59).every((v) => v === null) && f.engines[1].hist[59] === 2);
  const l = G.shape(reply([card({ engines: [{ eng: 0, phys: 0, name: '3D', pct: 1 }, { eng: 0, phys: 1, name: '3D (Link 1)', pct: 6 }] })]), h)[0];
  check('linked adapters: same ordinal on another phys is its own engine', l.engines[1].hist[59] === 6 && l.engines[1].hist[58] === null && l.engines[0].hist[58] === 1);
}

// ---------------- devices: vanish, return, NPU, order
{
  const h = G.makeHistory();
  G.shape(reply([card(), card({ id: ID1, index: 1, name: 'Second' })]), h);
  check('two devices tracked', h.devices.size === 2);
  const one = G.shape(reply([card()]), h);
  check('a vanished device is dropped', one.length === 1 && h.devices.size === 1 && !h.devices.has(ID1));
  const back = G.shape(reply([card(), card({ id: ID1, index: 1, name: 'Second', pct: 2 })]), h);
  check('a returning device starts fresh', back[1].hist.slice(0, 59).every((v) => v === null) && back[1].hist[59] === 2 && back[0].hist[57] === 5);
  const npu = G.shape(reply([card(), card({ id: ID1, kind: 'npu', index: 0, name: 'NPU', directX: null, why: { directX: 'an NPU has no DirectX version' } })]), h);
  check('an NPU keeps kind npu and its why', npu[1].kind === 'npu' && npu[1].directX === null && npu[1].why.directX === 'an NPU has no DirectX version');
  check('raw order kept (GPUs, then NPUs)', npu.map((c) => c.id).join() === [ID0, ID1].join());
}

// ---------------- no gpus: nothing pushed, nothing dropped
{
  const h = G.makeHistory();
  G.shape(reply([card()]), h);
  const light = { byPid: {}, totals: { gpu: 3 }, gpus: null, why: { gpus: 'not asked' } };
  check('light reply -> []', Array.isArray(G.shape(light, h)) && G.shape(light, h).length === 0);
  check('light reply leaves the history alone', h.devices.size === 1 && h.devices.get(ID0).hist[59] === 5 && h.devices.get(ID0).hist[58] === null);
  check('null raw -> []', G.shape(null, h).length === 0 && G.shape(undefined, h).length === 0 && h.devices.size === 1);
  check('empty gpus array drops every device', G.shape(reply([]), h).length === 0 && h.devices.size === 0);
  check('works without a history object', G.shape(reply([card()])).length === 1);
}

// ---------------- every null has a why
{
  const h = G.makeHistory();
  const c = G.shape(reply([{ id: ID0, kind: 'gpu', index: 0, engines: [], why: { pct: 'baseline' } }]), h)[0];
  const nulls = ['name', 'pct', 'dedicatedUsed', 'dedicatedTotal', 'sharedUsed', 'sharedTotal', 'driverVersion', 'driverDate', 'directX', 'location', 'reserved'];
  check('missing fields come back null', nulls.every((k) => c[k] === null));
  check('every null has a reason', nulls.every((k) => typeof c.why[k] === 'string'), nulls.filter((k) => typeof c.why[k] !== 'string').join(','));
  check('the sidecar reason wins', c.why.pct === 'baseline');
  check('non-numbers never leak through', G.shape(reply([card({ pct: 'x', sharedUsed: NaN })]), G.makeHistory())[0].pct === null);
}

// ---------------- displayDate
check('displayDate: iso', G.displayDate('2024-03-14') === '3/14/2024');
check('displayDate: other text passes, null stays', G.displayDate('14.03.2024') === '14.03.2024' && G.displayDate(null) === null);

console.log(`TASKMGR GPU JS TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);
