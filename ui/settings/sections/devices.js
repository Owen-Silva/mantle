/* devices.js — Settings > Bluetooth & devices, done natively (lane devnet, 2026-09-28).
 *
 * Owen: Mantle Settings "should do everything windows can do and more and not ever rely on any old
 * windows feature". So every page here reads and changes the setting itself, through
 * settings.devices.* (lib/features/_settings-sections/devices.js -> the sidecar): no page hands
 * off to Windows' Settings app. What Windows itself does not let another app change is shown
 * read-only with the exact reason.
 *
 * Pages: Devices (replaces the built-in Bluetooth page: radio, paired devices, add/pair/remove,
 * the page's own switches), Printers & scanners, Mouse, Touchpad, Keyboard, Pen & Windows Ink,
 * Cameras, AutoPlay, USB. Kit only (ui/settings/SECTIONS.md): no CSS of its own.
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.devices.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  // A printer's or device's name as a row key: row ids allow letters, digits and _ . + - only.
  const keyOf = (s) => { let x = 5381; for (const ch of String(s)) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return 'k' + x.toString(36); };
  const onOff = (v) => (v ? 'On' : 'Off');

  // ============================================================== Devices (Bluetooth)
  function devicesPage(el, kit) {
    const radio = kit.toggle({ row: 'bluetooth.radio', label: 'Bluetooth', icon: 'bluetooth', help: 'Reading the radio…',
      onChange: async (on) => { const r = await C(kit, 'btRadio', { on }); if (r.ok && !r.dryRun) setTimeout(readPaired, 800); return r; } });
    const paired = kit.list({ row: 'bluetooth.devices', items: [], empty: 'Reading the paired devices…', onAction: pairedAction });
    const scanBtn = kit.button({ row: 'devices.bluetooth.add', label: 'Add a device', icon: 'bluetooth',
      help: 'Searches for Bluetooth devices that are ready to pair (put the device in pairing mode first)',
      text: 'Search', tone: 'acc', onClick: () => toggleScan() });
    const found = kit.list({ row: 'devices.bluetooth.found', items: [], empty: 'Nothing found yet', onAction: foundAction });
    const ceremony = kit.h('div', {});
    const optsBox = kit.h('div', {});
    el.append(kit.group('Bluetooth'), kit.card(radio), kit.group('Paired devices', { row: 'bluetooth.devices' }), kit.card(paired),
      kit.group('Add a device'), kit.card(scanBtn, found), ceremony, kit.group('Device settings'), optsBox);

    const P = { devs: [], confirm: null, removing: null, scanning: false, found: new Map(), hidden: 0, pairing: null };

    async function readRadio() {
      const q = await kit.call('qs.get');
      const b = q && q.bluetooth;
      if (!q || q.ok === false || !b) return radio.set({ reason: bad(q, 'The radio could not be read') || 'The radio could not be read', disabled: true });
      if (b.ok === false) return radio.set({ reason: b.reason, disabled: true, help: null });
      if (b.present === false) return radio.set({ value: false, disabled: true, help: null, reason: 'This PC has no Bluetooth radio' });
      radio.set({ value: !!b.on, disabled: false, reason: null, help: b.on ? 'Paired devices can connect' : 'Paired devices cannot connect' });
    }
    function drawPaired() {
      paired.set({ empty: 'No paired devices', items: P.devs.map((d) => {
        const bits = [d.kind ? d.kind.charAt(0).toUpperCase() + d.kind.slice(1) : 'Device', d.connected ? 'Connected' : 'Not connected'];
        if (d.connected && typeof d.battery === 'number') bits.push('Battery ' + d.battery + '%');
        const confirm = P.removing === d.id;
        const acts = confirm ? [{ id: 'remove-yes', text: 'Remove', tone: 'acc' }, { id: 'remove-no', text: 'Keep' }]
          : [d.canConnect ? { id: d.connected ? 'disconnect' : 'connect', text: d.connected ? 'Disconnect' : 'Connect' }
            : { id: 'connect', text: d.connected ? 'Connected' : 'Connect', disabled: true, reason: d.connectWhy || 'Windows connects this device itself when it is used' },
          { id: 'remove', text: 'Remove device', tone: 'quiet' }];
        return { key: keyOf(d.id), label: d.name || 'Unnamed device', icon: 'bluetooth', help: bits.join(' · '),
          reason: confirm ? 'Remove this device? It has to be paired again to use it.' : null, actions: acts, dev: d.id };
      }) });
    }
    async function readPaired() {
      const r = await kit.call('qs.bt.list');
      if (!r || r.ok === false) { paired.set({ items: [], empty: bad(r, 'The paired devices could not be read') }); return; }
      P.devs = Array.isArray(r.devices) ? r.devices : [];
      drawPaired();
    }
    async function pairedAction(key, act, it) {
      const device = it.dev;
      if (act === 'remove') { P.removing = device; drawPaired(); return { ok: true }; }
      if (act === 'remove-no') { P.removing = null; drawPaired(); return { ok: true }; }
      if (act === 'remove-yes') {
        const r = await C(kit, 'unpair', { device });
        P.removing = null;
        if (r.ok && !r.dryRun) setTimeout(readPaired, 400); else setTimeout(drawPaired, 0);
        return r;
      }
      const r = await C(kit, 'btConnect', { device, on: act === 'connect' });
      if (r.ok && !r.dryRun) readPaired();
      return r;
    }

    // ---- discovery + pairing
    function drawFound() {
      const items = [...P.found.values()].sort((a, b) => (b.signal || -999) - (a.signal || -999)).map((d) => ({
        key: keyOf(d.device), label: d.name, icon: 'bluetooth', dev: d.device,
        help: [d.kind ? d.kind.charAt(0).toUpperCase() + d.kind.slice(1) : 'Device', d.protocol === 'le' ? 'Bluetooth LE' : 'Bluetooth',
          typeof d.signal === 'number' ? 'Signal ' + d.signal + ' dBm' : null].filter(Boolean).join(' · '),
        reason: d.canPair === false ? 'Windows says this device cannot be paired right now' : null,
        actions: [{ id: 'pair', text: P.pairing === d.device ? 'Pairing…' : 'Pair', tone: 'acc', disabled: d.canPair === false || (P.pairing && P.pairing !== d.device) }],
      }));
      found.set({ items, empty: P.scanning ? 'Searching… (put the device in pairing mode)' + (P.hidden ? '' : '')
        : 'Nothing found. Press Search with the device in pairing mode.' + (P.hidden ? ' (' + P.hidden + ' nameless device' + (P.hidden === 1 ? '' : 's') + ' hidden, as Windows hides them)' : '') });
    }
    async function toggleScan(force) {
      const on = force === undefined ? !P.scanning : force;
      const r = await C(kit, 'scan', { on });
      if (r.ok === false) return r;
      P.scanning = on && r.scanning !== false;
      if (on) { P.found.clear(); P.hidden = 0; }
      scanBtn.set({ text: P.scanning ? 'Stop' : 'Search', info: P.scanning ? 'Searching for about 30 seconds' : null });
      drawFound();
      return { ok: true };
    }
    function showCeremony(ev) {
      const done = (accept, pin) => C(kit, 'respond', { session: ev.session, accept, pin }).then((r) => { if (r.ok !== false) ceremony.replaceChildren(); return r; });
      const rows = [];
      if (ev.how === 'confirmPinMatch') {
        rows.push(kit.status({ row: 'devices.bluetooth.pin', label: 'Does this PIN match the one on the device?', value: ev.pin || '(no PIN came back)', tone: 'info' }),
          kit.button({ row: 'devices.bluetooth.pin.yes', label: 'It matches', text: 'Yes, pair', tone: 'acc', onClick: () => done(true) }),
          kit.button({ row: 'devices.bluetooth.pin.no', label: 'It does not match', text: 'No', onClick: () => done(false) }));
      } else if (ev.how === 'displayPin') {
        // Accepted at once by the sidecar (needsAnswer:false): the PIN is typed on the other device.
        rows.push(kit.status({ row: 'devices.bluetooth.pin', label: 'Type this PIN on the device, then press Enter there', value: ev.pin || '(no PIN came back)', tone: 'info' }),
          kit.button({ row: 'devices.bluetooth.pin.no', label: 'Stop pairing', text: 'Cancel',
            onClick: () => C(kit, 'cancel', { session: ev.session }).then((r) => { if (r.ok !== false) ceremony.replaceChildren(); return r; }) }));
      } else if (ev.how === 'providePin') {
        let pin = '';
        rows.push(kit.text({ row: 'devices.bluetooth.pin', label: 'Type the PIN the device shows (often 0000 or 1234)', value: '', password: true,
          onChange: (s) => { pin = s; return { ok: true }; } }),
        kit.button({ row: 'devices.bluetooth.pin.yes', label: 'Send the PIN', text: 'Pair', tone: 'acc', onClick: () => done(true, pin) }),
        kit.button({ row: 'devices.bluetooth.pin.no', label: 'Stop pairing', text: 'Cancel', onClick: () => done(false) }));
      } else {
        rows.push(kit.status({ row: 'devices.bluetooth.pin', label: 'Pair with this device?', value: '', tone: 'info' }),
          kit.button({ row: 'devices.bluetooth.pin.yes', label: 'Allow it', text: 'Pair', tone: 'acc', onClick: () => done(true) }),
          kit.button({ row: 'devices.bluetooth.pin.no', label: 'Stop pairing', text: 'Cancel', onClick: () => done(false) }));
      }
      ceremony.replaceChildren(kit.group('Pairing'), kit.card(...rows));
    }
    async function foundAction(key, act, it) {
      if (act !== 'pair') return { ok: true };
      P.pairing = it.dev; drawFound();
      const r = await C(kit, 'pair', { device: it.dev });
      P.pairing = null; ceremony.replaceChildren();
      if (r.ok && !r.dryRun) { P.found.delete(it.dev); readPaired(); }
      drawFound();
      if (r.ok && !r.dryRun && r.status && r.status !== 'Paired' && r.status !== 'AlreadyPaired') return { ok: false, reason: r.reason || r.words || r.status };
      return r;
    }
    kit.watch('settings.devices.pair', (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if ((ev.kind === 'found' || ev.kind === 'updated') && ev.device && ev.device.device) P.found.set(ev.device.device, Object.assign(P.found.get(ev.device.device) || {}, ev.device));
      else if (ev.kind === 'removed' && ev.device) P.found.delete(ev.device.device || ev.device);
      else if (ev.kind === 'done' || ev.kind === 'stopped') { P.scanning = false; if (typeof ev.nameless === 'number') P.hidden = ev.nameless; scanBtn.set({ text: 'Search', info: ev.reason || null }); }
      else if (ev.kind === 'confirm') { showCeremony(ev); return; }
      else if (ev.kind === 'ended' || ev.kind === 'timeout') { ceremony.replaceChildren(); if (ev.kind === 'timeout') scanBtn.set({ info: 'The device did not answer in time, so it was not paired' }); }
      drawFound();
    });

    // ---- the page's own switches (Swift Pair, discovery, metered downloads)
    let optRows = null;
    async function readOptions() {
      const r = await C(kit, 'btOptions');
      if (!r.ok) { optsBox.replaceChildren(kit.card(kit.reason(bad(r, 'These settings could not be read')))); optRows = null; return; }
      const list = Array.isArray(r.options) ? r.options : [];
      if (!optRows) {
        optRows = new Map();
        const ctl = list.map((o) => {
          const common = { row: 'devices.bluetooth.' + o.key, label: o.label, help: o.help || null,
            admin: o.admin ? (o.does || 'change whether devices download their software over metered connections') : false,
            onChange: (value) => C(kit, 'btOption', { key: o.key, value }) };
          const c = o.type === 'choice'
            ? kit.choice(Object.assign(common, { options: (o.choices || []).map((x) => (typeof x === 'object' ? x : { value: x, label: x })), value: o.value, style: 'dropdown' }))
            : kit.toggle(Object.assign(common, { value: !!o.value }));
          optRows.set(o.key, c);
          return c;
        });
        optsBox.replaceChildren(ctl.length ? kit.card(...ctl) : kit.card(kit.reason('Windows offered no Bluetooth settings to read', { info: true })));
      }
      for (const o of list) { const c = optRows.get(o.key); if (c) c.set({ value: o.type === 'choice' ? o.value : !!o.value, reason: o.reason || null, disabled: !!o.readOnly }); }
    }

    kit.watch('btdevices', (ev) => { if (ev && Array.isArray(ev.devices)) { P.devs = ev.devices; drawPaired(); } else readPaired(); });
    const lease = () => kit.call('qs.bt.watch', { on: true });
    lease(); kit.every(30000, lease);
    readRadio(); readPaired(); readOptions();
    kit.every(5000, readRadio);
    return { update() { readRadio(); readPaired(); readOptions(); }, dispose() { if (P.scanning) C(kit, 'scan', { on: false }); } };
  }

  // ============================================================== Printers & scanners
  function printersPage(el, kit) {
    const manage = kit.toggle({ row: 'devices.printers.manage', label: 'Let Windows manage my default printer',
      help: 'The default becomes the printer you used last at each location', onChange: (on) => C(kit, 'printerManage', { on }) });
    const list = kit.list({ row: 'devices.printers.list', items: [], empty: 'Reading the printers…', onAction });
    const queueOf = kit.status({ row: 'devices.printers.queueOf', label: 'Showing the queue of', value: 'no printer yet' });
    const queue = kit.list({ row: 'devices.printers.queue', items: [], empty: 'Choose "Open queue" on a printer', onAction: onJob });
    let path = '';
    const addPath = kit.text({ row: 'devices.printers.add', label: 'Add a printer', help: 'A shared printer (\\\\server\\printer) or a network printer\'s address (192.168.1.40)',
      value: '', placeholder: '\\\\server\\printer', onChange: (s) => { path = s; return { ok: true }; } });
    const addBtn = kit.button({ row: 'devices.printers.addGo', label: 'Add it for your account', text: 'Add printer', tone: 'acc',
      onClick: async () => {
        const v = path.trim();
        // \\server\printer = a shared printer (your account); anything else = a TCP/IP address (admin).
        const r = await C(kit, 'printerAdd', v.startsWith('\\\\') ? { path: v } : { address: v }); if (r.ok && !r.dryRun) { addPath.set({ value: '' }); read(); } return r; } });
    const scanners = kit.list({ row: 'devices.printers.scanners', items: [], empty: 'Reading the scanners…' });
    el.append(kit.group('Printers'), kit.card(manage, list), kit.group('Print queue'), kit.card(queueOf, queue), kit.group('Add a printer'), kit.card(addPath, addBtn),
      kit.group('Scanners'), kit.card(scanners));
    const S = { printers: [], open: null, removing: null };
    function draw() {
      list.set({ empty: 'No printers', items: S.printers.map((p) => {
        const confirm = S.removing === p.printer; const admin = p.kind === 'local';
        return { key: keyOf(p.printer), label: p.printer, icon: 'apps', name: p.printer, value: p.isDefault ? 'Default' : null,
          help: [p.statusText || null, p.kind === 'connection' ? 'Shared from another PC' : p.network ? 'Network' : 'Local', p.jobs ? p.jobs + ' in the queue' : null, p.port || null].filter(Boolean).join(' · '),
          reason: confirm ? 'Remove this printer?' + (admin ? ' Windows will ask for administrator permission to remove this printer from this PC.' : '') : (p.reason || null),
          actions: confirm ? [{ id: 'remove-yes', text: 'Remove', tone: 'acc', admin }, { id: 'remove-no', text: 'Keep' }]
            : [p.isDefault ? null : { id: 'default', text: 'Set as default' }, { id: 'queue', text: 'Open queue' }, { id: 'remove', text: 'Remove', tone: 'quiet' }].filter(Boolean) };
      }) });
    }
    async function read() {
      const r = await C(kit, 'printers');
      if (!r.ok) { list.set({ items: [], empty: bad(r, 'The printers could not be read') }); manage.set({ disabled: true, reason: bad(r, 'Not read') }); return; }
      S.printers = r.printers || [];
      manage.set({ value: !!r.letWindowsManage, disabled: false, reason: null, info: r.letWindowsManage ? 'While this is on, Windows can move the default back when you print elsewhere' : null });
      draw();
      scanners.set({ empty: r.scannersReason || 'No scanners', items: (r.scanners || []).map((s) => ({ key: keyOf(s.scanner || s.name), label: s.name, icon: 'apps', help: [s.enabled === false ? 'Disabled' : null, s.isDefault ? 'Default' : null].filter(Boolean).join(' · ') || null })) });
      if (S.open) readQueue();
    }
    async function readQueue() {
      const r = await C(kit, 'queue', { printer: S.open });
      queueOf.set({ value: S.open });
      if (!r.ok) { queue.set({ items: [], empty: bad(r, 'The queue could not be read') }); return; }
      queue.set({ empty: 'Nothing is printing', items: (r.jobs || []).map((j) => ({ key: 'j' + j.job, label: j.document || 'Untitled', job: j.job,
        help: [j.statusText, j.owner, j.pages ? j.pages + ' pages' : null, j.submitted].filter(Boolean).join(' · '),
        reason: j.reason || null, actions: [{ id: 'cancel', text: 'Cancel', tone: 'quiet' }] })) });
    }
    async function onAction(key, act, it) {
      if (act === 'remove') { S.removing = it.name; draw(); return { ok: true }; }
      if (act === 'remove-no') { S.removing = null; draw(); return { ok: true }; }
      if (act === 'queue') { S.open = it.name; await readQueue(); kit.highlight('devices.printers.queue'); return { ok: true }; }
      const r = act === 'default' ? await C(kit, 'printerDefault', { printer: it.name }) : await C(kit, 'printerRemove', { printer: it.name });
      if (act === 'remove-yes') S.removing = null;
      if (r.ok && !r.dryRun) read(); else draw();
      return r;
    }
    async function onJob(key, act, it) {
      const r = await C(kit, 'printerCancel', { printer: S.open, job: it.job });
      if (r.ok && !r.dryRun) readQueue();
      return r;
    }
    read();
    kit.every(5000, () => { if (S.open) readQueue(); });
    return { update: read, dispose() {} };
  }

  // ============================================================== Mouse / Touchpad / Keyboard / Pen
  function inputRows(kit, specs) {
    const rows = new Map();
    const make = (s) => {
      const common = { row: s.row, label: s.label, help: s.help || null, onChange: (v) => C(kit, 'inputSet', { key: s.key, value: s.to ? s.to(v) : v }) };
      let c;
      if (s.kind === 'toggle') c = kit.toggle(common);
      else if (s.kind === 'choice') c = kit.choice(Object.assign(common, { options: s.options, style: s.style }));
      else c = kit.slider(Object.assign(common, { min: s.min, max: s.max, step: s.step || 1, unit: s.unit, format: s.format }));
      rows.set(s.key, { c, s });
      return c;
    };
    return { rows, make };
  }
  function applyValues(rows, values, problems) {
    for (const [key, { c, s }] of rows) {
      if (values && key in values) c.set({ value: s.from ? s.from(values[key]) : values[key], disabled: false, reason: null });
      else c.set({ disabled: true, reason: (problems || []).find((p) => p.startsWith(key)) || 'Windows did not report this value' });
    }
  }

  function mousePage(el, kit) {
    const R = inputRows(kit);
    const g1 = [
      { key: 'mouse.primary', row: 'devices.mouse.primary', label: 'Primary mouse button', kind: 'choice', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] },
      { key: 'mouse.speed', row: 'devices.mouse.speed', label: 'Mouse pointer speed', kind: 'slider', min: 1, max: 20 },
      { key: 'mouse.enhancePrecision', row: 'devices.mouse.precision', label: 'Enhance pointer precision', help: 'Moves the pointer further when the mouse moves faster', kind: 'toggle' },
    ].map(R.make);
    const pageScroll = { key: 'mouse.scrollLines', row: 'devices.mouse.scrollMode', label: 'Roll the mouse wheel to scroll', kind: 'choice', style: 'dropdown',
      options: [{ value: 'lines', label: 'Multiple lines at a time' }, { value: 'page', label: 'One screen at a time' }],
      from: (v) => (v === 'page' ? 'page' : 'lines'), to: (v) => (v === 'page' ? 'page' : 3) };
    const g2 = [R.make(pageScroll)];
    // The lines slider shares its key with the mode above; it is wired by hand.
    const lineRow = kit.slider({ row: 'devices.mouse.scrollLines', label: 'Lines to scroll at a time', min: 1, max: 100, onChange: (v) => C(kit, 'inputSet', { key: 'mouse.scrollLines', value: v }) });
    g2.push(lineRow, ...[
      { key: 'mouse.scrollInactive', row: 'devices.mouse.scrollInactive', label: 'Scroll inactive windows when hovering over them', kind: 'toggle' },
      { key: 'mouse.scrollChars', row: 'devices.mouse.scrollChars', label: 'Characters to scroll sideways', help: 'When the wheel tilts left or right', kind: 'slider', min: 1, max: 100 },
    ].map(R.make));
    const g3 = [
      { key: 'mouse.doubleClickMs', row: 'devices.mouse.doubleClick', label: 'Double-click speed', help: 'The most time between two clicks of a double-click', kind: 'slider', min: 200, max: 900, step: 10, unit: ' ms' },
      { key: 'mouse.clickLock', row: 'devices.mouse.clickLock', label: 'ClickLock', help: 'Hold the button briefly to lock it down, click again to let go', kind: 'toggle' },
      { key: 'mouse.trails', row: 'devices.mouse.trails', label: 'Pointer trails', help: '0 is off', kind: 'slider', min: 0, max: 7, format: (v) => (v < 2 ? 'Off' : String(v)) , to: (v) => (v < 2 ? 0 : v) },
      { key: 'mouse.vanish', row: 'devices.mouse.vanish', label: 'Hide the pointer while typing', kind: 'toggle' },
      { key: 'mouse.sonar', row: 'devices.mouse.sonar', label: 'Show where the pointer is when I press Ctrl', kind: 'toggle' },
      { key: 'mouse.snapToDefault', row: 'devices.mouse.snap', label: 'Move the pointer to the default button of a dialog', kind: 'toggle' },
    ].map(R.make);
    const status = kit.status({ row: 'devices.mouse.present', label: 'Mouse', value: '…' });
    el.append(kit.card(status), kit.group('Mouse'), kit.card(...g1), kit.group('Scrolling'), kit.card(...g2), kit.group('More mouse settings'), kit.card(...g3));
    async function read() {
      const r = await C(kit, 'input');
      if (!r.ok) { status.set({ value: 'Not read', tone: 'warn', reason: bad(r, 'The mouse settings could not be read') }); return; }
      const m = r.mouse || {};
      status.set({ value: m.present ? (m.buttons || '?') + ' buttons' + (m.wheel ? ', wheel' : '') : 'No mouse found', tone: m.present ? 'ok' : 'warn', reason: null });
      applyValues(R.rows, r.values, r.problems);
      const n = r.values && r.values['mouse.scrollLines'];
      lineRow.set({ value: typeof n === 'number' ? n : 3, disabled: n === 'page', info: n === 'page' ? 'The wheel scrolls one screen at a time' : null });
    }
    read();
    return { update: read, dispose() {} };
  }

  function touchpadPage(el, kit) {
    const R = inputRows(kit);
    const main = [
      { key: 'touchpad.enabled', row: 'devices.touchpad.enabled', label: 'Touchpad', kind: 'toggle' },
      { key: 'touchpad.whenMouse', row: 'devices.touchpad.whenMouse', label: 'Leave the touchpad on when a mouse is connected', kind: 'toggle' },
      { key: 'touchpad.speed', row: 'devices.touchpad.speed', label: 'Cursor speed', kind: 'slider', min: 1, max: 20 },
    ].map(R.make);
    const taps = [
      { key: 'touchpad.sensitivity', row: 'devices.touchpad.sensitivity', label: 'Touchpad sensitivity', kind: 'choice', style: 'dropdown',
        options: [{ value: 0, label: 'Most sensitive' }, { value: 1, label: 'High sensitivity' }, { value: 2, label: 'Medium sensitivity' }, { value: 3, label: 'Low sensitivity' }, { value: 4, label: 'Least sensitive' }] },
      { key: 'touchpad.tap', row: 'devices.touchpad.tap', label: 'Tap with a single finger to single-click', kind: 'toggle' },
      { key: 'touchpad.twoFingerTap', row: 'devices.touchpad.twoFingerTap', label: 'Tap with two fingers to right-click', kind: 'toggle' },
      { key: 'touchpad.tapDrag', row: 'devices.touchpad.tapDrag', label: 'Tap twice and drag to multi-select', kind: 'toggle' },
      { key: 'touchpad.rightClickZone', row: 'devices.touchpad.rightClickZone', label: 'Press the lower right corner of the touchpad to right-click', kind: 'toggle' },
    ].map(R.make);
    const scroll = [
      { key: 'touchpad.pan', row: 'devices.touchpad.pan', label: 'Drag two fingers to scroll', kind: 'toggle' },
      { key: 'touchpad.scrollReversed', row: 'devices.touchpad.scrollDirection', label: 'Scrolling direction', kind: 'choice', style: 'dropdown',
        options: [{ value: false, label: 'Down motion scrolls up' }, { value: true, label: 'Down motion scrolls down' }] },
      { key: 'touchpad.zoom', row: 'devices.touchpad.zoom', label: 'Pinch to zoom', kind: 'toggle' },
    ].map(R.make);
    const status = kit.status({ row: 'devices.touchpad.present', label: 'Precision touchpad', value: '…' });
    const body = kit.h('div', {}, kit.group('Touchpad'), kit.card(...main), kit.group('Taps'), kit.card(...taps), kit.group('Scroll & zoom'), kit.card(...scroll));
    el.append(kit.card(status), body);
    async function read() {
      const r = await C(kit, 'input');
      if (!r.ok) { status.set({ value: 'Not read', tone: 'warn', reason: bad(r, 'The touchpad could not be read') }); body.hidden = true; return; }
      const t = r.touchpad || {};
      if (!t.present) { status.set({ value: 'None', tone: 'warn', reason: t.reason || 'Windows reports no precision touchpad' }); body.hidden = true; return; }
      body.hidden = false;
      status.set({ value: (t.active ? 'In use' : 'Present') + (t.maxContacts ? ' · ' + t.maxContacts + ' fingers' : ''), tone: 'ok', reason: null });
      applyValues(R.rows, t.values, []);
    }
    read();
    return { update: read, dispose() {} };
  }

  function keyboardPage(el, kit) {
    const R = inputRows(kit);
    const rows = [
      { key: 'keyboard.repeatDelay', row: 'devices.keyboard.repeatDelay', label: 'Repeat delay', help: 'How long a key is held before it repeats', kind: 'slider', min: 0, max: 3,
        format: (v) => ['Short (0.25 s)', '0.5 s', '0.75 s', 'Long (1 s)'][v] || String(v) },
      { key: 'keyboard.repeatRate', row: 'devices.keyboard.repeatRate', label: 'Repeat rate', help: 'How fast a held key repeats', kind: 'slider', min: 0, max: 31,
        format: (v) => (v === 0 ? 'Slow' : v === 31 ? 'Fast' : String(v)) },
    ].map(R.make);
    let blinkOn = true;
    const blinkToggle = kit.toggle({ row: 'devices.keyboard.caretBlink', label: 'Blink the text cursor',
      onChange: (on) => C(kit, 'inputSet', { key: 'keyboard.caretBlinkMs', value: on ? 530 : 'off' }) });
    const blinkRate = kit.slider({ row: 'devices.keyboard.caretBlinkMs', label: 'Cursor blink rate', min: 200, max: 1200, step: 10, unit: ' ms',
      onChange: (v) => C(kit, 'inputSet', { key: 'keyboard.caretBlinkMs', value: v }) });
    el.append(kit.group('Typing'), kit.card(...rows), kit.group('Text cursor'), kit.card(blinkToggle, blinkRate));
    async function read() {
      const r = await C(kit, 'input');
      if (!r.ok) { rows.forEach((c) => c.set({ disabled: true, reason: bad(r, 'The keyboard settings could not be read') })); return; }
      applyValues(R.rows, r.values, r.problems);
      const b = r.values && r.values['keyboard.caretBlinkMs'];
      blinkOn = b !== 'off';
      blinkToggle.set({ value: blinkOn });
      blinkRate.set({ value: typeof b === 'number' ? b : 530, disabled: !blinkOn });
    }
    read();
    return { update: read, dispose() {} };
  }

  function penPage(el, kit) {
    const st = kit.status({ row: 'devices.pen.present', label: 'Pen', value: '…' });
    const touch = kit.status({ row: 'devices.pen.touch', label: 'Touch screen', value: '…' });
    el.append(kit.card(st, touch));
    async function read() {
      const r = await C(kit, 'input');
      if (!r.ok) { st.set({ value: 'Not read', tone: 'warn', reason: bad(r, 'The pen could not be read') }); return; }
      const p = r.pen || {};
      // No pen is not a fault (Windows hides the page then), so it is a quiet note, not a warning.
      st.set({ value: p.present ? 'Present' : 'None', tone: p.present ? 'ok' : null,
        reason: p.present ? 'Pen buttons and handwriting settings are not in Mantle yet' : null,
        info: p.present ? null : (p.reason || 'Windows reports no pen') });
      touch.set({ value: p.touch ? (p.maxTouches ? p.maxTouches + '-point touch' : 'Present') : 'None', tone: p.touch ? 'ok' : null });
    }
    read();
    return { update: read, dispose() {} };
  }

  // ============================================================== Cameras
  function camerasPage(el, kit) {
    const list = kit.list({ row: 'devices.cameras.list', items: [], empty: 'Reading the cameras…', onAction });
    const def = kit.status({ row: 'devices.cameras.default', label: 'Default camera', value: 'None in Windows' });
    el.append(kit.group('Connected cameras'), kit.card(list), kit.card(def));
    async function read() {
      const r = await C(kit, 'cameras');
      if (!r.ok) { list.set({ items: [], empty: bad(r, 'The cameras could not be read') }); return; }
      def.set({ info: r.defaultReason || null });
      list.set({ empty: r.reason || 'No cameras', items: (r.cameras || []).map((c) => ({ key: keyOf(c.device || c.name), label: c.name, icon: 'display', dev: c.device, on: c.enabled,
        help: [c.enabled ? 'Enabled' : 'Disabled', c.where ? c.where.charAt(0).toUpperCase() + c.where.slice(1) : null].filter(Boolean).join(' · '),
        reason: c.reason || null, admin: true,
        actions: c.device ? [{ id: c.enabled ? 'disable' : 'enable', text: c.enabled ? 'Disable' : 'Enable', admin: true }] : [] })) });
    }
    async function onAction(key, act, it) {
      const r = await C(kit, 'cameraEnable', { device: it.dev, on: act === 'enable' });
      if (r.ok && !r.dryRun) read();
      return r;
    }
    read();
    return { update: read, dispose() {} };
  }

  // ============================================================== AutoPlay
  function autoplayPage(el, kit) {
    const master = kit.toggle({ row: 'devices.autoplay.enabled', label: 'Use AutoPlay for all media and devices', onChange: (on) => C(kit, 'autoplayEnable', { on }) });
    const main = kit.h('div', {}), more = kit.h('div', {});
    el.append(kit.card(master), kit.group('Choose AutoPlay defaults'), main, kit.group('More kinds of media'), more);
    let rows = null;
    async function read() {
      const r = await C(kit, 'autoplay');
      if (!r.ok) { master.set({ disabled: true, reason: bad(r, 'AutoPlay could not be read') }); return; }
      master.set({ value: !!r.enabled, disabled: false, reason: r.reason || null });
      if (!rows) {
        rows = new Map();
        const mk = (m) => {
          const c = kit.choice({ row: 'devices.autoplay.' + keyOf(m.media), label: m.label, style: 'dropdown',
            options: [{ value: '', label: 'Not chosen (ask with a notification)' }].concat(m.choices.map((x) => ({ value: x.handler, label: x.label }))),
            onChange: (handler) => (handler ? C(kit, 'autoplayChoose', { media: m.media, handler }) : { ok: false, reason: 'Pick one of the actions; Windows has no way to go back to "not chosen"' }) });
          rows.set(m.media, c);
          return c;
        };
        const set = (r.media || []).filter((m) => m.page === 'settings').map(mk), classic = (r.media || []).filter((m) => m.page !== 'settings').map(mk);
        main.replaceChildren(kit.card(...set));
        more.replaceChildren(kit.card(...classic));
      }
      for (const m of r.media || []) { const c = rows.get(m.media); if (c) c.set({ value: m.chosen || '', disabled: !r.enabled, info: r.enabled ? null : 'AutoPlay is off for everything' }); }
    }
    read();
    return { update: read, dispose() {} };
  }

  // ============================================================== USB
  function usbPage(el, kit) {
    const box = kit.h('div', {});
    el.append(box);
    let rows = null;
    async function read() {
      const r = await C(kit, 'usb');
      if (!r.ok) { box.replaceChildren(kit.card(kit.reason(bad(r, 'The USB settings could not be read')))); rows = null; return; }
      if (!rows) {
        rows = new Map();
        box.replaceChildren(kit.card(...(r.settings || []).map((s) => {
          const c = kit.toggle({ row: 'devices.usb.' + s.key, label: s.label, admin: s.elevated ? 'change USB battery saver for every user of this PC' : false,
            onChange: (value) => C(kit, 'usbSet', { key: s.key, value }) });
          rows.set(s.key, c);
          return c;
        })));
      }
      for (const s of r.settings || []) { const c = rows.get(s.key); if (c) c.set({ value: !!s.on, reason: s.reason || null }); }
    }
    read();
    return { update: read, dispose() {} };
  }

  // ============================================================== the section
  const row = (r, label, keywords) => ({ row: r, label, keywords });
  MantleSettings.section({
    id: 'devices',
    title: 'Bluetooth & devices',
    group: 'windows',
    icon: 'bluetooth',
    order: 20,
    help: 'Bluetooth, printers, mouse, keyboard, cameras',
    keywords: 'bt devices paired headphones mouse keyboard printer camera usb autoplay touchpad pen',
    replaces: ['bluetooth'],
    pages: [
      { id: 'bluetooth', title: 'Devices', icon: 'bluetooth', help: 'Bluetooth, pair, connect and remove devices',
        search: [row('bluetooth.radio', 'Bluetooth', 'bt radio wireless on off'), row('bluetooth.devices', 'Paired devices', 'bt headphones earbuds connect disconnect battery remove unpair'),
          row('devices.bluetooth.add', 'Add a device', 'pair new bluetooth device search discover pin'), row('devices.bluetooth.swiftPair', 'Swift Pair notifications', 'swift pair quick pair notification')] },
      { id: 'printers', title: 'Printers & scanners', icon: 'apps', help: 'Default printer, print queue, add or remove',
        search: [row('devices.printers.list', 'Printers', 'printer default remove'), row('devices.printers.manage', 'Let Windows manage my default printer', 'default printer'),
          row('devices.printers.queue', 'Print queue', 'jobs cancel print'), row('devices.printers.add', 'Add a printer', 'network shared printer add'), row('devices.printers.scanners', 'Scanners', 'scanner scan')],
        render: printersPage },
      { id: 'mouse', title: 'Mouse', icon: 'apps', help: 'Buttons, pointer speed, scrolling',
        search: [row('devices.mouse.primary', 'Primary mouse button', 'left right swap buttons'), row('devices.mouse.speed', 'Mouse pointer speed', 'sensitivity cursor speed dpi'),
          row('devices.mouse.precision', 'Enhance pointer precision', 'acceleration'), row('devices.mouse.scrollLines', 'Lines to scroll at a time', 'wheel scroll'),
          row('devices.mouse.scrollInactive', 'Scroll inactive windows', 'hover wheel'), row('devices.mouse.doubleClick', 'Double-click speed', 'double click'),
          row('devices.mouse.trails', 'Pointer trails', 'trail'), row('devices.mouse.clickLock', 'ClickLock', 'click lock drag')],
        render: mousePage },
      { id: 'touchpad', title: 'Touchpad', icon: 'apps', help: 'Taps, gestures, scrolling',
        search: [row('devices.touchpad.enabled', 'Touchpad', 'trackpad on off'), row('devices.touchpad.tap', 'Tap to click', 'tap click'),
          row('devices.touchpad.scrollDirection', 'Scrolling direction', 'natural reverse scroll'), row('devices.touchpad.sensitivity', 'Touchpad sensitivity', 'palm')],
        render: touchpadPage },
      { id: 'keyboard', title: 'Keyboard', icon: 'apps', help: 'Repeat delay and rate, cursor blink',
        search: [row('devices.keyboard.repeatDelay', 'Repeat delay', 'key repeat'), row('devices.keyboard.repeatRate', 'Repeat rate', 'key repeat speed'),
          row('devices.keyboard.caretBlinkMs', 'Cursor blink rate', 'caret blink')],
        render: keyboardPage },
      { id: 'pen', title: 'Pen & Windows Ink', icon: 'apps', help: 'Pen and touch',
        search: [row('devices.pen.present', 'Pen', 'stylus windows ink handwriting')], render: penPage },
      { id: 'cameras', title: 'Cameras', icon: 'display', help: 'Connected cameras, enable or disable',
        search: [row('devices.cameras.list', 'Cameras', 'webcam camera disable enable')], render: camerasPage },
      { id: 'autoplay', title: 'AutoPlay', icon: 'apps', help: 'What happens when you plug in a drive or card',
        search: [row('devices.autoplay.enabled', 'Use AutoPlay', 'autoplay autorun removable drive memory card')], render: autoplayPage },
      { id: 'usb', title: 'USB', icon: 'apps', help: 'Connection notifications, battery saver',
        search: [row('devices.usb.notifyErrors', 'USB connection notifications', 'usb error notification'), row('devices.usb.batterySaver', 'USB battery saver', 'usb battery drain')],
        render: usbPage },
    ].map((p) => (p.id === 'bluetooth' ? Object.assign(p, { render: devicesPage }) : p)),
  });
}());
