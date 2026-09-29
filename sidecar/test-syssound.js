// test-syssound.js - the Sound backend (SysSound.cs, lane syssnd, 2026-09-28), passive only.
//
//   node sidecar/test-syssound.js --exe=<your built Mantle.Sidecar.exe>   [--verbose]
//
// NEVER changes Owen's sound: every write is sent with dryRun (and a re-read proves nothing moved),
// every real write - the test tone and the microphone test included - is sent to a PASSIVE sidecar and
// must answer the passive refusal, and the format maths is proven with made-up inputs through
// syssound.decide. Reads are real (devices, levels, formats, spatial sound, the app mixer and each
// app's own device through the undocumented factory). Output carries counts and shapes only - never
// a device, app or path name (privacy rule).
'use strict';

const T = require('./test-lib');

const VERBOSE = process.argv.includes('--verbose');
const REFUSAL = T.PASSIVE_REFUSAL || 'refused: sidecar is passive (test mode)';
const KEY = /^\{0\.0\.[01]\.00000000\}\.\{[0-9a-f-]{36}\}$/i;

(async () => {
  const t = T.checker('SYSSOUND');
  const s = await T.startPassive({ readyMs: 30000 });
  let last = '';
  const send = (cmd, extra, ms) => { last = cmd + ' ' + Object.keys(extra || {}).join(','); return s.send(cmd, extra || {}, ms || 20000); };
  const refused = (r) => r && r.ok === false && typeof r.error === 'string' && r.error.startsWith(REFUSAL);
  const said = (r, re) => r && r.ok === false && re.test(String(r.error || ''));
  const noPath = (txt) => !/[A-Za-z]:\\/.test(String(txt || ''));
  const log = (...a) => { if (VERBOSE) console.log(...a); };
  const names = [];
  try {
    // ------------------------------------------------------------ registration
    const el = await send('elevate.list', {});
    const acts = el.ok && el.result && Array.isArray(el.result.actions) ? el.result.actions.map((a) => a.action) : [];
    t.check('elevate.list carries syssound.deviceProp', acts.includes('syssound.deviceProp'), acts.join(' '));
    const probs = el.ok && el.result && Array.isArray(el.result.problems) ? el.result.problems.filter((p) => /syssound/i.test(JSON.stringify(p))) : [];
    t.check('elevate.list names no problem with a syssound action', probs.length === 0, JSON.stringify(probs));

    // ------------------------------------------------------------ syssound.devices
    const t0 = Date.now();
    const d = await send('syssound.devices', {}, 30000);
    const ms = Date.now() - t0;
    t.check('devices answers', d.ok === true && d.result && d.result.output && d.result.input, JSON.stringify(d).slice(0, 300));
    const R = d.result || {};
    const outs = (R.output && R.output.devices) || [], ins = (R.input && R.input.devices) || [];
    const all = outs.concat(ins);
    for (const x of all) { if (x.name) names.push(x.name); if (x.label) names.push(x.label); if (x.adapter) names.push(x.adapter); }
    t.check('devices: at least one output device', outs.length >= 1, `outputs ${outs.length}`);
    t.check('devices: every device has a key, a flow and a state', all.every((x) => KEY.test(x.device) && (x.flow === 'output' || x.flow === 'input') && /^(active|disabled|unplugged|notpresent|unknown)$/.test(x.state)));
    t.check('devices: outputs are {0.0.0...}, inputs {0.0.1...}', outs.every((x) => x.device.startsWith('{0.0.0.')) && ins.every((x) => x.device.startsWith('{0.0.1.')));
    const dOut = outs.find((x) => x.isDefault), dIn = ins.find((x) => x.isDefault);
    t.check('devices: one default output, and it is the reported default', outs.filter((x) => x.isDefault).length === 1 && dOut && dOut.device === R.output.defaultDevice);
    t.check('devices: the default output is active with a volume 0-100 and channels', dOut && dOut.state === 'active' && dOut.volume && Number.isInteger(dOut.volume.level) && dOut.volume.level >= 0 && dOut.volume.level <= 100 && Array.isArray(dOut.volume.channels) && dOut.volume.channels.length >= 1, JSON.stringify(dOut && dOut.volume));
    t.check('devices: every channel has a name and a level', dOut && dOut.volume.channels.every((c) => typeof c.name === 'string' && Number.isInteger(c.level)));
    t.check('devices: the default output has a format with its words', dOut && dOut.format && dOut.format.rate > 0 && /channel, \d+ bit, \d+ Hz/.test(dOut.format.text), JSON.stringify(dOut && dOut.format));
    const offered = dOut && Array.isArray(dOut.formats) ? dOut.formats : [];
    t.check('devices: the default output lists formats it takes, or says why not', offered.length > 0 || (dOut && typeof dOut.formatsReason === 'string'), dOut && dOut.formatsReason);
    t.check('devices: the current format is among the offered ones (when any are)', !offered.length || offered.some((f) => f.rate === dOut.format.rate && f.bits === dOut.format.bits), offered.map((f) => f.value).join(' '));
    t.check('devices: enhancements and exclusive mode are read', all.every((x) => x.enhancements && typeof x.enhancements.on === 'boolean' && x.exclusive && typeof x.exclusive.allow === 'boolean'));
    const sp = dOut && dOut.spatial;
    t.check('devices: spatial sound answers for the default output (value or reason)', sp && (typeof sp.supported === 'boolean' ? Array.isArray(sp.formats) : typeof sp.why === 'string'), JSON.stringify(sp));
    t.check('devices: no spatial block on inputs', ins.every((x) => x.spatial == null));
    t.check('devices: mono audio and ducking are read', R.mono && typeof R.mono.on === 'boolean' && R.ducking && Number.isInteger(R.ducking.value) && R.ducking.options.length === 4);
    t.check('devices: "Listen to this device" is read-only WITH its reason', R.listen && R.listen.writable === false && /Sound control panel/.test(R.listen.why));
    t.check('devices: whether device properties need administrator is known', typeof R.propsWritable === 'boolean', String(R.propsWritable));
    t.check('devices: no reason carries a path', noPath(JSON.stringify(all.map((x) => [x.formatsReason, x.volume && x.volume.reason, x.spatial && x.spatial.why]))));
    console.log(`measured: ${outs.length} outputs (${outs.filter((x) => x.state === 'active').length} active), ${ins.length} inputs (${ins.filter((x) => x.state === 'active').length} active), read in ${ms} ms; ` +
      `default output ${dOut ? `${dOut.volume.channels.length} ch, ${dOut.format ? dOut.format.rate + '/' + dOut.format.bits : 'no format'}, ${offered.length} formats, formFactor ${dOut.formFactor}` : 'none'}; ` +
      `spatial ${sp ? `supported=${sp.supported} formats=${(sp.formats || []).length} current=${sp.current ? 'set' : 'off'}` : 'n/a'}; ` +
      `propsWritable=${R.propsWritable}; mono=${R.mono && R.mono.on}; ducking=${R.ducking && R.ducking.value}; ` +
      `enhancements set on ${all.filter((x) => x.enhancements.set).length}, exclusive keys set on ${all.filter((x) => x.exclusive.set).length}`);

    // ------------------------------------------------------------ meter + apps
    const m = await send('syssound.meter', {});
    t.check('meter answers a peak 0-100 per active device', m.ok && Array.isArray(m.result.peaks) && m.result.peaks.every((p) => KEY.test(p.device) && p.peak >= 0 && p.peak <= 100), JSON.stringify(m).slice(0, 200));
    const a = await send('syssound.apps', {}, 30000);
    t.check('apps answers', a.ok && Array.isArray(a.result.apps), JSON.stringify(a).slice(0, 300));
    const apps = (a.result && a.result.apps) || [];
    for (const x of apps) { if (x.name) names.push(x.name); }
    t.check('apps: every app has a key, a level and a mute', apps.every((x) => /^(system|pid:\d+|sid:\d+)$/.test(x.app) && Number.isInteger(x.level) && typeof x.muted === 'boolean'));
    t.check('apps: system sounds come first (when present) and cannot take a device', apps.every((x, i) => !x.system || (i === 0 && x.deviceWritable === false && /default device/.test(x.deviceWhy))));
    t.check('apps: per-app devices answered (or said why not)', a.result && (a.result.perAppDevices === true || typeof a.result.perAppWhy === 'string'), a.result && a.result.perAppWhy);
    const pidApps = apps.filter((x) => /^pid:/.test(x.app));
    t.check('apps: each app\'s own devices are a key or "" (the default)', pidApps.every((x) => !x.deviceWritable || ((x.output === '' || KEY.test(x.output)) && (x.input === '' || KEY.test(x.input)))), JSON.stringify(pidApps.map((x) => [x.output, x.input])));
    console.log(`measured: ${apps.length} apps with sound (${pidApps.length} by process, ${apps.filter((x) => x.active).length} playing); per-app devices ${a.result && a.result.perAppDevices ? 'readable' : 'NOT readable: ' + (a.result && a.result.perAppWhy)}; ${pidApps.filter((x) => x.output).length} apps with their own output`);
    // the factory's Get slot, READ for the shell's own process (measured: S_OK with "" = the default);
    // a process Windows has no audio identity for (this node) answers E_INVALIDARG, which must be words
    let shell = 0;
    try {
      const out = require('child_process').execSync('tasklist /FI "IMAGENAME eq explorer.exe" /FO CSV /NH', { encoding: 'utf8' });
      shell = Number((out.split(/\r?\n/)[0] || '').split('","')[1]) || 0;
    } catch (_) { shell = 0; }
    if (shell) {
      const pb = await send('syssound.apps', { probePid: shell }, 30000);
      const pr = pb.ok && pb.result.probe;
      t.check('apps probePid: the shell\'s own devices are read through the factory', pr && pr.pid === shell && pr.read === true, JSON.stringify(pr));
      t.check('apps probePid: they are "" (follows the default) or a device key', pr && (pr.output === '' || KEY.test(pr.output)) && (pr.input === '' || KEY.test(pr.input)), JSON.stringify(pr));
      console.log(`measured: per-app device read for the shell: ${pr ? `read=${pr.read} output=${pr.output === '' ? 'default' : pr.output ? 'own' : 'none'} input=${pr.input === '' ? 'default' : pr.input ? 'own' : 'none'}` : 'no answer'}`);
    } else t.fail('apps probePid: no shell process to read');
    const pn = await send('syssound.apps', { probePid: process.pid }, 30000);
    const pq = pn.ok && pn.result.probe;
    t.check('apps probePid: a process Windows will not answer for says so in words', pq && (pq.read === true || /would not say which device this app uses \(HRESULT 0x/.test(pq.reason || '')), JSON.stringify(pq));
    const alive = await send('syssound.decide', { what: 'channels', mask: 3, count: 2 });
    t.check('the sidecar is still alive after the per-app vtable reads', alive.ok === true);

    // ------------------------------------------------------------ dry runs (and a re-read proves nothing moved)
    if (dOut) {
      const other = outs.find((x) => x.state === 'active' && !x.isDefault);
      const same = await send('syssound.default', { device: dOut.device, role: 'default', dryRun: true });
      t.check('default dryRun: the current default writes nothing', same.ok && same.result.dryRun === true && same.result.changed === false && same.result.writes.length === 0, JSON.stringify(same).slice(0, 200));
      if (other) {
        const dr = await send('syssound.default', { device: other.device, role: 'default', dryRun: true });
        t.check('default dryRun: another device would write SetDefaultEndpoint', dr.ok && dr.result.changed === true && dr.result.writes.length === 1 && dr.result.writes[0].api === 'IPolicyConfig.SetDefaultEndpoint', JSON.stringify(dr).slice(0, 200));
      } else log('only one active output: the "another device" dry run is skipped');
      const comm = await send('syssound.default', { device: dOut.device, role: 'communications', dryRun: true });
      t.check('default dryRun: communications role answers', comm.ok && comm.result.dryRun === true);
      const want = dOut.volume.level >= 50 ? dOut.volume.level - 10 : dOut.volume.level + 10;
      const lv = await send('syssound.level', { device: dOut.device, level: want, muted: !dOut.volume.muted, dryRun: true });
      t.check('level dryRun: volume + mute would write two calls', lv.ok && lv.result.writes.length === 2 && lv.result.before.level === dOut.volume.level, JSON.stringify(lv).slice(0, 300));
      const ch = await send('syssound.level', { device: dOut.device, channel: 0, level: dOut.volume.channels[0].level === 100 ? 90 : 100, dryRun: true });
      t.check('level dryRun: one channel would write SetChannelVolumeLevelScalar', ch.ok && ch.result.writes.length === 1 && ch.result.writes[0].api === 'IAudioEndpointVolume.SetChannelVolumeLevelScalar', JSON.stringify(ch).slice(0, 200));
      const bad = await send('syssound.level', { device: dOut.device, channel: 9, level: 50, dryRun: true });
      t.check('level: a channel the device does not have is refused in words', said(bad, /needs channel: 0 to/), bad.error);
      const nm = await send('syssound.props', { device: dOut.device, prop: 'name', value: 'Made-up name', dryRun: true });
      t.check('props dryRun: a rename answers what it would write (or needs admin)', nm.ok && nm.result.dryRun && nm.result.writes.length === 1 && nm.result.writes[0].api === 'IPropertyStore.SetValue' && (nm.result.needsAdmin === false || nm.result.elevate === 'syssound.deviceProp'), JSON.stringify(nm).slice(0, 300));
      const en = await send('syssound.props', { device: dOut.device, prop: 'enhancements', value: !dOut.enhancements.on, dryRun: true });
      t.check('props dryRun: enhancements flip would write the SysFx key', en.ok && en.result.changed === true && en.result.writes.length === 1, JSON.stringify(en).slice(0, 300));
      const ex = await send('syssound.props', { device: dOut.device, prop: 'exclusive', value: dOut.exclusive.allow, dryRun: true });
      t.check('props dryRun: exclusive mode at its current value writes nothing', ex.ok && ex.result.changed === false && ex.result.writes.length === 0, JSON.stringify(ex).slice(0, 300));
      if (offered.length) {
        const cur = offered.find((f) => f.rate === dOut.format.rate && f.bits === dOut.format.bits) || offered[0];
        const alt = offered.find((f) => f !== cur);
        const f1 = await send('syssound.props', { device: dOut.device, prop: 'format', value: cur.value, dryRun: true });
        t.check('props dryRun: the current format writes nothing', f1.ok && f1.result.writes.length === 0, JSON.stringify(f1).slice(0, 300));
        if (alt) {
          const f2 = await send('syssound.props', { device: dOut.device, prop: 'format', value: alt.value, dryRun: true });
          t.check('props dryRun: another offered format would write SetDeviceFormat', f2.ok && f2.result.changed === true && f2.result.writes[0].api === 'IPolicyConfig.SetDeviceFormat', JSON.stringify(f2).slice(0, 300));
        }
      }
      const f3 = await send('syssound.props', { device: dOut.device, prop: 'format', value: '12345/16/16', dryRun: true });
      t.check('props: a made-up format is refused in words', said(f3, /format needs value/), f3.error);
      const sp1 = await send('syssound.props', { device: dOut.device, prop: 'spatial', value: 'not-a-format', dryRun: true });
      t.check('props dryRun: an unknown spatial format would be refused, with the reason', sp1.ok && typeof sp1.result.wouldRefuse === 'string' && sp1.result.writes.length === 0, JSON.stringify(sp1).slice(0, 300));
      const spOff = await send('syssound.props', { device: dOut.device, prop: 'spatial', value: '', dryRun: true });
      t.check('props dryRun: spatial Off answers', spOff.ok && spOff.result.dryRun === true, JSON.stringify(spOff).slice(0, 300));
      const e1 = await send('syssound.enable', { device: dOut.device, on: false, dryRun: true });
      t.check('enable dryRun: disabling the default says Windows picks another', e1.ok && e1.result.changed === true && /pick another/.test(e1.result.note || ''), JSON.stringify(e1).slice(0, 300));
      const tn = await send('syssound.tone', { device: dOut.device, dryRun: true });
      t.check('tone dryRun: says what it would play', tn.ok && tn.result.dryRun && tn.result.writes.length === 1, JSON.stringify(tn).slice(0, 200));
      const tr = await send('syssound.tone', { device: dOut.device });
      t.check('tone: PASSIVE refuses to play', refused(tr), JSON.stringify(tr).slice(0, 200));
      for (const [cmd, args] of [['syssound.default', { device: dOut.device, role: 'default' }], ['syssound.level', { device: dOut.device, level: 10 }],
        ['syssound.props', { device: dOut.device, prop: 'enhancements', value: true }], ['syssound.props', { device: dOut.device, prop: 'name', value: 'x' }],
        ['syssound.props', { device: dOut.device, prop: 'spatial', value: '' }], ['syssound.enable', { device: dOut.device, on: true }],
        ['syssound.setting', { key: 'mono', value: true }], ['syssound.setting', { key: 'ducking', value: 3 }], ['syssound.resetApps', {}]]) {
        const r = await send(cmd, args);
        t.check(`${cmd} ${args.prop || args.key || ''}: PASSIVE refuses the real write`.replace(/\s+:/, ':'), refused(r), JSON.stringify(r).slice(0, 200));
      }
    }
    if (dIn) {
      const mt = await send('syssound.micTest', { device: dIn.device, ms: 1000, dryRun: true });
      t.check('micTest dryRun: says it would listen, keeps nothing', mt.ok && mt.result.dryRun && /nothing kept/.test(mt.result.writes[0].value), JSON.stringify(mt).slice(0, 200));
      const mr = await send('syssound.micTest', { device: dIn.device, ms: 1000 });
      t.check('micTest: PASSIVE refuses to listen', refused(mr), JSON.stringify(mr).slice(0, 200));
      const wrong = await send('syssound.micTest', { device: dOut ? dOut.device : dIn.device.replace('{0.0.1.', '{0.0.0.'), dryRun: true });
      t.check('micTest: an output device is refused in words', said(wrong, /listens to an input device/), wrong.error);
      const lvIn = await send('syssound.level', { device: dIn.device, level: dIn.volume.level === 100 ? 90 : 100, dryRun: true });
      t.check('level dryRun: the input level too', lvIn.ok && lvIn.result.writes.length === 1, JSON.stringify(lvIn).slice(0, 200));
      const spIn = await send('syssound.props', { device: dIn.device, prop: 'spatial', value: '', dryRun: true });
      t.check('props: spatial on an input is refused in words', said(spIn, /output devices only/), spIn.error);
    } else log('no default input: the microphone dry runs are skipped');
    const mono = await send('syssound.setting', { key: 'mono', value: !R.mono.on, dryRun: true });
    t.check('setting dryRun: mono writes ONE HKCU value', mono.ok && mono.result.writes.length === 1 && mono.result.writes[0].hive === 'HKCU' && mono.result.writes[0].name === 'AccessibilityMonoMixState', JSON.stringify(mono).slice(0, 300));
    const duck = await send('syssound.setting', { key: 'ducking', value: (R.ducking.value + 1) % 4, dryRun: true });
    t.check('setting dryRun: ducking writes UserDuckingPreference', duck.ok && duck.result.writes[0].name === 'UserDuckingPreference', JSON.stringify(duck).slice(0, 300));
    const duckBad = await send('syssound.setting', { key: 'ducking', value: 7, dryRun: true });
    t.check('setting: ducking outside 0-3 is refused', said(duckBad, /0 to 3/), duckBad.error);
    const rs = await send('syssound.resetApps', { dryRun: true });
    t.check('resetApps dryRun: clears per-app devices and volumes', rs.ok && rs.result.writes.length === 2 && /ClearAllPersisted/.test(rs.result.writes[0].api), JSON.stringify(rs).slice(0, 300));
    const app = pidApps[0] || apps[0];
    if (app) {
      const as = await send('syssound.appSet', { app: app.app, level: app.level === 100 ? 80 : 100, dryRun: true });
      t.check('appSet dryRun: one app\'s level would be set on its sessions', as.ok && as.result.writes.length === 1 && as.result.writes[0].sessions >= 1, JSON.stringify(as).slice(0, 300));
      const ar = await send('syssound.appSet', { app: app.app, muted: !app.muted });
      t.check('appSet: PASSIVE refuses the real write', refused(ar), JSON.stringify(ar).slice(0, 200));
    } else log('no app is playing sound: the app dry runs are skipped');
    if (pidApps[0] && pidApps[0].deviceWritable && dOut) {
      const ad = await send('syssound.appDevice', { app: pidApps[0].app, flow: 'output', device: pidApps[0].output ? '' : dOut.device, dryRun: true });
      t.check('appDevice dryRun: would set the app\'s own output device', ad.ok && ad.result.changed === true && /SetPersistedDefaultAudioEndpoint/.test(ad.result.writes[0].api), JSON.stringify(ad).slice(0, 300));
      const ar = await send('syssound.appDevice', { app: pidApps[0].app, flow: 'output', device: '' });
      t.check('appDevice: PASSIVE refuses the real write', refused(ar), JSON.stringify(ar).slice(0, 200));
      if (dIn) {
        const wrongFlow = await send('syssound.appDevice', { app: pidApps[0].app, flow: 'output', device: dIn.device, dryRun: true });
        t.check('appDevice: an input device as an output is refused', said(wrongFlow, /input device/), wrongFlow.error);
      }
    } else log('no app with a device of its own to try: the appDevice dry run is skipped');
    const sysDev = await send('syssound.appDevice', { app: 'system', flow: 'output', device: '', dryRun: true });
    t.check('appDevice: system sounds cannot take a device, said in words', said(sysDev, /default device/), sysDev.error);

    // ------------------------------------------------------------ argument checks
    for (const [cmd, args, re, what] of [
      ['syssound.level', { device: 'C:\\not-a-device', level: 5, dryRun: true }, /needs device/, 'a path as a device'],
      ['syssound.level', { device: '{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}', level: 5, dryRun: true }, /not on this PC/, 'an unknown device'],
      ['syssound.level', { device: dOut ? dOut.device : 'x', level: 101, dryRun: true }, /0 to 100/, 'level 101'],
      ['syssound.level', { device: dOut ? dOut.device : 'x', dryRun: true }, /needs level/, 'nothing to set'],
      ['syssound.level', { device: dOut ? dOut.device : 'x', channel: 0, level: 5, muted: true, dryRun: true }, /level only/, 'channel with mute'],
      ['syssound.default', { device: dOut ? dOut.device : 'x', role: 'everything', dryRun: true }, /needs role/, 'a made-up role'],
      ['syssound.props', { device: dOut ? dOut.device : 'x', prop: 'volume', value: 1, dryRun: true }, /needs prop/, 'a made-up property'],
      ['syssound.props', { device: dOut ? dOut.device : 'x', prop: 'name', value: '', dryRun: true }, /1 to 64/, 'an empty name'],
      ['syssound.props', { device: dOut ? dOut.device : 'x', prop: 'name', value: 'a\u0007b', dryRun: true }, /control characters/, 'a control character in a name'],
      ['syssound.props', { device: dOut ? dOut.device : 'x', prop: 'enhancements', value: 'yes', dryRun: true }, /true or false/, 'a string for a switch'],
      ['syssound.appSet', { app: 'C:\\x.exe', level: 5, dryRun: true }, /needs app/, 'a path as an app'],
      ['syssound.appDevice', { app: 'pid:1', flow: 'sideways', device: '', dryRun: true }, /needs flow/, 'a made-up flow'],
      ['syssound.setting', { key: 'loudness', value: true, dryRun: true }, /needs key/, 'a made-up setting'],
      ['syssound.tone', { device: dOut ? dOut.device : 'x', dryRun: 'yes' }, /dryRun: true or false/, 'dryRun as a string'],
    ]) {
      const r = await send(cmd, args);
      t.check(`args: ${what} is refused in words`, said(r, re) && noPath(r.error), r.error);
    }

    // ------------------------------------------------------------ syssound.decide (pure)
    const mk = await send('syssound.decide', { what: 'make', channels: 2, rate: 48000, bits: 24, container: 32 });
    t.check('decide make: 40-byte WAVEFORMATEXTENSIBLE', mk.ok && mk.result.hex.length === 80 && mk.result.hex.startsWith('feff0200'), mk.result && mk.result.hex);
    t.check('decide make: parses back as 2 ch 24/32 at 48000', mk.ok && mk.result.format.rate === 48000 && mk.result.format.bits === 24 && mk.result.format.container === 32 && mk.result.format.value === '48000/24/32' && /Studio Quality/.test(mk.result.format.text), JSON.stringify(mk.result && mk.result.format));
    const cd = await send('syssound.decide', { what: 'make', channels: 2, rate: 44100, bits: 16 });
    t.check('decide make: 16/44100 is CD Quality', cd.ok && cd.result.format.text === '2 channel, 16 bit, 44100 Hz (CD Quality)', cd.result && cd.result.format.text);
    const fl = await send('syssound.decide', { what: 'make', channels: 2, rate: 48000, bits: 32, float: true });
    t.check('decide make: float is recognised', fl.ok && fl.result.format.float === true);
    const pcm = await send('syssound.decide', { what: 'fmt', hex: '01000200' + '80bb0000' + '00ee0200' + '0400' + '1000' });
    t.check('decide fmt: a plain 16-byte PCMWAVEFORMAT parses', pcm.ok && pcm.result.format.rate === 48000 && pcm.result.format.bits === 16 && pcm.result.format.channels === 2 && pcm.result.format.float === false, JSON.stringify(pcm.result));
    const short = await send('syssound.decide', { what: 'fmt', hex: '0100' });
    t.check('decide fmt: too short is no format', short.ok && short.result.format === null);
    for (const [v, ok] of [['48000/24/32', true], ['44100/16/16', true], ['96000/24/24', true], ['48000/16/32', false], ['12345/16/16', false], ['48000/24', false], ['48000/20/20', false], ['', false]]) {
      const r = await send('syssound.decide', { what: 'value', value: v });
      t.check(`decide value: "${v}" is ${ok ? 'a format' : 'refused'}`, r.ok && r.result.ok === ok);
    }
    const pa = await send('syssound.decide', { what: 'path', device: '{0.0.0.00000000}.{12345678-aaaa-bbbb-cccc-1234567890ab}', flow: 'output' });
    t.check('decide path: output interface path round-trips', pa.ok && /^\\\\\?\\SWD#MMDEVAPI#\{0\.0\.0\.00000000\}\.\{12345678-aaaa-bbbb-cccc-1234567890ab\}#\{e6327cad-dcec-4949-ae8a-991e976a79d2\}$/.test(pa.result.path) && pa.result.back === '{0.0.0.00000000}.{12345678-aaaa-bbbb-cccc-1234567890ab}', JSON.stringify(pa.result));
    t.check('decide path: "" is the default, junk is nothing', pa.ok && pa.result.empty === '' && pa.result.junk === null);
    const pi = await send('syssound.decide', { what: 'path', device: '{0.0.1.00000000}.{12345678-aaaa-bbbb-cccc-1234567890ab}', flow: 'input' });
    t.check('decide path: input uses the capture interface class', pi.ok && /#\{2eef81be-33fa-4800-9670-1cd474972c3f\}$/.test(pi.result.path));
    const c51 = await send('syssound.decide', { what: 'channels', mask: 0x3f, count: 6 });
    t.check('decide channels: 5.1 names', c51.ok && c51.result.names.join(',') === 'Left,Right,Center,Subwoofer,Back left,Back right', c51.result && c51.result.names.join(','));
    const mono1 = await send('syssound.decide', { what: 'channels', mask: 4, count: 1 });
    t.check('decide channels: one channel is Mono', mono1.ok && mono1.result.names.join() === 'Mono');
    const st = await send('syssound.decide', { what: 'channels', mask: 0, count: 2 });
    t.check('decide channels: no mask, two channels = Left, Right', st.ok && st.result.names.join(',') === 'Left,Right');

    // ------------------------------------------------------------ nothing moved
    const d2 = await send('syssound.devices', {}, 30000);
    const R2 = d2.result || {};
    const o2 = ((R2.output && R2.output.devices) || []).find((x) => x.isDefault);
    t.check('after: the default output is unchanged', o2 && dOut && o2.device === dOut.device && R2.output.defaultComms === R.output.defaultComms);
    t.check('after: the volume and mute are unchanged', o2 && dOut && o2.volume.level === dOut.volume.level && o2.volume.muted === dOut.volume.muted, `${o2 && o2.volume.level} vs ${dOut && dOut.volume.level}`);
    t.check('after: the format and enhancements are unchanged', o2 && dOut && JSON.stringify(o2.format) === JSON.stringify(dOut.format) && o2.enhancements.on === dOut.enhancements.on);
    t.check('after: mono and ducking are unchanged', R2.mono && R2.mono.on === R.mono.on && R2.ducking.value === R.ducking.value);
    t.check('after: every device is in the same state', JSON.stringify(((R2.output && R2.output.devices) || []).concat((R2.input && R2.input.devices) || []).map((x) => x.state)) === JSON.stringify(all.map((x) => x.state)));

    // ------------------------------------------------------------ privacy
    const noise = s.stderr + JSON.stringify(s.events.filter((e) => e.ev !== 'ready'));
    const leaked = names.filter((n) => n && n.length > 3 && noise.includes(n));
    t.check('privacy: no device or app name in stderr or events', leaked.length === 0, `${leaked.length} names leaked`);
    t.check('privacy: no syssound event was sent by a passive run', !s.events.some((e) => e.ev === 'syssound'));
  } catch (e) {
    t.fail('threw', (e && e.message) + ' during ' + last);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();
