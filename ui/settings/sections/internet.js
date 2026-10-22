/* internet.js — Settings > Network & internet, done natively (lane net2, 2026-09-28).
 *
 * The user: Mantle Settings "should do everything windows can do and more and not ever rely on any old
 * windows feature". Every page reads and changes the setting itself through settings.internet.*
 * (lib/features/_settings-sections/internet.js -> the sidecar: NetWifi, Wlan, NetAdapters, NetProxy,
 * NetMisc) and the bar's own qs.* backend for the Wi-Fi radio and the networks in range. What Mantle
 * cannot change is shown read-only with the exact reason ON THE ROW.
 *
 * The id is "internet" because a module may not take a built-in's id ("network"); it replaces the
 * built-in Network page instead (its rows network.wifi / network.status / network.networks live on).
 * Pages: Status (the built-in's id), Wi-Fi, Ethernet, VPN, Mobile hotspot, Airplane mode, Proxy,
 * Dial-up, Advanced network settings. Kit only (ui/settings/SECTIONS.md): no CSS of its own.
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.internet.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  const keyOf = (s) => { let x = 5381; for (const ch of String(s)) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return 'k' + x.toString(36); };
  const bytes = (n) => { if (typeof n !== 'number') return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; };
  const speed = (bps) => (typeof bps !== 'number' || bps <= 0 ? null : bps >= 1e9 ? (bps / 1e9).toFixed(bps % 1e9 ? 1 : 0) + ' Gbps' : Math.round(bps / 1e6) + ' Mbps');
  const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : '—');
  const KIND = { wifi: 'Wi-Fi', ethernet: 'Ethernet', bluetooth: 'Bluetooth network', virtual: 'Virtual adapter', other: 'Network adapter' };
  const ICO = {
    ethernet: '<path d="M3 3.5h10v6H3z"/><path d="M5.5 9.5v3h5v-3M6 6.5h4"/>',
    vpn: '<path d="M8 1.8 3 3.8v3.6c0 3 2.1 5.4 5 6.8 2.9-1.4 5-3.8 5-6.8V3.8z"/><path d="M6 8.2l1.4 1.4L10.2 6.8"/>',
    hotspot: '<circle cx="8" cy="8.5" r="1.3"/><path d="M5.2 11.3a4 4 0 0 1 0-5.6M10.8 5.7a4 4 0 0 1 0 5.6M3.3 13.2a6.7 6.7 0 0 1 0-9.4M12.7 3.8a6.7 6.7 0 0 1 0 9.4"/>',
    airplane: '<path d="M8 1.8c.7 0 1 .8 1 1.6v3.3l5 2.8v1.4l-5-1.5v2.8l1.6 1.2v1.1L8 13.8l-2.6.7v-1.1L7 12.2V9.4L2 10.9V9.5l5-2.8V3.4c0-.8.3-1.6 1-1.6z"/>',
    proxy: '<circle cx="3.5" cy="8" r="1.6"/><circle cx="12.5" cy="4" r="1.6"/><circle cx="12.5" cy="12" r="1.6"/><path d="M5 7.3l6-2.6M5 8.7l6 2.6"/>',
    dialup: '<path d="M4 2.5h2l1 3-1.5 1a7 7 0 0 0 4 4l1-1.5 3 1v2a1.5 1.5 0 0 1-1.6 1.5A11 11 0 0 1 2.5 4.1 1.5 1.5 0 0 1 4 2.5z"/>',
    advanced: '<path d="M2.5 4h7M12 4h1.5M2.5 8h2M7 8h6.5M2.5 12h8M13 12h.5"/><circle cx="10.8" cy="4" r="1.3"/><circle cx="5.6" cy="8" r="1.3"/><circle cx="11.8" cy="12" r="1.3"/>',
  };

  /* One adapter's properties as status rows (Wi-Fi's connected network, Ethernet, Advanced). */
  function propRows(kit, pre, a, extra) {
    const ad = (a && a.addressing) || {};
    const rows = (extra || []).slice();
    const drv = (a && a.driver) || {};
    rows.push(
      ['ipv4', 'IPv4 address', list(ad.ipv4)], ['ipv6', 'IPv6 address', list(ad.ipv6)], ['gateway', 'Default gateway', list(ad.gateway)],
      ['dns', 'DNS servers', list((ad.dns4 || []).concat(ad.dns6 || [])) + (ad.dnsManual ? ' (typed in)' : ' (automatic, from DHCP)')],
      ['assign', 'IP assignment', ad.dhcp === false ? 'Manual' : ad.dhcp === true ? 'Automatic (DHCP)' : '—'],
      ['mac', 'Physical address (MAC)', ad.mac || '—'],
      ['driver', 'Driver', [drv.description || a.description, drv.provider, drv.version ? 'version ' + drv.version : null, drv.date].filter(Boolean).join(' · ') || '—'],
      ['traffic', 'Sent / received', typeof ad.bytesIn === 'number' ? bytes(ad.bytesOut) + ' sent · ' + bytes(ad.bytesIn) + ' received (since it was last turned on)' : '—'],
    );
    const out = rows.map(([k, label, value]) => kit.status({ row: pre + '.' + k, label, value: String(value), tone: 'info' }));
    if (ad.reason) out.push(kit.reason(ad.reason, { info: true }));
    return out;
  }

  /* The DNS editor for one adapter: an administrator change (network.setDns). */
  function dnsEditor(kit, pre, a, reread) {
    const ad = a.addressing || {};
    let typed = (ad.manualDns || []).join(', ');
    const field = kit.text({ row: pre + '.dns.edit', label: 'DNS servers (up to 4 IPv4 and 4 IPv6, separated by commas)', value: typed, placeholder: 'e.g. 1.1.1.1, 1.0.0.1',
      onChange: (s) => { typed = s; return { ok: true }; } });
    const save = kit.button({ row: pre + '.dns.save', label: 'DNS server assignment', help: ad.dnsManual ? 'Manual: ' + list(ad.manualDns) : 'Automatic (from DHCP)',
      admin: 'change this adapter\'s DNS servers', text: 'Save', tone: 'acc',
      onClick: async () => {
        const servers = typed.split(/[,;\s]+/).filter(Boolean);
        const r = await C(kit, 'dnsSet', { adapter: a.adapter, servers });
        if (r.ok && !r.dryRun) setTimeout(reread, 600);
        return r;
      } });
    const auto = kit.button({ row: pre + '.dns.auto', label: 'Use automatic DNS (DHCP)', help: 'Removes the typed-in servers', admin: 'change this adapter\'s DNS servers',
      text: 'Automatic', disabled: !ad.dnsManual, info: ad.dnsManual ? null : 'This adapter already uses automatic DNS',
      onClick: async () => { const r = await C(kit, 'dnsSet', { adapter: a.adapter, servers: [] }); if (r.ok && !r.dryRun) setTimeout(reread, 600); return r; } });
    return [save, field, auto];
  }

  // ============================================================== Status (the built-in's page)
  function statusPage(el, kit) {
    const status = kit.status({ row: 'network.status', label: 'Connection', value: 'Reading…', tone: 'info' });
    const props = kit.h('div', {});
    const usage = kit.list({ row: 'network.status.usage', items: [], empty: 'Reading the adapters…' });
    const perApp = kit.status({ row: 'network.status.apps', label: 'Data usage per app (last 30 days)', value: 'Read-only', tone: 'warn',
      reason: 'Windows keeps the 30-day data usage per network and per app in its System Resource Usage Monitor, which only Windows itself may read; the traffic above is what each adapter has moved since it was last turned on' });
    el.append(kit.group('Status'), kit.card(status), kit.group('Properties', { row: 'network.status.props' }), props,
      kit.group('Data usage', { row: 'network.status.usage' }), kit.card(usage, perApp));
    async function read() {
      const [n, a] = await Promise.all([kit.call('net.get'), C(kit, 'adapters')]);
      if (kit.disposed) return;
      if (!n || n.ok === false) status.set({ value: 'Unknown', tone: 'warn', reason: bad(n, 'The connection could not be read') });
      else {
        const via = n.kind === 'wifi' ? 'Wi-Fi' + (n.wifi && n.wifi.ssid ? ' · ' + n.wifi.ssid : '') : n.kind === 'ethernet' ? 'Ethernet' : n.kind === 'none' ? 'Not connected' : 'Connected (' + (n.adapter || 'another adapter') + ')';
        status.set({ value: via + (n.kind === 'none' ? '' : n.internet === true ? ' · Internet' : n.internet === false ? ' · No internet' : ''), tone: n.internet === false || n.kind === 'none' ? 'warn' : 'ok',
          reason: n.internet === false ? 'Connected, but Windows\' own check found no internet through it' : null });
      }
      if (!a.ok) { usage.set({ items: [], empty: bad(a, 'The adapters could not be read') }); props.replaceChildren(kit.card(kit.reason(bad(a, 'The adapters could not be read')))); return; }
      const ads = a.adapters || [];
      usage.set({ empty: 'No network adapters', items: ads.map((x) => ({ key: keyOf(x.adapter), label: x.name, icon: 'network',
        help: (KIND[x.kind] || 'Adapter') + ' · ' + (x.enabled ? (typeof x.addressing.bytesIn === 'number' ? bytes(x.addressing.bytesIn) + ' received · ' + bytes(x.addressing.bytesOut) + ' sent' : 'no traffic counted') : 'turned off'),
        actions: [] })) });
      const up = ads.find((x) => x.status === 'connected' && (n && n.kind ? x.kind === n.kind : true)) || ads.find((x) => x.status === 'connected');
      props.replaceChildren(up ? kit.card(...propRows(kit, 'network.status.props', up, [['name', 'Adapter', up.name + ' (' + (up.description || KIND[up.kind]) + ')'], ['speed', 'Link speed', speed(up.speedBps) || '—']]))
        : kit.card(kit.reason('No adapter is connected, so there are no connection properties')));
    }
    read();
    kit.watch('net', () => read());
    kit.every(8000, read);
    return { update: read, dispose() {} };
  }

  // ============================================================== Wi-Fi
  function wifiPage(el, kit) {
    const radio = kit.toggle({ row: 'network.wifi', label: 'Wi-Fi', icon: 'network', help: 'Reading the radio…',
      onChange: async (on) => {
        if (kit.test) return { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would turn Wi-Fi ' + (on ? 'on' : 'off') };
        const r = await kit.call('qs.set', { part: 'wifi', value: on });
        setTimeout(readAll, 900);
        return r.ok === false ? r : { ok: true, value: r.state && r.state.wifi && typeof r.state.wifi.on === 'boolean' ? r.state.wifi.on : on };
      } });
    const scan = kit.button({ row: 'network.wifi.scan', label: 'Look for networks', text: 'Refresh', onClick: async () => {
      const r = await kit.call('qs.wifi.scan'); readNets(); return r.ok === false ? r : { ok: true };
    } });
    const nets = kit.list({ row: 'network.networks', items: [], empty: 'Reading the networks in range…', onAction: netAction });
    const joinBox = kit.h('div', {});
    const props = kit.h('div', {});
    const known = kit.list({ row: 'network.wifi.known', items: [], empty: 'Reading the saved networks…', onAction: knownAction });
    const editBox = kit.h('div', {});
    // Hidden network: name + security + password, then connect.
    const H = { ssid: '', security: 'wpa2', password: '' };
    const hName = kit.text({ row: 'network.wifi.hidden.name', label: 'Network name (SSID)', value: '', placeholder: 'Exactly as the router has it', onChange: (s) => { H.ssid = s; return { ok: true }; } });
    const hSec = kit.choice({ row: 'network.wifi.hidden.security', label: 'Security', style: 'dropdown', value: 'wpa2',
      options: [{ value: 'open', label: 'Open' }, { value: 'wpa2', label: 'WPA2-Personal' }, { value: 'wpa3', label: 'WPA3-Personal' }, { value: 'wpa', label: 'WPA-Personal' }],
      onChange: (v) => { H.security = v; return { ok: true }; } });
    const hPw = kit.text({ row: 'network.wifi.hidden.password', label: 'Password', value: '', password: true, onChange: (s) => { H.password = s; return { ok: true }; } });
    const hGo = kit.button({ row: 'network.wifi.hidden', label: 'Connect to a hidden network', help: 'For a network that does not broadcast its name', text: 'Connect', tone: 'acc',
      onClick: async () => {
        const r = await C(kit, 'wifiConnect', { ssid: H.ssid, hidden: true, security: H.security, password: H.security === 'open' ? '' : H.password });
        if (r.ok && !r.dryRun) { H.password = ''; hPw.set({ value: '' }); setTimeout(readAll, 500); }
        return r;
      } });
    el.append(kit.card(radio), kit.group('Connected network', { row: 'network.wifi.props' }), props,
      kit.group('Available networks', { row: 'network.networks' }), kit.card(scan, nets), joinBox,
      kit.group('Hidden network', { row: 'network.wifi.hidden' }), kit.card(hName, hSec, hPw, hGo),
      kit.group('Manage known networks', { row: 'network.wifi.known' }), kit.card(known), editBox);

    const S = { nets: [], known: [], iface: null, join: null, edit: null, forget: false };

    async function readRadio() {
      const q = await kit.call('qs.get');
      const w = q && q.wifi;
      if (!q || q.ok === false || !w) return radio.set({ disabled: true, reason: bad(q, 'The Wi-Fi radio could not be read') || 'The Wi-Fi radio could not be read' });
      if (w.present === false) return radio.set({ value: false, disabled: true, help: null, reason: 'This PC has no Wi-Fi adapter' });
      if (w.ok === false) return radio.set({ disabled: true, reason: w.reason });
      radio.set({ value: !!w.on, disabled: false, reason: null, help: w.on ? (w.connected ? 'Connected to ' + (w.ssid || 'a network') : 'On, not connected') : 'Off' });
    }
    async function readNets() {
      const r = await kit.call('qs.wifi.list');
      if (kit.disposed) return;
      if (!r || r.ok === false) { nets.set({ items: [], empty: bad(r, 'The networks in range could not be read') }); return; }
      if (!r.on) { nets.set({ items: [], empty: 'Wi-Fi is off, so no networks are listed. Turn it on above.' }); scan.set({ disabled: true }); return; }
      scan.set({ disabled: false });
      S.nets = Array.isArray(r.networks) ? r.networks : [];
      nets.set({ empty: 'No networks in range. Press Refresh to look again.', items: S.nets.map((n) => {
        const act = n.connected ? { id: 'disconnect', text: 'Disconnect' }
          : ['connect', 'open', 'password'].includes(n.action) ? { id: 'connect', text: 'Connect', tone: 'acc' }
          : { id: 'connect', text: 'Connect', disabled: true, reason: n.why || 'Mantle cannot join this kind of network (enterprise sign-in)' };
        return { key: 'n' + (n.hex || keyOf(n.ssid)), label: n.hidden ? 'Hidden network' : n.ssid, icon: 'network', net: n,
          help: [n.connected ? 'Connected' : n.known ? 'Saved' : null, n.security || (n.secure ? 'Secured' : 'Open'), typeof n.signal === 'number' ? 'Signal ' + n.signal + '%' : null].filter(Boolean).join(' · '),
          actions: [act] };
      }) });
    }
    function showJoin(n) {
      S.join = n;
      let pw = '', auto = true;
      const title = kit.status({ row: 'network.wifi.join', label: 'Join ' + (n.ssid || 'this network'), value: n.security || '', tone: 'info' });
      const rows = [title];
      if (n.action === 'password') rows.push(kit.text({ row: 'network.wifi.join.password', label: 'Network password', value: '', password: true, onChange: (s) => { pw = s; return { ok: true }; } }));
      rows.push(kit.toggle({ row: 'network.wifi.join.auto', label: 'Connect automatically', value: true, onChange: (v) => { auto = v; return { ok: true }; } }),
        kit.button({ row: 'network.wifi.join.go', label: 'Join the network', text: 'Connect', tone: 'acc', onClick: async () => {
          const r = await C(kit, 'wifiConnect', { ssid: n.ssid, hex: n.hex, password: pw, auto });
          if (r.ok && !r.dryRun) { joinBox.replaceChildren(); S.join = null; readAll(); }
          return r;
        } }),
        kit.button({ row: 'network.wifi.join.cancel', label: 'Not now', text: 'Cancel', tone: 'quiet', onClick: () => { joinBox.replaceChildren(); S.join = null; return { ok: true }; } }));
      joinBox.replaceChildren(kit.card(...rows));
    }
    async function netAction(key, act, it) {
      const n = it.net;
      if (act === 'disconnect') { const r = await C(kit, 'wifiDisconnect'); if (r.ok && !r.dryRun) setTimeout(readAll, 500); return r; }
      if (n.known || n.action === 'connect' || n.action === 'open') {
        const r = await C(kit, 'wifiConnect', { ssid: n.ssid, hex: n.hex });
        if (r.ok && !r.dryRun) setTimeout(readAll, 500);
        return r;
      }
      showJoin(n);
      return { ok: true };
    }
    async function readProps() {
      const p = await C(kit, 'props');
      if (kit.disposed) return;
      if (!p.ok) { props.replaceChildren(kit.card(kit.reason(bad(p, 'The connected network could not be read')))); return; }
      if (!p.connected) { props.replaceChildren(kit.card(kit.status({ row: 'network.wifi.props.none', label: 'Not connected', value: '', tone: 'info', info: p.reason || 'Wi-Fi is not connected' }))); return; }
      props.replaceChildren(kit.card(...propRows(kit, 'network.wifi.props', p, [
        ['ssid', 'Network name (SSID)', p.ssid || '(not text)'], ['protocol', 'Protocol', p.protocol || '—'],
        ['security', 'Security type', [p.security, p.cipher].filter(Boolean).join(' · ') || '—'],
        ['band', 'Network band', p.band || '—'], ['channel', 'Network channel', p.channel != null ? String(p.channel) : '—'],
        ['speed', 'Link speed (receive / transmit)', p.rxMbps + ' / ' + p.txMbps + ' Mbps'], ['signal', 'Signal', p.signal + '%'],
      ])));
    }
    function drawKnown() {
      known.set({ empty: 'No saved networks', items: S.known.map((k) => ({
        key: keyOf(k.profile), label: k.ssid || k.profile, icon: 'network', prof: k,
        help: [k.connected ? 'Connected' : null, k.security, k.autoConnect ? 'Connects automatically' : 'Connects when you choose', k.hidden ? 'Hidden' : null, k.allUsers ? null : 'Only you'].filter(Boolean).join(' · '),
        reason: k.canEdit === false ? k.editWhy : k.reason || null,
        actions: [{ id: 'edit', text: S.edit === k.profile ? 'Close' : 'Properties' }] })) });
    }
    async function readKnown() {
      const r = await C(kit, 'known');
      if (kit.disposed) return;
      if (!r.ok) { known.set({ items: [], empty: bad(r, 'The saved networks could not be read') }); return; }
      if (r.present === false) { known.set({ items: [], empty: r.reason || 'This PC has no Wi-Fi adapter' }); return; }
      S.iface = r.iface;
      S.known = (r.profiles || []).slice().sort((a, b) => (b.connected - a.connected) || String(a.ssid || a.profile).localeCompare(String(b.ssid || b.profile)));
      drawKnown();
      if (S.edit) { const k = S.known.find((x) => x.profile === S.edit); if (k) showEdit(k); else { S.edit = null; editBox.replaceChildren(); } }
    }
    function showEdit(k) {
      S.edit = k.profile; S.forget = false;
      const set = async (patch, pickBack) => {
        const r = await C(kit, 'wifiSet', Object.assign({ profile: k.profile, iface: S.iface }, patch));
        if (r.ok && !r.dryRun && r.now) { Object.assign(k, r.now); drawKnown(); return { ok: true, value: pickBack(r.now) }; }
        return r;
      };
      const lock = k.canEdit === false ? { disabled: true, reason: k.editWhy } : {};
      const rows = [
        kit.status({ row: 'network.wifi.known.security', label: 'Security type', value: k.security || '—', tone: 'info', info: k.keySaved ? 'A password is saved for it' : null }),
        kit.toggle(Object.assign({ row: 'network.wifi.known.auto', label: 'Connect automatically when in range', value: !!k.autoConnect,
          onChange: (v) => set({ autoConnect: v }, (n) => n.autoConnect) }, lock)),
        kit.toggle(Object.assign({ row: 'network.wifi.known.hidden', label: 'Connect even if the network is not broadcasting its name', value: !!k.hidden,
          onChange: (v) => set({ hidden: v }, (n) => n.hidden) }, lock)),
        kit.choice(Object.assign({ row: 'network.wifi.known.random', label: 'Random hardware addresses', style: 'dropdown', value: k.randomMac || 'off',
          options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }, { value: 'daily', label: 'Change daily' }],
          info: k.randomMac ? null : k.randomMacWhy, onChange: (v) => set({ randomMac: v }, (n) => n.randomMac) }, lock)),
        kit.choice(Object.assign({ row: 'network.wifi.known.metered', label: 'Metered connection', value: null,
          options: [{ value: 'on', label: 'Metered' }, { value: 'off', label: 'Not metered' }],
          info: 'Windows does not tell other apps what a saved network\'s metered setting is, so neither is shown as chosen; pick one to set it',
          onChange: async (v) => { const r = await C(kit, 'wifiSet', { profile: k.profile, iface: S.iface, metered: v === 'on' }); return r.ok && !r.dryRun ? { ok: true, value: v } : r; } }, lock)),
      ];
      const forget = kit.button(Object.assign({ row: 'network.wifi.known.forget', label: 'Forget this network', help: 'Deletes its saved password; it will not connect by itself any more',
        text: 'Forget', onClick: async () => {
          if (!S.forget) { S.forget = true; forget.set({ text: 'Yes, forget it', reason: 'Forget ' + (k.ssid || k.profile) + '? Press again to confirm.' }); return { ok: true }; }
          const r = await C(kit, 'wifiForget', { profile: k.profile, iface: S.iface });
          S.forget = false;
          if (r.ok && !r.dryRun) { S.edit = null; editBox.replaceChildren(); readAll(); }
          else forget.set({ text: 'Forget', reason: null });
          return r;
        } }, lock));
      rows.push(forget);
      editBox.replaceChildren(kit.group(k.ssid || k.profile, { row: 'network.wifi.known.edit' }), kit.card(...rows));
      drawKnown();
    }
    function knownAction(key, act, it) {
      if (S.edit === it.prof.profile) { S.edit = null; editBox.replaceChildren(); drawKnown(); return { ok: true }; }
      showEdit(it.prof);
      kit.highlight('network.wifi.known.edit');
      return { ok: true };
    }
    function readAll() { readRadio(); readNets(); readProps(); readKnown(); }
    readAll();
    kit.every(5000, () => { readRadio(); readNets(); });
    kit.watch('net', () => { readRadio(); readProps(); });
    return { update: readAll, dispose() {} };
  }

  // ============================================================== adapters (Ethernet + Advanced)
  function adaptersOf(kit, cb) {
    return C(kit, 'adapters').then((r) => { if (!kit.disposed) cb(r); });
  }

  function ethernetPage(el, kit) {
    const box = kit.h('div', {});
    const summary = kit.status({ row: 'network.ethernet', label: 'Ethernet', value: 'Reading…', tone: 'info' });
    el.append(kit.card(summary), box);
    function read() {
      adaptersOf(kit, (r) => {
        if (!r.ok) { summary.set({ value: 'Unknown', tone: 'warn', reason: bad(r, 'The adapters could not be read') }); box.replaceChildren(); return; }
        const eth = (r.adapters || []).filter((a) => a.kind === 'ethernet');
        summary.set({ value: eth.length ? eth.length + ' wired adapter' + (eth.length === 1 ? '' : 's') + ', ' + eth.filter((a) => a.status === 'connected').length + ' connected' : 'No Ethernet adapter', tone: eth.some((a) => a.status === 'connected') ? 'ok' : 'info', info: eth.length ? null : 'This PC has no wired network adapter turned on or plugged in' });
        if (!eth.length) { box.replaceChildren(); return; }
        const parts = [];
        eth.forEach((a) => {
          const pre = 'network.ethernet.' + keyOf(a.adapter);
          parts.push(kit.group(a.name, { row: pre }), kit.card(
            kit.status({ row: pre + '.status', label: a.description || 'Ethernet', value: a.status === 'connected' ? 'Connected' + (speed(a.speedBps) ? ' · ' + speed(a.speedBps) : '') : a.status === 'disabled' ? 'Turned off' : 'Not connected (unplugged)',
              tone: a.status === 'connected' ? 'ok' : 'warn', info: a.status === 'disabled' ? 'Turn it back on under Advanced network settings' : null }),
            kit.status({ row: pre + '.metered', label: 'Metered connection', value: 'Read-only', tone: 'info',
              reason: 'Mantle cannot mark a wired network as metered: Windows keeps that setting inside its Data Usage service, which has no public way to change it' }),
            kit.status({ row: pre + '.ipassign', label: 'IP assignment', value: a.addressing.dhcp === false ? 'Manual' : 'Automatic (DHCP)', tone: 'info',
              reason: 'Mantle cannot change the IP assignment yet; it shows what Windows uses' }),
            ...dnsEditor(kit, pre, a, read)),
          kit.group('Properties'), kit.card(...propRows(kit, pre + '.props', a, [['speed', 'Link speed', speed(a.speedBps) || '—']])));
        });
        box.replaceChildren(...parts);
      });
    }
    read();
    kit.watch('net', read);
    return { update: read, dispose() {} };
  }

  function advancedPage(el, kit) {
    const adapters = kit.list({ row: 'network.advanced.adapters', items: [], empty: 'Reading the adapters…', onAction: act });
    const detail = kit.h('div', {});
    const reset = kit.button({ row: 'network.advanced.reset', label: 'Network reset', help: 'Removes and reinstalls every network adapter and sets networking back to how Windows ships it; the PC must restart afterwards',
      admin: 'reset every network adapter', text: 'Reset now', onClick: async () => {
        if (!reset.armed) { reset.armed = true; reset.set({ text: 'Yes, reset', reason: 'Every saved Wi-Fi password, VPN and adapter setting is removed. Press again to confirm.' }); return { ok: true }; }
        reset.armed = false;
        const r = await C(kit, 'networkReset');
        reset.set({ text: 'Reset now' });
        return r;
      } });
    el.append(kit.group('Network adapters', { row: 'network.advanced.adapters' }), kit.card(adapters), detail,
      kit.group('More settings'), kit.card(reset));
    const S = { ads: [], open: null, elevated: false };
    function draw() {
      adapters.set({ empty: 'No network adapters', items: S.ads.map((a) => ({
        key: keyOf(a.adapter), label: a.name, icon: 'network', ad: a,
        help: [a.description, a.status === 'connected' ? 'Connected' : a.status === 'disabled' ? 'Turned off' : 'Not connected', speed(a.speedBps)].filter(Boolean).join(' · '),
        actions: [
          { id: 'details', text: S.open === a.adapter ? 'Close' : 'Details' },
          a.canToggle ? { id: a.enabled ? 'disable' : 'enable', text: a.enabled ? 'Disable' : 'Enable', admin: 'turn this network adapter on or off' }
            : { id: 'enable', text: a.enabled ? 'Disable' : 'Enable', disabled: true, reason: a.toggleWhy },
        ] })) });
    }
    function showDetail(a) {
      const pre = 'network.advanced.adapter';
      detail.replaceChildren(kit.group(a.name + ' — details', { row: pre }),
        kit.card(...propRows(kit, pre + '.props', a, [['desc', 'Description', a.description || '—'], ['kind', 'Type', KIND[a.kind] || 'Adapter'], ['speed', 'Link speed', speed(a.speedBps) || '—']])),
        kit.group('DNS'), kit.card(...dnsEditor(kit, pre, a, read)));
    }
    async function act(key, id, it) {
      const a = it.ad;
      if (id === 'details') {
        if (S.open === a.adapter) { S.open = null; detail.replaceChildren(); } else { S.open = a.adapter; showDetail(a); }
        draw();
        return { ok: true };
      }
      const r = await C(kit, 'adapterEnable', { adapter: a.adapter, on: id === 'enable' });
      if (r.ok && !r.dryRun) setTimeout(read, 1200);
      return r;
    }
    function read() {
      adaptersOf(kit, (r) => {
        if (!r.ok) { adapters.set({ items: [], empty: bad(r, 'The adapters could not be read') }); return; }
        S.ads = r.adapters || [];
        draw();
        if (S.open) { const a = S.ads.find((x) => x.adapter === S.open); if (a) showDetail(a); }
      });
    }
    read();
    return { update: read, dispose() {} };
  }

  // ============================================================== VPN and Dial-up
  function entriesPage(kinds, what) {
    return function (el, kit) {
      const pre = 'network.' + what;
      const entries = kit.list({ row: pre + '.list', items: [], empty: 'Reading…', onAction: act });
      const add = kit.button({ row: pre + '.add', label: what === 'vpn' ? 'Add a VPN connection' : 'Set up a new connection', text: 'Add', disabled: true,
        reason: 'Adding a connection is not built into Mantle yet; connections added in Windows are listed and dialled here' });
      el.append(kit.group(what === 'vpn' ? 'VPN connections' : 'Dial-up connections', { row: pre + '.list' }), kit.card(entries, add));
      if (what === 'vpn') {
        el.append(kit.group('Advanced settings for all VPN connections'), kit.card(
          kit.status({ row: 'network.vpn.metered', label: 'Allow VPN over metered networks', value: 'Read-only', tone: 'info', reason: 'Mantle cannot change this yet: Windows keeps it with its own Settings\' VPN policy, which has no public way to change it' }),
          kit.status({ row: 'network.vpn.roaming', label: 'Allow VPN while roaming', value: 'Read-only', tone: 'info', reason: 'Mantle cannot change this yet: Windows keeps it with its own Settings\' VPN policy, which has no public way to change it' })));
      }
      async function act(key, id, it) {
        const r = await C(kit, 'vpnConnect', { entry: it.entry, on: id === 'connect' });
        if (r.ok && !r.dryRun) setTimeout(read, 500);
        return r;
      }
      async function read() {
        const r = await C(kit, 'vpn');
        if (kit.disposed) return;
        if (!r.ok) { entries.set({ items: [], empty: bad(r, 'The connections could not be read') }); return; }
        const mine = (r.entries || []).filter((e) => kinds.includes(e.kind));
        entries.set({ empty: what === 'vpn' ? 'No VPN connections are set up on this PC' : 'No dial-up connections are set up on this PC', items: mine.map((e) => ({
          key: keyOf(e.entry), label: e.entry, icon: what === 'vpn' ? ICO.vpn : ICO.dialup, entry: e.entry,
          help: [e.connected ? 'Connected' : 'Not connected', e.type, e.server, e.allUsers ? 'For everyone' : null].filter(Boolean).join(' · '),
          reason: r.reason || null,
          actions: [{ id: e.connected ? 'disconnect' : 'connect', text: e.connected ? 'Disconnect' : 'Connect', tone: e.connected ? undefined : 'acc' }] })) });
      }
      read();
      kit.every(6000, read);
      return { update: read, dispose() {} };
    };
  }

  // ============================================================== Mobile hotspot
  function hotspotPage(el, kit) {
    el.append(kit.card(
      kit.status({ row: 'network.hotspot.state', label: 'Mobile hotspot', value: 'Not available in Mantle yet', tone: 'warn',
        reason: 'Windows only offers the mobile hotspot through its tethering API (NetworkOperatorTetheringManager), which Mantle\'s helper is not built with yet; nothing here can change it' }),
      kit.status({ row: 'network.hotspot.props', label: 'Network name, password and band', value: 'Read-only', tone: 'info', reason: 'Shown and changed through the same tethering API, which Mantle cannot reach yet' })));
    return { dispose() {} };
  }

  // ============================================================== Airplane mode
  function airplanePage(el, kit) {
    const air = kit.toggle({ row: 'network.airplane', label: 'Airplane mode', icon: ICO.airplane, help: 'Stops all wireless communication: Wi-Fi, Bluetooth and mobile data',
      onChange: async (on) => { const r = await C(kit, 'airplaneSet', { on }); if (r.ok && !r.dryRun) setTimeout(read, 800); return r; } });
    const radio = (part, row, label) => kit.toggle({ row, label, onChange: async (on) => {
      if (kit.test) return { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would turn ' + label + ' ' + (on ? 'on' : 'off') };
      const r = await kit.call('qs.set', { part, value: on });
      return r.ok === false ? r : { ok: true, value: r.state && r.state[part] && typeof r.state[part].on === 'boolean' ? r.state[part].on : on };
    } });
    const wifi = radio('wifi', 'network.airplane.wifi', 'Wi-Fi');
    const bt = radio('bluetooth', 'network.airplane.bluetooth', 'Bluetooth');
    el.append(kit.card(air), kit.group('Wireless devices'), kit.card(wifi, bt));
    async function read() {
      const [a, q] = await Promise.all([C(kit, 'airplane'), kit.call('qs.get')]);
      if (kit.disposed) return;
      if (!a.ok) air.set({ disabled: true, reason: bad(a, 'Airplane mode could not be read') });
      else air.set({ value: !!a.airplane, disabled: !a.canSet, reason: a.canSet ? null : a.reason });
      for (const [h, part] of [[wifi, 'wifi'], [bt, 'bluetooth']]) {
        const s = q && q[part];
        if (!s || q.ok === false) h.set({ disabled: true, reason: bad(q, 'The radio could not be read') || 'The radio could not be read' });
        else if (s.present === false) h.set({ value: false, disabled: true, reason: 'This PC has no ' + (part === 'wifi' ? 'Wi-Fi adapter' : 'Bluetooth radio') });
        else h.set({ value: !!s.on, disabled: false, reason: null });
      }
    }
    read();
    kit.every(5000, read);
    return { update: read, dispose() {} };
  }

  // ============================================================== Proxy
  function proxyPage(el, kit) {
    const P = { autoDetect: false, script: { on: false, url: '' }, manual: { on: false, server: '', port: 0, bypass: [], local: false } };
    const setP = async (patch) => {
      const r = await C(kit, 'proxySet', patch);
      if (r.ok && !r.dryRun && r.now) { Object.assign(P, r.now); fill(); }
      return r;
    };
    const detect = kit.toggle({ row: 'network.proxy.detect', label: 'Automatically detect settings', onChange: async (v) => { const r = await setP({ autoDetect: v }); return r.ok && !r.dryRun ? { ok: true, value: P.autoDetect } : r; } });
    const scriptOn = kit.toggle({ row: 'network.proxy.script', label: 'Use setup script', onChange: async (v) => {
      const r = await setP({ script: { on: v, url: P.script.url || undefined } }); return r.ok && !r.dryRun ? { ok: true, value: P.script.on } : r; } });
    const scriptUrl = kit.text({ row: 'network.proxy.script.url', label: 'Script address', value: '', placeholder: 'http://proxy.example/proxy.pac', onChange: (s) => { P.script.url = s; return { ok: true }; } });
    const scriptSave = kit.button({ row: 'network.proxy.script.save', label: 'Save the script address', text: 'Save', tone: 'acc', onClick: () => setP({ script: { on: P.script.on, url: P.script.url } }) });
    const manOn = kit.toggle({ row: 'network.proxy.manual', label: 'Use a proxy server', onChange: async (v) => {
      const r = await setP({ manual: { on: v, server: P.manual.server || undefined, port: P.manual.port || undefined } }); return r.ok && !r.dryRun ? { ok: true, value: P.manual.on } : r; } });
    const server = kit.text({ row: 'network.proxy.manual.server', label: 'Proxy IP address', value: '', placeholder: 'proxy.example', onChange: (s) => { P.manual.server = s; return { ok: true }; } });
    const port = kit.number({ row: 'network.proxy.manual.port', label: 'Port', value: 0, min: 1, max: 65535, onChange: (n) => { P.manual.port = n; return { ok: true }; } });
    const bypass = kit.text({ row: 'network.proxy.manual.bypass', label: 'Don\'t use the proxy server for these addresses (separate with semicolons)', value: '', placeholder: '*.example.org; 10.*',
      onChange: (s) => { P.manual.bypass = s.split(/[;,\s]+/).filter(Boolean); return { ok: true }; } });
    const local = kit.toggle({ row: 'network.proxy.manual.local', label: 'Don\'t use the proxy server for local (intranet) addresses', onChange: (v) => { P.manual.local = v; return { ok: true }; } });
    const manSave = kit.button({ row: 'network.proxy.manual.save', label: 'Save the proxy server', text: 'Save', tone: 'acc',
      onClick: () => setP({ manual: { on: P.manual.on, server: P.manual.server, port: P.manual.port, bypass: P.manual.bypass, local: P.manual.local } }) });
    el.append(kit.group('Automatic proxy setup'), kit.card(detect, scriptOn, scriptUrl, scriptSave),
      kit.group('Manual proxy setup'), kit.card(manOn, server, port, bypass, local, manSave));
    function fill() {
      detect.set({ value: !!P.autoDetect });
      scriptOn.set({ value: !!P.script.on }); scriptUrl.set({ value: P.script.url || '' });
      manOn.set({ value: !!P.manual.on }); server.set({ value: P.manual.server || '' }); port.set({ value: P.manual.port || 0 });
      bypass.set({ value: (P.manual.bypass || []).join('; ') }); local.set({ value: !!P.manual.local });
    }
    async function read() {
      const r = await C(kit, 'proxy');
      if (kit.disposed) return;
      if (!r.ok) { const why = bad(r, 'The proxy settings could not be read'); [detect, scriptOn, manOn].forEach((h) => h.set({ disabled: true, reason: why })); return; }
      P.autoDetect = r.autoDetect;
      P.script = Object.assign({ on: false, url: '' }, r.script);
      P.manual = Object.assign({ on: false, server: '', port: 0, bypass: [], local: false }, r.manual);
      fill();
    }
    read();
    return { update: read, dispose() {} };
  }

  const S = (row, label, keywords, uri) => (uri ? { row, label, keywords, uri } : { row, label, keywords });
  MantleSettings.section({
    id: 'internet',
    title: 'Network & internet',
    group: 'windows',
    icon: 'network',
    order: 30,
    help: 'Wi-Fi, Ethernet, VPN, proxy, airplane mode',
    keywords: 'network internet wifi wireless ethernet lan vpn proxy hotspot airplane dns adapter',
    replaces: ['network'],
    pages: [
      { id: 'network', title: 'Status', icon: 'network', help: 'Connection, properties and data usage', render: statusPage,
        search: [S('network.status', 'Network status', 'connection internet connected', 'ms-settings:network-status'),
          S('network.status.props', 'Network properties', 'ip address gateway dns mac', 'ms-settings:network'),
          S('network.status.usage', 'Data usage', 'traffic bytes sent received', 'ms-settings:datausage'),
          S('network.status.apps', 'Data usage per app', 'app usage 30 days')] },
      { id: 'wifi', title: 'Wi-Fi', icon: 'network', help: 'Networks in range, known networks, properties', render: wifiPage,
        search: [S('network.wifi', 'Wi-Fi', 'wireless radio on off', 'ms-settings:network-wifi'),
          S('network.networks', 'Available networks', 'connect join scan wifi list'),
          S('network.wifi.props', 'Wi-Fi properties', 'ssid band channel protocol link speed ip'),
          S('network.wifi.hidden', 'Connect to a hidden network', 'hidden ssid not broadcasting'),
          S('network.wifi.known', 'Manage known networks', 'saved forget auto connect metered random hardware address mac', 'ms-settings:network-wifisettings')] },
      { id: 'ethernet', title: 'Ethernet', icon: ICO.ethernet, help: 'Wired connection, IP and DNS', render: ethernetPage,
        search: [S('network.ethernet', 'Ethernet', 'wired lan cable dns ip assignment', 'ms-settings:network-ethernet')] },
      { id: 'vpn', title: 'VPN', icon: ICO.vpn, help: 'Connect and disconnect VPNs', render: entriesPage(['vpn'], 'vpn'),
        search: [S('network.vpn.list', 'VPN connections', 'vpn connect disconnect', 'ms-settings:network-vpn'),
          S('network.vpn.add', 'Add a VPN connection', 'new vpn'),
          S('network.vpn.metered', 'Allow VPN over metered networks', 'vpn metered'), S('network.vpn.roaming', 'Allow VPN while roaming', 'vpn roaming')] },
      { id: 'hotspot', title: 'Mobile hotspot', icon: ICO.hotspot, help: 'Share this PC\'s internet', render: hotspotPage,
        search: [S('network.hotspot.state', 'Mobile hotspot', 'hotspot tethering share internet', 'ms-settings:network-mobilehotspot')] },
      { id: 'airplane', title: 'Airplane mode', icon: ICO.airplane, help: 'Turn every radio off at once', render: airplanePage,
        search: [S('network.airplane', 'Airplane mode', 'flight mode radios off', 'ms-settings:network-airplanemode'),
          S('network.airplane.wifi', 'Wi-Fi (airplane mode)', 'wireless radio'), S('network.airplane.bluetooth', 'Bluetooth (airplane mode)', 'radio')] },
      { id: 'proxy', title: 'Proxy', icon: ICO.proxy, help: 'Proxy server for web traffic', render: proxyPage,
        search: [S('network.proxy.detect', 'Automatically detect proxy settings', 'proxy wpad auto', 'ms-settings:network-proxy'),
          S('network.proxy.script', 'Use setup script', 'pac proxy script'), S('network.proxy.manual', 'Use a proxy server', 'manual proxy server port bypass')] },
      { id: 'dialup', title: 'Dial-up', icon: ICO.dialup, help: 'Dial-up and broadband connections', render: entriesPage(['dialup', 'broadband', 'other'], 'dialup'),
        search: [S('network.dialup.list', 'Dial-up connections', 'dial up modem pppoe broadband', 'ms-settings:network-dialup')] },
      { id: 'advanced', title: 'Advanced network settings', icon: ICO.advanced, help: 'Adapters, DNS, network reset', render: advancedPage,
        search: [S('network.advanced.adapters', 'Network adapters', 'adapter disable enable driver hardware properties dns server', 'ms-settings:network-advancedsettings'),
          S('network.advanced.reset', 'Network reset', 'reset reinstall adapters')] },
    ],
  });
}());
