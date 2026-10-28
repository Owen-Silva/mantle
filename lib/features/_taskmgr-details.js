'use strict';
/*
 * _taskmgr-details.js - the Details page's rows and the Processes page's extra columns, PURE
 * (lane tm-details, 2026-10-28). No Electron, no sidecar, no clock: every input is a sidecar reply.
 *
 *   rowsFrom(cur, prev, opts)       taskmgr.details replies (this tick, the last one) -> model.details.rows
 *                                   (TM-SPEC "Details"). The sidecar sends raw counters only; what needs two
 *                                   samples is done here: cpu (% of the whole machine, Windows' Details CPU
 *                                   column), wsDelta and pfDelta. A row is matched to its last sample by
 *                                   pid + creation time, so a reused pid starts fresh (cpu/deltas null).
 *                                   opts.fullAccountName: user = DOMAIN\name (Windows' Settings toggle).
 *   extraMapFrom(reply)             taskmgr.procextra reply -> Map 'pid|created' -> its row.
 *   procExtraFor(group, extraMap)   one Processes row group ({root, created, procs:[{pid, created}]}) ->
 *                                   { publisher, cmdline, efficiency, status }: the root's publisher and
 *                                   command line, Efficiency mode when every readable member is in it,
 *                                   status 'Efficiency mode' then (else null).
 *
 * Null is "not measured" (the UI shows an em dash and the row's `why`); never a made-up number.
 */

const keyOf = (r) => `${r.pid}|${r.created}`;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;

/** cur/prev: taskmgr.details results ({ t (ms), cpus, rows }). Returns model.details.rows. */
function rowsFrom(cur, prev, opts) {
  const o = opts || {};
  if (!cur || !Array.isArray(cur.rows)) return [];
  const before = new Map();
  if (prev && Array.isArray(prev.rows)) for (const r of prev.rows) before.set(keyOf(r), r);
  const elapsedMs = prev && num(prev.t) !== null && num(cur.t) !== null && cur.t > prev.t ? cur.t - prev.t : 0;
  const cpus = cur.cpus > 0 ? cur.cpus : 1;
  const span = elapsedMs * 1e4 * cpus;   // 100-ns units of CPU time the whole machine had in the interval
  return cur.rows.map((r) => {
    const p = before.get(keyOf(r));
    let cpu = null;
    if (p && span > 0 && num(r.cpuTime100ns) !== null && num(p.cpuTime100ns) !== null) {
      cpu = Math.min(100, Math.max(0, round1(((r.cpuTime100ns - p.cpuTime100ns) / span) * 100)));
    }
    const delta = (f) => (p && num(r[f]) !== null && num(p[f]) !== null ? r[f] - p[f] : null);
    return {
      key: keyOf(r),
      pid: r.pid,
      created: r.created,
      name: r.name,
      status: r.status || null,
      user: o.fullAccountName ? (r.userFull || r.user || null) : (r.user || null),
      cpu,
      mem: num(r.privateWs),
      arch: r.arch || null,
      desc: r.desc || null,
      path: r.path || null,
      packageName: typeof r.packageName === 'string' ? r.packageName : null,
      sessionId: num(r.sessionId),
      jobId: r.jobId === undefined ? null : r.jobId,
      cpuTimeSec: num(r.cpuTime100ns) === null ? null : Math.floor(r.cpuTime100ns / 1e7),
      cycles: num(r.cycles),
      ws: num(r.ws),
      wsPeak: num(r.wsPeak),
      wsDelta: delta('ws'),
      privateWs: num(r.privateWs),
      sharedWs: num(r.sharedWs),
      commit: num(r.commit),
      pagedPool: num(r.pagedPool),
      npPool: num(r.npPool),
      pageFaults: num(r.pageFaults),
      pfDelta: delta('pageFaults'),
      basePriority: r.basePriority || null,
      handles: num(r.handles),
      threads: num(r.threads),
      userObjects: num(r.userObjects),
      gdiObjects: num(r.gdiObjects),
      ioReads: num(r.ioReads),
      ioWrites: num(r.ioWrites),
      ioOther: num(r.ioOther),
      ioReadBytes: num(r.ioReadBytes),
      ioWriteBytes: num(r.ioWriteBytes),
      ioOtherBytes: num(r.ioOtherBytes),
      cmdline: typeof r.cmdline === 'string' ? r.cmdline : null,
      osContext: r.osContext || null,
      platform: r.platform || null,
      elevated: typeof r.elevated === 'boolean' ? r.elevated : null,
      uacVirt: r.uacVirt || null,
      dep: r.dep || null,
      enterprise: r.enterprise || null,
      powerThrottling: r.powerThrottling || null,
      shadowStack: r.shadowStack || null,
      efficiency: typeof r.efficiency === 'boolean' ? r.efficiency : null,
      needsAdmin: !!r.needsAdmin,
      why: r.why || null,
      unread: Array.isArray(r.unread) ? r.unread.slice() : [],
    };
  });
}

/** taskmgr.procextra result -> Map 'pid|created' -> row. */
function extraMapFrom(reply) {
  const m = new Map();
  if (reply && Array.isArray(reply.rows)) for (const r of reply.rows) m.set(keyOf(r), r);
  return m;
}

const lookup = (extraMap, k) => {
  if (!extraMap) return undefined;
  if (extraMap instanceof Map) return extraMap.get(k);
  return Object.prototype.hasOwnProperty.call(extraMap, k) ? extraMap[k] : undefined;
};

/** group: a Processes row group ({root, created, procs:[{pid, created}]}); extraMap: extraMapFrom(...) or a plain object. */
function procExtraFor(group, extraMap) {
  const none = { publisher: null, cmdline: null, efficiency: null, status: null };
  if (!group) return none;
  const members = Array.isArray(group.procs) && group.procs.length ? group.procs
    : group.root != null ? [{ pid: group.root, created: group.created }] : [];
  const rootKey = group.root != null ? `${group.root}|${group.created}` : null;
  const extras = members.map((m) => lookup(extraMap, keyOf(m))).filter(Boolean);
  const root = (rootKey && lookup(extraMap, rootKey)) || extras[0] || null;
  if (!root && !extras.length) return none;
  const withPub = root && root.publisher ? root : extras.find((e) => e.publisher);
  const known = extras.filter((e) => typeof e.efficiency === 'boolean');
  const efficiency = known.length ? known.every((e) => e.efficiency) : null;
  return {
    publisher: withPub ? withPub.publisher : null,
    cmdline: root && typeof root.cmdline === 'string' ? root.cmdline : null,
    efficiency,
    status: efficiency === true ? 'Efficiency mode' : null,
  };
}

module.exports = { rowsFrom, procExtraFor, extraMapFrom, keyOf };
