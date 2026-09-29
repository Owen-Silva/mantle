'use strict';
/*
 * internet.js - the main half of Settings > Network & internet (ui/settings/sections/internet.js),
 * lane net2, 2026-09-28. Every command is settings.internet.<name> and asks the sidecar:
 *   sidecar/NetWifi.cs      saved (known) networks: forget, auto-connect, hidden, random MAC,
 *                           metered; the connected network's properties
 *   sidecar/Wlan.cs         join a network in range or a HIDDEN one, disconnect (the bar's backend)
 *   sidecar/NetAdapters.cs  every adapter; [Elevated] adapter on/off and DNS servers
 *   sidecar/NetProxy.cs     proxy: auto-detect, setup script, manual
 *   sidecar/NetMisc.cs      VPN / dial-up entries (connect, disconnect), airplane mode
 * Writes: a dry run in a test run, the read-back otherwise (_devices-bridge.js). Administrator
 * actions go through env.elevate, one prompt per click (sidecar/ELEVATE.md); in a test run their
 * plan command answers instead, so no prompt can appear. Nothing here logs an SSID, a profile or
 * adapter name, an address or a password.
 */
const { pick, send, write, elevated } = require('./_devices-bridge');

const reads = {
  known: ['netwifi.known', ['iface'], 10000],
  props: ['netwifi.props', ['iface'], 10000],
  adapters: ['netadapt.list', [], 12000],
  proxy: ['netproxy.get', [], 6000],
  vpn: ['netvpn.list', [], 8000],
  airplane: ['netair.get', [], 8000],
};

const commands = {};
for (const [name, [cmd, keys, ms]] of Object.entries(reads)) {
  commands[name] = (args, env) => send(env, cmd, pick(args, keys), ms);
}

const SECURITY = ['open', 'wpa', 'wpa2', 'wpa3'];

Object.assign(commands, {
  // ---- Wi-Fi: networks in range (the list itself is qs.wifi.list / qs.wifi.scan)
  async wifiConnect(args, env) {
    // THE PASSWORD LEAVES args FIRST: a failed call's args are logged (as lengths), and args is that object.
    let password = null;
    if (Object.prototype.hasOwnProperty.call(args, 'password')) { password = args.password; delete args.password; }
    if (password !== null && password !== '' && typeof password !== 'string') return { ok: false, reason: 'the password must be text' };
    if (password === '') password = null;
    const hidden = args.hidden === true;
    const ssid = typeof args.ssid === 'string' && args.ssid ? args.ssid : null;
    const hex = typeof args.hex === 'string' && /^[0-9a-fA-F]{2,64}$/.test(args.hex) ? args.hex : null;
    if (!ssid && !hex) return { ok: false, reason: 'which network? (its name)' };
    if (ssid && Buffer.byteLength(ssid, 'utf8') > 32) return { ok: false, reason: 'a network name is at most 32 bytes' };
    if (hidden) {
      if (!ssid) return { ok: false, reason: 'a hidden network needs its exact name' };
      if (!SECURITY.includes(args.security)) return { ok: false, reason: 'choose the hidden network\'s security (open, WPA2 or WPA3)' };
      if (args.security !== 'open' && !password) return { ok: false, reason: 'type the hidden network\'s password' };
      if (args.security === 'open' && password) return { ok: false, reason: 'an open network takes no password' };
    }
    if (password && (password.length < 8 || password.length > 64)) { password = null; return { ok: false, reason: 'a Wi-Fi password is 8 to 63 characters (or 64 hex digits)' }; }
    const auto = args.auto !== false;
    if (env.test) {
      password = null;
      return { ok: true, dryRun: true, reason: `Test run, nothing changed: Mantle would join ${hidden ? 'the hidden network' : 'this network'}${auto ? ' and connect to it automatically from now on' : ''}` };
    }
    const req = { op: 'connect', auto };
    if (hex && !hidden) req.hex = hex; else req.ssid = ssid;
    if (hidden) { req.hidden = true; req.security = args.security; }
    if (password) req.password = password;
    password = null;
    const pending = send(env, 'wlan', req, 45000);
    delete req.password;                      // already written to the sidecar
    return pending;
  },
  async wifiDisconnect(args, env) {
    if (env.test) return { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would disconnect Wi-Fi from this network' };
    return send(env, 'wlan', { op: 'disconnect' }, 15000);
  },

  // ---- Wi-Fi: saved networks
  wifiForget: (args, env) => write(env, 'netwifi.forget', pick(args, ['profile', 'iface']), { ms: 10000, value: () => undefined }),
  wifiSet: (args, env) => write(env, 'netwifi.set', pick(args, ['profile', 'iface', 'autoConnect', 'hidden', 'randomMac', 'metered']),
    { ms: 15000, value: () => undefined }),

  // ---- Advanced: adapters and DNS (administrator)
  adapterEnable(args, env) {
    const a = pick(args, ['adapter', 'on']);
    return elevated(env, 'network.setAdapterEnabled', a, { cmd: 'netadapt.plan', args: a, ms: 10000 });
  },
  dnsSet(args, env) {
    const a = pick(args, ['adapter', 'servers']);
    return elevated(env, 'network.setDns', a, { cmd: 'netadapt.plan', args: a, ms: 10000 });
  },
  // Settings' "Network reset": the System lane's [Elevated] system.networkReset (sidecar/SysAbout.cs).
  networkReset: (args, env) => elevated(env, 'system.networkReset', {}),

  // ---- Proxy, VPN, airplane mode
  proxySet: (args, env) => write(env, 'netproxy.set', pick(args, ['autoDetect', 'script', 'manual']), { ms: 8000, value: () => undefined }),
  vpnConnect: (args, env) => write(env, 'netvpn.connect', pick(args, ['entry', 'on']), { ms: 70000, value: (r) => r.now }),
  airplaneSet: (args, env) => write(env, 'netair.set', pick(args, ['on']), { ms: 8000, value: (r) => r.now }),
});

module.exports = { id: 'internet', commands };
