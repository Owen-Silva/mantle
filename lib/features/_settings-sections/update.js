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
 *   pause     1-5 weeks, 0 = resume; } HKLM: the sidecar answers needsAdmin and _devices-bridge.js turns
 *             extend:true moves the   } it into ONE administrator prompt ([Elevated] update.pause /
 *             end of a running pause, } update.activeHours / update.smartHours, sidecar/ELEVATE.md); a
 *             counted from its start  } test run is a dryRun
 *   activeHours  {start, end}         }
 *   smartHours   {on}: Windows sets the active hours from use (Automatically) or you do (Manually)
 * status: the last check's HRESULT (check.code) becomes words here and never reaches the page; a "busy"
 * code (another check or install running, the service stopping) is check.busy, which the page shows
 * as "Windows Update is busy" with Try again.
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
  smartHours: 'update.smartHours',
};
/** The administrator actions a write may turn into (SysUpdate.cs [Elevated]). */
const ADMIN = ['update.pause', 'update.activeHours', 'update.smartHours'];

const whole = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/* An update that did not install says why in words (quality pass 2026-09-29): SysUpdate.cs hands back
   Windows Update's HRESULT ("0x800F0922"), which means nothing to a person. The common ones, from
   Microsoft's Windows Update error reference; anything else is left for the page's own fallback line. */
const NO_NET = 'Windows could not reach the update service. Check the internet connection; Windows tries again by itself';
const WHY = {
  '0x80070005': 'Windows did not allow it: it needs administrator rights',
  '0x80070070': 'There was not enough free space on the disk. Free some space; Windows tries again by itself',
  '0x80070643': 'The installer stopped with an error. Windows usually tries it again by itself',
  '0x800F0922': 'Windows could not finish it: the system reserved partition may be too small, or the network dropped',
  '0x800F081F': 'Windows could not find files it needed to install it',
  '0x800F0906': 'Windows could not download files it needed to install it',
  '0x80073712': 'Some Windows system files are damaged, so it could not be installed',
  '0x80070002': 'Windows could not find files it needed to install it',
  '0x80070422': 'The Windows Update service is turned off',
  '0x800705B4': 'It took too long and Windows stopped it. Windows tries again by itself',
  '0x8024200D': 'The download did not finish. Windows tries again by itself',
  '0x80246008': 'The download did not finish. Windows tries again by itself',
  '0x80242016': 'It did not finish after the restart. Windows tries again by itself',
  '0x80240017': 'It does not apply to this PC',
  '0x8024000B': 'It was cancelled before it finished',
  '0x8024402C': NO_NET, '0x8024401C': NO_NET, '0x80072EE2': NO_NET, '0x80072EFD': NO_NET, '0x80072F8F': NO_NET, '0x80244022': NO_NET,
};
/* Windows Update refusing because it is busy: the codes from Microsoft's Windows Update error reference
   (learn.microsoft.com/windows/deployment/update/windows-update-error-reference) whose description is
   "another operation in progress / in use / shutting down", plus COM's own "the server is busy" pair. */
