'use strict';
/*
 * _taskmgr-gpu.js - the Performance page's GPU cards (TM-SPEC model.perf.gpus), PURE (lane tm-gpu,
 * 2026-10-28). No Electron, no sidecar, no clock: the input is a `taskmgr.gpu {full:true}` reply.
 *
 *   makeHistory()        -> the per-device state shape() keeps: 60-sample histories per device (hist,
 *                           dedHist, sharedHist) and per engine (engines[].hist), null-padded at the start.
 *   shape(raw, hist)     -> model.perf.gpus. ONE sample is pushed per call (the coordinator calls it once per
 *                           updateSpeed tick, only while Performance is visible). A device missing from
 *                           raw.gpus is dropped from the history (so is an engine missing from its device);
 *                           when raw.gpus is not an array (light reply, sidecar failure) nothing is pushed or
 *                           dropped and the answer is [].
 *
 * Elsewhere the coordinator reads raw.byPid ({pid: {pct, engine}}) and raw.totals.gpu directly.
 *
 * Output per device (TM-SPEC fields, then extras):
 *   { id, name, pct, engines: [{ name, pct, hist[60] }], dedicatedUsed, dedicatedTotal, sharedUsed,
 *     sharedTotal, dedHist[60], sharedHist[60], driverVersion, driverDate, directX, location, reserved,
 *     kind 'gpu'|'npu', index (the n of "GPU n" / "NPU n"), hist[60] (the card's sparkline + main graph),
 *     why: {field: reason} }
 *   driverDate is Windows' en-US short date ('7/6/2026'); the sidecar sends 'yyyy-MM-dd'.
 *   Every null field has a reason in why (the sidecar's, else "not reported").
 */

const N = 60;
const FIELDS = ['id', 'name', 'pct', 'dedicatedUsed', 'dedicatedTotal', 'sharedUsed', 'sharedTotal',
  'driverVersion', 'driverDate', 'directX', 'location', 'reserved'];

const padded = () => new Array(N).fill(null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function push(arr, v) { arr.push(v); while (arr.length > N) arr.shift(); }

function makeHistory() {
  return { devices: new Map() };   // id -> { hist, dedHist, sharedHist, engines: Map key -> hist }
}

/** Windows' en-US short date for the sidecar's 'yyyy-MM-dd' (anything else passes through). */
function displayDate(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${+m[2]}/${+m[3]}/${m[1]}` : iso;
}

function engineKey(e, i) {
  return Number.isInteger(e.eng) ? `${Number.isInteger(e.phys) ? e.phys : 0}:${e.eng}` : `name:${e.name}#${i}`;
}

function shape(raw, hist) {
  if (!raw || !Array.isArray(raw.gpus)) return [];
  const h = hist || makeHistory();
  const seen = new Set();
  const out = [];
  for (const g of raw.gpus) {
    if (!g || typeof g.id !== 'string') continue;
    seen.add(g.id);
    let dev = h.devices.get(g.id);
    if (!dev) { dev = { hist: padded(), dedHist: padded(), sharedHist: padded(), engines: new Map() }; h.devices.set(g.id, dev); }
    const pct = num(g.pct), ded = num(g.dedicatedUsed), shr = num(g.sharedUsed);
    push(dev.hist, pct); push(dev.dedHist, ded); push(dev.sharedHist, shr);

    const engKeys = new Set();
    const engines = (Array.isArray(g.engines) ? g.engines : []).map((e, i) => {
      const key = engineKey(e, i);
      engKeys.add(key);
      let eh = dev.engines.get(key);
      if (!eh) { eh = padded(); dev.engines.set(key, eh); }
      const ep = num(e.pct);
      push(eh, ep);
      return { name: typeof e.name === 'string' ? e.name : null, pct: ep, hist: eh.slice() };
    });
    for (const k of [...dev.engines.keys()]) if (!engKeys.has(k)) dev.engines.delete(k);

    const why = Object.assign({}, g.why && typeof g.why === 'object' ? g.why : {});
    const card = {
      id: g.id,
      name: typeof g.name === 'string' ? g.name : null,
      pct,
      engines,
      dedicatedUsed: ded,
      dedicatedTotal: num(g.dedicatedTotal),
      sharedUsed: shr,
      sharedTotal: num(g.sharedTotal),
      dedHist: dev.dedHist.slice(),
      sharedHist: dev.sharedHist.slice(),
      driverVersion: typeof g.driverVersion === 'string' ? g.driverVersion : null,
      driverDate: displayDate(g.driverDate),
      directX: typeof g.directX === 'string' ? g.directX : null,
      location: typeof g.location === 'string' ? g.location : null,
      reserved: num(g.reserved),
      kind: g.kind === 'npu' ? 'npu' : 'gpu',
      index: Number.isInteger(g.index) ? g.index : null,
      hist: dev.hist.slice(),
      why,
    };
    for (const k of FIELDS) if (card[k] === null && typeof why[k] !== 'string') why[k] = 'not reported by the sidecar';
    if (card.index === null && typeof why.index !== 'string') why.index = 'not reported by the sidecar';
    out.push(card);
  }
  for (const id of [...h.devices.keys()]) if (!seen.has(id)) h.devices.delete(id);
  return out;
}

module.exports = { makeHistory, shape, displayDate, N };
