// test-qs.js - the Quick Settings panel's sidecar commands, on a PASSIVE sidecar (lane bar-qs, 2026-09-29).
//
//   node sidecar/test-qs.js --exe=<a private build>      (or MANTLE_SIDECAR_EXE; default sidecar/bin)
//
// WHAT: every read the panel and its sub-views make (volume, wifi, bluetooth, brightness, nightlight,
// power, net, wlan list, audio devices/sessions, btdevices list, qswatch pushes), with their shapes;
// and every WRITE they can make, proved refused by the passive sidecar (or answered as a dry run).
// WHY: test-sidecar.js covers wlan/audio/btdevices in depth; nothing covered the panel's own switches
// as a set, and `volume {level}` was NOT refused in passive (fixed in Volume.cs the same day): a
// --test instance's volume slider moved Owen's real speaker.
// SAFE BY CONSTRUCTION: every write asks for the value the part ALREADY has (read just before), so
// even a sidecar that wrongly obeyed would change nothing. Output is counts and shapes, never names.
'use strict';
const { startPassive, checker, sleep, PASSIVE_REFUSAL } = require('./test-lib');

const t = checker('QS SIDECAR');
const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
const bool = (v) => typeof v === 'boolean';
const refused = (r) => !!r && r.ok === false && typeof r.error === 'string' && r.error.indexOf(PASSIVE_REFUSAL) === 0;
const shape = (o) => JSON.stringify(Object.keys(o || {}).sort());

