'use strict';
/*
 * devices.js - the main half of Settings > Bluetooth & devices (ui/settings/sections/devices.js),
 * lane devnet, 2026-09-28. Every command is settings.devices.<name> and asks the sidecar:
 *   sidecar/DevPair.cs      discover, pair (PIN confirm in the page), remove; the Devices page toggles
 *   sidecar/BtDevices.cs    the paired list, connect / disconnect (qs.bt.* in main reads it too)
 *   sidecar/DevPrinters.cs  printers, default, queue, remove, add by path
 *   sidecar/DevInput.cs     mouse, keyboard, touchpad, pen
 *   sidecar/DevMisc.cs      cameras, AutoPlay, USB
 * Writes: a dry run in a test run, the read-back otherwise (_devices-bridge.js). Administrator
 * actions go through env.elevate, one prompt per click (sidecar/ELEVATE.md).
 */
const { pick, send, write, elevated, relay } = require('./_devices-bridge');

const reads = {
  input: ['devinput.get', []],
  cameras: ['devcam.list', [], 10000],
  autoplay: ['autoplay.get', []],
  usb: ['usb.get', []],
  printers: ['printers.list', [], 12000],
  queue: ['printers.queue', ['printer'], 8000],
  btOptions: ['devpair.options', []],
  pairList: ['devpair.list', []],
};

const commands = {};
for (const [name, [cmd, keys, ms]] of Object.entries(reads)) {
  commands[name] = (args, env) => send(env, cmd, pick(args, keys), ms);
}

Object.assign(commands, {
  // ---- Bluetooth
  async btRadio(args, env) {
    if (typeof args.on !== 'boolean') return { ok: false, reason: 'on must be true or false' };
    return write(env, 'bluetooth', { on: args.on }, { ms: 12000, value: (r) => (typeof r.on === 'boolean' ? r.on : undefined) });
  },
  async btConnect(args, env) {
    if (typeof args.device !== 'string' || !args.device) return { ok: false, reason: 'which device? (device)' };
    if (typeof args.on !== 'boolean') return { ok: false, reason: 'on must be true or false' };
    const op = args.on ? 'connect' : 'disconnect';
    // BtDevices has no dryRun of its own: a test run answers here and never reaches it.
    if (env.test) return { ok: true, dryRun: true, reason: `Test run, nothing changed: Mantle would ${op} this device through its audio driver` };
    return send(env, 'btdevices', { op, device: args.device }, 25000);
  },
  scan: (args, env) => send(env, 'devpair.scan', { on: args.on === true, leaseMs: 30000 }, 6000),
  // DevPair waits up to 180 s for a pairing (a PIN typed on the other device is slow).
  pair: (args, env) => write(env, 'devpair.pair', pick(args, ['device']), { ms: 190000 }),
  respond: (args, env) => send(env, 'devpair.respond', pick(args, ['session', 'accept', 'pin']), 8000),
  cancel: (args, env) => send(env, 'devpair.cancel', pick(args, ['session']), 8000),
  unpair: (args, env) => write(env, 'devpair.unpair', pick(args, ['device']), { ms: 20000 }),
  // A machine-wide option (meteredDownload) answers needsAdmin + elevate: write() turns that into the prompt.
  btOption: (args, env) => write(env, 'devpair.setOption', pick(args, ['key', 'value']), { value: (x) => x.value }),

  // ---- Printers & scanners
  printerDefault: (args, env) => write(env, 'printers.setDefault', pick(args, ['printer']), { ms: 12000, value: () => true }),
  printerManage: (args, env) => write(env, 'printers.manage', pick(args, ['on']), { value: (r) => r.now }),
  printerRemove: (args, env) => write(env, 'printers.remove', pick(args, ['printer']), { ms: 20000 }),
  printerCancel: (args, env) => write(env, 'printers.cancelJob', pick(args, ['printer', 'job']), { ms: 10000 }),
  printerAdd: (args, env) => write(env, 'printers.addNetwork', pick(args, ['path', 'address', 'name', 'driver']), { ms: 60000 }),
  printerPause: (args, env) => write(env, args.resume ? 'printers.resumeJob' : 'printers.pauseJob', pick(args, ['printer', 'job']), { ms: 10000 }),

  // ---- Mouse, touchpad, keyboard
  inputSet: (args, env) => write(env, 'devinput.set', pick(args, ['key', 'value']), { ms: 6000, value: (r) => r.now }),

  // ---- Cameras
  cameraEnable(args, env) {
    const a = pick(args, ['device', 'on']);
    return elevated(env, 'camera.setEnabled', a, { cmd: 'devcam.plan', args: a, ms: 8000 });
  },

  // ---- AutoPlay
  autoplayEnable: (args, env) => write(env, 'autoplay.enable', pick(args, ['on']), { value: (r) => r.now }),
  autoplayChoose: (args, env) => write(env, 'autoplay.choose', pick(args, ['media', 'handler']), { value: (r) => r.now }),

  // ---- USB
  usbSet(args, env) {
    if (args.key === 'batterySaver') {
      return elevated(env, 'usb.setBatterySaver', { on: args.value },
                      { cmd: 'usb.set', args: { key: 'batterySaver', value: args.value, dryRun: true } });
    }
    return write(env, 'usb.set', pick(args, ['key', 'value']), { value: (r) => r.now });
  },
});

module.exports = {
  id: 'devices',
  commands,
  install(env) {
    const offPair = relay(env, 'devpair', 'pair');
    const offRest = env.onRest(({ on }) => {
      // A game started: a discovery scan must not keep the radio busy under it.
      if (on) send(env, 'devpair.scan', { on: false }, 4000);
    });
    return () => {
      offPair();
      offRest();
      send(env, 'devpair.scan', { on: false }, 4000);   // its lease would lapse anyway
    };
  },
};
