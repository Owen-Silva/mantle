// test-devices.js - the Bluetooth & devices backends: DevPair.cs (devpair.*) and DevPrinters.cs
// (printers.*), plus their [Elevated] actions (devnet lane, 2026-09-28).
//
//   node sidecar/test-devices.js --exe=<built exe>          reads, dryRuns, passive refusals, bad args
//   node sidecar/test-devices.js --exe=<built exe> --scan   + ONE short Bluetooth scan (6 s lease)
//
// NEVER changes the user's machine: the sidecar is passive, every write is proven by its dryRun (for a
// REAL target read from the machine, and a bogus one) and by its passive refusal. The scan is a read,
// gated behind --scan so it runs at most when asked (the user's rule: at most two short scans).
// Prints counts and shapes only: no device, printer, document or owner names, no addresses.
'use strict';

const T = require('./test-lib');

const SCAN = process.argv.includes('--scan');
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : String(o));
/** A failure detail with the error text or the reply's keys, never its values (names live there). */
const shape = (r) => (r && r.ok === false ? 'error: ' + String(r.error).slice(0, 160) : 'keys: ' + keys(r && r.result));

(async () => {
  const t = T.checker('DEVICES');
  const s = await T.startPassive();
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 15000);
  const refused = (r) => r && r.ok === false && String(r.error).startsWith(T.PASSIVE_REFUSAL);
  const plainErr = (r) => r && r.ok === false && isStr(r.error) && !String(r.error).startsWith(T.PASSIVE_REFUSAL);
  const dryOk = (r) => r && r.ok === true && r.result && r.result.dryRun === true && isStr(r.result.would);
  const notes = [];

  try {
    // ---------------------------------------------------------------- registration
    const ping = await send('ping', {}, 8000);
    const feats = (ping.result && ping.result.features) || {};
    const cmds = feats.commands || [];
    const want = ['devpair.scan', 'devpair.list', 'devpair.pair', 'devpair.respond', 'devpair.cancel', 'devpair.unpair',
      'devpair.options', 'devpair.setOption', 'printers.list', 'printers.setDefault', 'printers.manage', 'printers.remove',
      'printers.queue', 'printers.cancelJob', 'printers.pauseJob', 'printers.resumeJob', 'printers.addNetwork'];
    const missing = want.filter((c) => !cmds.includes(c));
    t.check('ping lists all 17 devpair.* / printers.* commands', missing.length === 0, 'missing ' + missing.join(','));
    const probs = (feats.problems || []).filter((p) => /DevPair|DevPrinters/.test(p));
    t.check('ping names no DevPair / DevPrinters problem', probs.length === 0, probs.join('; '));

    const el = await send('elevate.list', {}, 8000);
    const acts = ((el.result && el.result.actions) || []).map((a) => a.action);
    for (const a of ['devpair.meteredDownload', 'printers.removeLocal', 'printers.addTcp']) {
      t.check(`elevate.list registers ${a}`, acts.includes(a), shape(el));
    }
    const eprobs = ((el.result && el.result.problems) || []).filter((p) => /devpair|printers|DevPair|DevPrinters/.test(String(p)));
    t.check('elevate.list names no problem in these files', eprobs.length === 0, eprobs.join('; '));

    // ---------------------------------------------------------------- devpair.options / setOption
    const op = await send('devpair.options');
    const opts = (op.result && op.result.options) || [];
    t.check('devpair.options answers ok with 3 options', op.ok && isBool(op.result.ok) && opts.length === 3, shape(op));
    const byKey = {};
    for (const o of opts) byKey[o.key] = o;
    t.check('options: swiftPair bool, user scope, no admin, no broadcast',
      byKey.swiftPair && isBool(byKey.swiftPair.value) && byKey.swiftPair.scope === 'user' && byKey.swiftPair.admin === false &&
      byKey.swiftPair.broadcast === false && isStr(byKey.swiftPair.where), keys(byKey.swiftPair));
    t.check('options: discoveryMode default|advanced',
      byKey.discoveryMode && ['default', 'advanced'].includes(byKey.discoveryMode.value), keys(byKey.discoveryMode));
    t.check('options: meteredDownload bool, machine scope, admin, elevate action',
      byKey.meteredDownload && isBool(byKey.meteredDownload.value) && byKey.meteredDownload.admin === true &&
      byKey.meteredDownload.elevate === 'devpair.meteredDownload', keys(byKey.meteredDownload));
    for (const o of opts) {
      t.check(`options: ${o.key} says why when it is Windows' default`, !o.isDefault || isStr(o.reason), keys(o));
    }

    const spCur = byKey.swiftPair ? byKey.swiftPair.value : true;
    let r = await send('devpair.setOption', { key: 'swiftPair', value: spCur, dryRun: true });
    t.check('setOption swiftPair dryRun: would + needsAdmin false', dryOk(r) && r.result.needsAdmin === false, shape(r));
    r = await send('devpair.setOption', { key: 'discoveryMode', value: 'advanced', dryRun: true });
    t.check('setOption discoveryMode dryRun: would', dryOk(r) && /AdvancedDiscoveryMode/.test(r.result.would), shape(r));
    r = await send('devpair.setOption', { key: 'meteredDownload', value: true, dryRun: true });
    t.check('setOption meteredDownload dryRun: needsAdmin + elevate plan', dryOk(r) && r.result.needsAdmin === true &&
      r.result.elevate && r.result.elevate.action === 'devpair.meteredDownload' && r.result.elevate.args.on === true, shape(r));
    r = await send('devpair.setOption', { key: 'swiftPair', value: spCur });
    t.check('setOption swiftPair real: passive refusal', refused(r), shape(r));
    r = await send('devpair.setOption', { key: 'discoveryMode', value: 'default' });
    t.check('setOption discoveryMode real: passive refusal', refused(r), shape(r));
    r = await send('devpair.setOption', { key: 'meteredDownload', value: false });
    t.check('setOption meteredDownload real: passive refusal', refused(r), shape(r));
    for (const [label, args] of [
      ['no key', { value: true, dryRun: true }],
      ['unknown key', { key: 'bogus', value: true, dryRun: true }],
      ['swiftPair "yes"', { key: 'swiftPair', value: 'yes', dryRun: true }],
      ['discoveryMode "fast"', { key: 'discoveryMode', value: 'fast', dryRun: true }],
      ['no value', { key: 'swiftPair', dryRun: true }],
      ['dryRun "true" (a string)', { key: 'swiftPair', value: true, dryRun: 'true' }],
    ]) {
      r = await send('devpair.setOption', args);
      t.check(`setOption ${label}: plain error`, plainErr(r), shape(r));
    }

    // ---------------------------------------------------------------- devpair.list / scan args
    r = await send('devpair.list');
    t.check('devpair.list (no scan yet): ok, not scanning, devices [], reason', r.ok && r.result.scanning === false &&
      Array.isArray(r.result.devices) && isNum(r.result.nameless) && isStr(r.result.reason), shape(r));
    for (const [label, args] of [
      ['no on', {}], ['on "yes"', { on: 'yes' }], ['leaseMs 5', { on: true, leaseMs: 5 }],
      ['leaseMs "x"', { on: true, leaseMs: 'x' }], ['leaseMs 999999', { on: true, leaseMs: 999999 }],
    ]) {
      r = await send('devpair.scan', args);
      t.check(`devpair.scan ${label}: plain error`, plainErr(r), shape(r));
    }
    r = await send('devpair.scan', { on: false });
    t.check('devpair.scan off while idle: ok, stopped false', r.ok && r.result.scanning === false && r.result.stopped === false, shape(r));

    // ---------------------------------------------------------------- a real paired device (btdevices)
    const bl = await send('btdevices', { op: 'list' }, 15000);
    const paired = (bl.ok && bl.result && bl.result.devices) || [];
    console.log(`  btdevices: ${paired.length} paired device(s)`);
    const real = paired.length ? paired[0].id : null;
    const bogus = 'Bluetooth#Bluetooth00:00:00:00:00:00-00:00:00:00:00:00';

    if (real) {
      r = await send('devpair.unpair', { device: real, dryRun: true }, 20000);
      const ent = (r.result && r.result.entries) || [];
      t.check('unpair dryRun (real paired device): would + entries with device/protocol', dryOk(r) && ent.length >= 1 &&
        ent.every((e) => isStr(e.device) && ['classic', 'le'].includes(e.protocol)), shape(r));
      console.log(`  unpair plan: ${ent.length} AEP entr${ent.length === 1 ? 'y' : 'ies'}`);
      r = await send('devpair.unpair', { device: real }, 20000);
      t.check('unpair real (paired device): passive refusal', refused(r), shape(r));
      r = await send('devpair.pair', { device: real, dryRun: true }, 20000);
      t.check('pair dryRun (paired device): isPaired, 4 ceremonies, would', dryOk(r) && r.result.isPaired === true &&
        (r.result.ceremonies || []).length === 4 && isStr(r.result.protectionLevel), shape(r));
      r = await send('devpair.pair', { device: real });
      t.check('pair real: passive refusal', refused(r), shape(r));
    } else {
      notes.push('no paired Bluetooth device: unpair/pair dryRun on a real device not exercised');
    }
    r = await send('devpair.unpair', { device: bogus, dryRun: true }, 20000);
    t.check('unpair dryRun (bogus id): plain error', plainErr(r), shape(r));
    r = await send('devpair.pair', { device: bogus, dryRun: true }, 20000);
    t.check('pair dryRun (bogus id): plain error', plainErr(r), shape(r));
    for (const [cmd, label, args] of [
      ['devpair.unpair', 'no device', { dryRun: true }],
      ['devpair.unpair', 'device 5', { device: 5, dryRun: true }],
      ['devpair.pair', 'no device', { dryRun: true }],
      ['devpair.pair', 'device ""', { device: '', dryRun: true }],
      ['devpair.pair', 'dryRun 1', { device: bogus, dryRun: 1 }],
    ]) {
      r = await send(cmd, args);
      t.check(`${cmd} ${label}: plain error`, plainErr(r), shape(r));
    }

    // respond / cancel: no session exists in a passive sidecar
    const secret = '739154';
    r = await send('devpair.respond', { session: 'nosuchsession', accept: true, pin: secret });
    t.check('respond (unknown session): plain error', plainErr(r), shape(r));
    t.check('respond never echoes the PIN', !JSON.stringify(r).includes(secret) && !s.stderr.includes(secret), 'PIN seen');
    r = await send('devpair.respond', { accept: true });
    t.check('respond (no session): plain error', plainErr(r), shape(r));
    r = await send('devpair.respond', { session: 'nosuchsession' });
    t.check('respond (no accept): plain error', plainErr(r), shape(r));
    r = await send('devpair.cancel', { session: 'nosuchsession' });
    t.check('cancel (unknown session): plain error', plainErr(r), shape(r));
    r = await send('devpair.cancel', {});
    t.check('cancel (no session): plain error', plainErr(r), shape(r));

    // ---------------------------------------------------------------- the one live scan (--scan)
    if (SCAN) {
      const t0 = Date.now();
      r = await send('devpair.scan', { on: true, leaseMs: 6000 }, 10000);
      if (r.ok && r.result.ok === false) {
        t.check('scan refused with a reason (radio off / absent)', isStr(r.result.reason), shape(r));
        notes.push('scan not run: ' + r.result.reason);
      } else {
        t.check('scan on: ok, scanning, started, leaseMs 6000', r.ok && r.result.scanning === true &&
          r.result.started === true && r.result.leaseMs === 6000, shape(r));
        r = await send('devpair.scan', { on: true, leaseMs: 6000 }, 10000);
        t.check('scan on again renews (started false)', r.ok && r.result.scanning === true && r.result.started === false, shape(r));
        let stopped = null;
        try {
          stopped = await s.waitEvent('devpair', 9000, (e) => e.kind === 'stopped');
        } catch (e) { /* checked below */ }
        const ms = Date.now() - t0;
        t.check('scan lapses by itself (stopped push with a reason)', stopped && isStr(stopped.reason) && /lapsed/.test(stopped.reason),
          stopped ? keys(stopped) : 'no stopped event within 9 s');
        const evs = s.collect('devpair');
        const found = evs.filter((e) => e.kind === 'found');
        const done = evs.filter((e) => e.kind === 'done');
        t.check('found pushes carry the documented device shape', found.every((e) => e.device && isStr(e.device.device) &&
          typeof e.device.name === 'string' && ['audio', 'input', 'phone', 'computer', 'display', 'other'].includes(e.device.kind) &&
          ['classic', 'le'].includes(e.device.protocol) && isBool(e.device.canPair)), found.length ? keys(found[0].device) : 'none');
        r = await send('devpair.list');
        t.check('list after the scan: not scanning, devices + counts', r.ok && r.result.scanning === false &&
          Array.isArray(r.result.devices) && isNum(r.result.nameless) && isNum(r.result.away), shape(r));
        const nDev = r.ok ? r.result.devices.length : -1;
        console.log(`  scan: ${ms} ms, ${found.length} found push(es), ${evs.filter((e) => e.kind === 'updated').length} updated, ` +
          `${done.length} done, list ${nDev} shown / ${r.ok ? r.result.nameless : '?'} nameless / ${r.ok ? r.result.away : '?'} away`);
        const cand = r.ok ? r.result.devices.find((d) => d.canPair) : null;
        if (cand) {
          r = await send('devpair.pair', { device: cand.device, dryRun: true }, 20000);
          t.check('pair dryRun (a found, unpaired device): not paired, canPair, would', dryOk(r) && r.result.isPaired === false, shape(r));
        } else {
          notes.push('no pairable device was in range: pair dryRun on an unpaired device not exercised');
        }
      }
    } else {
      notes.push('live scan skipped (run with --scan)');
    }

    // ---------------------------------------------------------------- printers.list
    const pl = await send('printers.list', {}, 30000);
    const prs = (pl.result && pl.result.printers) || [];
    t.check('printers.list: ok, printers[], letWindowsManage, scanners[]', pl.ok && pl.result.ok === true && Array.isArray(prs) &&
      isBool(pl.result.letWindowsManage) && Array.isArray(pl.result.scanners) && isStr(pl.result.scannersVia), shape(pl));
    t.check('printers.list rows have the documented shape', prs.every((p) => isStr(p.printer) && typeof p.port === 'string' &&
      typeof p.driver === 'string' && Array.isArray(p.status) && isStr(p.statusText) && isNum(p.jobs) && isBool(p.isDefault) &&
      isBool(p.shared) && isBool(p.offline) && ['local', 'connection'].includes(p.kind)), prs.length ? keys(prs[0]) : 'no printers');
    const defs = prs.filter((p) => p.isDefault);
    t.check('at most one default printer, matching default', defs.length <= 1 &&
      (defs.length === 0 || defs[0].printer === pl.result.default), `${defs.length} defaults`);
    t.check('scanners carry scanner/name/enabled', (pl.result.scanners || []).every((x) => isStr(x.scanner) && typeof x.name === 'string' &&
      isBool(x.enabled)), 'scanner shape');
    console.log(`  printers: ${prs.length} (${prs.filter((p) => p.kind === 'local').length} local, ` +
      `${prs.filter((p) => p.kind === 'connection').length} connection(s)), ${defs.length} default, ` +
      `${(pl.result && pl.result.scanners || []).length} scanner(s), letWindowsManage ${pl.result && pl.result.letWindowsManage}`);

    const dflt = defs[0] || prs[0];
    const other = prs.find((p) => !p.isDefault);
    const local = prs.find((p) => p.kind === 'local');
    const conn = prs.find((p) => p.kind === 'connection');
    const noPrinter = 'Mantle No Such Printer 7f3a';

    // queue
    if (dflt) {
      r = await send('printers.queue', { printer: dflt.printer }, 20000);
      const jobs = (r.result && r.result.jobs) || [];
      t.check('printers.queue (real printer): ok, jobs[], count', r.ok && r.result.ok === true && Array.isArray(jobs) &&
        r.result.count === jobs.length, shape(r));
      t.check('queue jobs have the documented shape', jobs.every((j) => isNum(j.job) && isNum(j.pages) && isNum(j.size) &&
        Array.isArray(j.status) && isStr(j.statusText) && isBool(j.own)), jobs.length ? keys(jobs[0]) : 'empty');
      let jobsTotal = 0;
      let withJob = null;
      for (const p of prs) {
        if (!p.jobs) continue;
        jobsTotal += p.jobs;
        if (!withJob) withJob = p;
      }
      console.log(`  queues: ${jobsTotal} job(s) across all printers`);
      if (withJob) {
        const q = await send('printers.queue', { printer: withJob.printer }, 20000);
        const j = q.ok && q.result.jobs[0];
        if (j) {
          r = await send('printers.cancelJob', { printer: withJob.printer, job: j.job, dryRun: true }, 20000);
          t.check('cancelJob dryRun (a real job): would + own + needsAdmin', dryOk(r) && isBool(r.result.own) &&
            r.result.needsAdmin === !r.result.own, shape(r));
        }
      } else {
        notes.push('every queue is empty: cancelJob dryRun on a real job not exercised');
      }
      r = await send('printers.cancelJob', { printer: dflt.printer, job: 999999, dryRun: true }, 20000);
      t.check('cancelJob dryRun (no such job): plain error', plainErr(r), shape(r));
      for (const c of ['cancelJob', 'pauseJob', 'resumeJob']) {
        r = await send('printers.' + c, { printer: dflt.printer, job: 1 });
        t.check(`${c} real: passive refusal`, refused(r), shape(r));
      }
      r = await send('printers.pauseJob', { printer: dflt.printer, job: 999999, dryRun: true }, 20000);
      t.check('pauseJob dryRun (no such job): plain error', plainErr(r), shape(r));

      // setDefault
      r = await send('printers.setDefault', { printer: dflt.printer, dryRun: true }, 20000);
      t.check('setDefault dryRun (current default): would, already', dryOk(r) && r.result.already === !!defs.length &&
        isBool(r.result.letWindowsManage), shape(r));
      t.check('setDefault dryRun notes that Windows may move it back when it manages', !r.result || !r.result.letWindowsManage ||
        isStr(r.result.note), shape(r));
      if (other) {
        r = await send('printers.setDefault', { printer: other.printer, dryRun: true }, 20000);
        t.check('setDefault dryRun (another printer): already false', dryOk(r) && r.result.already === false, shape(r));
      }
      r = await send('printers.setDefault', { printer: dflt.printer });
      t.check('setDefault real: passive refusal', refused(r), shape(r));
    } else {
      notes.push('no printers installed: queue/setDefault on a real printer not exercised');
    }
    r = await send('printers.setDefault', { printer: noPrinter, dryRun: true }, 20000);
    t.check('setDefault dryRun (bogus printer): plain error', plainErr(r), shape(r));
    r = await send('printers.queue', { printer: noPrinter }, 20000);
    t.check('queue (bogus printer): plain error', plainErr(r), shape(r));

    // manage
    r = await send('printers.manage', { on: true, dryRun: true });
    t.check('manage dryRun on: would (LegacyDefaultPrinterMode 0 + broadcast)', dryOk(r) && /LegacyDefaultPrinterMode to 0/.test(r.result.would) &&
      /WM_SETTINGCHANGE/.test(r.result.would) && isBool(r.result.current), shape(r));
    r = await send('printers.manage', { on: false, dryRun: true });
    t.check('manage dryRun off: would (LegacyDefaultPrinterMode 1)', dryOk(r) && /LegacyDefaultPrinterMode to 1/.test(r.result.would), shape(r));
    r = await send('printers.manage', { on: !!(pl.result && pl.result.letWindowsManage) });
    t.check('manage real: passive refusal', refused(r), shape(r));

    // remove
    if (local) {
      r = await send('printers.remove', { printer: local.printer, dryRun: true }, 20000);
      t.check('remove dryRun (a local printer): route local, admin check, elevate plan when needed', dryOk(r) &&
        r.result.route === 'local' && isBool(r.result.needsAdmin) && isStr(r.result.adminCheck) &&
        (!r.result.needsAdmin || (r.result.elevate && r.result.elevate.action === 'printers.removeLocal')), shape(r));
      console.log(`  remove plan (local): needsAdmin ${r.result && r.result.needsAdmin}`);
      r = await send('printers.remove', { printer: local.printer }, 20000);
      t.check('remove real (local): passive refusal', refused(r), shape(r));
    }
    if (conn) {
      r = await send('printers.remove', { printer: conn.printer, dryRun: true }, 20000);
      t.check('remove dryRun (a connection): route connection, no admin', dryOk(r) && r.result.route === 'connection' &&
        r.result.needsAdmin === false, shape(r));
    } else {
      notes.push('no per-user printer connection: remove dryRun on a connection not exercised');
    }
    r = await send('printers.remove', { printer: noPrinter, dryRun: true }, 20000);
    t.check('remove dryRun (bogus printer): plain error', plainErr(r), shape(r));

    // addNetwork
    r = await send('printers.addNetwork', { path: '\\\\localhost\\' + noPrinter, dryRun: true }, 30000);
    t.check('addNetwork dryRun (share path): route connection, reachable reported', dryOk(r) && r.result.route === 'connection' &&
      isBool(r.result.reachable) && (r.result.reachable || isStr(r.result.reason)), shape(r));
    r = await send('printers.addNetwork', { address: '192.168.1.250', dryRun: true }, 20000);
    const drivers = (r.result && r.result.drivers) || [];
    t.check('addNetwork dryRun (address, no driver): route tcp, drivers[], asks for a driver', dryOk(r) && r.result.route === 'tcp' &&
      Array.isArray(drivers) && r.result.needsAdmin === true && isStr(r.result.reason) && r.result.port === 'IP_192.168.1.250', shape(r));
    console.log(`  installed printer drivers: ${drivers.length}`);
    if (drivers.length) {
      r = await send('printers.addNetwork', { address: '192.168.1.250', name: 'Mantle Test Printer 7f3a', driver: drivers[0], dryRun: true }, 20000);
      t.check('addNetwork dryRun (address + installed driver): elevate printers.addTcp plan', dryOk(r) && r.result.reason === null &&
        r.result.elevate && r.result.elevate.action === 'printers.addTcp' && r.result.elevate.args.driver === drivers[0], shape(r));
    }
    r = await send('printers.addNetwork', { address: '192.168.1.250', driver: 'Mantle No Such Driver', dryRun: true }, 20000);
    t.check('addNetwork dryRun (bogus driver): says so', dryOk(r) && /no printer driver/.test(r.result.reason || ''), shape(r));
    r = await send('printers.addNetwork', { path: '\\\\localhost\\' + noPrinter });
    t.check('addNetwork real (share path): passive refusal', refused(r), shape(r));
    r = await send('printers.addNetwork', { address: '192.168.1.250', driver: drivers[0] || 'x' });
    t.check('addNetwork real (address): passive refusal', refused(r), shape(r));

    // bad args across printers.*
    for (const [cmd, label, args] of [
      ['printers.setDefault', 'no printer', { dryRun: true }],
      ['printers.setDefault', 'printer 5', { printer: 5, dryRun: true }],
      ['printers.remove', 'no printer', { dryRun: true }],
      ['printers.remove', 'dryRun "yes"', { printer: noPrinter, dryRun: 'yes' }],
      ['printers.queue', 'no printer', {}],
      ['printers.manage', 'no on', { dryRun: true }],
      ['printers.manage', 'on "yes"', { on: 'yes', dryRun: true }],
      ['printers.cancelJob', 'no job', { printer: noPrinter, dryRun: true }],
      ['printers.cancelJob', 'job "x"', { printer: noPrinter, job: 'x', dryRun: true }],
      ['printers.cancelJob', 'job 1.5', { printer: noPrinter, job: 1.5, dryRun: true }],
      ['printers.addNetwork', 'neither path nor address', { dryRun: true }],
      ['printers.addNetwork', 'both path and address', { path: '\\\\a\\b', address: '10.0.0.1', dryRun: true }],
      ['printers.addNetwork', 'path not UNC', { path: 'C:\\printer', dryRun: true }],
      ['printers.addNetwork', 'address 999.1.1.1', { address: '999.1.1.1', dryRun: true }],
      ['printers.addNetwork', 'IPv6 address', { address: 'fe80::1', dryRun: true }],
      ['printers.addNetwork', 'name with a comma', { address: '10.0.0.1', name: 'a,b', dryRun: true }],
    ]) {
      r = await send(cmd, args, 20000);
      t.check(`${cmd} ${label}: plain error`, plainErr(r), shape(r));
    }
  } catch (e) {
    t.fail('the test itself threw', e.message);
  } finally {
    await s.stop();
  }
  for (const n of notes) console.log('  note: ' + n);
  process.exit(t.summary());
})();