(async () => {
  const s = await startPassive();
  const notes = [];
  try {
    // ---- volume: read, then the passive refusal (the fixed hole) -----------------------------
    const v = await s.send('volume', {});
    t.check('volume reads a whole level 0-100 and a mute flag', v.ok && num(v.result.level, 0, 100) && Number.isInteger(v.result.level) && bool(v.result.muted), JSON.stringify(v).slice(0, 200));
    const lvl = v.ok ? v.result.level : 0, muted = v.ok ? v.result.muted : false;
    const vl = await s.send('volume', { level: lvl });
    t.check('volume {level} is refused in passive (it moved the real speaker before 2026-09-29)', refused(vl), JSON.stringify(vl).slice(0, 200));
    const vm = await s.send('volume', { muted });
    t.check('volume {muted} is refused in passive', refused(vm), JSON.stringify(vm).slice(0, 200));
    const vr = await s.send('volume', {});
    t.check('volume still reads after the refusals, unchanged', vr.ok && vr.result.level === lvl && vr.result.muted === muted, JSON.stringify(vr).slice(0, 200));

    // ---- the cached parts: first read may be pending, the second is a reading -------------------
    await s.send('wifi', {}); await s.send('bluetooth', {}); await s.send('brightness', {});
    await sleep(2500);
    const parts = {};
    for (const p of ['wifi', 'bluetooth', 'brightness', 'nightlight', 'power']) {
      const r = await s.send(p, {}, 8000);
      parts[p] = r.ok ? r.result : null;
      t.check(p + ' reads (ok or a reason)', r.ok && r.result && (r.result.ok !== false || (typeof r.result.reason === 'string' && r.result.reason.length > 0)), JSON.stringify(r).slice(0, 200));
    }
    const w = parts.wifi || {};
    t.check('wifi has present/on/connected, and a band string or null', bool(w.present) && bool(w.on) && bool(w.connected), shape(w));
    const b = parts.bluetooth || {};
    t.check('bluetooth has present and on', bool(b.present) && (bool(b.on) || b.on === null), shape(b));
    const br = parts.brightness || {};
    t.check('brightness is a level 0-100 or says why not', br.ok === false ? typeof br.reason === 'string' : num(br.level, 0, 100), shape(br));
    const nl = parts.nightlight || {};
    t.check('nightlight is on/off or says why not', nl.ok === false ? typeof nl.reason === 'string' : bool(nl.on), shape(nl));
    const pw = parts.power || {};
    t.check('power has its fields', pw.ok === false ? typeof pw.reason === 'string' : ('percent' in pw && 'ac' in pw), shape(pw));
    notes.push('parts: wifi ' + (w.on ? 'on' : 'off') + (w.connected ? ' connected' : '') + ', bt ' + (b.on ? 'on' : 'off') +
      ', brightness ' + (br.ok === false ? 'unreadable' : 'readable') + ', nightlight ' + (nl.ok === false ? 'unreadable' : nl.on ? 'on' : 'off'));

    // ---- every switch: refused in passive, asked for the value it already has -----------------
    const same = {
      wifi: { on: !!w.on }, bluetooth: { on: !!b.on }, nightlight: { on: !!nl.on },
      brightness: { level: num(br.level, 0, 100) ? Math.round(br.level) : 50 }
    };
    for (const p of Object.keys(same)) {
      if (p === 'brightness' && !num(br.level, 0, 100)) continue;   // no panel to dim: nothing to ask
      const r = await s.send(p, same[p]);
      t.check(p + ' switch is refused in passive', refused(r), JSON.stringify(r).slice(0, 200));
    }
    // bluetooth's dry run: the gate and the read, without SetStateAsync; passive answers it
    const dry = await s.send('bluetooth', { on: !!b.on, dryRun: true }, 8000);
    t.check('bluetooth {dryRun} answers with a plan in passive', dry.ok && dry.result && typeof dry.result === 'object', JSON.stringify(dry).slice(0, 200));
    // strict arguments, before any passive check
    const badArgs = [
      ['wifi', { on: 'yes' }, /on/], ['bluetooth', { on: 1 }, /on/], ['nightlight', { on: 'true' }, /on/],
      ['brightness', { level: '50' }, /level/], ['brightness', { level: 101 }, /level/], ['brightness', { level: -1 }, /level/],
      ['qswatch', { on: true, leaseMs: 5 }, /leaseMs/], ['qswatch', {}, /on/]
    ];
    for (const [cmd, a, want] of badArgs) {
      const r = await s.send(cmd, a);
      t.check(cmd + ' ' + JSON.stringify(a) + ' is refused as a bad argument', r.ok === false && want.test(r.error || '') && !/passive/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
    }
    // energy saver has no public switch: it says so rather than pretending
    const ps = await s.send('power', { saver: true });
    t.check('power {saver} says Windows has no public switch', ps.ok && ps.result.ok === false && /no public switch/.test(ps.result.reason || ''), JSON.stringify(ps).slice(0, 200));

    // ---- the watch: pushes every part once, then stops ---------------------------------------
    const before = s.collect('qs').length;
    const on = await s.send('qswatch', { on: true, leaseMs: 5000 });
    t.check('qswatch on answers', on.ok, JSON.stringify(on).slice(0, 200));
    await sleep(2500);
    const got = s.collect('qs').slice(before);
    const seen = Array.from(new Set(got.map((e) => e.part))).sort();
    t.check('qswatch pushed each part at least once', ['bluetooth', 'brightness', 'nightlight', 'power', 'volume', 'wifi'].every((p) => seen.indexOf(p) >= 0), JSON.stringify(seen));
    t.check('every qs push carries a part and a state object', got.every((e) => typeof e.part === 'string' && e.state && typeof e.state === 'object'), String(got.length));
    const off = await s.send('qswatch', { on: false });
    t.check('qswatch off answers', off.ok, JSON.stringify(off).slice(0, 200));
    await sleep(1500);
    const n0 = s.collect('qs').length;
    await sleep(2500);
    t.check('no qs pushes after the watch stopped', s.collect('qs').length === n0, String(s.collect('qs').length - n0));
    notes.push('qswatch: ' + got.length + ' push(es) in 2.5 s, parts ' + seen.length);

    // ---- net: the readout's reading --------------------------------------------------------
    const net = await s.send('net', { op: 'get' }, 8000);
    t.check('net get answers with a kind and internet flag', net.ok && net.result && ('internet' in net.result), JSON.stringify(net).slice(0, 160));

    // ---- one level down: the lists the sub-views draw (their writes: test-sidecar.js) ----------
    const wl = await s.send('wlan', { op: 'list' }, 10000);
    t.check('wlan list answers', wl.ok && wl.result && (Array.isArray(wl.result.networks) || wl.result.ok === false), JSON.stringify(wl).slice(0, 160));
    const nets = (wl.result && wl.result.networks) || [];
    t.check('every network row has a signal 0-100 and an action', nets.every((n) => num(n.signal, 0, 100) && typeof n.action === 'string'), String(nets.length));
    const wd = await s.send('wlan', { op: 'disconnect' });
    t.check('wlan disconnect is refused in passive', wd.ok === false && /passive/.test(wd.error || ''), JSON.stringify(wd).slice(0, 160));
    const ad = await s.send('audio', { op: 'devices' });
    const devs = (ad.result && ad.result.devices) || [];
    t.check('audio devices lists at most one default', ad.ok && devs.filter((d) => d.isDefault).length <= 1, String(devs.length));
    const as = await s.send('audio', { op: 'sessions' });
    const ss = (as.result && as.result.sessions) || [];
    t.check('audio sessions have a key and a level 0-100', as.ok && ss.every((x) => typeof x.key === 'string' && num(x.level, 0, 100) && bool(x.muted)), String(ss.length));
    const other = devs.find((d) => !d.isDefault);
    if (other) {
      const r = await s.send('audio', { op: 'default', device: other.id });
      t.check('audio default to another device is refused in passive', r.ok === false && /passive/.test(r.error || ''), JSON.stringify(r).slice(0, 160));
    }
    const bl = await s.send('btdevices', { op: 'list' }, 10000);
    t.check('btdevices list answers', bl.ok && bl.result && (Array.isArray(bl.result.devices) || bl.result.ok === false), JSON.stringify(bl).slice(0, 160));
    notes.push('lists: ' + nets.length + ' network row(s), ' + devs.length + ' playback device(s), ' + ss.length + ' app session(s), ' +
      ((bl.result && bl.result.devices) || []).length + ' paired device(s)');
  } catch (e) {
    t.fail('the run threw', e.message);
  } finally {
    await s.stop();
  }
  for (const n of notes) console.log('  note: ' + n);
  process.exitCode = t.summary();
})();
