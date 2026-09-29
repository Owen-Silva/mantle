'use strict';
/*
 * devnet.test.js - the main halves of Settings' devices (and, when it exists, network) sections
 * against a FAKE sidecar (lane devnet, 2026-09-28). Plain node, no Electron, nothing real:
 *   node lib/features/_settings-sections/devnet.test.js      -> "DEVNET MAIN TEST: n passed, m failed"
 * Proves: a test run turns every write into the sidecar's own dryRun and answers the kit's test-run
 * shape; a real write answers the read-back; arguments pass a whitelist (an `id` never reaches the
 * sidecar); administrator actions go through env.elevate, and in a test run through the plan command
 * only; a declined prompt answers `cancelled`.
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

function env(test, answers) {
  const sent = [], elevations = [], pushed = [];
  const e = {
    id: 'devices', test,
    sidecar: {
      async send(cmd, args) {
        sent.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) });   // a copy: a caller may delete keys after sending
        const f = answers[cmd];
        return f ? f(args) : { ok: false, error: `unknown command ${cmd}` };
      },
      on() { return () => {}; },
    },
    log() {}, settings: { get: (k, d) => d, set() {} },
    onRest() { return () => {}; },
    async elevate(action, args) { elevations.push({ action, args }); return answers['elevate:' + action] ? answers['elevate:' + action](args) : { ok: true, result: { on: args.on } }; },
    push(ev, p) { pushed.push({ ev, p }); return true; },
  };
  return { e, sent, elevations, pushed };
}

(async () => {
  const dev = require('./devices');
  check('devices module id', dev.id === 'devices');
  const names = Object.keys(dev.commands);
  check('every command name is letters/digits/_', names.every((n) => /^[A-Za-z0-9_]+$/.test(n)), names.join(','));

  const answers = {
    'devinput.set': (a) => ({ ok: true, result: a.dryRun ? { ok: true, dryRun: true, would: 'set the pointer speed from 10 to 12', from: 10, to: 12 } : { ok: true, now: 12 } }),
    'devinput.get': () => ({ ok: true, result: { ok: true, values: { 'mouse.speed': 10 } } }),
    'printers.setDefault': (a) => ({ ok: true, result: a.dryRun ? { ok: true, dryRun: true, would: 'make it the default printer' } : { ok: true } }),
    'devcam.plan': () => ({ ok: true, result: { ok: true, dryRun: true, would: 'switch the camera off for every app after an administrator prompt' } }),
    'usb.set': (a) => ({ ok: true, result: { ok: true, dryRun: !!a.dryRun, would: 'turn USB battery saver off for every user, after an administrator prompt', now: a.value } }),
    'devpair.pair': (a) => ({ ok: true, result: a.dryRun ? { ok: true, dryRun: true, would: 'pair with this device' } : { ok: true, status: 'Paired' } }),
    'autoplay.get': () => ({ ok: false, error: 'autoplay.get failed: the registry said no' }),
  };

  // --- a test run: every write is a dry run
  {
    const { e, sent } = env(true, answers);
    const r = await dev.commands.inputSet({ key: 'mouse.speed', value: 12, id: 'evil', cmd: 'x' }, e);
    check('test run: inputSet answers the kit test-run shape', r.ok === true && r.dryRun === true && /^Test run, nothing changed: Mantle would set/.test(r.reason), JSON.stringify(r));
    check('test run: the sidecar got dryRun:true', sent[0].args.dryRun === true);
    check('no id/cmd key ever reaches the sidecar', !('id' in sent[0].args) && !('cmd' in sent[0].args), JSON.stringify(sent[0].args));
    const p = await dev.commands.pair({ device: 'BTHENUM#x' }, e);
    check('test run: pair is a dry run', p.dryRun === true);
    const c = await dev.commands.btConnect({ device: 'BT#1', on: true }, e);
    check('test run: btConnect never reaches the sidecar', c.dryRun === true && !sent.some((s) => s.cmd === 'btdevices'));
  }
  {
    const { e, sent, elevations } = env(true, answers);
    const r = await dev.commands.cameraEnable({ device: 'USB\\A\\B', on: false }, e);
    check('test run: an admin action uses its plan, never elevate', r.dryRun === true && elevations.length === 0 && sent[0].cmd === 'devcam.plan', JSON.stringify(r));
    const u = await dev.commands.usbSet({ key: 'batterySaver', value: false }, e);
    check('test run: battery saver plan is usb.set dryRun', u.dryRun === true && sent[1].cmd === 'usb.set' && sent[1].args.dryRun === true && elevations.length === 0);
  }

  // --- a real run: read-back, elevation, failures in words
  {
    const { e, sent, elevations } = env(false, answers);
    const r = await dev.commands.inputSet({ key: 'mouse.speed', value: 12 }, e);
    check('real run: inputSet answers the read-back as value', r.ok === true && r.value === 12 && !r.dryRun, JSON.stringify(r));
    check('real run: the sidecar got dryRun:false', sent[0].args.dryRun === false);
    const d = await dev.commands.printerDefault({ printer: 'P' }, e);
    check('real run: setDefault answers value true', d.ok === true && d.value === true);
    const c = await dev.commands.cameraEnable({ device: 'USB\\A\\B', on: false, extra: 1 }, e);
    check('real run: camera goes through env.elevate with only device/on', c.ok === true && elevations.length === 1 && elevations[0].action === 'camera.setEnabled' && !('extra' in elevations[0].args));
    const a = await dev.commands.autoplay({}, e);
    check('a sidecar error comes back in its own words', a.ok === false && /registry said no/.test(a.reason));
    const x = await dev.commands.btRadio({ on: 'yes' }, e);
    check('bad args are refused before the sidecar', x.ok === false && /true or false/.test(x.reason));
  }
  {
    const { e } = env(false, Object.assign({}, answers, { 'elevate:camera.setEnabled': () => ({ ok: false, kind: 'cancelled', reason: 'you said no' }) }));
    const c = await dev.commands.cameraEnable({ device: 'USB\\A\\B', on: false }, e);
    check('a declined prompt answers cancelled, quietly worded', c.ok === false && c.cancelled === true && /said no/.test(c.reason));
  }

  // --- the network half (lane net2): id "internet", since a module may not take the built-in "network"
  check('no module takes the built-in id "network"', !fs.existsSync(path.join(__dirname, 'network.js')));
  const net = require('./internet');
  check('internet module id', net.id === 'internet');
  check('every internet command name is letters/digits/_', Object.keys(net.commands).every((n) => /^[A-Za-z0-9_]+$/.test(n)));
  const netAnswers = {
    'netwifi.set': (a) => ({ ok: true, result: a.dryRun ? { ok: true, dryRun: true, would: 'stop connecting automatically', xml: '<keyMaterial>REDACTED</keyMaterial>' } : { ok: true, now: { profile: a.profile, autoConnect: false } } }),
    'netwifi.forget': (a) => ({ ok: true, result: a.dryRun ? { ok: true, dryRun: true, would: 'forget this saved network' } : { ok: true, forgotten: true } }),
    'netadapt.plan': (a) => ({ ok: true, result: { ok: true, dryRun: true, action: a.servers ? 'network.setDns' : 'network.setAdapterEnabled', would: 'turn Wi-Fi off after an administrator prompt' } }),
    'netair.set': (a) => ({ ok: true, result: a.dryRun ? { ok: true, dryRun: true, would: 'turn airplane mode on' } : { ok: true, now: true } }),
    'wlan': () => ({ ok: true, result: { ok: true, ssid: 'Made-up', connected: true, reason: null } }),
    'netwifi.known': () => ({ ok: false, error: 'netwifi.known: the Wi-Fi service (WLAN AutoConfig) is not running' }),
  };
  {
    const { e, sent, elevations } = env(true, netAnswers);
    const r = await net.commands.wifiSet({ profile: 'P', autoConnect: false, id: 'evil' }, e);
    check('internet test run: wifiSet is the sidecar dry run', r.ok && r.dryRun && /Mantle would stop connecting/.test(r.reason) && sent[0].args.dryRun === true && !('id' in sent[0].args), JSON.stringify(r));
    const args = { ssid: 'Made-up', password: 'made-up-pass', auto: true };
    const c = await net.commands.wifiConnect(args, e);
    check('internet test run: connect never reaches the sidecar', c.dryRun === true && !sent.some((s) => s.cmd === 'wlan'));
    check('the password leaves the args object first', !('password' in args));
    const h = await net.commands.wifiConnect({ ssid: 'X', hidden: true, password: 'made-up-pass' }, e);
    check('a hidden network without security is refused in words', h.ok === false && /security/.test(h.reason));
    const a = await net.commands.adapterEnable({ adapter: '{1}', on: false }, e);
    check('internet test run: adapter off uses its plan, never elevate', a.dryRun === true && elevations.length === 0 && sent.some((s) => s.cmd === 'netadapt.plan'));
    const n = await net.commands.networkReset({}, e);
    check('internet test run: network reset never elevates', n.dryRun === true && elevations.length === 0);
    const d = await net.commands.wifiDisconnect({}, e);
    check('internet test run: disconnect is a dry run', d.dryRun === true && !sent.some((s) => s.cmd === 'wlan'));
  }
  {
    const { e, sent, elevations } = env(false, netAnswers);
    const r = await net.commands.wifiSet({ profile: 'P', autoConnect: false }, e);
    check('internet real run: wifiSet answers the read-back profile', r.ok && !r.dryRun && r.now && r.now.autoConnect === false && sent[0].args.dryRun === false);
    const c = await net.commands.wifiConnect({ ssid: 'Made-up', hidden: true, security: 'wpa3', password: 'made-up-pass' }, e);
    const w = sent.find((s) => s.cmd === 'wlan');
    check('internet real run: a hidden connect goes to wlan with hidden + security', c.ok && w && w.args.op === 'connect' && w.args.hidden === true && w.args.security === 'wpa3' && w.args.password === 'made-up-pass', JSON.stringify(w && Object.keys(w.args)));
    await net.commands.adapterEnable({ adapter: '{1}', on: false, extra: 1 }, e);
    await net.commands.dnsSet({ adapter: '{1}', servers: ['1.1.1.1'] }, e);
    await net.commands.networkReset({ anything: 1 }, e);
    check('internet real run: the three admin actions go through env.elevate with whitelisted args',
      elevations.map((x) => x.action).join() === 'network.setAdapterEnabled,network.setDns,system.networkReset' && !('extra' in elevations[0].args) && Object.keys(elevations[2].args).length === 0, JSON.stringify(elevations));
    const air = await net.commands.airplaneSet({ on: true }, e);
    check('internet real run: airplane answers the read-back', air.ok && air.value === true);
    const k = await net.commands.known({}, e);
    check('internet: a sidecar error comes back in its own words', k.ok === false && /WLAN AutoConfig/.test(k.reason));
  }

  console.log(`DEVNET MAIN TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exitCode = failures.length || !passed ? 1 : 0;
})().catch((e) => { console.log('DEVNET MAIN TEST: crashed: ' + e.stack); process.exitCode = 1; });
