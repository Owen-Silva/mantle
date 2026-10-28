// test-taskmgr-perf.js - sidecar/Perf.cs (`taskmgr.perf`) against a PASSIVE sidecar (lane tm-perf, 2026-10-28).
//
//   node sidecar/test-taskmgr-perf.js [--exe=<Mantle.Sidecar.exe>]     (or MANTLE_SIDECAR_EXE)
//
// READ-ONLY: the command only reads counters; nothing is started, ended or changed. Reference reads are
// Windows' own: typeperf (\Processor(_Total)\% Processor Time), node's os module, and one WMI read of the
// disk model (Get-CimInstance Win32_DiskDrive). Prints no SSID, address, process name or path (only
// "present"/counts), and the disk model (hardware, not personal).
//
// Takes ~30 s: rates need two samples 1 s apart, the static facts arrive on a background thread, and the
// "gap > 6 s means baseline" rule is checked by waiting 6.5 s.
//
// --idle adds ~80 s: no call for 76 s, then the idle timer must have closed the counters (the next sample
// answers "opening ...", the one after that a baseline, then numbers again).
//
// Prints "TASKMGR PERF TEST: n passed, m failed".
'use strict';
const cp = require('child_process');
const os = require('os');
const T = require('./test-lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPct = (v) => typeof v === 'number' && v >= 0 && v <= 100;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Every null field of `o` (keys) has a non-empty reason in why[prefix + key]. Returns the unexplained keys. */
function unexplained(o, keys, why, prefix) {
  return keys.filter((k) => o[k] === null && !(typeof why[prefix + k] === 'string' && why[prefix + k].length > 0));
}

(async () => {
  const t = T.checker('TASKMGR PERF');
  const s = await T.startPassive();
  const call = (args) => s.call('taskmgr.perf', args, 15000);
  const ms = { light: [], full: [] };
  try {
    // ---- LIGHT: first call (nothing to compare against yet), then rates
    const l0 = await call({ full: false });
    ms.lightFirst = l0.ms;
    t.check('light: reply shape', l0.cpu && l0.mem && l0.totals && 'disks' in l0 && 'nets' in l0 && 'static' in l0 && typeof l0.staticPending === 'boolean' && l0.why && typeof l0.ms === 'number', Object.keys(l0).join());
    t.check('light: first call has no CPU rate and says baseline', l0.cpu.pct === null && l0.why['cpu.pct'] === 'baseline', JSON.stringify(l0.why['cpu.pct']));
    t.check('light: disks/nets are null with a reason', l0.disks === null && l0.nets === null && /light/.test(l0.why.disks) && /light/.test(l0.why.nets));
    t.check('light: static not started by a light call', l0.static === null && l0.staticPending === false && typeof l0.why.static === 'string');
    await sleep(1000);
    const l1 = await call({ full: false });
    ms.light.push(l1.ms);
    await sleep(1000);
    const l2 = await call({ full: false });
    ms.light.push(l2.ms);
    t.check('light: cpu pct and kernelPct are percentages, kernel <= total', isPct(l2.cpu.pct) && isPct(l2.cpu.kernelPct) && l2.cpu.kernelPct <= l2.cpu.pct + 0.1, `${l2.cpu.pct} / ${l2.cpu.kernelPct}`);
    t.check('light: totals.disk is a percentage', isPct(l2.totals.disk), `${l2.totals.disk} ${l2.why['totals.disk'] || ''}`);
    t.check('light: totals.net is a percentage or null with a reason', isPct(l2.totals.net) || (l2.totals.net === null && !!l2.why['totals.net']), `${l2.totals.net} ${l2.why['totals.net'] || ''}`);
    const m = l2.mem;
    t.check('mem.total equals the OS total (os.totalmem)', m.total === os.totalmem(), `${m.total} vs ${os.totalmem()}`);
    t.check('mem: used = total - avail, avail <= total', m.used === m.total - m.avail && m.avail > 0 && m.avail <= m.total);
    t.check('mem: commit within its limit, pools > 0', m.committed > 0 && m.committed <= m.commitLimit && m.pagedPool > 0 && m.nonPagedPool > 0, JSON.stringify([m.committed, m.commitLimit]));
    const c = m.composition;
    t.check('mem: composition sums to total; cached = standby + modified', c && c.inUse + c.modified + c.standby + c.free === m.total && m.cached === c.standby + c.modified && c.inUse > 0, JSON.stringify(c));
    t.check('mem: avail is close to standby + free (Windows\' definition)', c && Math.abs(m.avail - (c.standby + c.free)) < 0.05 * m.total, `${m.avail} vs ${c && c.standby + c.free}`);
    t.check('cpu: procs/threads/handles/uptime are counts', l2.cpu.procs > 20 && l2.cpu.threads > l2.cpu.procs && l2.cpu.handles > l2.cpu.threads && l2.cpu.uptimeSec > 60, JSON.stringify(l2.cpu));
    t.check('light: every null cpu/mem field has a reason', unexplained(l2.cpu, Object.keys(l2.cpu), l2.why, 'cpu.').length === 0 && unexplained(l2.mem, Object.keys(l2.mem), l2.why, 'mem.').length === 0,
      unexplained(l2.cpu, Object.keys(l2.cpu), l2.why, 'cpu.').concat(unexplained(l2.mem, Object.keys(l2.mem), l2.why, 'mem.')).join());

    // ---- CPU against Windows' own counter over the same seconds
    {
      const a = await call({ full: false });
      let ref = null;
      try {
        const out = cp.execFileSync('typeperf', ['\\Processor(_Total)\\% Processor Time', '-si', '1', '-sc', '2'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        const vals = out.split(/\r?\n/).map((l) => l.match(/^"[^"]*","([\d.]+)"/)).filter(Boolean).map((x) => parseFloat(x[1]));
        if (vals.length) ref = vals.reduce((x, y) => x + y, 0) / vals.length;
      } catch (_) { ref = null; }
      const b = await call({ full: false });
      if (ref === null) t.check('cpu: typeperf reference read', false, 'typeperf gave no number');
      else t.check('cpu: within 15 points of typeperf over the same seconds', b.cpu.pct !== null && Math.abs(b.cpu.pct - ref) <= 15, `${b.cpu.pct}% vs typeperf ${ref.toFixed(1)}% (${b.why['cpu.pct'] || 'ok'})`);
      console.log(`  (read-only) cpu ${b.cpu.pct}% vs typeperf ${ref === null ? 'n/a' : ref.toFixed(1) + '%'}; sample a->b ${a ? 'ok' : ''}`);
    }

    // ---- FULL: first full starts the static read
    const f0 = await call({ full: true, cores: true });
    ms.fullFirst = f0.ms;
    t.check('full: the first full call starts the static read (pending, static null, reason)', f0.staticPending === true && f0.static === null && /reading/.test(f0.why.static), JSON.stringify([f0.staticPending, f0.why.static]));
    t.check('full: disks and nets are lists', Array.isArray(f0.disks) && (Array.isArray(f0.nets) || (f0.nets === null && !!f0.why.nets)), JSON.stringify([f0.why.disks, f0.why.nets]));
    let f = f0;
    let gotStatic = null, gotDisk = null;
    for (let i = 0; i < 15 && (i < 3 || !(gotStatic && gotDisk)); i++) {
      await sleep(1000);
      f = await call({ full: true, cores: true });
      ms.full.push(f.ms);
      if (f.static && !gotStatic) gotStatic = i + 1;
      if (!gotDisk && (f.disks || []).some((d) => d.capacity > 0)) gotDisk = i + 1;
    }
    t.check('static facts arrive after staticPending (seconds)', !!gotStatic && f.staticPending === false, String(gotStatic));
    const st = f.static || { cpu: {}, mem: {}, why: {} };
    const sc = st.cpu, sm = st.mem;
    t.check('static: cpu name, base speed, sockets/cores/logical', typeof sc.name === 'string' && sc.name.length > 3 && sc.baseGHz > 0.3 && sc.baseGHz < 7 && sc.sockets >= 1 && sc.cores >= 1 && sc.logical === os.cpus().length && sc.cores <= sc.logical,
      JSON.stringify(sc));
    t.check('static: caches L1 < L2, L3 or a reason', sc.l1KB > 0 && sc.l2KB > sc.l1KB && (sc.l3KB > 0 || !!st.why['cpu.l3KB']), JSON.stringify([sc.l1KB, sc.l2KB, sc.l3KB]));
    t.check('static: virtualization Enabled/Disabled or null with a reason', sc.virtualization === 'Enabled' || sc.virtualization === 'Disabled' || (sc.virtualization === null && !!st.why['cpu.virtualization']), String(sc.virtualization));
    t.check('static: memory slots used <= total, speed and form factor or reasons', sm.slotsTotal >= sm.slotsUsed && sm.slotsUsed >= 1 && (sm.speedMTs > 100 || !!st.why['mem.speedMTs']) && (typeof sm.formFactor === 'string' || !!st.why['mem.formFactor']), JSON.stringify(sm));
    t.check('static: hardware reserved is >= 0 and under 4 GB', sm.hardwareReserved >= 0 && sm.hardwareReserved < 4 * 1024 ** 3, String(sm.hardwareReserved));
    t.check('static: every null field has a reason', unexplained(sc, Object.keys(sc), st.why, 'cpu.').length === 0 && unexplained(sm, Object.keys(sm), st.why, 'mem.').length === 0);

    // rates on a full sample
    t.check('full: cpu.speedGHz within 0.2-8 GHz', f.cpu.speedGHz > 0.2 && f.cpu.speedGHz < 8, `${f.cpu.speedGHz} ${f.why['cpu.speedGHz'] || ''}`);
    t.check('full: perCore has one % per logical processor', Array.isArray(f.cpu.perCore) && f.cpu.perCore.length === os.cpus().length && f.cpu.perCore.every(isPct), JSON.stringify(f.cpu.perCore));
    t.check('full: compressed memory is a byte count (0 = compression off) or null with a reason', (typeof f.mem.compressed === 'number' && f.mem.compressed >= 0) || (f.mem.compressed === null && !!f.why['mem.compressed']), `${f.mem.compressed} ${f.why['mem.compressed'] || ''}`);
    const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();
    const disk = (f.disks || []).find((d) => /^Disk \d+ \([A-Z]:/.test(d.name) && d.capacity > 0);
    t.check('disks: a "Disk n (X:)" disk with capacity > 0', !!disk, JSON.stringify((f.disks || []).map((d) => [d.name, d.capacity, d.why && d.why.capacity])));
    if (disk) {
      t.check('disk: active %, response ms, read/write bytes per second', isPct(disk.activePct) && disk.respMs >= 0 && disk.readBps >= 0 && disk.writeBps >= 0, JSON.stringify([disk.activePct, disk.respMs, disk.readBps, disk.writeBps, disk.why]));
      t.check('disk: type SSD/HDD (or a reason), formatted <= capacity', (disk.type === 'SSD' || disk.type === 'HDD' || !!disk.why.type) && (disk.formatted === null || disk.formatted <= disk.capacity), JSON.stringify([disk.type, disk.formatted, disk.capacity]));
      t.check('disk: the system drive\'s disk says systemDisk', (f.disks || []).some((d) => d.systemDisk === true && d.letters.includes(sysDrive)), sysDrive);
      t.check('disk: id/name/number agree', disk.id === 'disk' + disk.number && disk.name.startsWith('Disk ' + disk.number));
      let wmi = null;
      try {
        wmi = cp.execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_DiskDrive -Filter 'Index=${disk.number}').Model`], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
      } catch (_) { wmi = null; }
      t.check('disk: model matches Windows\' Win32_DiskDrive.Model', wmi && disk.model === wmi, `${disk.model} vs ${wmi}`);
      console.log(`  (read-only) ${disk.name}: ${disk.model}, ${disk.type}${disk.bus ? ' (' + disk.bus + ')' : ''}, ${(disk.capacity / 1e9).toFixed(0)} GB, formatted ${disk.formatted && (disk.formatted / 1e9).toFixed(0)} GB, active ${disk.activePct}%, ${disk.respMs} ms`);
    }
    const busiest = Math.max(...(f.disks || []).map((d) => (typeof d.activePct === 'number' ? d.activePct : -1)));
    t.check('totals.disk = the busiest disk\'s active % (same sample)', f.totals.disk !== null && Math.abs(f.totals.disk - busiest) < 0.11, `${f.totals.disk} vs ${busiest}`);
    const allDiskNullsExplained = (f.disks || []).every((d) => unexplained(d, Object.keys(d), d.why, '').length === 0);
    t.check('disks: every null field has a reason', allDiskNullsExplained, JSON.stringify((f.disks || []).map((d) => unexplained(d, Object.keys(d), d.why, ''))));

    // adapters
    const nets = f.nets || [];
    const ifs = os.networkInterfaces();
    const withV4 = nets.filter((n) => n.ipv4 && (ifs[n.name] || []).some((a) => a.family === 'IPv4' && a.address === n.ipv4));
    t.check('nets: the connected adapter is listed with its IPv4 (matches os.networkInterfaces)', withV4.length >= 1, JSON.stringify(nets.map((n) => [n.kind, !!n.ipv4])));
    t.check('nets: send/recv bytes per second >= 0 and a kind', nets.every((n) => n.sendBps >= 0 && n.recvBps >= 0 && typeof n.kind === 'string'), JSON.stringify(nets.map((n) => [n.sendBps, n.recvBps, n.why])));
    const wifi = nets.find((n) => n.kind === 'Wi-Fi');
    if (wifi) {
      t.check('wi-fi: SSID or a reason, PHY type 802.11x or a reason, signal 0-100 or a reason',
        (typeof wifi.ssid === 'string' || !!wifi.why.ssid) && (/^802\.11/.test(wifi.connType || '') || !!wifi.why.connType) && (isPct(wifi.signal) || !!wifi.why.signal), JSON.stringify([!!wifi.ssid, wifi.connType, wifi.signal, wifi.why]));
      console.log(`  (read-only) Wi-Fi: ssid ${wifi.ssid ? 'present' : 'null (' + wifi.why.ssid + ')'}, ${wifi.connType}, signal ${wifi.signal}, link ${wifi.linkBps / 1e6} Mbps, ipv4 ${wifi.ipv4 ? 'present' : 'none'}`);
    } else console.log('  (read-only) no Wi-Fi adapter is connected; the Wi-Fi checks were skipped');
    t.check('nets: every null field has a reason', nets.every((n) => unexplained(n, Object.keys(n), n.why, '').length === 0), JSON.stringify(nets.map((n) => unexplained(n, Object.keys(n), n.why, ''))));
    const linked = nets.filter((n) => n.linkBps > 0 && n.sendBps !== null);
    if (linked.length) {
      const top = Math.max(...linked.map((n) => Math.min(100, ((n.sendBps + n.recvBps) * 8 * 100) / n.linkBps)));
      t.check('totals.net = the busiest adapter\'s (send+recv)*8/link %', f.totals.net !== null && Math.abs(f.totals.net - top) < 0.11, `${f.totals.net} vs ${top}`);
    }

    // cores:false, too-soon repeat, gap -> baseline
    const nc = await call({ full: true, cores: false });
    t.check('cores:false -> perCore null with a reason', nc.cpu.perCore === null && /cores:false/.test(nc.why['cpu.perCore']));
    const again = await call({ full: false });
    t.check('a repeat within 250 ms gives the same interval\'s numbers, not a rate over a few ms', again.cpu.pct === nc.cpu.pct && again.totals.disk === nc.totals.disk, `${again.cpu.pct} vs ${nc.cpu.pct}`);
    for (let i = 0; i < 4; i++) { await sleep(1000); const x = await call({ full: false }); ms.light.push(x.ms); }
    await sleep(6500);
    const gap = await call({ full: true, cores: true });
    t.check('after a gap > 6 s the rates are null with "baseline"', gap.cpu.pct === null && gap.why['cpu.pct'] === 'baseline' && gap.why['totals.disk'] === 'baseline' && gap.why['cpu.speedGHz'] === 'baseline' && (gap.disks || []).every((d) => d.why.readBps === 'baseline'),
      JSON.stringify([gap.why['cpu.pct'], gap.why['totals.disk'], gap.why['cpu.speedGHz']]));
    t.check('after a gap: non-rate fields still answer', gap.mem.total > 0 && gap.mem.cached > 0 && gap.static !== null);
    await sleep(1000);
    const after = await call({ full: true, cores: true });
    t.check('the sample after the baseline has rates again', isPct(after.cpu.pct) && after.cpu.speedGHz > 0 && isPct(after.totals.disk));

    if (process.argv.includes('--idle')) {
      await sleep(76000);
      const i0 = await call({ full: false });
      t.check('idle 76 s: the counters were closed (the next sample reopens them, why says so)', /opening/.test(i0.why['totals.disk'] || '') && i0.why['cpu.pct'] === 'baseline', JSON.stringify([i0.why['totals.disk'], i0.why['cpu.pct']]));
      await sleep(1000); await call({ full: false });
      await sleep(1000);
      const i2 = await call({ full: false });
      t.check('idle: numbers come back two samples after reopening', isPct(i2.cpu.pct) && isPct(i2.totals.disk) && i2.mem.cached > 0, JSON.stringify([i2.cpu.pct, i2.totals.disk, i2.why]));
      console.log(`  (read-only) reopen sample ${i0.ms} ms`);
    }

    const lm = median(ms.light), fm = median(ms.full);
    t.check('light repeat calls stay under 10 ms (median)', lm < 10, `${lm} ms`);
    t.check('full repeat calls stay under 25 ms (median)', fm < 25, `${fm} ms`);
    console.log(`  (read-only) ms: light first ${ms.lightFirst}, light repeat median ${lm} (max ${Math.max(...ms.light)}); full first ${ms.fullFirst}, full repeat median ${fm} (max ${Math.max(...ms.full)})`);
    console.log(`  (read-only) static after ${gotStatic} s; cpu ${sc.name ? 'named' : 'unnamed'} ${sc.cores}c/${sc.logical}t base ${sc.baseGHz} GHz, L1/L2/L3 ${sc.l1KB}/${sc.l2KB}/${sc.l3KB} KB, virt ${sc.virtualization}; mem ${sm.speedMTs} MT/s ${sm.slotsUsed}/${sm.slotsTotal} ${sm.formFactor}, reserved ${(sm.hardwareReserved / 1048576).toFixed(0)} MB, compressed ${f.mem.compressed}`);
  } catch (e) {
    t.check('no exception', false, e.stack);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
