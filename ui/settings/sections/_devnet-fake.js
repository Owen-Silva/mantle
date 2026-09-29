/* _devnet-fake.js — plays the MAIN half of the devices and network sections for the mock page
 * (lane devnet, 2026-09-28). Loaded ONLY by ui/settings/sections/devnet.test.js as an init script
 * (the leading _ keeps Settings from ever loading it as a section).
 *
 * It wraps the settings lane's mock (ui/settings/mock-mantle.js, not edited): settings.sections lists
 * the REAL page files sections/devices.js and sections/network.js, settings.devices.* and
 * settings.network.* are answered here with the real shapes (lib/features/_settings-sections/*.js
 * over the sidecar's replies), everything else goes to the mock. EVERYTHING IS MADE UP: no name,
 * network, address or device here comes from Owen's machine.
 *
 * ?test=1 makes every write a dry run, as the main half does in a test run.
 * window.__devnet exposes the fake state; window.__mockEmit(event, payload) pushes events.
 */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1';
  const FAIL = q.get('mock') === 'failing';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const dry = (would) => ({ ok: true, dryRun: true, would, reason: 'Test run, nothing changed: Mantle would ' + would });
  const no = (why) => ({ ok: false, reason: why });

  // ---------------------------------------------------------------- devices
  const D = {
    values: { 'mouse.primary': 'left', 'mouse.speed': 10, 'mouse.enhancePrecision': true, 'mouse.scrollLines': 3, 'mouse.scrollChars': 3,
      'mouse.scrollInactive': true, 'mouse.doubleClickMs': 500, 'mouse.trails': 0, 'mouse.vanish': true, 'mouse.sonar': false,
      'mouse.snapToDefault': false, 'mouse.clickLock': false, 'keyboard.repeatDelay': 1, 'keyboard.repeatRate': 31, 'keyboard.caretBlinkMs': 530 },
    touchpad: { present: true, active: true, mousePresent: true, maxContacts: 5, values: { 'touchpad.enabled': true, 'touchpad.whenMouse': true, 'touchpad.tap': true,
      'touchpad.tapDrag': true, 'touchpad.twoFingerTap': true, 'touchpad.rightClickZone': true, 'touchpad.pan': true, 'touchpad.zoom': true,
      'touchpad.scrollReversed': false, 'touchpad.sensitivity': 2, 'touchpad.speed': 10 }, reason: null },
    printers: [
      { printer: 'Office Laser 400', port: 'IP_10.0.0.20', driver: 'Office Laser PCL6', statusText: 'Ready', kind: 'local', network: true, isDefault: true, jobs: 2 },
      { printer: 'Save as PDF', port: 'PORTPROMPT:', driver: 'PDF writer', statusText: 'Ready', kind: 'local', network: false, isDefault: false, jobs: 0 },
      { printer: '\\\\print-server\\Hall Color', port: 'shared', driver: 'Color MFP', statusText: 'Offline', kind: 'connection', network: true, isDefault: false, jobs: 0 },
    ],
    jobs: [{ job: 7, document: 'Trip itinerary.pdf', owner: 'you', pages: 3, statusText: 'Printing', submitted: '10:42' },
      { job: 8, document: 'Recipe card', owner: 'you', pages: 1, statusText: 'Waiting', submitted: '10:43' }],
    manage: false,
    cameras: [{ device: 'USB\\VID_0C45&PID_6A10&MI_00\\6&MOCK&0&0000', name: 'Integrated Webcam', enabled: true, where: 'front', reason: null }],
    autoplay: { enabled: true, media: [
      { media: 'StorageOnArrival', label: 'Removable drive', page: 'settings', chosen: 'MSOpenFolder' },
      { media: 'CameraAlternate\\ShowPicturesOnArrival', label: 'Memory card', page: 'settings', chosen: null },
      { media: 'PlayVideoFilesOnArrival', label: 'Videos', page: 'classic', chosen: null },
      { media: 'PlayCDAudioOnArrival', label: 'Audio CD', page: 'classic', chosen: 'MSTakeNoAction' }] },
    usb: [{ key: 'notifyErrors', label: 'Connection notifications: show one if there are issues connecting to USB devices', on: true },
      { key: 'notifyWeakCharger', label: 'Show a notification if this PC is charging slowly over USB', on: true },
      { key: 'batterySaver', label: 'USB battery saver: stop USB devices from draining the battery when the screen is off', on: true, elevated: true }],
    options: [
      { key: 'swiftPair', label: 'Show notifications to connect using Swift Pair', help: 'Nearby Swift Pair devices offer themselves', type: 'bool', value: true },
      { key: 'discoveryMode', label: 'Bluetooth devices discovery', type: 'choice', choices: [{ value: 'default', label: 'Default' }, { value: 'advanced', label: 'Advanced' }], value: 'default' },
      { key: 'meteredDownload', label: 'Download over metered connections', help: 'Device software on metered networks', type: 'bool', value: false, admin: true, does: 'change device downloads over metered connections for every user' }],
    found: [{ device: 'BTHENUM#mock-new-1', name: 'Running Earbuds', kind: 'audio', protocol: 'classic', signal: -52, canPair: true },
      { device: 'BTHLE#mock-new-2', name: 'Slim Keyboard', kind: 'input', protocol: 'le', signal: -70, canPair: true }],
  };
  const handlers = [{ handler: 'MSTakeNoAction', label: 'Take no action' }, { handler: 'MSOpenFolder', label: 'Open folder to view files (File Explorer)' },
    { handler: 'MSPromptEachTime', label: 'Ask me every time' }];
  let session = 0;

  const dev = {
    input: () => (FAIL ? no('devinput.get: the sidecar is not running') : { ok: true, values: Object.assign({}, D.values), mouse: { present: true, buttons: 5, wheel: true },
      touchpad: JSON.parse(JSON.stringify(D.touchpad)), pen: { present: false, touch: false, reason: 'no pen digitizer on this PC (GetSystemMetrics SM_DIGITIZER lists none), so there is nothing to set' }, problems: [], reason: null }),
    inputSet(a) {
      const tp = a.key.startsWith('touchpad.'), bag = tp ? D.touchpad.values : D.values;
      if (!(a.key in bag)) return no('devinput.set: unknown key "' + a.key + '"');
      if (TEST) return dry('set ' + a.key + ' from ' + bag[a.key] + ' to ' + a.value);
      bag[a.key] = a.value;
      return { ok: true, key: a.key, now: a.value, value: a.value };
    },
    printers: () => (FAIL ? no('printers.list: the print spooler is not running') : later(80, { ok: true, printers: JSON.parse(JSON.stringify(D.printers)), letWindowsManage: D.manage,
      scanners: [{ scanner: 'SWD#mock-scan-1', name: 'Office Laser 400 (scanner)', enabled: true, isDefault: true }], scannersReason: null })),
    queue: (a) => ({ ok: true, printer: a.printer, jobs: a.printer === D.printers[0].printer ? D.jobs.slice() : [] }),
    printerDefault(a) {
      if (TEST) return dry('make "' + a.printer + '" the default printer');
      D.printers.forEach((p) => { p.isDefault = p.printer === a.printer; });
      return { ok: true, value: true };
    },
    printerManage(a) { if (TEST) return dry('let Windows manage the default printer: ' + (a.on ? 'on' : 'off')); D.manage = a.on; return { ok: true, value: a.on }; },
    printerRemove(a) {
      const p = D.printers.find((x) => x.printer === a.printer);
      if (!p) return no('printers.remove: Windows has no printer by that name');
      if (TEST) return dry('remove "' + a.printer + '"' + (p.kind === 'local' ? ' after an administrator prompt' : ''));
      D.printers = D.printers.filter((x) => x !== p);
      return { ok: true };
    },
    printerCancel(a) { if (TEST) return dry('cancel print job ' + a.job); D.jobs = D.jobs.filter((j) => j.job !== a.job); return { ok: true }; },
    printerAdd(a) {
      if (!/^\\\\[^\\]+\\[^\\]+$/.test(a.path || '')) return no('printers.addNetwork: a shared printer path looks like \\\\server\\printer');
      if (TEST) return dry('connect the shared printer ' + a.path + ' for your account');
      return later(600, no('Windows could not reach that print server (error 1722, the RPC server is unavailable)'));
    },
    cameras: () => ({ ok: true, cameras: JSON.parse(JSON.stringify(D.cameras)), defaultCamera: null, defaultReason: 'Windows 11 has no system-wide default camera: each app chooses its own', reason: null }),
    cameraEnable(a) {
      if (TEST) return dry((a.on ? 'switch the camera back on' : 'switch the camera off for every app') + ' after an administrator prompt');
      return later(500, { ok: false, cancelled: true, kind: 'cancelled', reason: 'You said no to the administrator prompt; nothing changed.' });
    },
    autoplay: () => ({ ok: true, enabled: D.autoplay.enabled, media: D.autoplay.media.map((m) => Object.assign({ choices: handlers }, m)), reason: null }),
    autoplayEnable(a) { if (TEST) return dry('turn AutoPlay ' + (a.on ? 'on' : 'off')); D.autoplay.enabled = a.on; return { ok: true, value: a.on }; },
    autoplayChoose(a) {
      const m = D.autoplay.media.find((x) => x.media === a.media);
      if (!m) return no('autoplay.choose: unknown media');
      if (TEST) return dry('make "' + a.handler + '" what happens for ' + m.label);
      m.chosen = a.handler;
      return { ok: true, value: a.handler };
    },
    usb: () => ({ ok: true, settings: D.usb.map((s) => Object.assign({ reason: null }, s)), reason: null }),
    usbSet(a) {
      const s = D.usb.find((x) => x.key === a.key);
      if (!s) return no('usb.set needs key');
      if (TEST) return dry('turn "' + s.label + '" ' + (a.value ? 'on' : 'off') + (s.elevated ? ' after an administrator prompt' : ''));
      if (s.elevated) return later(400, { ok: false, cancelled: true, kind: 'cancelled', reason: 'You said no to the administrator prompt; nothing changed.' });
      s.on = a.value;
      return { ok: true, value: a.value };
    },
    btOptions: () => ({ ok: true, options: JSON.parse(JSON.stringify(D.options)) }),
    btOption(a) {
      const o = D.options.find((x) => x.key === a.key);
      if (!o) return no('devpair.setOption: unknown key');
      if (TEST) return dry('set "' + o.label + '" to ' + a.value);
      o.value = a.value;
      return { ok: true, value: a.value };
    },
    btRadio(a) { if (TEST) return dry('Radio.SetStateAsync(' + (a.on ? 'On' : 'Off') + ') on the Bluetooth radio'); return later(300, { ok: true, value: a.on }); },
    btConnect(a) { if (TEST) return dry((a.on ? 'connect' : 'disconnect') + ' this device through its audio driver'); return later(500, { ok: true }); },
    unpair(a) { if (TEST) return dry('remove the paired device (2 Windows records)'); return later(300, { ok: true, removed: 1 }); },
    scan(a) {
      if (a.on) {
        D.found.forEach((d, i) => setTimeout(() => window.__mockEmit('settings.devices.pair', { kind: 'found', device: Object.assign({}, d) }), 150 + i * 120));
      }
      return { ok: true, scanning: !!a.on, started: !!a.on, leaseMs: 30000 };
    },
    pairList: () => ({ ok: true, devices: D.found.slice() }),
    pair(a) {
      if (TEST) return dry('pair with this device; Windows would offer: confirm a PIN, show a PIN, or type a PIN');
      session++;
      const s = 's' + session;
      setTimeout(() => window.__mockEmit('settings.devices.pair', { kind: 'confirm', session: s, how: 'confirmPinMatch', pin: '482913' }), 200);
      return new Promise((res) => { window.__devnetPairDone = (ok) => res(ok ? { ok: true, status: 'Paired' } : { ok: false, status: 'RejectedByHandler', reason: 'You said the PIN did not match, so the device was not paired' }); });
    },
    respond(a) { if (window.__devnetPairDone) setTimeout(() => window.__devnetPairDone(a.accept), 100); return { ok: true }; },
    cancel() { if (window.__devnetPairDone) window.__devnetPairDone(false); return { ok: true }; },
  };

  const NET = window.__devnetNet || {};   // the network half joins here (see the network part below)
  const table = { 'settings.devices.': dev, 'settings.network.': NET };

  function answer(name, args) {
    for (const pre of Object.keys(table)) {
      if (!name.startsWith(pre)) continue;
      const f = table[pre][name.slice(pre.length)];
      if (!f) return Promise.reject(new Error(name + ' is not a command (fake)'));
      try { return Promise.resolve(f(args || {})); } catch (e) { return Promise.reject(e); }
    }
    return null;
  }

  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = {
        on: m.on.bind(m),
        call(name, args) {
          if (name === 'settings.sections') {
            const ids = String(window.__DEVNET_SECS || 'devices,network').split(',').filter(Boolean);
            return Promise.resolve({ ok: true, reason: null, sections: ids.map((id) => ({ id, file: 'sections/' + id + '.js', down: null, main: null })) });
          }
          const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : args;
          const mine = answer(name, copy);
          if (!mine) return m.call(name, args);
          const logged = copy && typeof copy === 'object' ? Object.assign({}, copy) : copy;
          if (logged && (logged.password || logged.pin || logged.psk)) ['password', 'pin', 'psk'].forEach((k) => { if (logged[k]) logged[k] = '(redacted)'; });
          (window.__mockCalls = window.__mockCalls || []).push({ name, args: logged });
          return mine;
        },
      };
    },
  });
  window.__devnet = { D, NET };
}());
