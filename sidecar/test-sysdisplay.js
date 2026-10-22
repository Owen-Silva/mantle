// test-sysdisplay.js - the Display backend (SysDisplay.cs, lane sysset-disp, 2026-09-28), passive only.
//
//   node sidecar/test-sysdisplay.js --exe=<your built Mantle.Sidecar.exe>   [--verbose]
//
// NEVER changes the user's display: every write is sent with dryRun (and a re-read proves nothing moved),
// every real write is sent to a PASSIVE sidecar and must answer the passive refusal, and the pure
// decisions (mode matching, layout rules, scale steps, what a revert restores, the night light
// parse/encode, the ;-field editor) are proven with made-up inputs through sysdisplay.decide.
// Output carries counts and numbers only - never a display, device or app name (privacy rule).
'use strict';

const T = require('./test-lib');

const VERBOSE = process.argv.includes('--verbose');
const REFUSAL = T.PASSIVE_REFUSAL || 'refused: sidecar is passive (test mode)';

// The night light settings blob exactly as measured on the user's machine (2026-09-28, 43 bytes).
const MEASURED = '43420100' + '0a020100' + '2a06' + 'd9e5ebcf06' + '2a2b0e15' +
                 '43420100' + 'ca140e1500' + 'ca1e0e0700' + 'ca3200' + 'ca3c00' + '00' + '000000';

function varint(n) {                   // LEB128, as Bond writes it
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  out.push(Number(v));
  return Buffer.from(out).toString('hex');
}
/** Builds a settings blob around `innerHex` (the part after the inner "CB" header, incl. its 00). */
function blob(tsSecs, innerHex) {
  const inner = '43420100' + innerHex;
  return '43420100' + '0a020100' + '2a06' + varint(tsSecs) + '2a2b0e' + varint(inner.length / 2) + inner + '000000';
}

