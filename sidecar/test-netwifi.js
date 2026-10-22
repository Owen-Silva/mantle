// test-netwifi.js - NetWifi.cs, NetAdapters.cs, NetProxy.cs, NetMisc.cs and the hidden-network
// additions to Wlan.cs against a PASSIVE sidecar (lane net2, 2026-09-28).
//
//   node sidecar/test-netwifi.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes the user's network: no connect, disconnect, forget, profile write, adapter switch, DNS,
// proxy, VPN or airplane change. Every write is proven by its dryRun against a REAL target (a real
// saved network, a real adapter), which a passive sidecar answers because it changes nothing, and
// by the passive refusal of the real write. Prints counts and shapes only: never an SSID, profile
// name, adapter name, address or MAC.
'use strict';
const T = require('./test-lib');

(async () => {
  const t = T.checker('NETWIFI');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 12000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const err = (r) => (r && r.ok === false ? String(r.error || '') : '');
  const secrets = [];                       // names the log must never carry

  try {
    // --- registration
    const ping = await send('ping');
    const feats = ping.ok && ping.result && ping.result.features;
    const cmds = (feats && feats.commands) || [];
    for (const c of ['netwifi.known', 'netwifi.forget', 'netwifi.set', 'netwifi.props', 'netadapt.list', 'netadapt.plan',
      'netproxy.get', 'netproxy.set', 'netvpn.list', 'netvpn.connect', 'netair.get', 'netair.set']) {
      t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    }
    const probs = ((feats && feats.problems) || []).filter((p) => /Net(Wifi|Adapters|Proxy|Misc)/.test(p));
    t.check('no Net* registration problems', probs.length === 0, probs.join('; '));
    const el = await send('elevate.list');
    const acts = (el.ok && el.result && el.result.actions) || [];
    for (const a of ['network.setAdapterEnabled', 'network.setDns']) {
      const hit = acts.find((x) => x.action === a);
      t.check(`${a} is an elevated action with its words`, !!hit && /adapter/.test(hit.does), JSON.stringify(acts.map((x) => x.action)));
    }
    const eprobs = ((el.result && el.result.problems) || []).filter((p) => /network\.|NetAdapters/i.test(p));
    t.check('no elevate problems for the network actions', eprobs.length === 0, eprobs.join('; '));

    // --- netwifi.known (a read)
    const k = await send('netwifi.known');
    const kr = k.ok ? k.result : null;
    t.check('netwifi.known answers', !!kr && Array.isArray(kr.profiles), err(k).slice(0, 160));
    const profs = kr && kr.profiles ? kr.profiles : [];
    if (kr && kr.present) {
      const shaped = profs.filter((p) => typeof p.profile === 'string' && typeof p.autoConnect === 'boolean' && typeof p.hidden === 'boolean' &&
        typeof p.canEdit === 'boolean' && typeof p.connected === 'boolean' && typeof p.security === 'string' && [null, 'off', 'on', 'daily'].includes(p.randomMac));
      t.check('every saved network has the full shape', shaped.length === profs.length, `${shaped.length} of ${profs.length}`);
      t.check('at most one saved network is the connected one', profs.filter((p) => p.connected).length <= 1);
      t.check('a read-only saved network says why', profs.every((p) => p.canEdit || (typeof p.editWhy === 'string' && p.editWhy.length > 10)));
      t.check('iface is a {GUID}', /^\{[0-9a-f-]{36}\}$/i.test(kr.iface || ''));
      profs.forEach((p) => { if (p.ssid) secrets.push(p.ssid); if (p.profile) secrets.push(p.profile); });
      process.stdout.write(`known: ${profs.length} saved, ${profs.filter((p) => p.autoConnect).length} auto, ${profs.filter((p) => p.keySaved).length} with a key, ` +
        `randomMac ${JSON.stringify(profs.reduce((a, p) => { a[p.randomMac] = (a[p.randomMac] || 0) + 1; return a; }, {}))}\n`);
    } else {
      t.check('no Wi-Fi: the reason says so', kr && /no Wi-Fi/.test(kr.reason || ''));
    }

    // --- netwifi.props (a read)
    const pr = await send('netwifi.props');
    const pp = pr.ok ? pr.result : null;
    t.check('netwifi.props answers', !!pp && typeof pp.connected === 'boolean', err(pr).slice(0, 160));
    if (pp && pp.connected) {
      t.check('props: band is a known band', ['2.4 GHz', '5 GHz', '6 GHz'].includes(pp.band), String(pp.band));
      t.check('props: channel and protocol', typeof pp.channel === 'number' && typeof pp.protocol === 'string', `${typeof pp.channel} ${typeof pp.protocol}`);
      t.check('props: security and link speed', typeof pp.security === 'string' && typeof pp.rxMbps === 'number' && pp.rxMbps > 0);
      const a = pp.addressing || {};
      t.check('props: IPv4, gateway, DNS lists', Array.isArray(a.ipv4) && a.ipv4.length > 0 && Array.isArray(a.gateway) && Array.isArray(a.dns4), JSON.stringify(Object.keys(a)));
      t.check('props: DNS typed-in vs DHCP is a bool', typeof a.dnsManual === 'boolean');
      t.check('props: MAC and driver', /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(a.mac || '') && pp.driver && typeof pp.driver.version === 'string');
      if (pp.ssid) secrets.push(pp.ssid);
      process.stdout.write(`props: connected, ${pp.band}, ${pp.protocol}, dns ${a.dnsManual ? 'manual' : 'dhcp'}\n`);
    } else if (pp) {
      t.check('props: not connected says why', typeof pp.reason === 'string');
    }

    // --- netwifi.forget / netwifi.set: dry runs on a REAL saved network, refusals for real
    const target = profs.find((p) => p.canEdit && !p.connected && p.keySaved) || profs.find((p) => p.canEdit);
    if (target) {
      const f = await send('netwifi.forget', { profile: target.profile, dryRun: true });
      t.check('forget dryRun answers would', f.ok && f.result.dryRun === true && /forget/.test(f.result.would), err(f).slice(0, 160));
      t.check('forget for real is refused in passive', refused(await send('netwifi.forget', { profile: target.profile, dryRun: false })));
      const set = await send('netwifi.set', { profile: target.profile, autoConnect: !target.autoConnect, hidden: !target.hidden, randomMac: 'daily', dryRun: true });
      const sr = set.ok ? set.result : {};
      t.check('set dryRun answers would + changes', sr.dryRun === true && Array.isArray(sr.changes) && sr.changes.length >= 2, err(set).slice(0, 160));
      const xml = String(sr.xml || '');
      t.check('set dryRun XML carries the edits', xml.includes('<connectionMode>' + (target.autoConnect ? 'manual' : 'auto')) && /nonBroadcast>/.test(xml) && /randomizeEveryday>true/.test(xml));
      const keys = xml.match(/<keyMaterial>([^<]*)<\/keyMaterial>/g) || [];
      t.check('set dryRun XML never carries a key (keyMaterial REDACTED)', keys.every((x) => x === '<keyMaterial>REDACTED</keyMaterial>') && (!target.keySaved || keys.length === 1), `${keys.length} key elements`);
      t.check('set for real is refused in passive', refused(await send('netwifi.set', { profile: target.profile, autoConnect: !target.autoConnect, dryRun: false })));
      const met = await send('netwifi.set', { profile: target.profile, metered: true, dryRun: true });
      t.check('metered dryRun answers would', met.ok && /metered/.test(met.result.would), err(met).slice(0, 160));
      t.check('metered for real is refused in passive', refused(await send('netwifi.set', { profile: target.profile, metered: true, dryRun: false })));
      t.check('metered with other changes is refused in words', /on its own/.test(err(await send('netwifi.set', { profile: target.profile, metered: true, hidden: true, dryRun: true }))));
      t.check('a bad randomMac is refused in words', /off, on or daily/.test(err(await send('netwifi.set', { profile: target.profile, randomMac: 'always', dryRun: true }))));
      t.check('nothing to change is refused in words', /needs something to change/.test(err(await send('netwifi.set', { profile: target.profile, dryRun: true }))));
    } else {
      t.check('(no editable saved network: forget/set dry runs skipped)', true);
    }
    t.check('forget of a network that does not exist says so', /no saved network/.test(err(await send('netwifi.forget', { profile: 'mantle-test-no-such-profile-' + Date.now(), dryRun: true }))));
    t.check('forget without a profile says so', /needs profile/.test(err(await send('netwifi.forget', { dryRun: true }))));

    // --- Wlan.cs: hidden networks
    const hp = await send('wlan', { op: 'profile', ssid: 'Mantle Test Hidden', security: 'wpa2', password: 'test-pass-1234', hidden: true });
    const hx = hp.ok && hp.result ? String(hp.result.xml || '') : '';
    t.check('wlan profile hidden:true writes nonBroadcast', hx.includes('<nonBroadcast>true</nonBroadcast>') && hp.result.wellFormed === true, err(hp).slice(0, 160));
    const np = await send('wlan', { op: 'profile', ssid: 'Mantle Test Open', security: 'open' });
    t.check('wlan profile without hidden has no nonBroadcast', np.ok && !String(np.result.xml).includes('nonBroadcast'));
    t.check('wlan connect hidden is refused in passive', refused(await send('wlan', { op: 'connect', ssid: 'Mantle Test Hidden', hidden: true, security: 'wpa2', password: 'test-pass-1234' })));
    t.check('wlan connect hidden without security says so', /needs security/.test(err(await send('wlan', { op: 'connect', ssid: 'X', hidden: true }))));
    t.check('wlan connect hidden secured without password says so', /needs its password/.test(err(await send('wlan', { op: 'connect', ssid: 'X', hidden: true, security: 'wpa3' }))));

    // --- netadapt.list + plan
    const al = await send('netadapt.list');
    const ads = al.ok && al.result && Array.isArray(al.result.adapters) ? al.result.adapters : null;
    t.check('netadapt.list answers adapters', !!ads && ads.length > 0, err(al).slice(0, 160));
    if (ads) {
      const good = ads.filter((a) => /^\{[0-9A-F-]{36}\}$/i.test(a.adapter) && typeof a.name === 'string' && typeof a.enabled === 'boolean' &&
        ['connected', 'disconnected', 'disabled', 'unknown'].includes(a.status) && a.addressing && Array.isArray(a.addressing.ipv4));
      t.check('every adapter has the full shape', good.length === ads.length, `${good.length} of ${ads.length}`);
      t.check('a connected adapter has bytes and a speed', ads.filter((a) => a.status === 'connected').every((a) => typeof a.addressing.bytesIn === 'number' && typeof a.speedBps === 'number'));
      t.check('the Wi-Fi adapter is listed', !(pp && pp.present) || ads.some((a) => a.kind === 'wifi'));
      ads.forEach((a) => secrets.push(a.name));
      process.stdout.write(`adapters: ${ads.length} (${JSON.stringify(ads.reduce((o, a) => { o[a.kind] = (o[a.kind] || 0) + 1; return o; }, {}))}), ` +
        `${ads.filter((a) => !a.enabled).length} disabled\n`);
      const real = ads.find((a) => a.enabled && a.canToggle);
      if (real) {
        const p1 = await send('netadapt.plan', { adapter: real.adapter, on: false });
        t.check('plan: adapter off is a dry run with would', p1.ok && p1.result.dryRun === true && p1.result.action === 'network.setAdapterEnabled' && /administrator/.test(p1.result.would), err(p1).slice(0, 160));
        const p2 = await send('netadapt.plan', { adapter: real.adapter, servers: ['1.1.1.1', '2606:4700:4700::1111'] });
        t.check('plan: DNS is a dry run with would', p2.ok && p2.result.action === 'network.setDns' && /1\.1\.1\.1/.test(p2.result.would), err(p2).slice(0, 160));
        const p3 = await send('netadapt.plan', { adapter: real.adapter, servers: [] });
        t.check('plan: empty DNS list = automatic', p3.ok && /automatic/.test(p3.result.would));
        t.check('plan: a bad DNS address is refused in words', /not an IP address/.test(err(await send('netadapt.plan', { adapter: real.adapter, servers: ['1.1.1'] }))));
      }
      t.check('plan: a non-GUID adapter is refused', /GUID/.test(err(await send('netadapt.plan', { adapter: 'Wi-Fi', on: true }))));
      t.check('plan: an unknown adapter is refused', /no network adapter/.test(err(await send('netadapt.plan', { adapter: '{00000000-0000-0000-0000-000000000000}', on: true }))));
      t.check('plan: on must be a bool', /true or false/.test(err(await send('netadapt.plan', { adapter: '{00000000-0000-0000-0000-000000000000}', on: 'yes' }))));
    }

    // --- proxy
    const pg = await send('netproxy.get');
    const px = pg.ok ? pg.result : null;
    t.check('netproxy.get answers the shape', !!px && typeof px.autoDetect === 'boolean' && px.script && typeof px.script.on === 'boolean' && px.manual && Array.isArray(px.manual.bypass), err(pg).slice(0, 160));
    if (px) {
      const d1 = await send('netproxy.set', { autoDetect: !px.autoDetect, dryRun: true });
      t.check('proxy autoDetect dryRun answers would', d1.ok && d1.result.dryRun && /detect/.test(d1.result.would), err(d1).slice(0, 160));
      const d2 = await send('netproxy.set', { manual: { on: true, server: 'proxy.example', port: 8080, bypass: ['*.example.org'], local: true }, dryRun: true });
      t.check('proxy manual dryRun answers the plan', d2.ok && d2.result.plan && d2.result.plan.manual.port === 8080 && d2.result.plan.manual.local === true, err(d2).slice(0, 160));
      t.check('proxy: a bad port is refused', /port/.test(err(await send('netproxy.set', { manual: { on: true, server: 'p', port: 70000 }, dryRun: true }))));
      t.check('proxy: a bad script address is refused', /web address/.test(err(await send('netproxy.set', { script: { on: true, url: 'not a url' }, dryRun: true }))));
      t.check('proxy for real is refused in passive', refused(await send('netproxy.set', { autoDetect: px.autoDetect, dryRun: false })));
    }

    // --- VPN
    const vl = await send('netvpn.list');
    const ents = vl.ok && Array.isArray(vl.result.entries) ? vl.result.entries : null;
    t.check('netvpn.list answers entries', !!ents, err(vl).slice(0, 160));
    if (ents) {
      process.stdout.write(`vpn: ${ents.length} entries\n`);
      ents.forEach((e) => secrets.push(e.entry));
      if (ents.length) {
        const vd = await send('netvpn.connect', { entry: ents[0].entry, on: !ents[0].connected, dryRun: true });
        t.check('vpn connect dryRun answers would', vd.ok && vd.result.dryRun === true, err(vd).slice(0, 160));
        t.check('vpn connect for real is refused in passive', refused(await send('netvpn.connect', { entry: ents[0].entry, on: !ents[0].connected })));
      }
    }
    t.check('vpn connect of an unknown entry says so', /no VPN connection/.test(err(await send('netvpn.connect', { entry: 'mantle-no-such-vpn', on: true, dryRun: true }))));

    // --- airplane mode
    const ag = await send('netair.get');
    const ap = ag.ok ? ag.result : null;
    t.check('netair.get answers', !!ap && typeof ap.canSet === 'boolean' && (typeof ap.airplane === 'boolean' || typeof ap.reason === 'string'), err(ag).slice(0, 160));
    if (ap) {
      process.stdout.write(`airplane: ${ap.airplane}, canSet ${ap.canSet}, registry agrees ${ap.registryAgrees}\n`);
      if (ap.canSet) {
        t.check('radio manager agrees with the registry', ap.registryAgrees !== false);
        const ad = await send('netair.set', { on: !ap.airplane, dryRun: true });
        t.check('airplane dryRun answers would', ad.ok && /airplane/.test(ad.result.would), err(ad).slice(0, 160));
        t.check('airplane for real is refused in passive', refused(await send('netair.set', { on: !ap.airplane })));
      }
      t.check('airplane: on must be a bool', /true or false/.test(err(await send('netair.set', { on: 1, dryRun: true }))));
    }
  } catch (e) {
    t.fail('the run crashed', e.stack);
  }

  // --- privacy: nothing we read may be in the sidecar's log
  const log = typeof s.stderr === 'function' ? s.stderr() : Array.isArray(s.stderr) ? s.stderr.join('\n') : String(s.stderr || '');
  const leaked = secrets.filter((x) => x && x.length >= 4 && log.includes(x)).length;
  t.check('no SSID, profile, adapter or VPN name in the sidecar log', leaked === 0, `${leaked} leaked`);
  t.check('no test password in the sidecar log', !log.includes('test-pass-1234'));
  await s.stop();
  process.exit(t.summary());
})();
