#!/usr/bin/env node
/* test-power.js - power mode + battery, against Windows' own answers (lane sysmon-power, 2026-09-29).
 *
 * WHAT IT CHANGES ON OWEN'S MACHINE: NOTHING. The sidecar runs --passive; every write is a dryRun
 * or a passive refusal - there is no same-value write here at all (test-osd.js has those) - and the
 * plan, both power-mode choices and the battery are read independently before and after and must
 * be identical.
 *
 * THE INDEPENDENT READS (never the sidecar's own code):
 *   plan          powercfg /getactivescheme, and powercfg /list for the installed plans
 *   modes         the registry: HKLM\...\Power\User\PowerSchemes ActiveOverlay{Ac,Dc}PowerScheme
 *   battery       System.Windows.Forms.SystemInformation.PowerStatus (GetSystemPowerStatus via .NET)
 *   low/critical  powercfg /q SCHEME_CURRENT <battery subgroup>: "Current DC Power Setting Index"
 *
 *   node sidecar/test-power.js --exe=<your build>      (or MANTLE_SIDECAR_EXE)
 * Prints "POWER TEST: n passed, m failed"; exits 1 on a failure. Output: counts and shapes only.
 */
'use strict';
const { execFileSync } = require('child_process');
const T = require('./test-lib');

const MODE_OF = { '': 'balanced', '00000000-0000-0000-0000-000000000000': 'balanced',
  '961cc777-2547-4f9d-8174-7d86181b8a7a': 'efficiency', 'ded574b5-45a0-4f42-8737-46345c09c238': 'performance' };
const GUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const run = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });

function independent() {
  const out = { plan: null, plans: [], ac: null, dc: null };
  try { const m = GUID_RE.exec(run('powercfg', ['/getactivescheme'])); out.plan = m ? m[1].toLowerCase() : null; } catch (e) { out.planError = e.message; }
  try {
    out.plans = run('powercfg', ['/list']).split(/\r?\n/).map((l) => GUID_RE.exec(l)).filter(Boolean).map((m) => m[1].toLowerCase());
  } catch (e) { out.listError = e.message; }
  try {
    const s = run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes']);
    const ac = /ActiveOverlayAcPowerScheme\s+REG_SZ\s*([^\r\n]*)/.exec(s);
    const dc = /ActiveOverlayDcPowerScheme\s+REG_SZ\s*([^\r\n]*)/.exec(s);
    out.ac = MODE_OF[ac ? ac[1].trim().toLowerCase() : ''] || 'other';
    out.dc = MODE_OF[dc ? dc[1].trim().toLowerCase() : ''] || 'other';
  } catch (e) { out.regError = e.message; }
  return out;
}

function powerStatus() {
  const ps = 'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.SystemInformation]::PowerStatus; ' +
    '"$($p.PowerLineStatus)|$($p.BatteryChargeStatus)|$($p.BatteryLifePercent)|$($p.BatteryLifeRemaining)"';
  const [line, charge, pct, secs] = run('powershell', ['-NoProfile', '-Command', ps]).trim().split('|');
  return { line, charge, percent: Math.round(parseFloat(pct) * 100), seconds: parseInt(secs, 10) };
}

function levels() {
  const q = run('powercfg', ['/q', 'SCHEME_CURRENT', 'e73a048d-bf27-4f12-9731-8b2076e8891f']);
  const dcOf = (guid) => {
    const i = q.indexOf(guid);
    if (i < 0) return null;
    const m = /Current DC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(q.slice(i));
    return m ? parseInt(m[1], 16) : null;
  };
  return { lowAt: dcOf('8183ba9a-e910-48da-8769-14ae6dc1170a'), criticalAt: dcOf('9a66d8d7-4ff7-4ef9-b5a2-5a326ca2a469') };
}

