'use strict';
/*
 * system.js - the main half of Mantle Settings > System (ui/settings/sections/system.js; contract
 * ui/settings/SECTIONS.md). Lane sysset, 2026-09-28.
 *
 * WHY: Owen wants Mantle Settings to do everything Windows' Settings > System does, natively. The work
 * is in the sidecar (SysPower.cs, SysNotify.cs, SysMulti.cs, SysAbout.cs, SysDisplay.cs, SysSound.cs,
 * SysStorage.cs); this file is the door between the page and those commands, and it holds the three
 * rules the page must not be trusted with:
 *   - ONLY the sidecar commands listed below can be reached (READS / WRITES), never a name from the page;
 *   - in a test run (env.test) EVERY write is sent with dryRun: the sidecar answers exactly what it
 *     would write, the page shows that as a quiet note and the control springs back;
 *   - administrator actions go through env.elevate (lib/elevate.js, one UAC prompt per change), and
 *     only the ones listed in ADMIN.
 *
 *   settings.system.read  { what, ...args }   -> { ok: true, ...the sidecar's result } | { ok: false, reason }
 *   settings.system.write { what, ...args }   -> the same; { ok: true, dryRun: true, reason, would } in a test
 *   settings.system.admin { action, args }    -> env.elevate's answer; a dry run in a test
 *
 * PRIVACY: nothing is logged except command names and outcomes; device names, app ids and paths only
 * travel in results.
 */

/* page word -> sidecar command, and how long it may take (WMI and app-name lookups are slow). */
const READS = {
  power: ['syspower.get', 8000],
  notify: ['sysnotify.get', 20000],
  multi: ['sysmulti.get', 8000],
  about: ['sysabout.get', 8000],
  activation: ['sysabout.activation', 20000],
  recovery: ['sysabout.recovery', 8000],
  display: ['sysdisplay.get', 10000],
  nightlight: ['sysdisplay.nightlight', 6000],
  gpu: ['sysdisplay.gpuPrefs', 8000],
  sound: ['syssound.devices', 10000],
  apps: ['syssound.apps', 10000],
  meter: ['syssound.meter', 3000],
  storage: ['sysstorage.get', 10000],
  storageScan: ['sysstorage.scan', 10000],
  cleanupPlan: ['sysstorage.plan', 60000],
};

const WRITES = {
  powerSet: 'syspower.set',
  hibernate: 'syspower.hibernateSet',
  fastStartup: 'syspower.fastStartupSet',
  notifySet: 'sysnotify.set',
  dnd: 'sysnotify.dnd',
  focus: 'sysnotify.focus',
  notifyApp: 'sysnotify.app',
  multiSet: 'sysmulti.set',
  clearClipboard: 'sysmulti.clearClipboard',
  advancedStartup: 'sysabout.advancedStartup',
  displayMode: 'sysdisplay.mode',
  displayKeep: 'sysdisplay.keep',
  displayRevert: 'sysdisplay.revert',
  topology: 'sysdisplay.topology',
  primary: 'sysdisplay.primary',
  arrange: 'sysdisplay.arrange',
  scale: 'sysdisplay.scale',
  hdr: 'sysdisplay.hdr',
  nightlightSet: 'sysdisplay.nightlightSet',
  gpuPrefSet: 'sysdisplay.gpuPrefSet',
  gpuGlobalSet: 'sysdisplay.gpuGlobalSet',
  gpuSchedulingSet: 'sysdisplay.gpuSchedulingSet',
  soundDefault: 'syssound.default',
  soundLevel: 'syssound.level',
  soundProps: 'syssound.props',
  soundEnable: 'syssound.enable',
  micTest: 'syssound.micTest',
  appSet: 'syssound.appSet',
  appDevice: 'syssound.appDevice',
  resetApps: 'syssound.resetApps',
  storageSense: 'sysstorage.senseSet',
  cleanup: 'sysstorage.cleanup',
};