const BUSY_NOW = 'Windows Update is busy with another check or an install, so it did not check now. Try again in a few minutes';
const STOPPING = 'Windows Update was stopping (Windows may be restarting or shutting down), so it did not check. Try again in a minute';
const BUSY = {
  '0x80240009': BUSY_NOW,    // WU_E_OPERATIONINPROGRESS: another conflicting operation was in progress
  '0x80240016': 'Windows Update is installing, or waiting for a restart to finish installing, so it did not check now. Try again later',   // WU_E_INSTALL_NOT_ALLOWED
  '0x8024001B': 'Windows Update is updating itself, so it did not check now. Try again in a few minutes',   // WU_E_SELFUPDATE_IN_PROGRESS
  '0x8024001E': STOPPING,    // WU_E_SERVICE_STOP
  '0x80248000': STOPPING,    // WU_E_DS_SHUTDOWN
  '0x80248001': BUSY_NOW,    // WU_E_DS_INUSE: the data store was in use
  '0x8024800C': BUSY_NOW,    // WU_E_DS_LOCKTIMEOUTEXPIRED
  '0x8024800F': BUSY_NOW,    // WU_E_DS_STOREFILELOCKED
  '0x8024A000': BUSY_NOW,    // WU_E_AU_NOSERVICE: Automatic Updates was unable to service incoming requests
  '0x8001010A': BUSY_NOW,    // RPC_E_SERVERCALL_RETRYLATER: the application is busy
  '0x80010001': BUSY_NOW,    // RPC_E_CALL_REJECTED
};
const codeOf = (c) => (typeof c === 'string' && /^0x[0-9a-f]{8}$/i.test(c) ? '0x' + c.slice(2).toUpperCase() : null);
/** update.status for the page: the running check's code becomes words (busy or not), and the code goes. */
function withCheck(r) {
  if (!r || r.ok === false || !r.check || typeof r.check !== 'object') return r;
  const c = Object.assign({}, r.check);
  const code = codeOf(c.code);
  delete c.code;
  c.busy = !!(code && BUSY[code]);
  if (c.busy) c.error = BUSY[code];
  else if (code && WHY[code]) c.error = WHY[code];
  return Object.assign({}, r, { check: c });
}

/** One history entry + `why`: the words for its code, or null (never the code itself). */
function withWhy(h) {
  if (!h || typeof h !== 'object') return h;
  const code = typeof h.code === 'string' ? h.code.toUpperCase().replace(/^0X/, '0x') : null;
  return Object.assign({}, h, { why: h.ok || !code ? null : WHY[code] || null });
}

/* TEST RUN ONLY (env.test): MANTLE_TEST_UPDATE_CHECK_CODE=0x........ stands in for the code of the last online
 * check, so the end-to-end test (ui/settings/sections/sysrows.e2e.test.js) can show "Windows Update is busy"
 * through the real page, main and sidecar without making Windows Update busy. Never read in a live run. */
function testCode(r, env) {
  const code = env && env.test ? codeOf(process.env.MANTLE_TEST_UPDATE_CHECK_CODE) : null;
  if (!code || !r || r.ok === false || !r.check || typeof r.check !== 'object') return r;
  return Object.assign({}, r, { check: Object.assign({}, r.check, { running: false, code }) });
}

const commands = {
  status: (args, env) => send(env, SIDECAR.status, {}, 20000).then((r) => withCheck(testCode(r, env))),
  list: (args, env) => send(env, SIDECAR.list, {}, 90000),
  history: (args, env) => send(env, SIDECAR.history, whole(args.count, 1, 200) ? { count: args.count } : {}, 60000)
    .then((r) => (r && r.ok && Array.isArray(r.items) ? Object.assign({}, r, { items: r.items.map(withWhy) }) : r)),

  check: (args, env) => write(env, SIDECAR.check, {}, { ms: 15000, value: () => undefined }),
  pause(args, env) {
    if (!whole(args.weeks, 0, 5)) return { ok: false, reason: 'weeks must be a whole number from 0 (resume) to 5' };
    if (args.extend !== undefined && typeof args.extend !== 'boolean') return { ok: false, reason: 'extend must be true or false' };
    if (args.extend && args.weeks === 0) return { ok: false, reason: 'only a pause can be extended (weeks 1 to 5)' };
    return write(env, SIDECAR.pause, pick(args, ['weeks', 'extend']), { ms: 15000, value: (r) => r.value });   // "0".."5" or "paused", the page's choice value
  },
  activeHours(args, env) {
    if (!whole(args.start, 0, 23) || !whole(args.end, 0, 23)) return { ok: false, reason: 'start and end must be whole hours from 0 to 23' };
    return write(env, SIDECAR.activeHours, pick(args, ['start', 'end']), { ms: 15000, value: () => undefined });
  },
  smartHours(args, env) {
    if (typeof args.on !== 'boolean') return { ok: false, reason: 'on must be true (Windows sets the active hours) or false (you set them)' };
    return write(env, SIDECAR.smartHours, pick(args, ['on']), { ms: 15000, value: (r) => r.value });   // "auto" | "manual", the page's choice value
  },
};

module.exports = { id: 'update', commands, SIDECAR, ADMIN, WHY, BUSY };
