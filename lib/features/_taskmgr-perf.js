'use strict';
/*
 * _taskmgr-perf.js - PURE: turns one `taskmgr.perf` sample (sidecar/Perf.cs) into model.perf's cpu, mem,
 * disks and nets (TM-SPEC.md, Performance) with the 60-sample histories the graphs draw (lane tm-perf,
 * 2026-10-28). No I/O, no timers, no Electron.
 *
 *   const P = require('./_taskmgr-perf.js');
 *   const hist = P.makeHistory();                          // one per window
 *   Object.assign(base, P.shape(raw, hist, { cpuPct }));   // once per tick, ONLY while Performance is visible
 *
 * shape() pushes exactly one sample into every history per call. Histories are 60 long, oldest first,
 * null-padded at the start (a graph that has seen 3 ticks is 57 nulls then 3 values). A disk or adapter
 * missing from a sample's list drops its history (it comes back empty); a sample whose whole list is null
 * (Windows gave none this tick) pads every history with null and keeps them.
 *
 * opts.cpuPct, when a number, overrides cpu.pct and is what cpu.hist records (the coordinator passes its
 * idle-time CPU %, so the header and the graph agree).
 *
 * UNITS: bytes and bytes/s throughout (mem.*, disks[].readBps/writeBps/capacity/formatted,
 * nets[].sendBps/recvBps, nets[].linkBps is BITS/s as Windows reports link speed); percentages 0-100.
 * nets[].sendHist / recvHist are BITS per second (the page draws Kbps/Mbps like Windows). nets[].connected:
 * false = Windows' "Not connected" card (an unplugged Ethernet / Wi-Fi adapter). cpu.perCoreKernel: per
 * logical processor, 60-sample kernel-time histories (null until the sidecar sends perCoreKernel).
 *
 * NULLS: every null field has a plain-words reason in its object's `why` (cpu.why, mem.why, disks[i].why,
 * nets[i].why); "baseline" means rates need a second sample (first tick, or the window was hidden).
 * listWhy.disks / listWhy.nets say why a whole list is empty when Windows gave none.
 */

const N = 60;

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function ring() { return new Array(N).fill(null); }
function push(r, v) { r.push(num(v)); while (r.length > N) r.shift(); }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

function makeHistory() {
  return { cpu: ring(), kernel: ring(), cores: [], coresK: [], mem: ring(), disks: new Map(), nets: new Map() };
}

/** Fill `why` for every key of `out` listed in `keys` whose value is null, from the first source that has a reason. */
function explain(out, keys, why, sources, fallback) {
  for (const k of keys) {
    if (out[k] !== null && out[k] !== undefined) continue;
    out[k] = null;
    let r = null;
    for (const s of sources) { if (s && typeof s[k] === 'string' && s[k]) { r = s[k]; break; } }
    why[k] = r || fallback;
  }
}

/** Sub-keys of a flat why ("cpu.speedGHz" -> { speedGHz }) for one prefix. */
function sub(why, prefix) {
  const o = {};
  for (const [k, v] of Object.entries(obj(why))) if (k.startsWith(prefix)) o[k.slice(prefix.length)] = v;
  return o;
}

const CPU_LIVE = ['pct', 'kernelPct', 'speedGHz', 'procs', 'threads', 'handles', 'uptimeSec'];
const CPU_STATIC = ['name', 'baseGHz', 'sockets', 'cores', 'logical', 'virtualization', 'l1KB', 'l2KB', 'l3KB'];
const MEM_LIVE = ['total', 'used', 'avail', 'committed', 'commitLimit', 'cached', 'pagedPool', 'nonPagedPool', 'compressed', 'composition'];
const MEM_STATIC = ['speedMTs', 'slotsUsed', 'slotsTotal', 'formFactor', 'hardwareReserved'];
const DISK_KEYS = ['model', 'type', 'activePct', 'respMs', 'readBps', 'writeBps', 'capacity', 'formatted', 'systemDisk', 'pageFile'];
const NET_KEYS = ['sendBps', 'recvBps', 'ssid', 'connType', 'ipv4', 'ipv6', 'signal', 'linkBps', 'connected'];