(async () => {
  const t = T.checker('POWER');
  const exe = T.exePath();
  const before = independent();
  t.check('independent reads work (powercfg, registry)', !!before.plan && before.plans.length > 0 && !before.regError, JSON.stringify(before));
  let s;
  try { s = await T.startPassive({ exe }); } catch (e) { t.fail('the sidecar starts passive', e.message); process.exit(t.summary()); }
  try {
    const ping = await s.call('ping', {}, 15000);
    const cmds = (ping.features && ping.features.commands) || [];
    t.check('ping lists powermode.get/set/plan/watch/decide', ['get', 'set', 'plan', 'watch', 'decide'].every((c) => cmds.includes('powermode.' + c)), cmds.filter((c) => /^powermode/.test(c)).join(' '));

    /* ---------------- BATTERY: the reading vs GetSystemPowerStatus through .NET */
    const b = await s.call('battery', {}, 4000);
    const ps = powerStatus();
    const noBattery = /NoSystemBattery/.test(ps.charge);
    t.check('battery: present agrees with .NET PowerStatus', b.present === !noBattery, JSON.stringify({ sidecar: b.present, charge: ps.charge }));
    t.check('battery: on AC agrees', b.ac === (ps.line === 'Online' ? true : ps.line === 'Offline' ? false : null), JSON.stringify({ sidecar: b.ac, line: ps.line }));
    if (!noBattery) {
      t.check('battery: percent agrees (the number Windows shows)', b.percent === ps.percent, JSON.stringify({ sidecar: b.percent, dotnet: ps.percent }));
      t.check('battery: charging agrees with the Charging flag', b.charging === /Charging/.test(ps.charge), JSON.stringify({ sidecar: b.charging, charge: ps.charge }));
      t.check('battery: a time left only on battery, and never an "unknown" as a number',
        (b.ac === true ? b.secondsLeft === null : true) && (b.secondsLeft === null || (b.secondsLeft >= 0 && b.secondsLeft < 360000)), JSON.stringify({ ac: b.ac, s: b.secondsLeft }));
      if (b.ac === false && ps.seconds >= 0) t.check('battery: seconds left agree within 2 min', Math.abs(b.secondsLeft - ps.seconds) <= 120, `${b.secondsLeft} vs ${ps.seconds}`);
    }
    // FIXED 2026-09-29: the readout warned on BatteryFlag's "low" bit (under 33 %); it now carries the
    // plan's own warning levels. Before this fix lowAt/criticalAt did not exist.
    const lv = levels();
    t.check('battery: lowAt = the plan\'s DC "Low battery level" (powercfg)', b.lowAt === lv.lowAt && Number.isInteger(b.lowAt), JSON.stringify({ sidecar: b.lowAt, powercfg: lv.lowAt }));
    t.check('battery: criticalAt = the plan\'s DC "Critical battery level" (powercfg)', b.criticalAt === lv.criticalAt && Number.isInteger(b.criticalAt), JSON.stringify({ sidecar: b.criticalAt, powercfg: lv.criticalAt }));
    const pw = await s.call('power', {}, 4000);
    t.check('power (the older name) carries the same reading, levels included', pw.percent === b.percent && pw.lowAt === b.lowAt && pw.onBattery === (b.ac === false), JSON.stringify({ p: pw.percent, l: pw.lowAt }));
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) await s.call('battery', {}, 4000);
    const perRead = (Date.now() - t0) / 20;
    t.check('battery: a read stays cheap (under 25 ms round trip)', perRead < 25, perRead.toFixed(1) + ' ms');
    console.log(`  battery: present=${b.present} ac=${b.ac} charging=${b.charging} percent=${b.percent} lowAt=${b.lowAt} criticalAt=${b.criticalAt} read=${perRead.toFixed(1)}ms`);

    const w = await s.call('battery', { watch: true }, 4000);
    t.check('battery watch arms the same three registrations', w.watching === true && w.registered.length === 3 && w.watchReason === null, JSON.stringify(w.registered));
    const off = await s.call('battery', { watch: false }, 4000);
    t.check('battery watch stops', off.watching === false && off.registered.length === 0, JSON.stringify(off.registered));

    /* ---------------- POWER MODE: the read vs powercfg + the registry */
    const g = await s.call('powermode.get', {}, 5000);
    t.check('powermode.get: plan = powercfg /getactivescheme', g.plan && g.plan.guid === before.plan, JSON.stringify({ sidecar: g.plan && g.plan.guid, powercfg: before.plan }));
    t.check('powermode.get: plans = powercfg /list (same set)', Array.isArray(g.plans) && g.plans.length === before.plans.length &&
      g.plans.every((p) => before.plans.includes(p.guid)) && g.plans.filter((p) => p.active).length === 1, `${(g.plans || []).length} vs ${before.plans.length}`);
    t.check('powermode.get: source agrees with the battery reading', g.source === (b.ac === true ? 'ac' : b.ac === false ? 'battery' : 'unknown'), `${g.source} / ${b.ac}`);
    t.check('powermode.get: the choice per source = the registry', g.configured && g.configured.ac === before.ac && g.configured.battery === before.dc,
      JSON.stringify({ sidecar: g.configured, reg: { ac: before.ac, dc: before.dc } }));
    t.check('powermode.get: mode = the choice for the current source', g.mode === (g.source === 'battery' ? before.dc : before.ac), `${g.mode}`);
    t.check('powermode.get: available = on the Balanced plan', g.available === (before.plan === '381b4222-f694-41f0-9685-ff5bb260df2e'), String(g.available));
    t.check('powermode.get: settable only when available and Energy saver off', g.settable === (g.available && !g.saver), JSON.stringify({ a: g.available, s: g.saver, set: g.settable }));
    t.check('powermode.get: a locked or unavailable switch always says why', g.settable || (typeof g.reason === 'string' && g.reason.length > 10), String(g.reason));
    console.log(`  powermode: mode=${g.mode} inForce=${g.inForce} source=${g.source} saver=${g.saver} available=${g.available} settable=${g.settable} plans=${(g.plans || []).length} ${g.ms} ms`);

    /* ---------------- set: bad arguments refused in words, before anything is called */
    for (const [label, arg] of [['nothing', {}], ['"turbo"', { mode: 'turbo' }], ['a number', { mode: 5 }], ['""', { mode: '' }], ['"Balanced" (case)', { mode: 'Balanced' }]]) {
      const r = await s.send('powermode.set', Object.assign({ dryRun: true }, arg), 4000);
      t.check(`powermode.set refuses ${label} with a reason naming the three modes`, r.ok === false && /efficiency/.test(r.error || '') && /performance/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
    }

    /* ---------------- set: dryRun of every mode (FIXED 2026-09-29: there was no dryRun at all) */
    for (const mode of ['efficiency', 'balanced', 'performance']) {
      const r = await s.call('powermode.set', { mode, dryRun: true }, 5000);
      if (g.settable) {
        t.check(`dryRun ${mode}: ok, marked dryRun, says what it would do`, r.ok === true && r.dryRun === true && typeof r.would === 'string' && r.would.length > 5, JSON.stringify(r).slice(0, 240));
        t.check(`dryRun ${mode}: would write this source's value`, r.wroteFor === g.source, `${r.wroteFor} vs ${g.source}`);
        t.check(`dryRun ${mode}: same only when it is the current choice`, r.same === (mode === g.mode), String(r.same));
      } else {
        t.check(`dryRun ${mode}: refused like a real set, with the lock's reason`, r.ok === false && r.reason === g.reason && !r.dryRun, JSON.stringify(r).slice(0, 240));
      }
    }
    /* a real different-mode set in --passive: refused (or the lock), nothing written */
    const other = g.mode === 'performance' ? 'balanced' : 'performance';
    const d = await s.call('powermode.set', { mode: other }, 5000);
    t.check('a real different-mode set is refused in --passive (or by the lock) with a reason', d.ok === false && /passive|Balanced|Energy saver/.test(d.reason || ''), JSON.stringify(d).slice(0, 240));

    /* ---------------- plan: bad arguments, dryRun, passive */
    const bad = await s.send('powermode.plan', { plan: 'balanced please', dryRun: true }, 4000);
    t.check('powermode.plan refuses a non-GUID', bad.ok === false && /GUID/.test(bad.error || ''), JSON.stringify(bad).slice(0, 200));
    const none = await s.send('powermode.plan', { plan: '12345678-1234-1234-1234-123456789abc', dryRun: true }, 4000);
    t.check('powermode.plan refuses a plan that is not installed', none.ok === false && /no installed power plan/.test(none.error || ''), JSON.stringify(none).slice(0, 200));
    const act = (g.plans || []).find((p) => p.active);
    const alt = (g.plans || []).find((p) => !p.active);
    if (act) {
      const r = await s.call('powermode.plan', { plan: act.guid, dryRun: true }, 6000);
      t.check('plan dryRun of the active plan: ok, same, nothing to do', r.ok === true && r.dryRun === true && r.same === true && /nothing/.test(r.would), JSON.stringify(r).slice(0, 200));
    }
    if (alt) {
      const r = await s.call('powermode.plan', { plan: alt.guid, dryRun: true }, 6000);
      t.check('plan dryRun of another plan: ok, names both plans, no switch', r.ok === true && r.dryRun === true && r.same === false && r.would.includes(alt.name) && r.would.includes(act.name), JSON.stringify(r).slice(0, 240));
      const p = await s.call('powermode.plan', { plan: alt.guid }, 6000);
      t.check('a real plan switch in --passive is refused with the passive reason', p.ok === false && /passive/.test(p.reason || ''), JSON.stringify(p).slice(0, 200));
    }

    /* ---------------- the pure logic: the rows the panel depends on */
    const BAL = '00000000-0000-0000-0000-000000000000', PERF = 'ded574b5-45a0-4f42-8737-46345c09c238', EFF = '961cc777-2547-4f9d-8174-7d86181b8a7a';
    const dec = (f) => s.call('powermode.decide', f, 4000);
    let r = await dec({ source: 'battery', ac: BAL, dc: PERF, actual: PERF, effective: EFF, saver: 1, saverAt: 100 });
    t.check('decide: Energy saver on (at 100%): choice kept, locked, says always-on-when-unplugged', r.mode === 'performance' && r.inForce === 'efficiency' && r.settable === false && r.saver === true && r.saverAt === 100 && /100%/.test(r.reason), JSON.stringify(r).slice(0, 200));
    r = await dec({ source: 'ac', ac: PERF, dc: BAL, effective: PERF, saver: 0 });
    t.check('decide: plugged in, performance: settable, no reason', r.mode === 'performance' && r.settable === true && r.reason === null && r.configured.battery === 'balanced', JSON.stringify(r).slice(0, 200));
    r = await dec({ plan: '44444444-4444-4444-4444-444444444452', planName: 'Some plan', source: 'ac', ac: BAL, saver: 0 });
    t.check('decide: not on Balanced: unavailable, names the plan', r.available === false && r.settable === false && /Some plan/.test(r.reason), JSON.stringify(r).slice(0, 200));

    /* ---------------- the watch: arms, no push without a change, stops */
    const wr = await s.call('powermode.watch', { on: true }, 5000);
    t.check('powermode.watch on: answers with the state', wr.ok === true && wr.state && wr.state.mode === g.mode, JSON.stringify(wr).slice(0, 200));
    await T.sleep(1500);
    t.check('no powermode push without a change', s.collect('powermode').length === 0, String(s.collect('powermode').length));
    const wo = await s.call('powermode.watch', { on: false }, 5000);
    t.check('powermode.watch off', wo.watching === false, JSON.stringify(wo).slice(0, 120));
    const wr2 = await s.call('powermode.watch', { on: true }, 5000);
    t.check('powermode.watch re-arms after off (a sidecar restart / feature toggle)', wr2.ok === true && wr2.mode === true && wr2.plan === true && wr2.source === true, JSON.stringify(wr2).slice(0, 200));
    await s.call('powermode.watch', { on: false }, 5000);
  } catch (e) {
    t.fail('no exception', e.stack);
  } finally {
    await s.stop();
  }
  const after = independent();
  t.check('independent: the plan is unchanged', after.plan === before.plan, JSON.stringify({ before: before.plan, after: after.plan }));
  t.check('independent: both power-mode choices are unchanged', after.ac === before.ac && after.dc === before.dc, JSON.stringify({ before, after }));
  process.exit(t.summary());
})();
