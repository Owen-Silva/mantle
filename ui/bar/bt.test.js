'use strict';
/*
 * bt.test.js - the Bluetooth device list's words and glyphs (ui/bar/bt.js), in node, no Electron.
 *
 * Every type, every state a row can be in (connected, not connected, connecting, disconnecting, a
 * failed attempt that is still true and one that no longer is), the battery only while connected
 * (a disconnected WH-CH520 still reads 100: measured 2026-09-23), the actions and their reasons,
 * and every whole-view state (loading, cannot read, no adapter, off, no paired devices).
 *
 *   node ui/bar/bt.test.js
 *
 * Prints one summary line; exits 1 if anything failed.
 */
const T = require('./bt.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}
const show = (x) => JSON.stringify(x);

/* A row exactly as the sidecar sends it (BtDevices.cs), measured on this machine 2026-09-23. */
const row = (o) => Object.assign({
  id: 'Bluetooth#Bluetooth02:00:5e:00:00:01-02:00:5e:10:00:01', name: 'WH-CH520', kind: 'headphones', kindFrom: 'class',
  connected: false, battery: null, batteryWhy: null, audio: true, canConnect: true, connectWhy: null,
  le: false, address: '02:00:5e:10:00:01', cod: { major: 4, minor: 1 }, appearance: null,
  category: ['Communication.Headset.Bluetooth']
}, o);

// ---- types: the seven, and anything else is "other"
for (const k of ['headphones', 'speaker', 'mouse', 'keyboard', 'phone', 'gamepad', 'other']) {
  const x = T.describe(row({ kind: k }));
  check('kind ' + k, x.kind === k && typeof x.icon === 'string' && x.icon.indexOf('<') === 0 && x.kindLabel === T.KINDS[k], show(x));
}
check('kind labels', T.KINDS.gamepad === 'Game controller' && T.KINDS.other === 'Bluetooth device');
check('unknown kind is other', T.describe(row({ kind: 'toaster' })).kind === 'other');
check('missing kind is other', T.describe(row({ kind: undefined })).kind === 'other');
check('inherited property is not a kind', T.describe(row({ kind: 'constructor' })).kind === 'other');
check('other wears the tile rune', T.ICONS.other === T.RUNE);

// ---- connected / not connected
let x = T.describe(row({ connected: true }));
check('connected words', x.state === 'connected' && x.sub === 'Connected' && x.connected === true, show(x));
x = T.describe(row({ connected: false }));
check('not connected words', x.state === 'disconnected' && x.sub === 'Not connected' && x.connected === false, show(x));
x = T.describe(row({ connected: 'yes' }));
check('only true is connected', x.state === 'disconnected' && x.sub === 'Not connected', show(x));

// ---- the battery: only a 0-100 number, only while connected
x = T.describe(row({ connected: true, battery: 85 }));
check('battery shown', x.battery === 85 && x.batteryText === '85%' && x.batteryWhy === null, show(x));
check('battery in the tip', /battery 85%/.test(x.tip), x.tip);
x = T.describe(row({ connected: true, battery: 85.6 }));
check('battery rounds', x.battery === 86 && x.batteryText === '86%', show(x));
x = T.describe(row({ connected: false, battery: 100 }));
check('stale battery hidden when not connected', x.battery === null && x.batteryText === '' && x.batteryWhy === null, show(x));
check('no battery words in a disconnected tip', !/battery/i.test(x.tip), x.tip);
x = T.describe(row({ connected: true, battery: null, batteryWhy: 'this device does not report its battery to Windows' }));
check('no battery: the sidecar reason', x.battery === null && x.batteryWhy === 'this device does not report its battery to Windows', show(x));
check('no battery: the reason in the tip', /Battery: this device does not report its battery to Windows/.test(x.tip), x.tip);
x = T.describe(row({ connected: true, battery: null, batteryWhy: null }));
check('no battery and no reason: still a reason', x.batteryWhy === 'Windows gave no battery level for it', show(x));
for (const bad of [255, -1, 101, NaN, Infinity, '85', true, {}]) {
  x = T.describe(row({ connected: true, battery: bad }));
  check('battery ' + String(bad) + ' is not a level', x.battery === null && x.batteryText === '' && !!x.batteryWhy, show(x));
}
x = T.describe(row({ connected: true, battery: 0 }));
check('0% is a level', x.battery === 0 && x.batteryText === '0%', show(x));
check('battery() helper', T.battery(row({ connected: true, battery: 40 })) === 40 && T.battery(row({ connected: false, battery: 40 })) === null && T.battery(null) === null);

// ---- actions
x = T.describe(row({ connected: false, canConnect: true }));
check('audio, not connected: Connect', x.action === 'connect' && x.actionLabel === 'Connect' && x.actionWhy === null, show(x));
x = T.describe(row({ connected: true, canConnect: true }));
check('audio, connected: Disconnect', x.action === 'disconnect' && x.actionLabel === 'Disconnect', show(x));
x = T.describe(row({ kind: 'gamepad', audio: false, canConnect: false,
  connectWhy: 'Mantle can connect and disconnect audio devices only; Windows connects this one itself when it is used' }));
check('no route: settings with the reason', x.action === 'settings' && x.actionLabel === 'Open Bluetooth settings' &&
  /audio devices only/.test(x.actionWhy) && x.tip.indexOf(x.actionWhy) > 0, show(x));
x = T.describe(row({ canConnect: false, connectWhy: null }));
check('no route and no reason: still a reason', x.action === 'settings' && x.actionWhy === 'Mantle has no way to connect this device', show(x));
x = T.describe(row({ canConnect: 'true' }));
check('only true can connect', x.action === 'settings', show(x));

// ---- in flight
const id = row().id;
x = T.describe(row({ connected: false }), { busy: { id, what: 'connect' } });
check('connecting', x.state === 'connecting' && x.sub === 'Connecting…' && x.actionLabel === 'Connecting…', show(x));
x = T.describe(row({ connected: true }), { busy: { id, what: 'disconnect' } });
check('disconnecting', x.state === 'disconnecting' && x.sub === 'Disconnecting…' && x.actionLabel === 'Disconnecting…', show(x));
x = T.describe(row({ connected: false }), { busy: { id: 'someone else', what: 'connect' } });
check('busy on another row leaves this one', x.state === 'disconnected' && x.actionLabel === 'Connect', show(x));

// ---- failures: shown while still true, gone once not
const connectFail = { fail: {} };
connectFail.fail[id] = { op: 'connect', lead: 'Couldn’t connect.', reason: 'Windows asked WH-CH520 to connect, but it was still not connected after 12 s' };
x = T.describe(row({ connected: false }), connectFail);
check('failed connect shows', x.state === 'failed' && x.sub === 'Couldn’t connect' && x.failLead === 'Couldn’t connect.' && /after 12 s/.test(x.failWhy), show(x));
x = T.describe(row({ connected: true }), connectFail);
check('failed connect gone once connected', x.state === 'connected' && x.failLead === null, show(x));
const discFail = { fail: {} };
discFail.fail[id] = { op: 'disconnect', reason: 'the driver answered HRESULT 0x80070490' };
x = T.describe(row({ connected: true }), discFail);
check('failed disconnect shows', x.state === 'failed' && x.sub === 'Couldn’t disconnect' && x.failLead === 'Couldn’t disconnect.' && /0x80070490/.test(x.failWhy), show(x));
x = T.describe(row({ connected: false }), discFail);
check('failed disconnect gone once disconnected', x.state === 'disconnected', show(x));
x = T.describe(row({ connected: false }), Object.assign({ busy: { id, what: 'connect' } }, connectFail));
check('a new attempt hides the old failure', x.state === 'connecting' && x.failLead === null, show(x));
const noReason = { fail: {} };
noReason.fail[id] = { op: 'connect' };
x = T.describe(row({ connected: false }), noReason);
check('failure without a reason still says so', x.failWhy === 'no reason given', show(x));

// ---- names
x = T.describe(row({ name: '' }));
check('empty name', x.name === 'Unnamed device', show(x));
x = T.describe(row({ name: '   ' }));
check('blank name', x.name === 'Unnamed device', show(x));
const long = 'Bose QuietComfort Ultra Earbuds (Left) — Living Room Second Pairing';
x = T.describe(row({ name: long }));
check('long name kept whole (the row ellipsizes it)', x.name === long && x.tip.indexOf(long) === 0, show(x));

// ---- whole-view states
check('loading', T.view(null).state === 'loading');
let v = T.view({ ok: false, reason: 'Windows\' paired-device list did not answer within 3 s' });
check('cannot read', v.state === 'error' && /did not answer/.test(v.why), show(v));
v = T.view({ ok: false });
check('cannot read, no reason', v.state === 'error' && v.why === 'no reason given', show(v));
v = T.view({ ok: true, present: false, on: false, devices: [], reason: 'this machine has no Bluetooth radio' });
check('no adapter', v.state === 'none' && v.title === 'No Bluetooth adapter' && v.why === 'This machine has no Bluetooth radio.', show(v));
check('a reason standing alone gets a capital and a full stop, once',
  T.said('windows listed no Bluetooth radio') === 'Windows listed no Bluetooth radio.' &&
  T.said('Access is denied.') === 'Access is denied.' && T.said('') === '' && T.said(null) === '');
v = T.view({ ok: true, present: false, devices: [] });
check('no adapter, no reason', v.state === 'none' && /no Bluetooth radio/.test(v.why), show(v));
v = T.view({ ok: true, present: true, on: false, devices: [row()] });
check('radio off', v.state === 'off' && v.title === 'Bluetooth is off', show(v));
v = T.view({ ok: true, present: true, on: true, devices: [] });
check('no paired devices', v.state === 'empty' && v.title === 'No paired devices' && /Bluetooth settings/.test(v.why), show(v));
v = T.view({ ok: true, present: true, on: true, devices: [row()] });
check('list', v.state === 'list', show(v));
v = T.view({ ok: true, present: true, on: null, radioReason: 'x', devices: [row()] });
check('radio unknown still lists', v.state === 'list', show(v));

// ---- notes
check('radio note when unknown', /could not be read: the radio did not answer/.test(T.radioNote({ ok: true, present: true, on: null, radioReason: 'the radio did not answer' })));
check('no radio note when known', T.radioNote({ ok: true, present: true, on: true }) === '' && T.radioNote({ ok: true, present: true, on: false }) === '');
check('no radio note when the list failed', T.radioNote({ ok: false, on: null }) === '');
const last = { device: id, name: 'WH-CH520', op: 'connect', ok: false, reason: 'it may be off', agoMs: 30000 };
check('last failed connect', T.lastNote({ last }) === 'Last attempt (30 s ago): WH-CH520 did not connect — it may be off', T.lastNote({ last }));
check('last failed disconnect', /did not disconnect/.test(T.lastNote({ last: Object.assign({}, last, { op: 'disconnect', agoMs: 120000 }) })) &&
  /2 min ago/.test(T.lastNote({ last: Object.assign({}, last, { agoMs: 120000 }) })));
check('last success is not a note', T.lastNote({ last: Object.assign({}, last, { ok: true }) }) === '');
const rowFails = {}; rowFails[id] = { op: 'connect' };
check('last not repeated beside its row', T.lastNote({ last }, rowFails) === '');
check('no last', T.lastNote({}) === '' && T.lastNote(null) === '');
check('ago just now', T.ago(1200) === 'just now' && T.ago(undefined) === 'just now');

// ---- the sidecar's own in-flight op
check('busyOf', show(T.busyOf({ busy: { device: id, op: 'connect', ms: 800 } })) === show({ id, what: 'connect' }) &&
  T.busyOf({ busy: null }) === null && T.busyOf({ busy: { device: id, op: 'pair' } }) === null);

// ---- glyphs
check('battery glyph empty at 0', (T.batteryGlyph(0).match(/<rect/g) || []).length === 2);
check('battery glyph full at 100', /width="8\.60"/.test(T.batteryGlyph(100)));
check('battery glyph half at 50', /width="4\.30"/.test(T.batteryGlyph(50)));
check('battery glyph clamps', /width="8\.60"/.test(T.batteryGlyph(250)) && (T.batteryGlyph(-5).match(/<rect/g) || []).length === 2);
check('state glyphs', T.NO_BT.indexOf('<path') === 0 && T.PLUS.indexOf('<path') === 0);

for (const f of failures) console.log('FAIL ' + f);
console.log('BT WORDS TEST: ' + passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);
