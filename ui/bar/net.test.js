'use strict';
/*
 * net.test.js - the network readout's words and glyph (ui/bar/net.js), in node, no Electron.
 *
 * Every state the readout can be in, from readings shaped exactly as NetState.cs sends them
 * (measured on Owen's laptop 2026-09-23: Wi-Fi, connected, internet, signal 86, 5 GHz). Until that
 * day the readout was a fixed drawing that never changed, whatever the network did.
 *
 *   node ui/bar/net.test.js
 *
 * Prints one summary line; exits 1 if anything failed.
 */
const N = require('./net.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}
const show = (d) => JSON.stringify({ state: d.state, kind: d.kind, bars: d.bars, tip: d.tip });

const reading = (o, w) => Object.assign({
  ok: true, state: 'connected', kind: 'wifi', internet: true, local: false, connectivity: 1088,
  adapter: 'Wi-Fi', adapterType: 'wifi', reason: null, via: 'start',
  wifi: Object.assign({ present: true, on: true, connected: true, ssid: 'Maple-5G', signal: 86, band: '5 GHz', reason: null }, w || {}),
}, o);
const arcs = (svg) => (svg.match(/<path d="M(6\.3|4 8|1\.6)[^>]*opacity="1"/g) || []).length;

// ---- Wi-Fi, connected: the network's name over Windows' "Internet access"
{
  const d = N.describe(reading());
  check('Wi-Fi with internet is connected', d.state === 'connected' && d.kind === 'wifi', show(d));
  check('its tooltip is the network over "Internet access", with the signal', d.tip === 'Maple-5G\nInternet access · signal 86%', JSON.stringify(d.tip));
  check('86% is all three arcs', d.bars === 3 && arcs(N.svg(d)) === 3, show(d));
  check('the aria label reads as one sentence', d.label === 'Maple-5G, Internet access', d.label);
}
{
  const weak = N.describe(reading({}, { signal: 30 }));
  check('30% is one arc', weak.bars === 1 && arcs(N.svg(weak)) === 1, show(weak));
  const mid = N.describe(reading({}, { signal: 60 }));
  check('60% is two arcs', mid.bars === 2 && arcs(N.svg(mid)) === 2, show(mid));
  const hidden = N.describe(reading({}, { ssid: null }));
  check('a network with no name still says Wi-Fi', /^Wi-Fi\nInternet access/.test(hidden.tip), hidden.tip);
}

// ---- no internet: Windows' own words, and a mark on the glyph
{
  const d = N.describe(reading({ state: 'no-internet', internet: false, connectivity: 0x22 }));
  check('Wi-Fi without internet says so', d.state === 'no-internet' && /^Maple-5G\nNo internet access/.test(d.tip), show(d));
  check('and marks the glyph', /mask="url\(#mnet-ko\)"/.test(N.svg(d)), N.svg(d));
  check('the same glyph with the mark is not the connected one', N.svg(d) !== N.svg(N.describe(reading())));
}

// ---- Ethernet
{
  const d = N.describe(reading({ kind: 'ethernet', adapter: 'Ethernet', adapterType: 'ethernet' },
    { present: null, on: null, connected: false, ssid: null, signal: 0, reason: 'not read: the internet goes through Ethernet' }));
  check('Ethernet is its own kind, named by its adapter', d.kind === 'ethernet' && d.tip === 'Ethernet\nInternet access', show(d));
  check('drawn as a monitor, not Wi-Fi arcs', /<rect x="2" y="2\.6"/.test(N.svg(d)) && arcs(N.svg(d)) === 0, N.svg(d));
  const off = N.describe(reading({ kind: 'ethernet', adapter: 'Ethernet 2', state: 'no-internet', internet: false }, { connected: false }));
  check('Ethernet without internet', off.tip === 'Ethernet 2\nNo internet access' && /mnet-ko/.test(N.svg(off)), show(off));
}

// ---- nothing: off, or not connected
{
  const d = N.describe(reading({ state: 'wifi-off', kind: 'none', internet: false, adapter: null }, { on: false, connected: false, ssid: null, signal: 0 }));
  check('Wi-Fi switched off says so', d.state === 'wifi-off' && d.tip === 'Not connected\nWi-Fi is turned off', show(d));
  check('drawn as dimmed arcs with a slash', /M2\.2 2\.2l11\.6 11\.6/.test(N.svg(d)) && arcs(N.svg(d)) === 0, N.svg(d));
  const nc = N.describe(reading({ state: 'disconnected', kind: 'none', internet: false, adapter: null }, { on: true, connected: false, ssid: null, signal: 0 }));
  check('radio on but no network', nc.state === 'disconnected' && nc.tip === 'Not connected\nWi-Fi is on but not connected to a network', show(nc));
  const none = N.describe(reading({ state: 'disconnected', kind: 'none', adapter: null }, { present: false, on: false, connected: false, ssid: null, signal: 0 }));
  check('no adapter at all', none.tip === 'Not connected\nNo connections are available', show(none));
}

// ---- other routes (a VPN, a phone)
{
  const d = N.describe(reading({ kind: 'other', adapter: 'Tailscale', adapterType: 'virtual' }, { connected: true }));
  check('another adapter is named and drawn as a globe', d.kind === 'other' && d.tip === 'Tailscale\nInternet access' && /<circle cx="8" cy="8" r="5\.6"/.test(N.svg(d)), show(d));
}

// ---- failures are said, never drawn as a network
{
  const u = N.describe(null);
  check('before the first reading: unknown, and says so', u.state === 'unknown' && u.tip === 'Network\nNot read yet', show(u));
  const e = N.describe({ ok: false, state: 'unknown', reason: 'the network is not being read: the sidecar exited (code 1)' });
  check('a failed reading carries its reason', e.state === 'error' && /the sidecar exited/.test(e.tip), show(e));
  const odd = N.describe(reading({ state: 'teleporting' }));
  check('an unknown state is an error with the word it got', odd.state === 'error' && /"teleporting"/.test(odd.tip), show(odd));
  const unk = N.describe(reading({ internet: null, reason: 'the Network List Manager did not answer (HRESULT 0x80004005), so internet access is unknown' }));
  check('internet access Windows could not be asked about is not "no internet"', unk.state === 'connected' && /Internet access unknown: the Network List Manager/.test(unk.tip), show(unk));
  check('every state draws a whole svg', ['connected', 'no-internet', 'wifi-off', 'disconnected', 'error', 'unknown']
    .every((st) => /^<svg[^>]*>.*<\/svg>$/.test(N.svg({ state: st, kind: 'wifi', bars: 2 }))));
}

for (const f of failures) console.log('FAIL ' + f);
console.log('NET WORDS TEST: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