(async () => {
  const t = T.checker('SYSDISPLAY');
  const s = await T.startPassive({ readyMs: 30000 });
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 15000);
  const refused = (r) => r && r.ok === false && typeof r.error === 'string' && r.error.startsWith(REFUSAL);
  const noPath = (txt) => !/[A-Za-z]:\\/.test(String(txt || ''));
  try {
    // ------------------------------------------------------------------ registration
    const ping = await send('ping', {}, 8000);
    const cmds = (ping.result && ping.result.features && ping.result.features.commands) || [];
    const want = ['get', 'mode', 'topology', 'primary', 'arrange', 'keep', 'revert', 'scale', 'hdr', 'nightlight',
                  'nightlightSet', 'gpuPrefs', 'gpuPrefSet', 'gpuGlobalSet', 'gpuSchedulingSet', 'decide'];
    if (cmds.length) {
      const missing = want.filter((w) => !cmds.includes('sysdisplay.' + w));
      t.check('every sysdisplay command is registered', missing.length === 0, missing.join(','));
      const probs = ((ping.result.features.problems) || []).filter((p) => /SysDisplay/.test(p));
      t.check('SysDisplay registered without problems', probs.length === 0, probs.join('; '));
    }

    // ------------------------------------------------------------------ sysdisplay.get
    const g0 = await send('sysdisplay.get');
    t.check('get answers ok', g0.ok === true && g0.result && g0.result.ok === true, g0.error);
    const G = g0.result || {};
    const ds = G.displays || [];
    const act = ds.filter((d) => d.active);
    t.check('at least one display in use', act.length >= 1, `${ds.length} displays, ${act.length} active`);
    t.check('exactly one main display among those in use (or clone)', act.filter((d) => d.primary).length >= 1);
    t.check('display keys are "<16 hex>-<target>" and none is named id',
      ds.every((d) => /^[0-9a-f]{16}-\d+$/.test(d.display) && !('id' in d)));
    for (const d of act) {
      const n = act.indexOf(d) + 1;
      t.check(`#${n} bounds are physical pixels`, d.bounds && d.bounds.width > 0 && d.bounds.height > 0 &&
        Number.isInteger(d.bounds.x) && Number.isInteger(d.bounds.y));
      t.check(`#${n} main display sits at 0,0`, !d.primary || (d.bounds.x === 0 && d.bounds.y === 0));
      t.check(`#${n} refresh rate is a sane number`, d.refreshHz > 10 && d.refreshHz < 1000 && d.refresh && d.refresh.denominator > 0, d.refreshHz);
      t.check(`#${n} orientation is named`, ['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped'].includes(d.orientation));
      t.check(`#${n} kind + connector`, ['internal', 'external'].includes(d.kind) && typeof d.connector === 'string');
      t.check(`#${n} has a name and says where it came from`, typeof d.name === 'string' && d.name.length > 0 && typeof d.nameSource === 'string');
      t.check(`#${n} lists modes`, Array.isArray(d.modes) && d.modes.length > 0, d.modesReason);
      const cur = (d.modes || []).find((m) => m.width === d.resolution.width && m.height === d.resolution.height);
      t.check(`#${n} the current resolution is in its list`, !!cur, `${d.resolution.width}x${d.resolution.height}`);
      t.check(`#${n} the current refresh is offered there`, cur && cur.hz.some((h) => Math.abs(h - d.refreshHz) < 0.6), JSON.stringify(cur && cur.hz));
      t.check(`#${n} the native mode is marked`, !d.native || (d.modes || []).some((m) => m.native && m.width === d.native.width && m.height === d.native.height));
      t.check(`#${n} modes are deduped`, new Set((d.modes || []).map((m) => m.width + 'x' + m.height)).size === (d.modes || []).length);
      const sc = d.scale || {};
      t.check(`#${n} scale: percent in the allowed list, or a reason`,
        (Number.isInteger(sc.percent) && sc.allowed.includes(sc.percent) && sc.allowed.includes(sc.recommended)) || typeof sc.reason === 'string',
        JSON.stringify(sc).slice(0, 200));
      t.check(`#${n} scale says it is the undocumented call`, /undocumented/.test(sc.source || ''));
      const hd = d.hdr || {};
      t.check(`#${n} hdr: supported/enabled booleans with a source`, typeof hd.supported === 'boolean' && typeof hd.enabled === 'boolean' && /ADVANCED_COLOR_INFO/.test(hd.source || ''),
        JSON.stringify(hd).slice(0, 200));
      t.check(`#${n} hdr: unsupported comes with its reason`, hd.supported || typeof hd.reason === 'string');
      if (VERBOSE) console.log(`  #${n}: ${d.kind} ${d.resolution.width}x${d.resolution.height} @${d.refreshHz} ${d.orientation} scale ${sc.percent}% (rec ${sc.recommended}, allowed ${sc.allowed}) hdr ${hd.supported}/${hd.enabled} modes ${d.modes.length} native ${JSON.stringify(d.native)}`);
    }
    const topo = G.topology || {};
    t.check('topology: current is named', ['internal', 'clone', 'extend', 'external', 'custom'].includes(topo.current), JSON.stringify(topo).slice(0, 200));
    t.check('topology: available list + reasons for the rest', Array.isArray(topo.available) && topo.unavailable && typeof topo.unavailable === 'object');
    t.check('gpus listed with names', Array.isArray(G.gpus) && G.gpus.length >= 1 && G.gpus.every((x) => typeof x.name === 'string' && /^[0-9a-f]{16}$/.test(x.adapter)), G.gpusReason);
    t.check('every active display names a listed GPU', act.every((d) => (G.gpus || []).some((x) => x.adapter === d.adapter)));
    t.check('no change is pending in a fresh sidecar', G.pending === null);
    t.check('customScale read with its source', G.customScale && typeof G.customScale.on === 'boolean' && G.customScale.writable === false);
    if (VERBOSE) console.log(`  topology ${topo.current}, available ${topo.available}, gpus ${(G.gpus || []).length} ${JSON.stringify((G.gpus || []).map((x) => [x.software, x.hybrid, x.gpuScheduling.raw, x.gpuScheduling.supportState]))}, get ${G.ms} ms`);

    const snap = (r) => JSON.stringify(((r.result || {}).displays || []).map((d) => [d.display, d.active, d.primary, d.bounds, d.refreshHz, d.orientation, d.scale && d.scale.percent, d.hdr && d.hdr.enabled]));
    const before = snap(g0);

    // ------------------------------------------------------------------ mode
    const d1 = act.find((d) => d.primary) || act[0];
    if (d1) {
      const same = await send('sysdisplay.mode', { display: d1.display, width: d1.resolution.width, height: d1.resolution.height, hz: d1.refreshHz, dryRun: true });
      t.check('mode dryRun of the current mode: nothing to change', same.ok && same.result.dryRun === true && same.result.changed === false && same.result.writes.length === 0 && same.result.wouldRefuse === null,
        JSON.stringify(same).slice(0, 300));
      const other = (d1.modes || []).find((m) => !(m.width === d1.resolution.width && m.height === d1.resolution.height));
      if (other) {
        const dr = await send('sysdisplay.mode', { display: d1.display, width: other.width, height: other.height, hz: other.hz[0], dryRun: true });
        const w0 = dr.ok && dr.result.writes[0];
        t.check('mode dryRun of another mode: CDS_TEST verdict + the exact write', dr.ok && dr.result.dryRun &&
          (dr.result.wouldRefuse === null ? (w0 && w0.api === 'ChangeDisplaySettingsEx' && w0.width === other.width && w0.height === other.height && w0.hz === other.hz[0] && w0.flags.includes('dynamic (not saved)'))
                                          : typeof dr.result.wouldRefuse === 'string'),
          JSON.stringify(dr).slice(0, 400));
        t.check('mode dryRun says what a revert restores', dr.ok && dr.result.revert.length === 1 && dr.result.revert[0].width === d1.resolution.width &&
          dr.result.revert[0].height === d1.resolution.height && dr.result.keepWithinMs === 15000, JSON.stringify(dr.result && dr.result.revert));
        t.check('mode dryRun validated by CDS_TEST', dr.ok && /CDS_TEST/.test(dr.result.validatedBy));
      }
      const noHz = await send('sysdisplay.mode', { display: d1.display, width: d1.resolution.width, height: d1.resolution.height, dryRun: true });
      t.check('mode dryRun without hz keeps the current rate', noHz.ok && noHz.result.changed === false, JSON.stringify(noHz).slice(0, 200));
      const bad = await send('sysdisplay.mode', { display: d1.display, width: 123, height: 45, hz: 60, dryRun: true });
      t.check('mode dryRun of a mode the display lacks: refused in words', bad.ok && /not a resolution this display offers/.test(bad.result.wouldRefuse || '') && bad.result.writes.length === 0,
        JSON.stringify(bad).slice(0, 300));
      const badHz = await send('sysdisplay.mode', { display: d1.display, width: d1.resolution.width, height: d1.resolution.height, hz: 7, dryRun: true });
      t.check('mode dryRun of a rate the display lacks: refused in words', badHz.ok && /Hz is not offered/.test(badHz.result.wouldRefuse || ''), JSON.stringify(badHz).slice(0, 300));
      const badO = await send('sysdisplay.mode', { display: d1.display, width: d1.resolution.width, height: d1.resolution.height, orientation: 'sideways', dryRun: true });
      t.check('mode refuses an unknown orientation', badO.ok === false && /orientation/.test(badO.error));
      const real = await send('sysdisplay.mode', { display: d1.display, width: d1.resolution.width, height: d1.resolution.height, hz: d1.refreshHz });
      t.check('mode (real) answers the passive refusal', refused(real), JSON.stringify(real).slice(0, 200));
      const noArgs = await send('sysdisplay.mode', { display: d1.display, dryRun: true });
      t.check('mode without width says so', noArgs.ok === false && /width/.test(noArgs.error));
      const gone = await send('sysdisplay.mode', { display: '0000000000000000-1', width: 1, height: 1, dryRun: true });
      t.check('mode on an unknown display says it is not connected', gone.ok === false && /not connected/.test(gone.error));
      const idArg = await send('sysdisplay.mode', { width: 1, height: 1, dryRun: true });
      t.check('mode without display names the display key', idArg.ok === false && /display/.test(idArg.error));

      // ---------------------------------------------------------------- primary / arrange
      const pr = await send('sysdisplay.primary', { display: d1.display, dryRun: true });
      t.check('primary dryRun of the current main display: nothing to change', pr.ok && pr.result.changed === false && pr.result.writes.length === 0 && pr.result.wouldRefuse === null,
        JSON.stringify(pr).slice(0, 300));
      const prReal = await send('sysdisplay.primary', { display: d1.display });
      t.check('primary (real) answers the passive refusal', refused(prReal), JSON.stringify(prReal).slice(0, 200));
      const pos = act.filter((d) => d.bounds).map((d) => ({ display: d.display, x: d.bounds.x, y: d.bounds.y }));
      const ar = await send('sysdisplay.arrange', { positions: pos, dryRun: true });
      t.check('arrange dryRun of the current layout: nothing to change', ar.ok && ar.result.changed === false && ar.result.wouldRefuse === null && Array.isArray(ar.result.revert),
        JSON.stringify(ar).slice(0, 300));
      const arBad = await send('sysdisplay.arrange', { positions: [{ display: '0000000000000000-9', x: 0, y: 0 }], dryRun: true });
      t.check('arrange dryRun naming a display not in use: refused in words', arBad.ok && /not in use/.test(arBad.result.wouldRefuse || ''), JSON.stringify(arBad).slice(0, 300));
      const arReal = await send('sysdisplay.arrange', { positions: pos });
      t.check('arrange (real) answers the passive refusal', refused(arReal), JSON.stringify(arReal).slice(0, 200));
      const arArgs = await send('sysdisplay.arrange', { positions: 'left', dryRun: true });
      t.check('arrange with a bad positions arg says so', arArgs.ok === false && /positions/.test(arArgs.error));

      // ---------------------------------------------------------------- scale
      const sc = d1.scale || {};
      if (Number.isInteger(sc.percent)) {
        const s0 = await send('sysdisplay.scale', { display: d1.display, percent: sc.percent, dryRun: true });
        t.check('scale dryRun of the current scale: nothing to change', s0.ok && s0.result.changed === false && s0.result.writes.length === 0, JSON.stringify(s0).slice(0, 300));
        const alt = sc.allowed.find((p) => p !== sc.percent);
        if (alt) {
          const s1 = await send('sysdisplay.scale', { display: d1.display, percent: alt, dryRun: true });
          const w = s1.ok && s1.result.writes[0];
          const recIx = sc.allowed.indexOf(sc.recommended);
          t.check('scale dryRun of another allowed scale: the exact -4 write, steps from recommended',
            w && w.api === 'DisplayConfigSetDeviceInfo' && w.type === -4 && w.percent === alt && w.scaleRel === sc.allowed.indexOf(alt) - recIx && s1.result.wouldRefuse === null,
            JSON.stringify(s1).slice(0, 300));
        }
        const s2 = await send('sysdisplay.scale', { display: d1.display, percent: 137, dryRun: true });
        t.check('scale dryRun of 137%: refused in words', s2.ok && /not a scale Windows offers/.test(s2.result.wouldRefuse || ''), JSON.stringify(s2).slice(0, 300));
        const s3 = await send('sysdisplay.scale', { display: d1.display, percent: 500, dryRun: true });
        t.check('scale dryRun above the display limit: refused (or allowed if 500% is allowed)',
          s3.ok && (sc.allowed.includes(500) ? s3.result.wouldRefuse === null : /larger than this display allows/.test(s3.result.wouldRefuse || '')), JSON.stringify(s3).slice(0, 300));
        const sReal = await send('sysdisplay.scale', { display: d1.display, percent: sc.percent });
        t.check('scale (real) answers the passive refusal', refused(sReal), JSON.stringify(sReal).slice(0, 200));
      }

      // ---------------------------------------------------------------- hdr
      const hd = d1.hdr || {};
      const h0 = await send('sysdisplay.hdr', { display: d1.display, on: hd.enabled, dryRun: true });
      t.check('hdr dryRun of the current state: nothing to change', h0.ok && h0.result.changed === false && h0.result.writes.length === 0, JSON.stringify(h0).slice(0, 300));
      const h1 = await send('sysdisplay.hdr', { display: d1.display, on: !hd.enabled, dryRun: true });
      t.check('hdr dryRun of a switch: the exact write, or the reason it cannot',
        h1.ok && (h1.result.wouldRefuse === null
          ? (h1.result.writes[0].api === 'DisplayConfigSetDeviceInfo' && [10, 16].includes(h1.result.writes[0].type) && h1.result.writes[0].value === (hd.enabled ? 0 : 1))
          : (!hd.supported && /does not report HDR support/.test(h1.result.wouldRefuse))),
        JSON.stringify(h1).slice(0, 300));
      const hReal = await send('sysdisplay.hdr', { display: d1.display, on: !hd.enabled });
      t.check('hdr (real) answers the passive refusal', refused(hReal), JSON.stringify(hReal).slice(0, 200));
      const hArg = await send('sysdisplay.hdr', { display: d1.display, on: 'yes', dryRun: true });
      t.check('hdr needs a real boolean', hArg.ok === false && /true or false/.test(hArg.error));
    }

    // ------------------------------------------------------------------ topology
    if (topo.current && topo.current !== 'custom') {
      const t0 = await send('sysdisplay.topology', { mode: topo.current, dryRun: true });
      t.check('topology dryRun of the current layout: nothing to change', t0.ok && t0.result.changed === false && t0.result.writes.length === 0, JSON.stringify(t0).slice(0, 300));
    }
    for (const m of ['clone', 'extend', 'external', 'internal'].filter((x) => x !== topo.current)) {
      const r = await send('sysdisplay.topology', { mode: m, dryRun: true });
      const ok = r.ok && r.result.dryRun && (r.result.wouldRefuse === null
        ? (r.result.writes[0].api === 'SetDisplayConfig' && r.result.writes[0].flags.includes('SDC_TOPOLOGY_' + m.toUpperCase()) && r.result.revert.length === 1)
        : typeof r.result.wouldRefuse === 'string' && r.result.writes.length === 0);
      t.check(`topology dryRun ${m}: SDC_VALIDATE verdict + the exact call`, ok, JSON.stringify(r).slice(0, 300));
      t.check(`topology dryRun ${m} agrees with get's available list`, !r.ok || (r.result.wouldRefuse === null) === (topo.available || []).includes(m));
    }
    const tReal = await send('sysdisplay.topology', { mode: 'extend' });
    t.check('topology (real) answers the passive refusal', refused(tReal), JSON.stringify(tReal).slice(0, 200));
    const tBad = await send('sysdisplay.topology', { mode: 'mirror', dryRun: true });
    t.check('topology refuses an unknown mode in words', tBad.ok === false && /extend, clone, internal or external/.test(tBad.error));

    // ------------------------------------------------------------------ keep / revert with nothing pending
    const k = await send('sysdisplay.keep', { token: 'deadbeefdeadbeef' });
    t.check('keep with no pending change says so', k.ok === false && /no display change is waiting/.test(k.error), JSON.stringify(k));
    const rv = await send('sysdisplay.revert', { token: 'deadbeefdeadbeef' });
    t.check('revert with no pending change says so', rv.ok === false && /no display change is waiting/.test(rv.error), JSON.stringify(rv));
    const k2 = await send('sysdisplay.keep', {});
    t.check('keep without a token says so', k2.ok === false && /token/.test(k2.error));

    // nothing above moved anything
    const g1 = await send('sysdisplay.get');
    t.check('after every display dryRun, a re-read is identical', g1.ok && snap(g1) === before, VERBOSE ? snap(g1) : '');

    // ------------------------------------------------------------------ night light
    const nl = await send('sysdisplay.nightlight');
    const N = nl.result || {};
    t.check('nightlight answers', nl.ok && N.ok === true, JSON.stringify(nl).slice(0, 300));
    t.check('nightlight carries on/off from Display.cs', typeof N.on === 'boolean');
    if (N.present) {
      t.check('nightlight: the real blob round-trips exactly', N.roundTrip === true, N.reason);
      t.check('nightlight: schedule named with its source', N.schedule && ['off', 'sunset', 'hours'].includes(N.schedule.value) && typeof N.schedule.source === 'string');
      t.check('nightlight: set hours read', N.from && Number.isInteger(N.from.hour) && N.to && Number.isInteger(N.to.hour), JSON.stringify([N.from, N.to]));
      t.check('nightlight: strength is a percent or null with a reason', N.strength && (Number.isInteger(N.strength.percent) || typeof N.strength.reason === 'string'));
      t.check('nightlight: says which parts it can write, and why not the rest', N.writable && typeof N.writable.why === 'string');
      const rt = await send('sysdisplay.decide', { what: 'night', bytes: N.settingsBytes });
      t.check('decide night: the real bytes parse and re-encode byte for byte', rt.ok && rt.result.ok && rt.result.roundTrip === true, JSON.stringify(rt).slice(0, 300));
      if (VERBOSE) console.log(`  night light: ${N.settingsBytes.length / 2} bytes, layout ${N.layout}, schedule ${N.schedule.value}, ${N.from.text}-${N.to.text}, strength ${N.strength.percent}`);

      if (N.layout === 'measured') {
        const newFrom = N.from.hour === 20 ? '22:00' : '20:00';
        const nd = await send('sysdisplay.nightlightSet', { from: newFrom, dryRun: true });
        const w = nd.ok && nd.result.writes[0];
        t.check('nightlightSet dryRun from: the exact REG_BINARY, same length, only hour + timestamp differ',
          w && w.type === 'REG_BINARY' && w.name === 'Data' && w.bytes.length === w.before.length && nd.result.wouldRefuse === null && w.before === N.settingsBytes,
          JSON.stringify(nd).slice(0, 300));
        if (w) {
          const p = await send('sysdisplay.decide', { what: 'night', bytes: w.bytes });
          t.check('nightlightSet dryRun bytes parse back with the new hour', p.ok && p.result.ok && p.result.from.text === newFrom && p.result.to.text === N.to.text && p.result.layout === 'measured',
            JSON.stringify(p).slice(0, 300));
        }
      }
      const ns = await send('sysdisplay.nightlightSet', { strength: 50, dryRun: true });
      t.check('nightlightSet dryRun strength: refused with the reason, nothing written', ns.ok && typeof ns.result.wouldRefuse === 'string' && ns.result.writes.length === 0,
        JSON.stringify(ns).slice(0, 300));
      const nsch = await send('sysdisplay.nightlightSet', { schedule: N.schedule.value === 'off' ? 'hours' : 'off', dryRun: true });
      t.check('nightlightSet dryRun schedule change: refused with the reason', nsch.ok && typeof nsch.result.wouldRefuse === 'string' && nsch.result.writes.length === 0,
        JSON.stringify(nsch).slice(0, 300));
      const nmin = await send('sysdisplay.nightlightSet', { from: '20:30', dryRun: true });
      t.check('nightlightSet dryRun with minutes: refused (not measured)', nmin.ok && /minutes/.test(nmin.result.wouldRefuse || ''), JSON.stringify(nmin).slice(0, 300));
      const nReal = await send('sysdisplay.nightlightSet', { from: '20:00' });
      t.check('nightlightSet (real) answers the passive refusal', refused(nReal), JSON.stringify(nReal).slice(0, 200));
      const nBad = await send('sysdisplay.nightlightSet', { from: '25:00', dryRun: true });
      t.check('nightlightSet refuses a bad time in words', nBad.ok === false && /HH:MM/.test(nBad.error));
      const nl2 = await send('sysdisplay.nightlight');
      t.check('after the night light dryRuns, the blob is byte for byte the same', nl2.ok && nl2.result.settingsBytes === N.settingsBytes);
    }

    // night light with made-up bytes
    const m0 = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED });
    const M = m0.result || {};
    t.check('decide night (measured sample): parses as the measured layout', M.ok && M.layout === 'measured' && M.roundTrip === true, JSON.stringify(m0).slice(0, 300));
    t.check('decide night (measured sample): 21:00 -> 07:00, schedule off, no strength, empty sunset',
      M.from && M.from.text === '21:00' && M.to.text === '07:00' && M.schedule.value === 'off' && M.strength.percent === null && M.sunset.hour === null && M.updated === 1778053849,
      JSON.stringify(M).slice(0, 400));
    const NOW = 1790000000;
    const e1 = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED, set: { from: '20:00', to: '06:00' }, now: NOW });
    const expect1 = blob(NOW, 'ca140e1400' + 'ca1e0e0600' + 'ca3200' + 'ca3c00' + '00');
    t.check('decide night encode: exactly the bytes built independently here', e1.ok && e1.result.refuse === null && e1.result.next === expect1 && e1.result.changed === true,
      JSON.stringify(e1.result && [e1.result.refuse, e1.result.next, expect1]));
    t.check('decide night encode: the new bytes read back 20:00 -> 06:00', e1.ok && e1.result.nextParsed && e1.result.nextParsed.from.text === '20:00' && e1.result.nextParsed.to.text === '06:00');
    const e2 = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED, set: { from: '21:00' }, now: 1000000000 });
    t.check('decide night: the same hours change nothing', e2.ok && e2.result.changed === false && e2.result.next === null && e2.result.refuse === null);
    const e3 = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED, set: { from: '20:00' }, now: 1000000000 });
    t.check('decide night: a clock behind the blob still moves the timestamp forward (old + 1)',
      e3.ok && e3.result.next === blob(1778053850, 'ca140e1400' + 'ca1e0e0700' + 'ca3200' + 'ca3c00' + '00'), JSON.stringify(e3.result && e3.result.next));
    const e4 = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED, set: { strength: 40 }, now: NOW });
    t.check('decide night: strength is refused on the measured layout (field absent)', e4.ok && /strength is not stored/.test(e4.result.refuse || '') && e4.result.next === null);
    const e5 = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED, set: { schedule: 'sunset' }, now: NOW });
    t.check('decide night: switching the schedule on is refused (adds a field)', e5.ok && /not measured here/.test(e5.result.refuse || ''));
    const e6 = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED, set: { to: '00:00' }, now: NOW });
    t.check('decide night: hour 0 is refused (drops a field)', e6.ok && /midnight/.test(e6.result.refuse || ''));
    // an unmeasured layout (schedule on + 3000 K + minutes) reads, flagged, and refuses writes
    const fakeOn = blob(1778053849, '0201' + 'ca140e152e1e00' + 'ca1e0e0700' + 'cf28' + varint(6000) + 'ca3200' + 'ca3c00' + '00');
    const f1 = await send('sysdisplay.decide', { what: 'night', bytes: fakeOn, set: { to: '08:00' }, now: NOW });
    const F = f1.result || {};
    t.check('decide night (fake, schedule on + 3000 K + 21:30): reads it, flagged unmeasured',
      F.ok && F.roundTrip && F.schedule.value === 'hours' && F.from.text === '21:30' && F.strength.kelvin === 3000 && F.strength.percent === 66 && F.layout === 'unmeasured' && F.strength.measured === false,
      JSON.stringify(F).slice(0, 400));
    t.check('decide night (fake unmeasured): a write is refused, nothing encoded', F.ok && typeof F.refuse === 'string' && F.next === null);
    const fakeSunset = blob(1778053849, '0201' + 'c20a00' + 'ca140e1500' + 'ca1e0e0700' + 'ca3200' + 'ca3c00' + '00');
    const f2 = await send('sysdisplay.decide', { what: 'night', bytes: fakeSunset });
    t.check('decide night (fake): sunset-to-sunrise reads as sunset', f2.ok && f2.result.ok && f2.result.schedule.value === 'sunset');
    const junk = await send('sysdisplay.decide', { what: 'night', bytes: MEASURED.slice(0, 40) + 'ff' + MEASURED.slice(42) });
    t.check('decide night (corrupted byte): refused with the reason, not guessed', junk.ok && junk.result.ok === false && typeof junk.result.reason === 'string');
    const shortB = await send('sysdisplay.decide', { what: 'night', bytes: '434201' });
    t.check('decide night (3 bytes): refused with the reason', shortB.ok && shortB.result.ok === false && /too short/.test(shortB.result.reason));

    // ------------------------------------------------------------------ graphics
    const gp = await send('sysdisplay.gpuPrefs');
    const P = gp.result || {};
    t.check('gpuPrefs answers', gp.ok && P.ok === true && Array.isArray(P.apps), JSON.stringify(gp).slice(0, 300));
    t.check('gpuPrefs: the three global switches, each on/off/null with words',
      P.global && ['SwapEffectUpgradeEnable', 'VRROptimizeEnable', 'AutoHDREnable'].every((k) => P.global[k] && 'on' in P.global[k] && typeof P.global[k].words === 'string'));
    t.check('gpuPrefs: every app has a pref 0-2 or a reason', (P.apps || []).every((a) => [0, 1, 2].includes(a.pref) || typeof a.reason === 'string'));
    const H = P.gpuScheduling || {};
    t.check('gpuPrefs: GPU scheduling read, needs admin, names its elevated action', H.needsAdmin === true && H.elevate === 'sysdisplay.gpuScheduling' && typeof H.source === 'string',
      JSON.stringify(H).slice(0, 300));
    t.check('gpuPrefs: GPU scheduling on is a boolean, or null with a reason', typeof H.on === 'boolean' || (H.on === null && typeof H.reason === 'string'));
    if (VERBOSE) console.log(`  graphics: ${P.apps.length} app prefs, global ${JSON.stringify(P.global && P.global.raw)}, hags ${JSON.stringify([H.on, H.registry, H.supported, H.enabledNow])}`);
    const prefBefore = JSON.stringify(P.apps) + JSON.stringify(P.global);

    const target = (P.apps || []).find((a) => [0, 1, 2].includes(a.pref));
    const app = target ? target.app : process.execPath;           // node.exe exists; a new entry is a dryRun only
    const newPref = target ? (target.pref + 1) % 3 : 2;
    const ps = await send('sysdisplay.gpuPrefSet', { app, pref: newPref, dryRun: true });
    const pw = ps.ok && ps.result.writes[0];
    t.check('gpuPrefSet dryRun: the exact REG_SZ, GpuPreference changed', pw && pw.type === 'REG_SZ' && pw.hive === 'HKCU' && new RegExp('GpuPreference=' + newPref + '(;|$)').test(pw.value),
      JSON.stringify(ps).slice(0, 300));
    if (pw && target) {
      const others = target.raw.split(';').filter((f) => f && !/^GpuPreference=/i.test(f));
      t.check('gpuPrefSet dryRun keeps every other ;-field exactly', others.every((f) => pw.value.split(';').includes(f)) && pw.before === target.raw);
    } else if (pw) t.check('gpuPrefSet dryRun for a new app writes just the preference', pw.value === 'GpuPreference=2;' && pw.before === null);
    const psReal = await send('sysdisplay.gpuPrefSet', { app, pref: newPref });
    t.check('gpuPrefSet (real) answers the passive refusal', refused(psReal), JSON.stringify(psReal).slice(0, 200));
    const psBad = await send('sysdisplay.gpuPrefSet', { app: 'C:\\no\\such\\thing.exe', pref: 1, dryRun: true });
    t.check('gpuPrefSet refuses a path that is not an existing .exe, without echoing it', psBad.ok === false && /not the full path/.test(psBad.error) && noPath(psBad.error));
    const psP = await send('sysdisplay.gpuPrefSet', { app, pref: 3, dryRun: true });
    t.check('gpuPrefSet refuses pref 3', psP.ok === false && /pref/.test(psP.error));

    const gs = await send('sysdisplay.gpuGlobalSet', { key: 'AutoHDREnable', on: !(P.global.AutoHDREnable.on === true), dryRun: true });
    const gw = gs.ok && gs.result.writes[0];
    t.check('gpuGlobalSet dryRun: the exact REG_SZ with AutoHDREnable set', gw && gw.name === 'DirectXUserGlobalSettings' && /AutoHDREnable=[01];/.test(gw.value), JSON.stringify(gs).slice(0, 300));
    if (gw && P.global.raw) {
      const others = P.global.raw.split(';').filter((f) => f && !/^AutoHDREnable=/i.test(f));
      t.check('gpuGlobalSet dryRun keeps every other ;-field exactly', others.every((f) => gw.value.split(';').includes(f)));
    }
    const gsReal = await send('sysdisplay.gpuGlobalSet', { key: 'VRROptimizeEnable', on: true });
    t.check('gpuGlobalSet (real) answers the passive refusal', refused(gsReal) || (gsReal.ok && gsReal.result.changed === false), JSON.stringify(gsReal).slice(0, 200));
    const gsBad = await send('sysdisplay.gpuGlobalSet', { key: 'Nope', on: true, dryRun: true });
    t.check('gpuGlobalSet refuses an unknown key', gsBad.ok === false && /SwapEffectUpgradeEnable/.test(gsBad.error));

    const hs = await send('sysdisplay.gpuSchedulingSet', { on: !(H.on === true), dryRun: true });
    t.check('gpuSchedulingSet dryRun: the HKLM HwSchMode write + needsAdmin + elevate name, or the reason',
      hs.ok && hs.result.elevate === 'sysdisplay.gpuScheduling' && hs.result.restartNeeded === true &&
      (hs.result.wouldRefuse !== null || (hs.result.writes[0].hive === 'HKLM' && hs.result.writes[0].name === 'HwSchMode' && [1, 2].includes(hs.result.writes[0].value) && hs.result.needsAdmin === true)),
      JSON.stringify(hs).slice(0, 300));
    const hsReal = await send('sysdisplay.gpuSchedulingSet', { on: true });
    t.check('gpuSchedulingSet (real) answers the passive refusal', refused(hsReal), JSON.stringify(hsReal).slice(0, 200));
    const gp2 = await send('sysdisplay.gpuPrefs');
    t.check('after the graphics dryRuns, a re-read is identical', gp2.ok && JSON.stringify(gp2.result.apps) + JSON.stringify(gp2.result.global) === prefBefore);

    const el = await send('elevate.list', {}, 8000);
    if (el.ok) {
      t.check('elevate.list offers sysdisplay.gpuScheduling', (el.result.actions || []).some((a) => a.action === 'sysdisplay.gpuScheduling' && /GPU scheduling/.test(a.does)),
        JSON.stringify(el.result.actions).slice(0, 300));
      t.check('elevate.list has no problem with it', !(el.result.problems || []).some((p) => /sysdisplay|SysDisplay/.test(p)));
    }

    // ------------------------------------------------------------------ pure decisions (fake inputs)
    const MODES = [[1920, 1080, 60], [1920, 1080, 144], [1280, 720, 60], [2560, 1440, 165]];
    const dm = async (x) => (await send('sysdisplay.decide', Object.assign({ what: 'mode', modes: MODES }, x))).result || {};
    t.check('decide mode: 59.94 Hz matches the 60 Hz mode', (await dm({ width: 1920, height: 1080, hz: 59.94 })).hz === 60);
    t.check('decide mode: no hz keeps the current rate when offered', (await dm({ width: 1920, height: 1080, currentHz: 144 })).hz === 144);
    t.check('decide mode: no hz falls back to the highest offered', (await dm({ width: 1280, height: 720, currentHz: 144 })).hz === 60);
    const m800 = await dm({ width: 800, height: 600, hz: 60 });
    t.check('decide mode: a missing resolution names the largest offered', m800.ok === false && /2560 x 1440/.test(m800.reason), m800.reason);
    const m75 = await dm({ width: 1920, height: 1080, hz: 75 });
    t.check('decide mode: a missing rate lists the offered ones', m75.ok === false && /offered: 60, 144 Hz/.test(m75.reason), m75.reason);

    const TWO = [{ display: 'A', device: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, primary: true },
                 { display: 'B', device: '\\\\.\\DISPLAY2', x: 1920, y: 0, width: 1280, height: 1024 }];
    const da = async (positions) => (await send('sysdisplay.decide', { what: 'arrange', displays: TWO, positions })).result || {};
    const left = await da([{ display: 'B', x: -1280, y: 56 }]);
    t.check('decide arrange: B to the left, touching, is fine', left.ok && left.changed && left.layout[1].x === -1280 && left.layout[1].y === 56, JSON.stringify(left).slice(0, 300));
    t.check('decide arrange: writes one saved position per display then one apply',
      left.ok && left.writes.length === 3 && left.writes[0].flags.includes('CDS_UPDATEREGISTRY') && left.writes[0].flags.includes('CDS_NORESET') &&
      left.writes[0].flags.includes('CDS_SET_PRIMARY') && left.writes[2].step === 'cds.apply', JSON.stringify(left.writes));
    t.check('decide arrange: the revert writes the old positions', left.revert && left.revert[1].x === 1920 && left.revert[1].y === 0);
    t.check('decide arrange: corner-only contact is refused', /touch another along an edge/.test((await da([{ display: 'B', x: 1920, y: 1080 }])).reason || ''));
    t.check('decide arrange: a gap is refused', /touch another along an edge/.test((await da([{ display: 'B', x: 1950, y: 0 }])).reason || ''));
    t.check('decide arrange: an overlap is refused', /overlap/.test((await da([{ display: 'B', x: 1000, y: 0 }])).reason || ''));
    const shifted = await da([{ display: 'A', x: 100, y: 100 }, { display: 'B', x: 2020, y: 100 }]);
    t.check('decide arrange: the main display is shifted back to 0,0 with the rest', shifted.ok && shifted.layout[0].x === 0 && shifted.layout[0].y === 0 && shifted.layout[1].x === 1920 && shifted.changed === false,
      JSON.stringify(shifted).slice(0, 300));
    t.check('decide arrange: a display named twice is refused', /named twice/.test((await da([{ display: 'B', x: -1280, y: 0 }, { display: 'B', x: 1920, y: 0 }])).reason || ''));
    const dp = (await send('sysdisplay.decide', { what: 'primary', displays: TWO, display: 'B' })).result || {};
    t.check('decide primary: B becomes 0,0 and A moves with it', dp.ok && dp.layout[1].x === 0 && dp.layout[1].primary === true && dp.layout[0].x === -1920 && dp.layout[0].primary === false,
      JSON.stringify(dp).slice(0, 300));
    t.check('decide primary: CDS_SET_PRIMARY goes on B only', dp.ok && dp.writes[1].flags.includes('CDS_SET_PRIMARY') && !dp.writes[0].flags.includes('CDS_SET_PRIMARY'));

    const ds1 = (await send('sysdisplay.decide', { what: 'scale', min: -2, current: 0, max: 3, percent: 200 })).result || {};
    t.check('decide scale: min -2 -> recommended 150%, current 150%, up to 225%',
      ds1.recommended === 150 && ds1.percent === 150 && JSON.stringify(ds1.allowed) === '[100,125,150,175,200,225]', JSON.stringify(ds1));
    t.check('decide scale: 200% is +2 steps from recommended', ds1.scaleRel === 2 && ds1.refuse === null);
    const ds2 = (await send('sysdisplay.decide', { what: 'scale', min: -2, current: -1, max: 3, percent: 250 })).result || {};
    t.check('decide scale: current -1 is 125%; 250% is past the limit', ds2.percent === 125 && /larger than this display allows/.test(ds2.refuse || ''));
    const ds3 = (await send('sysdisplay.decide', { what: 'scale', min: 0, current: 0, max: 2, percent: 100 })).result || {};
    t.check('decide scale: min 0 -> recommended 100%, rel 0', ds3.recommended === 100 && ds3.scaleRel === 0);
    const ds4 = (await send('sysdisplay.decide', { what: 'scale', min: 3, current: 0, max: 0 })).result || {};
    t.check('decide scale: impossible steps answer a reason, not a guess', ds4.percent === null && typeof ds4.reason === 'string');

    const rm = (await send('sysdisplay.decide', { what: 'revert', kind: 'mode', display: 'A', device: '\\\\.\\DISPLAY1', width: 1920, height: 1080, hz: 144, orientation: 'landscape', bpp: 32 })).result || {};
    t.check('decide revert mode: the recorded mode, dynamically', rm.ok && rm.revert.length === 1 && rm.revert[0].step === 'cds.mode' && rm.revert[0].width === 1920 && rm.revert[0].hz === 144 &&
      rm.revert[0].flags.includes('dynamic (not saved)'), JSON.stringify(rm));
    const rt2 = (await send('sysdisplay.decide', { what: 'revert', kind: 'topology', topology: 'extend' })).result || {};
    t.check('decide revert topology: SDC_TOPOLOGY_EXTEND | SDC_APPLY', rt2.ok && rt2.revert[0].flags.includes('SDC_APPLY') && rt2.revert[0].flags.includes('SDC_TOPOLOGY_EXTEND'));
    const ra = (await send('sysdisplay.decide', { what: 'revert', kind: 'arrange', displays: TWO })).result || {};
    t.check('decide revert arrange: every old position, then one apply', ra.ok && ra.revert.length === 3 && ra.revert[1].x === 1920 && ra.revert[2].step === 'cds.apply');

    const fld = async (data, key, value) => (await send('sysdisplay.decide', { what: 'field', data, key, value })).result || {};
    t.check('decide field: replaces in place, other fields untouched',
      (await fld('GpuPreference=1;SwapEffectUpgradeEnable=1;', 'GpuPreference', '2')).set === 'GpuPreference=2;SwapEffectUpgradeEnable=1;');
    t.check('decide field: appends a missing key', (await fld('SwapEffectUpgradeEnable=1;', 'AutoHDREnable', '0')).set === 'SwapEffectUpgradeEnable=1;AutoHDREnable=0;');
    t.check('decide field: adds the ; a value lacked', (await fld('A=1', 'B', '0')).set === 'A=1;B=0;');
    t.check('decide field: empty data', (await fld(null, 'GpuPreference', '0')).set === 'GpuPreference=0;');
    t.check('decide field: reads a value', (await fld('X=5;VRROptimizeEnable=1;', 'VRROptimizeEnable')).get === '1');
    const dw = await send('sysdisplay.decide', { what: 'nope' });
    t.check('decide names its choices on a bad what', dw.ok === false && /mode, arrange, primary, scale, revert, night or field/.test(dw.error));
  } catch (e) {
    t.fail('the test itself threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
