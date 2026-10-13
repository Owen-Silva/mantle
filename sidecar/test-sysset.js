// test-sysset.js - the System backends of Mantle Settings that lane sysset wrote itself:
// SysPower.cs, SysNotify.cs, SysAbout.cs, SysMulti.cs (SysDisplay, SysSound and SysStorage have their
// own test files). Lane sysset, 2026-09-28.
//
//   node sidecar/test-sysset.js [--exe=<Mantle.Sidecar.exe>]
//
// PASSIVE ONLY, and it NEVER changes Owen's machine: reads are checked for shape on this PC, every
// write is sent with dryRun (it must say exactly what it would write, and a fresh read afterwards
// must be identical), and every real write must answer the passive refusal.
'use strict';
const T = require('./test-lib');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const brief = (r) => JSON.stringify(r).slice(0, 300);

(async () => {
  const t = T.checker('SYSSET');
  const s = await T.startPassive();
  const send = (cmd, args, ms) => s.send(cmd, args || {}, ms || 15000);

  // ---------------------------------------------------------------- SysPower
  const p0 = await send('syspower.get');
  t.check('syspower.get answers', p0.ok === true && p0.result && p0.result.ok === true, brief(p0));
  const P = (p0.result || {});
  const st = P.settings || {};
  for (const k of ['screenOff', 'sleep', 'hibernate', 'lid', 'powerButton', 'sleepButton', 'saverAt', 'saverBrightness', 'saverPolicy'])
    t.check(`syspower row ${k} has ac and dc`, st[k] && st[k].ac && st[k].dc && 'value' in st[k].ac && 'writable' in st[k].dc, brief(st[k]));
  t.check('syspower lid choices come from Windows', st.lid && Array.isArray(st.lid.choices) && st.lid.choices.length >= 3 &&
    st.lid.choices.every((c) => typeof c.value === 'number' && typeof c.label === 'string' && c.label.length > 0), brief(st.lid));
  t.check('syspower screenOff has a range', st.screenOff && st.screenOff.range && st.screenOff.range.max > 0, brief(st.screenOff));
  t.check('syspower plan named', P.plan && /^[0-9a-f-]{36}$/.test(P.plan.guid), brief(P.plan));
  t.check('syspower hibernation row says who may change it', P.hibernation && typeof P.hibernation.writable === 'boolean', brief(P.hibernation));

  const cur = st.screenOff && st.screenOff.ac ? st.screenOff.ac.value : 0;
  const want = cur === 600 ? 900 : 600;
  const d1 = await send('syspower.set', { setting: 'screenOff', source: 'both', value: want, dryRun: true });
  t.check('syspower.set dryRun lists the exact writes', d1.ok && d1.result.dryRun === true &&
    d1.result.writes.length === 3 && d1.result.writes[0].api === 'PowerWriteACValueIndex' && d1.result.writes[0].value === want &&
    d1.result.writes[1].api === 'PowerWriteDCValueIndex' && d1.result.writes[2].api === 'PowerSetActiveScheme' &&
    d1.result.wouldRefuse === null, brief(d1));
  const d2 = await send('syspower.set', { setting: 'lid', source: 'dc', value: 77, dryRun: true });
  t.check('syspower.set dryRun refuses a value Windows does not offer', d2.ok && typeof d2.result.wouldRefuse === 'string', brief(d2));
  const d3 = await send('syspower.set', { setting: 'nope', value: 1, dryRun: true });
  t.check('syspower.set names the settings on a bad key', !d3.ok && /screenOff/.test(d3.error), brief(d3));
  const d4 = await send('syspower.set', { setting: 'saverAt', source: 'dc', value: 101, dryRun: true });
  t.check('syspower.set refuses 101%', d4.ok && typeof d4.result.wouldRefuse === 'string', brief(d4));
  const real = await send('syspower.set', { setting: 'screenOff', source: 'ac', value: want });
  t.check('syspower.set real write is refused in passive', !real.ok && real.error.startsWith(T.PASSIVE_REFUSAL), brief(real));
  const h1 = await send('syspower.hibernateSet', { on: !P.hibernation.on, dryRun: true });
  t.check('syspower.hibernateSet dryRun', h1.ok && h1.result.dryRun && h1.result.writes[0].api === 'CallNtPowerInformation', brief(h1));
  const h2 = await send('syspower.hibernateSet', { on: false });
  t.check('syspower.hibernateSet refused in passive', !h2.ok && h2.error.startsWith(T.PASSIVE_REFUSAL), brief(h2));
  const f1 = await send('syspower.fastStartupSet', { on: true, dryRun: true });
  t.check('syspower.fastStartupSet dryRun names the HKLM value', f1.ok && f1.result.writes[0].name === 'HiberbootEnabled' && f1.result.writes[0].hive === 'HKLM', brief(f1));
  const p1 = await send('syspower.get');
  t.check('syspower: nothing changed after the dry runs', same(p0.result.settings, p1.result.settings), 'settings differ');

  // ---------------------------------------------------------------- SysNotify
  const n0 = await send('sysnotify.get', {}, 30000);
  const Nn = n0.result || {};
  t.check('sysnotify.get answers', n0.ok && Nn.ok === true, brief(n0));
  t.check('sysnotify globals', Nn.globals && ['toasts', 'sound', 'lockScreen', 'criticalLock'].every((k) => typeof Nn.globals[k].on === 'boolean'), brief(Nn.globals));
  t.check('sysnotify dnd read through the quiet-hours object', Nn.dnd && (typeof Nn.dnd.on === 'boolean' || typeof Nn.dnd.why === 'string'), brief(Nn.dnd));
  t.check('sysnotify focus says supported or why', Nn.focus && (Nn.focus.supported === true || typeof Nn.focus.why === 'string'), brief(Nn.focus));
  t.check('sysnotify lists apps with switches', Array.isArray(Nn.apps) && Nn.apps.length > 0 &&
    Nn.apps.every((a) => typeof a.app === 'string' && typeof a.enabled === 'boolean' && typeof a.banner === 'boolean' && typeof a.priority === 'number'), `apps ${Nn.apps && Nn.apps.length}`);
  t.check('sysnotify sound/lock per app are read-only with a reason', Nn.appWritable && Nn.appWritable.sound === false && typeof Nn.appWhy.sound === 'string', brief(Nn.appWhy));
  const g1 = await send('sysnotify.set', { key: 'toasts', on: !Nn.globals.toasts.on, dryRun: true });
  t.check('sysnotify.set dryRun names ToastEnabled', g1.ok && g1.result.writes[0].name === 'ToastEnabled' && g1.result.writes[0].hive === 'HKCU', brief(g1));
  const g2 = await send('sysnotify.set', { key: 'toasts', on: Nn.globals.toasts.on });
  t.check('sysnotify.set real write refused in passive', !g2.ok && g2.error.startsWith(T.PASSIVE_REFUSAL), brief(g2));
  const dn = await send('sysnotify.dnd', { on: !Nn.dnd.on, dryRun: true });
  t.check('sysnotify.dnd dryRun names the profile', dn.ok && /QuietHoursProfile\.(PriorityOnly|Unrestricted)/.test(dn.result.writes[0].value), brief(dn));
  const dr = await send('sysnotify.dnd', { on: true });
  t.check('sysnotify.dnd refused in passive', !dr.ok && dr.error.startsWith(T.PASSIVE_REFUSAL), brief(dr));
  const fo = await send('sysnotify.focus', { on: true, minutes: 25, dryRun: true });
  t.check('sysnotify.focus dryRun', fo.ok && fo.result.writes[0].minutes === 25, brief(fo));
  const fb = await send('sysnotify.focus', { on: true, minutes: 999, dryRun: true });
  t.check('sysnotify.focus refuses 999 minutes', !fb.ok, brief(fb));
  if (Nn.apps && Nn.apps[0]) {
    const a = Nn.apps[0];
    const ap = await send('sysnotify.app', { app: a.app, key: 'banner', value: !a.banner, dryRun: true });
    t.check('sysnotify.app dryRun names ShowBanner under that app', ap.ok && ap.result.writes[0].name === 'ShowBanner' && ap.result.writes[0].value === (a.banner ? 0 : 1), brief(ap).replace(a.app, '<app>'));
    const ar = await send('sysnotify.app', { app: a.app, key: 'enabled', value: a.enabled });
    t.check('sysnotify.app real write refused in passive', !ar.ok && ar.error.startsWith(T.PASSIVE_REFUSAL), 'reply');
    const as = await send('sysnotify.app', { app: a.app, key: 'sound', value: true, dryRun: true });
    t.check('sysnotify.app sound says why not', !as.ok && /database/.test(as.error), brief(as));
  }
  const ax = await send('sysnotify.app', { app: 'Not.A.Real.App!x', key: 'enabled', value: true, dryRun: true });
  t.check('sysnotify.app refuses an unknown app', !ax.ok && /not in Windows' notification list/.test(ax.error), brief(ax));
  const n1 = await send('sysnotify.get', {}, 30000);
  t.check('sysnotify: nothing changed after the dry runs', n1.ok && same(Nn.globals, n1.result.globals) && same(Nn.dnd, n1.result.dnd) &&
    same((Nn.apps || []).map((a) => [a.enabled, a.banner, a.center, a.priority]), (n1.result.apps || []).map((a) => [a.enabled, a.banner, a.center, a.priority])), 'differs');

  // ---------------------------------------------------------------- SysMulti
  const m0 = await send('sysmulti.get');
  const M = m0.result || {};
  t.check('sysmulti.get answers', m0.ok && M.ok === true && M.rows, brief(m0));
  for (const k of ['snap', 'snapAssist', 'snapFlyout', 'shake', 'altTabTabs', 'clipboardHistory', 'nearbySharing'])
    t.check(`sysmulti row ${k}`, M.rows && M.rows[k] && (typeof M.rows[k].value === 'boolean' || typeof M.rows[k].value === 'number'), brief(M.rows && M.rows[k]));
  t.check('sysmulti remote desktop row says why (Home cannot host)', M.remoteDesktop && typeof M.remoteDesktop.why === 'string' &&
    (M.edition !== 'Core' || (M.remoteDesktop.writable === false && /Home/.test(M.remoteDesktop.why))), brief(M.remoteDesktop));
  const ms1 = await send('sysmulti.set', { key: 'snap', value: !M.rows.snap.value, dryRun: true });
  t.check('sysmulti.set snap dryRun goes through SystemParametersInfo', ms1.ok && ms1.result.writes[0].action === 'SPI_SETWINARRANGING', brief(ms1));
  const ms2 = await send('sysmulti.set', { key: 'shake', value: true, dryRun: true });
  t.check('sysmulti.set shake is inverted (DisallowShaking 0 = on)', ms2.ok && ms2.result.writes[0].name === 'DisallowShaking' && ms2.result.writes[0].value === 0, brief(ms2));
  const ms3 = await send('sysmulti.set', { key: 'altTabTabs', value: 7, dryRun: true });
  t.check('sysmulti.set refuses a choice Windows does not have', !ms3.ok, brief(ms3));
  const ms4 = await send('sysmulti.set', { key: 'clipboardHistory', value: true });
  t.check('sysmulti.set real write refused in passive', !ms4.ok && ms4.error.startsWith(T.PASSIVE_REFUSAL), brief(ms4));
  const cc = await send('sysmulti.clearClipboard', { dryRun: true });
  t.check('sysmulti.clearClipboard dryRun', cc.ok && /ClearHistory/.test(cc.result.writes[0].api), brief(cc));
  const cr = await send('sysmulti.clearClipboard', {});
  t.check('sysmulti.clearClipboard refused in passive', !cr.ok && cr.error.startsWith(T.PASSIVE_REFUSAL), brief(cr));
  const m1 = await send('sysmulti.get');
  t.check('sysmulti: nothing changed after the dry runs', m1.ok && same(M.rows, m1.result.rows), 'differs');

  // ---------------------------------------------------------------- SysAbout
  const b0 = await send('sysabout.get');
  const B = b0.result || {};
  t.check('sysabout.get answers', b0.ok && B.ok === true, brief(b0));
  t.check('sysabout device specs', B.device && typeof B.device.processor === 'string' && B.device.ramInstalledBytes > 0 && /bit operating system/.test(B.device.systemType), 'device');
  t.check('sysabout windows specs', B.windows && /Windows/.test(B.windows.edition || '') && /^\d+\.\d+$/.test(B.windows.build), brief(B.windows));
  t.check('sysabout Windows 11 is not called Windows 10', !(Number((B.windows && B.windows.build || '0').split('.')[0]) >= 22000 && /Windows 10/.test(B.windows.edition)), brief(B.windows));
  t.check('sysabout rename points at the elevate lane', B.rename && B.rename.elevate === 'system.renamePc', brief(B.rename));
  {
    // the waiting name is read from the same registry pairs Windows keeps (a real read, no write):
    // null when nothing waits, else the NEW name, which then differs from the running one
    const pn = B.device && B.device.pendingName;
    const reg = (key, val) => { try { return (require('child_process').execSync(`reg query "${key}" /v "${val}"`, { encoding: 'utf8' }).match(/REG_SZ\s+(\S+)/) || [])[1] || null; } catch (_) { return null; } };
    const T = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters', C = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\';
    const waits = String(reg(T, 'NV Hostname')).toLowerCase() !== String(reg(T, 'Hostname')).toLowerCase() ||
      String(reg(C + 'ComputerName', 'ComputerName')).toLowerCase() !== String(reg(C + 'ActiveComputerName', 'ComputerName')).toLowerCase();
    t.check('sysabout pendingName matches the registry (null = no rename waiting for a restart)', waits ? typeof pn === 'string' && pn.toLowerCase() !== String(B.device.name).toLowerCase() : pn === null, `${pn} waits=${waits}`);
  }
  const ac = await send('sysabout.activation', {}, 30000);
  t.check('sysabout.activation answers', ac.ok && (typeof (ac.result || {}).activated === 'boolean' || typeof (ac.result || {}).reason === 'string'), brief(ac));
  const rc = await send('sysabout.recovery');
  t.check('sysabout.recovery answers with reasons', rc.ok && rc.result.reset && typeof rc.result.reset.why === 'string' && rc.result.networkReset.elevate === 'system.networkReset', brief(rc));
  const as1 = await send('sysabout.advancedStartup', { dryRun: true });
  t.check('sysabout.advancedStartup dryRun names InitiateShutdown', as1.ok && as1.result.writes[0].api === 'InitiateShutdown', brief(as1));
  const as2 = await send('sysabout.advancedStartup', {});
  t.check('sysabout.advancedStartup refused in passive', !as2.ok && as2.error.startsWith(T.PASSIVE_REFUSAL), brief(as2));

  // ---------------------------------------------------------------- the elevated actions are registered
  const el = await send('elevate.list');
  const names = ((el.result || {}).actions || []).map((a) => a.action);
  for (const a of ['system.hibernate', 'system.fastStartup', 'system.remoteDesktop', 'system.productKey', 'system.networkReset', 'system.renamePc'])
    t.check(`elevated action ${a} registered`, names.includes(a), brief(el));
  t.check('no elevated action left out', el.ok && Array.isArray(el.result.problems) && el.result.problems.length === 0, brief(el.result && el.result.problems));

  await s.stop();
  process.exit(t.summary());
})().catch((e) => { console.error('SYSSET TEST crashed:', e && e.stack || e); process.exit(2); });