/* Administrator actions this section may ask for (sidecar [Elevated] names), with their words. */
const ADMIN = {
  'system.renamePc': 'rename this PC',
  'system.hibernate': 'turn hibernation on or off',
  'system.fastStartup': 'turn fast start-up on or off',
  'system.remoteDesktop': 'turn Remote Desktop on or off',
  'system.productKey': 'change the Windows product key',
  'system.networkReset': 'reset every network adapter',
  'sysdisplay.gpuScheduling': 'turn hardware-accelerated GPU scheduling on or off',
};

const words = (e) => String((e && e.message) || e || 'unknown error').split(/\r?\n/)[0].slice(0, 200);

/** Copies the page's args minus the routing key and the sidecar protocol's own keys. */
function clean(args, drop) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (k === drop || k === 'id' || k === 'cmd' || k === 'ttl') continue;
    out[k] = v;
  }
  return out;
}

/** A sidecar reply as the page wants it: the result's own fields with ok, or ok:false + reason. */
function flat(r) {
  if (!r || typeof r !== 'object') return { ok: false, reason: 'the sidecar answered with nothing' };
  if (!r.ok) return { ok: false, reason: r.error || r.reason || 'the sidecar said no without a reason' };
  const res = r.result;
  if (res && typeof res === 'object' && !Array.isArray(res)) return Object.assign({ ok: true }, res);
  return { ok: true, value: res };
}

module.exports = {
  id: 'system',
  READS, WRITES, ADMIN,          // for the tests
  commands: {
    async read(args, env) {
      const w = READS[args && args.what];
      if (!w) return { ok: false, reason: `there is no System reading called "${String(args && args.what).slice(0, 40)}"` };
      return flat(await env.sidecar.send(w[0], clean(args, 'what'), { timeoutMs: w[1] }));
    },

    async write(args, env) {
      const cmd = WRITES[args && args.what];
      if (!cmd) return { ok: false, reason: `there is no System change called "${String(args && args.what).slice(0, 40)}"` };
      const a = clean(args, 'what');
      if (env.test || a.dryRun === true) {
        const r = flat(await env.sidecar.send(cmd, Object.assign(a, { dryRun: true }), { timeoutMs: 15000 }));
        if (!r.ok) return r;
        const would = (r.writes || []).map((x) => x.api === 'registry' ? `${x.hive}\\...\\${x.name} = ${x.value}` : `${x.api}${x.value !== undefined ? ` = ${x.value}` : ''}`).join('; ');
        return { ok: true, dryRun: true, would: r, reason: r.wouldRefuse ? `test run: Windows would refuse (${r.wouldRefuse})` : `test run: nothing was changed (would write: ${would || 'nothing'})` };
      }
      const r = flat(await env.sidecar.send(cmd, a, { timeoutMs: 20000 }));
      env.log(`${args.what}: ${r.ok ? 'done' : 'refused'}`);
      return r;
    },

    async admin(args, env) {
      const action = args && args.action;
      if (!Object.prototype.hasOwnProperty.call(ADMIN, action)) return { ok: false, reason: 'that administrator action is not one System offers' };
      const a = args.args && typeof args.args === 'object' ? args.args : {};
      if (env.test) return { ok: true, dryRun: true, reason: `test run: Windows would ask for administrator permission to ${ADMIN[action]}; nothing was changed` };
      const r = await env.elevate(action, a, { why: 'Settings > System' });
      env.log(`${action}: ${r && r.kind ? r.kind : r && r.ok ? 'ok' : 'failed'}`);
      if (r && r.kind === 'cancelled') return { ok: false, cancelled: true, reason: 'You said no to the administrator prompt; nothing changed.' };
      if (r && r.ok) return Object.assign({ ok: true }, r.result && typeof r.result === 'object' ? r.result : {});
      return { ok: false, reason: (r && r.reason) || 'the administrator step did not answer' };
    },
  },
  install(env) {
    // Display mode changes are kept or reverted by the SIDECAR's own timer (SysDisplay.cs); the page
    // only shows the countdown, so relay its events to the open window.
    const off = env.sidecar.on ? env.sidecar.on('sysdisplay', (ev) => { try { env.push('settings.system.display', ev); } catch (e) { env.log(`display event not relayed (${words(e)})`); } }) : null;
    return () => { if (typeof off === 'function') off(); };
  },
};