function shape(sample, hist, opts) {
  const s = obj(sample);
  const h = hist && hist.cpu ? hist : makeHistory();
  const o = obj(opts);
  const why = obj(s.why);
  const st = s.static && typeof s.static === 'object' ? s.static : null;
  const stWhy = st ? sub(st.why, '') : {};
  const staticMissing = (typeof why.static === 'string' && why.static) || (s.staticPending ? 'still reading the hardware facts' : 'the hardware facts have not been read yet');

  // ---- CPU
  const rc = obj(s.cpu);
  const pct = typeof o.cpuPct === 'number' && Number.isFinite(o.cpuPct) ? o.cpuPct : num(rc.pct);
  push(h.cpu, pct);
  push(h.kernel, rc.kernelPct);
  const pc = Array.isArray(rc.perCore) ? rc.perCore : null;
  if (pc && pc.length !== h.cores.length) h.cores = pc.map(() => ring());   // processor count changed: restart
  h.cores.forEach((r, i) => push(r, pc ? pc[i] : null));
  const sc = st ? obj(st.cpu) : {};
  // per-core kernel time (Show kernel times on the logical-processor graphs; tm-data 10-28, optional)
  const pk = Array.isArray(rc.perCoreKernel) ? rc.perCoreKernel : null;
  if (!h.coresK) h.coresK = [];
  if (pk && pk.length !== h.coresK.length) h.coresK = pk.map(() => ring());
  h.coresK.forEach((r, i) => push(r, pk ? pk[i] : null));
  const cpu = { hist: h.cpu.slice(), kernelHist: h.kernel.slice(), perCore: h.cores.map((r) => r.slice()), perCoreKernel: h.coresK.length ? h.coresK.map((r) => r.slice()) : null };
  for (const k of CPU_LIVE) cpu[k] = k === 'pct' ? pct : num(rc[k]);
  for (const k of CPU_STATIC) cpu[k] = sc[k] === undefined ? null : sc[k];
  cpu.why = {};
  explain(cpu, CPU_LIVE, cpu.why, [sub(why, 'cpu.')], 'Windows did not say');
  explain(cpu, CPU_STATIC, cpu.why, [sub(stWhy, 'cpu.')], st ? 'Windows did not say' : staticMissing);
  if (!pc) cpu.why.perCore = (typeof why['cpu.perCore'] === 'string' && why['cpu.perCore']) || 'no per-processor reading this tick';

  // ---- memory
  const rm = obj(s.mem);
  const sm = st ? obj(st.mem) : {};
  const total = num(rm.total), used = num(rm.used);
  push(h.mem, total && used !== null ? Math.round((1000 * used) / total) / 10 : null);
  const mem = { hist: h.mem.slice() };
  for (const k of MEM_LIVE) mem[k] = k === 'composition' ? (rm.composition && typeof rm.composition === 'object' ? { ...rm.composition } : null) : num(rm[k]);
  for (const k of MEM_STATIC) mem[k] = sm[k] === undefined ? null : sm[k];
  mem.why = {};
  explain(mem, MEM_LIVE, mem.why, [sub(why, 'mem.')], 'Windows did not say');
  explain(mem, MEM_STATIC, mem.why, [sub(stWhy, 'mem.')], st ? 'Windows did not say' : staticMissing);

  // ---- disks and adapters
  const listWhy = { disks: null, nets: null };
  const disks = devices(s.disks, h.disks, (d, r) => {
    push(r.act, d.activePct); push(r.read, d.readBps); push(r.write, d.writeBps);
    const out = { id: d.id, name: d.name == null ? null : d.name };
    for (const k of DISK_KEYS) out[k] = d[k] === undefined ? null : d[k];
    out.bus = d.bus === undefined ? null : d.bus;
    out.removable = d.removable === undefined ? null : d.removable;
    out.hist = r.act.slice(); out.readHist = r.read.slice(); out.writeHist = r.write.slice();
    out.why = {};
    explain(out, DISK_KEYS, out.why, [obj(d.why)], 'Windows did not say');
    return out;
  }, () => ({ act: ring(), read: ring(), write: ring() }), (r) => { push(r.act, null); push(r.read, null); push(r.write, null); });
  if (!Array.isArray(s.disks)) listWhy.disks = (typeof why.disks === 'string' && why.disks) || 'Windows gave no disk list this tick';

  const nets = devices(s.nets, h.nets, (n, r) => {
    const sb = num(n.sendBps), rb = num(n.recvBps);
    push(r.send, sb === null ? null : sb * 8); push(r.recv, rb === null ? null : rb * 8);
    const out = { id: n.id, name: n.name == null ? null : n.name, adapter: n.adapter == null ? null : n.adapter, kind: n.kind == null ? null : n.kind };
    for (const k of NET_KEYS) out[k] = n[k] === undefined ? null : n[k];
    out.sendHist = r.send.slice(); out.recvHist = r.recv.slice();
    out.why = {};
    explain(out, NET_KEYS, out.why, [obj(n.why)], 'Windows did not say');
    return out;
  }, () => ({ send: ring(), recv: ring() }), (r) => { push(r.send, null); push(r.recv, null); });
  if (!Array.isArray(s.nets)) listWhy.nets = (typeof why.nets === 'string' && why.nets) || 'Windows gave no adapter list this tick';

  return { cpu, mem, disks, nets, listWhy };
}

/** One list of devices: push into each device's rings, drop the rings of devices that left; a null list pads all. */
function devices(list, map, make, fresh, pad) {
  if (!Array.isArray(list)) { for (const r of map.values()) pad(r); return []; }
  const seen = new Set();
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object' || d.id == null) continue;
    const id = String(d.id);
    if (seen.has(id)) continue;
    seen.add(id);
    let r = map.get(id);
    if (!r) { r = fresh(); map.set(id, r); }
    out.push(make(d, r));
  }
  for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
  return out;
}

module.exports = { makeHistory, shape, HIST: N };
