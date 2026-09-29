'use strict';
/*
 * update.js - the main half of Settings > Windows Update (ui/settings/sections/update.js), lane
 * gameupd, 2026-09-29. Every command is settings.update.<name> and asks sidecar/SysUpdate.cs:
 *   status    build, last checked / installed, restart needed, pause, active hours, Advanced switches,
 *             Delivery Optimization, Insider, the running check (reads; Windows Update Agent COM API)
 *   list      the updates Windows Update already knows this PC needs (an OFFLINE search: no network)
 *   history   the update history
 *   check     "Check for updates": an ONLINE search on the sidecar's own thread. A real network action,
 *             so a test run sends it as a dryRun (nothing is downloaded or installed either way)
 *   pause     1-5 weeks, 0 = resume  } HKLM: the sidecar answers needsAdmin and _devices-bridge.js turns
 *   activeHours  {start, end}        } it into ONE administrator prompt ([Elevated] update.pause /
 *                                      update.activeHours, sidecar/ELEVATE.md); a test run is a dryRun
 * Installing, uninstalling and restarting are never done here.
 * PRIVACY: nothing here logs; update titles reach the page only in results.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.update.<name> -> the sidecar command it asks (the page test pins these). */
const SIDECAR = {
  status: 'update.status',
  list: 'update.list',
  history: 'update.history',
  check: 'update.check',
  pause: 'update.pause',
  activeHours: 'update.activeHours',
};
/** The administrator actions a write may turn into (SysUpdate.cs [Elevated]). */
const ADMIN = ['update.pause', 'update.activeHours'];

const whole = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

const commands = {
  status: (args, env) => send(env, SIDECAR.status, {}, 20000),
  list: (args, env) => send(env, SIDECAR.list, {}, 90000),
  history: (args, env) => send(env, SIDECAR.history, whole(args.count, 1, 200) ? { count: args.count } : {}, 60000),

  check: (args, env) => write(env, SIDECAR.check, {}, { ms: 15000, value: () => undefined }),
  pause(args, env) {
    if (!whole(args.weeks, 0, 5)) return { ok: false, reason: 'weeks must be a whole number from 0 (resume) to 5' };
    return write(env, SIDECAR.pause, pick(args, ['weeks']), { ms: 15000, value: (r) => r.value });   // "0".."5", the page's choice value
  },
  activeHours(args, env) {
    if (!whole(args.start, 0, 23) || !whole(args.end, 0, 23)) return { ok: false, reason: 'start and end must be whole hours from 0 to 23' };
    return write(env, SIDECAR.activeHours, pick(args, ['start', 'end']), { ms: 15000, value: () => undefined });
  },
};

module.exports = { id: 'update', commands, SIDECAR, ADMIN };
