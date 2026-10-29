/* pages/performance.js - Windows 11's Task Manager Performance page (TM-SPEC.md "Performance") in Mantle's skin.
 * Left: the device list (CPU, Memory, Disk n (X:), Wi-Fi / Ethernet, GPU n, NPU n when main sends one), each
 * card with its live line(s) and a sparkline; Up/Down/Home/End move through it. Right: the chosen device's
 * 60-second graph(s) with Windows' captions, then its numbers (big ones left, "key: value" right).
 * A null field is an em dash whose tooltip says why (the model's why[field], else this file's words). Nothing is
 * made up: a number main did not send is never drawn.
 * Menus: the graph's right-click (CPU: Change graph to > Overall utilization / Logical processors, Show kernel
 * times; GPU: Change graph to > Single engine / Multiple engines; every device: Graph summary view, View >,
 * Copy), the list's right-click (Hide graphs, Summary view, Copy) and the "..." (Open Resource Monitor, Copy,
 * Graph summary view). Every choice is remembered (TM.store 'perf.*').
 * Cost: drawn only while the page is visible (the shell renders the visible page only, and this file checks
 * too); the pane and the cards are built once per shape, then patched: a text only when its words changed, an
 * SVG path only when its numbers did.
 */
(function () {
  'use strict';
  const { esc, fmt, store, ICON } = TM;
  const MB = 1048576, GB = 1073741824;
  const ok = (x) => typeof x === 'number' && isFinite(x);
  const arr = (a) => (Array.isArray(a) ? a : []);

  /* ---------------------------------------------------------------- remembered choices */
  const S = {
    sel: store.get('perf.sel', 'cpu'),
    cpuGraph: store.get('perf.cpuGraph', 'overall'),   // 'overall' | 'logical'
    kernel: store.get('perf.kernel', false),           // Show kernel times
    gpuGraph: store.get('perf.gpuGraph', 'multi'),     // 'multi' | 'single'
    gpuEng: store.get('perf.gpuEng', {}),              // gpu id -> the engine name in each graph slot
    gsv: store.get('perf.gsv', false),                 // Graph summary view (the graph alone)
    sumv: store.get('perf.sumv', false),               // Summary view (the device list alone)
    hideGraphs: store.get('perf.hideGraphs', false),   // the list without its sparklines
  };
  function set(k, v) { S[k] = v; store.set('perf.' + k, v); TM.refresh(); }

  /* ---------------------------------------------------------------- Windows' units */
  const size = (b) => (!ok(b) ? null : b >= GB ? (b / GB).toFixed(1) + ' GB' : Math.round(b / MB) + ' MB');
  // "used/total unit", the unit picked by the total (Windows' "14.2/22.5 GB", "0/128 MB")
  const pair = (u, t) => (!ok(u) || !ok(t) ? null : t >= GB ? `${(u / GB).toFixed(1)}/${(t / GB).toFixed(1)} GB` : `${Math.round(u / MB)}/${Math.round(t / MB)} MB`);
  // disk sizes: binary GB, whole numbers from 100 GB (Windows' "477 GB")
  const cap = (b) => { if (!ok(b)) return null; const g = b / GB; return g >= 1024 ? (g / 1024).toFixed(1) + ' TB' : g >= 100 ? Math.round(g) + ' GB' : g.toFixed(1) + ' GB'; };
  const ghz = (x) => (ok(x) ? x.toFixed(2) + ' GHz' : null);
  const cache = (kb) => (!ok(kb) ? null : kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB');
  const pct = (x) => (ok(x) ? Math.round(x) + '%' : null);
  const yesNo = (b) => (b == null ? null : b ? 'Yes' : 'No');
  const date = (s) => { const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return r ? `${+r[2]}/${+r[3]}/${r[1]}` : s || null; };
  const rate = (b) => fmt.bps(b);   // Windows' "0 KB/s", "420 KB/s", "1.2 MB/s"
  // Windows 11's disk type: "SSD (NVMe)" for an NVMe drive, else "SSD" / "HDD" (lib's disks[].bus names the bus)
  const diskType = (k) => (k.type == null ? null : k.bus === 'NVMe' ? `${k.type} (NVMe)` : String(k.type));
  // bits per second; two numbers can share one unit (Windows' card line "S: 208 R: 3.3 Mbps")
  const BITU = [[1e9, 'Gbps'], [1e6, 'Mbps'], [1e3, 'Kbps']];
  const bitUnit = (b) => BITU.find(([d]) => b >= d) || BITU[2];
  const bitNum = (b, u) => { const v = b / u[0]; return v === 0 ? '0' : v < 10 ? v.toFixed(1) : String(Math.round(v)); };
  const bits = (Bps) => { if (!ok(Bps)) return null; const b = Bps * 8, u = bitUnit(b); return `${bitNum(b, u)} ${u[1]}`; };
  // a transfer graph's top label: Windows' 1 / 5 steps, the smallest that holds the last minute
  const DISK_SCALE = [100 * 1024, 500 * 1024, MB, 5 * MB, 10 * MB, 50 * MB, 100 * MB, 500 * MB, GB, 5 * GB, 10 * GB, 50 * GB];
  const NET_SCALE = [1e5, 5e5, 1e6, 5e6, 1e7, 5e7, 1e8, 5e8, 1e9, 5e9, 1e10, 5e10, 1e11];
  const pickScale = (steps, v) => steps.find((s) => s >= v) || v;
  const diskLbl = (s) => (s >= GB ? +(s / GB).toFixed(1) + ' GB/s' : s >= MB ? +(s / MB).toFixed(1) + ' MB/s' : Math.round(s / 1024) + ' KB/s');
  const netLbl = (s) => (s >= 1e9 ? +(s / 1e9).toFixed(1) + ' Gbps' : s >= 1e6 ? +(s / 1e6).toFixed(1) + ' Mbps' : Math.round(s / 1e3) + ' Kbps');
  const maxOf = (...as) => { let x = 0; for (const a of as) for (const v of arr(a)) if (v > x) x = v; return x; };

  /* ---------------------------------------------------------------- the em dash and its reason */
  const OLD_WHY = "This Mantle's helper doesn't report it yet (it needs updating)";
  const WHY = {
    speedGHz: 'Windows did not report the current processor speed', baseGHz: 'Windows did not report the base speed',
    virtualization: 'Windows did not say whether virtualization is on', threads: 'The thread count was not read', handles: 'The handle count was not read',
    compressed: 'Windows did not report compressed memory', composition: 'Windows did not report how memory is split (in use, modified, standby, free)',
    speedMTs: 'Windows did not report the memory speed', slotsUsed: 'Windows did not report the memory slots', formFactor: 'Windows did not report the form factor',
    hardwareReserved: 'Windows did not report hardware-reserved memory', cached: 'Windows did not report cached memory',
    respMs: 'The response time was not measured', capacity: 'Windows did not report the disk size', formatted: 'Windows did not report the formatted size',
    type: 'Windows did not say whether this disk is an SSD or an HDD', model: 'Windows did not report the model',
    ssid: 'No network name (not connected to Wi-Fi, or Windows did not say)', connType: 'Windows did not report the connection type',
    ipv4: 'No IPv4 address (not connected, or Windows did not say)', ipv6: 'No IPv6 address (not connected, or Windows did not say)',
    signal: 'Windows did not report the signal strength', driverVersion: 'Windows did not report the driver version', driverDate: 'Windows did not report the driver date',
    directX: 'Windows did not report the DirectX version', location: 'Windows did not report where the device sits', reserved: 'Windows did not report hardware-reserved memory',
    dedicatedUsed: 'Windows did not report dedicated GPU memory', dedicatedTotal: 'Windows did not report dedicated GPU memory',
    sharedUsed: 'Windows did not report shared GPU memory', sharedTotal: 'Windows did not report shared GPU memory',
  };
  const why = (o, k) => (o && o.why && o.why[k]) || (o && o.old ? OLD_WHY : WHY[k] || 'Windows did not report this to Mantle');
  // a field's html: its words, or the em dash with the reason
  const V = (o, k, f) => { const x = o ? o[k] : null; const t = x == null ? null : f ? f(x) : String(x); return t == null ? TM.na(why(o, k)) : esc(t); };
  const W = (t, o, k) => (t == null ? TM.na(why(o, k)) : esc(t));

  /* ---------------------------------------------------------------- an OLD main: only the legacy cpu + mem fields */
  function legacy(mm) {
    const h = mm.hist || {};
    if (!ok(mm.cpu) && !(mm.mem && ok(mm.mem.total))) return null;
    return {
      old: true,
      cpu: { old: true, pct: ok(mm.cpu) ? mm.cpu : null, hist: arr(h.cpu), logical: ok(mm.cpus) ? mm.cpus : null },
      mem: Object.assign({ old: true, hist: arr(h.mem) }, mm.mem || {}),
    };
  }

  /* ---------------------------------------------------------------- the device list (Windows' order and words) */
  function engineHist(g) {
    if (arr(g.hist).length) return g.hist;
    const es = arr(g.engines);
    if (!es.length) return [];
    const n = Math.max(...es.map((e) => arr(e.hist).length));
    return Array.from({ length: n }, (_, i) => Math.max(...es.map((e) => { const a = arr(e.hist); const v = a[a.length - n + i]; return ok(v) ? v : 0; })));
  }
  function devices(p) {
    const d = [];
    const c = p.cpu || {}, mm = p.mem || {};
    d.push({ key: 'cpu', kind: 'cpu', o: c, title: 'CPU', lines: [`${W(pct(c.pct), c, 'pct')}${ok(c.speedGHz) ? '&ensp;' + esc(ghz(c.speedGHz)) : ''}`], spark: [{ a: c.hist, max: 100 }] });
    const mp = ok(mm.used) && ok(mm.total) && mm.total > 0 ? ` (${Math.round((mm.used / mm.total) * 100)}%)` : '';
    d.push({ key: 'mem', kind: 'mem', o: mm, title: 'Memory', lines: [ok(mm.used) && ok(mm.total) ? esc(`${(mm.used / GB).toFixed(1)}/${(mm.total / GB).toFixed(1)} GB${mp}`) : TM.na(why(mm, 'used'))], spark: [{ a: mm.hist, max: 100 }] });
    arr(p.disks).forEach((k, i) => d.push({ key: 'disk:' + (k.id || i), kind: 'disk', o: k, title: k.name || `Disk ${i}`, lines: (k.type ? [esc(diskType(k))] : []).concat(W(pct(k.activePct), k, 'activePct')), spark: [{ a: k.hist, max: 100 }] }));
    arr(p.nets).forEach((n, i) => {
      const sb = ok(n.sendBps) ? n.sendBps * 8 : null, rb = ok(n.recvBps) ? n.recvBps * 8 : null;
      let sr;
      if (n.connected === false) sr = 'Not connected';
      else if (sb == null || rb == null) sr = null;
      else { const u = bitUnit(Math.max(sb, rb)); sr = `S: ${bitNum(sb, u)} R: ${bitNum(rb, u)} ${u[1]}`; }
      const mx = Math.max(maxOf(n.sendHist, n.recvHist), 1);
      d.push({ key: 'net:' + (n.id || i), kind: 'net', o: n, title: n.kind || 'Network', lines: [esc(n.name || n.adapter || ''), W(sr, n, 'sendBps')],
        spark: [{ a: n.recvHist, max: mx }, { a: n.sendHist, max: mx, cls: 's', line: true }] });
    });
    // GPUs and NPUs are separate lists (lib splits the sidecar's reply by kind); an older reply that still mixes
    // them is split here so an NPU never shows as a GPU. "GPU n" / "NPU n" is Windows' own index when sent
    // (the same n as the Processes page's "GPU 0 - 3D"), else the position in the list.
    const gl = arr(p.gpus), npus = Array.isArray(p.npus) ? p.npus : gl.filter((g) => g && g.kind === 'npu');
    const gpus = gl.filter((g) => g && g.kind !== 'npu');
    const nth = (g, i) => (Number.isInteger(g.index) ? g.index : i);
    gpus.forEach((g, i) => d.push({ key: 'gpu:' + (g.id || i), kind: 'gpu', o: g, n: nth(g, i), title: `GPU ${nth(g, i)}`, lines: [esc(g.name || ''), W(pct(g.pct), g, 'pct')], spark: [{ a: engineHist(g), max: 100 }] }));
    npus.forEach((g, i) => d.push({ key: 'npu:' + (g.id || i), kind: 'npu', o: g, n: nth(g, i), title: `NPU ${nth(g, i)}`, lines: [esc(g.name || ''), W(pct(g.pct), g, 'pct')], spark: [{ a: engineHist(g), max: 100 }] }));
    return d;
  }
  // a list that came back empty or not at all: the reason, never a silent gap (listWhy, gpuWhy, perf.error)
  function listNotes(p) {
    const out = [];
    const lw = p.listWhy || {};
    const empty = (a) => !Array.isArray(a) || !a.length;
    if (empty(p.disks) && lw.disks) out.push(['Disks', lw.disks]);
    if (empty(p.nets) && lw.nets) out.push(['Network adapters', lw.nets]);
    const gw = p.gpuWhy, gws = typeof gw === 'string' ? gw : gw && typeof gw === 'object' ? gw.gpus || gw['totals.gpu'] || gw.gpu : null;
    if (empty(p.gpus) && empty(p.npus) && typeof gws === 'string' && gws) out.push(['GPU', gws]);
    let h = out.map(([what, w]) => `<span class="pf-wl">${esc(what)}: ${TM.na(w)} <span class="pf-ww">${esc(w)}</span></span>`).join('');
    if (p.error) h += TM.warnLine('pf-oldl', String(p.error));
    return h;
  }
  /* ---------------------------------------------------------------- each device's pane: what it shows
     spec = { sig, head: [title html, model html], groups: [{ cls, cols?, cap?: [l, r], G: [graph] }],
       comp?: memory composition (null = not reported), big: [[[label, html, swatch?]]] (Windows' big numbers),
       kv: [[key, html]] (Windows' "key: value" block) }
     graph = { id, l, r (the caption over it, html), b (the "60 seconds" / "0" line under it), title,
       series: [{ id, a (60 numbers, oldest first), max (the top of the graph), cls 'm'|'k'|'s', fill }] } */
  const G1 = (id, l, r, series, b) => ({ id, l, r, series, b: b !== false });
  const quiet = (words, tip) => ` <span class="pp-q" title="${esc(tip)}">(${esc(words)})</span>`;
  const coreCols = (n) => (n <= 4 ? n : n <= 16 ? 4 : Math.ceil(Math.sqrt(n)));
  // a memory graph's top: its numbers are percent of the total (or bytes, when any is over 100)
  const memMax = (a, total) => (maxOf(a) > 100 && ok(total) && total > 0 ? total : 100);
  WHY.kernelHist = 'Windows did not report kernel time';

  function cpuSpec(c) {
    const cores = arr(c.perCore), n = cores.length, kc = arr(c.perCoreKernel), k = !!S.kernel;
    const logical = S.cpuGraph === 'logical' && n > 0;
    let groups;
    if (logical) {
      const kNote = k && kc.length !== n ? quiet('kernel times: whole CPU only', c.old ? OLD_WHY : 'Mantle reads kernel time for the whole CPU, not for each logical processor') : '';
      groups = [{ cls: 'cores', cols: coreCols(n), cap: ['% Utilization over 60 seconds' + kNote, '100%'],
        G: cores.map((a, i) => ({ id: 'c' + i, title: `CPU ${i}`, series: [{ id: 'm', a, max: 100, fill: true }].concat(k && kc.length === n ? [{ id: 'k', a: kc[i], max: 100, cls: 'k', fill: true }] : []) })) }];
    } else {
      const lNote = S.cpuGraph === 'logical' ? quiet('logical processors not reported', c.old ? OLD_WHY : 'Windows did not report each logical processor') : '';
      // kernelHist is null-padded: no number in it at all = not reported (a note, never a drawn zero line)
      const hasK = arr(c.kernelHist).some(ok);
      const kNote = k && !hasK ? quiet('kernel times not reported', (c.why && c.why.kernelPct) || why(c, 'kernelHist')) : '';
      groups = [{ cls: 'one', G: [G1('u', '% Utilization' + lNote + kNote, '100%', [{ id: 'm', a: c.hist, max: 100, fill: true }].concat(k && hasK ? [{ id: 'k', a: c.kernelHist, max: 100, cls: 'k', fill: true }] : []))] }];
    }
    return {
      sig: `cpu|${logical ? 'L' + n : 'O'}|${k}`, head: ['CPU', V(c, 'name')], groups,
      big: [[['Utilization', V(c, 'pct', pct)], ['Speed', V(c, 'speedGHz', ghz)]],
        [['Processes', V(c, 'procs')], ['Threads', V(c, 'threads')], ['Handles', V(c, 'handles')]],
        [['Up time', V(c, 'uptimeSec', fmt.uptime)]]],
      kv: [['Base speed:', V(c, 'baseGHz', ghz)], ['Sockets:', V(c, 'sockets')], ['Cores:', V(c, 'cores')], ['Logical processors:', V(c, 'logical')],
        ['Virtualization:', V(c, 'virtualization')], ['L1 cache:', V(c, 'l1KB', cache)], ['L2 cache:', V(c, 'l2KB', cache)], ['L3 cache:', V(c, 'l3KB', cache)]],
    };
  }

  function memSpec(mm) {
    const total = W(size(mm.total), mm, 'total');
    const slots = ok(mm.slotsUsed) && ok(mm.slotsTotal) ? esc(`${mm.slotsUsed} of ${mm.slotsTotal}`) : TM.na(why(mm, 'slotsUsed'));
    return {
      sig: 'mem', head: ['Memory', total],
      groups: [{ cls: 'one', G: [G1('u', 'Memory usage', total, [{ id: 'm', a: mm.hist, max: memMax(mm.hist, mm.total), fill: true }])] }],
      comp: mm.composition || null, compWhy: why(mm, 'composition'),
      big: [[['In use (Compressed)', `${W(size(mm.used), mm, 'used')} (${V(mm, 'compressed', size)})`], ['Available', V(mm, 'avail', size)]],
        [['Committed', W(pair(mm.committed, mm.commitLimit), mm, 'committed')], ['Cached', V(mm, 'cached', size)]],
        [['Paged pool', V(mm, 'pagedPool', size)], ['Non-paged pool', V(mm, 'nonPagedPool', size)]]],
      kv: [['Speed:', V(mm, 'speedMTs', (x) => `${x} MT/s`)], ['Slots used:', slots], ['Form factor:', V(mm, 'formFactor')], ['Hardware reserved:', V(mm, 'hardwareReserved', size)]],
    };
  }

  function diskSpec(k) {
    const sc = pickScale(DISK_SCALE, maxOf(k.readHist, k.writeHist));
    return {
      sig: 'disk', head: [esc(k.name || 'Disk'), V(k, 'model')],
      groups: [{ cls: 'one', G: [G1('a', 'Active time', '100%', [{ id: 'm', a: k.hist, max: 100, fill: true }])] },
        { cls: 'one mid', G: [G1('t', 'Disk transfer rate', esc(diskLbl(sc)), [{ id: 'r', a: k.readHist, max: sc, fill: true }, { id: 'w', a: k.writeHist, max: sc, cls: 's' }])] }],
      big: [[['Active time', V(k, 'activePct', pct)], ['Average response time', V(k, 'respMs', (x) => x.toFixed(1) + ' ms')]],
        [['Read speed', V(k, 'readBps', rate), 'm'], ['Write speed', V(k, 'writeBps', rate), 's']]],
      kv: [['Capacity:', V(k, 'capacity', cap)], ['Formatted:', V(k, 'formatted', cap)], ['System disk:', V(k, 'systemDisk', yesNo)], ['Page file:', V(k, 'pageFile', yesNo)], ['Type:', W(diskType(k), k, 'type')]],
    };
  }

  function signal(n) {
    const s = n.signal;
    if (!ok(s)) return TM.na(why(n, 'signal'));
    // lib sends Windows' signal quality in percent (0..100); Windows draws it as 4 bars, a bar per quarter
    const q = Math.max(0, Math.min(100, s));
    const b = q <= 0 ? 0 : Math.min(4, Math.ceil(q / 25));
    const words = `${b} of 4 bars (${Math.round(q)}%)`;
    return `<span class="pp-sig" title="Signal strength: ${esc(words)}"><svg viewBox="0 0 17 12" width="17" height="12" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<rect x="${i * 4.5}" y="${9 - i * 3}" width="3" height="${3 + i * 3}" rx=".6"${i < b ? ' class="on"' : ''}/>`).join('')}</svg><span class="pp-vh">${esc(words)}</span></span>`;
  }
  function netSpec(n) {
    // sendHist / recvHist are BITS per second (lib), so the scale and the graphs are in bits as Windows draws them;
    // sendBps / recvBps (the Send / Receive numbers) are BYTES per second and bits() converts them
    const sc = pickScale(NET_SCALE, maxOf(n.sendHist, n.recvHist));
    const wifi = /wi-?fi|wireless|802\.11/i.test(n.kind || '');
    const kv = [['Adapter name:', V(n, 'name')]];
    if (wifi) kv.push(['SSID:', V(n, 'ssid')]);
    kv.push(['Connection type:', V(n, 'connType')], ['IPv4 address:', V(n, 'ipv4')], ['IPv6 address:', V(n, 'ipv6')]);
    if (wifi) kv.push(['Signal strength:', signal(n)]);
    return {
      sig: 'net|' + wifi, head: [esc(n.kind || 'Network'), V(n, 'adapter')],
      groups: [{ cls: 'one', G: [G1('t', 'Throughput' + (n.connected === false ? quiet('not connected', 'Windows says this adapter is not connected') : ''), esc(netLbl(sc)),
        [{ id: 'r', a: n.recvHist, max: sc, fill: true }, { id: 's', a: n.sendHist, max: sc, cls: 's' }])] }],
      big: [[['Send', V(n, 'sendBps', bits), 's'], ['Receive', V(n, 'recvBps', bits), 'm']]], kv,
    };
  }

  function gpuSpec(g) {
    const es = arr(g.engines), gid = g.id || 'gpu';
    const single = S.gpuGraph === 'single', slots = es.length ? (single ? 1 : Math.min(4, es.length)) : 0;
    const pick = arr(S.gpuEng[gid]);
    const G = [];
    for (let i = 0; i < slots; i++) {
      const e = es.find((x) => x.name === pick[i]) || es[i];
      G.push(G1('e' + i, `<button type="button" class="pg-pick" data-slot="${i}" aria-haspopup="menu" title="Choose the engine this graph shows">${esc(e.name)}${ICON.down}</button>`, W(pct(e.pct), e, 'pct'), [{ id: 'm', a: e.hist, max: 100, fill: true }], false));
    }
    if (!slots) G.push(G1('e0', '% Utilization' + quiet('engines not reported', why(g, 'engines')), '100%', [{ id: 'm', a: [], max: 100, fill: true }], false));
    const all = [g.dedicatedUsed, g.sharedUsed, g.dedicatedTotal, g.sharedTotal].every(ok) ? pair(g.dedicatedUsed + g.sharedUsed, g.dedicatedTotal + g.sharedTotal) : null;
    return {
      sig: `gpu|${slots}`, head: ['GPU', V(g, 'name')],
      groups: [{ cls: slots > 1 ? 'quad' : 'one', G },
        { cls: 'thin', G: [G1('d', 'Dedicated GPU memory usage', V(g, 'dedicatedTotal', size), [{ id: 'm', a: g.dedHist, max: memMax(g.dedHist, g.dedicatedTotal), fill: true }], false)] },
        { cls: 'thin', G: [G1('s', 'Shared GPU memory usage', V(g, 'sharedTotal', size), [{ id: 'm', a: g.sharedHist, max: memMax(g.sharedHist, g.sharedTotal), fill: true }], false)] }],
      big: [[['Utilization', V(g, 'pct', pct)], ['Dedicated GPU memory', W(pair(g.dedicatedUsed, g.dedicatedTotal), g, 'dedicatedUsed')]],
        [['GPU Memory', W(all, g, 'sharedUsed')], ['Shared GPU memory', W(pair(g.sharedUsed, g.sharedTotal), g, 'sharedUsed')]]],
      kv: [['Driver version:', V(g, 'driverVersion')], ['Driver date:', V(g, 'driverDate', date)], ['DirectX version:', V(g, 'directX')],
        ['Physical location:', V(g, 'location')], ['Hardware reserved memory:', V(g, 'reserved', size)]],
    };
  }

  function npuSpec(g) {
    const groups = [{ cls: 'one', G: [G1('u', '% Utilization', '100%', [{ id: 'm', a: g.hist, max: 100, fill: true }])] }];
    if (g.sharedHist) groups.push({ cls: 'thin', G: [G1('s', 'Shared memory usage', V(g, 'sharedTotal', size), [{ id: 'm', a: g.sharedHist, max: memMax(g.sharedHist, g.sharedTotal), fill: true }], false)] });
    return {
      sig: 'npu|' + groups.length, head: ['NPU', V(g, 'name')], groups,
      big: [[['Utilization', V(g, 'pct', pct)], ['Shared memory', W(pair(g.sharedUsed, g.sharedTotal), g, 'sharedUsed')]]],
      kv: [['Driver version:', V(g, 'driverVersion')], ['Driver date:', V(g, 'driverDate', date)], ['Physical location:', V(g, 'location')]],
    };
  }
  const SPEC = { cpu: cpuSpec, mem: memSpec, disk: diskSpec, net: netSpec, gpu: gpuSpec, npu: npuSpec };
  /* ---------------------------------------------------------------- drawing: built once per shape, then patched */
  let root = null, listEl = null, paneEl = null, stateEl = null, oldEl = null, whyEl = null, wrapEl = null;
  let m = {}, visible = false, devs = [], dev = null, sp = null;
  const P = { shape: null, t: new Map(), p: [], comp: null };      // the built pane
  const C = { shape: null, cards: new Map() };                       // the built list
  const stat = window.__tmPerfStat = { draws: 0, paths: 0 };         // for the page test: draws while visible, paths redrawn

  // a 60-second series on a 0..60 x 0..100 box (stretched to the graph), newest at the right edge
  function pathD(a, max) {
    const n = Math.min(a.length, 60);
    if (!n || !(max > 0)) return ['', ''];
    const k = 60 / 59, x0 = 60 - (n - 1) * k;
    let d = '';
    for (let i = 0; i < n; i++) {
      const v = a[a.length - n + i];
      const y = 100 - Math.max(0, Math.min(100, ((ok(v) ? v : 0) / max) * 100));
      d += (i ? 'L' : 'M') + (x0 + i * k).toFixed(2) + ' ' + y.toFixed(2);
    }
    return [d, `${d}L60 100L${x0.toFixed(2)} 100Z`];
  }
  const same = (x, a) => { if (!x || x.length !== a.length) return false; for (let i = 0; i < a.length; i++) if (x[i] !== a[i]) return false; return true; };
  function patchSeries(rec, a, max) {
    a = arr(a);
    if (!rec || (rec.max === max && same(rec.last, a))) return;
    rec.last = a.slice(); rec.max = max;
    const [line, area] = pathD(a, max);
    rec.l.setAttribute('d', line);
    if (rec.a) rec.a.setAttribute('d', area);
    stat.paths++;
  }
  // every area first, then every line (the kernel shade under the total line)
  const seriesSvg = (ss) => '<svg viewBox="0 0 60 100" preserveAspectRatio="none" aria-hidden="true">' +
    ss.map((s) => (s.fill ? `<path class="a ${s.cls || 'm'}" data-s="${s.id}a"/>` : '')).join('') +
    ss.map((s) => `<path class="l ${s.cls || 'm'}" data-s="${s.id}l" vector-effect="non-scaling-stroke"/>`).join('') + '</svg>';
  const swatch = (cls) => `<svg class="pp-sw" viewBox="0 0 14 6" width="14" height="6" aria-hidden="true"><path class="l ${cls}" d="M0 3h14"/></svg>`;
  const graphHtml = (g) => `<div class="pg-g" data-g="${g.id}">` +
    (g.l != null ? `<div class="pg-gl"><span class="pg-l" data-t="${g.id}.l"></span><span class="pg-r" data-t="${g.id}.r"></span></div>` : '') +
    `<div class="pg-box"${g.title ? ` title="${esc(g.title)}"` : ''}>${seriesSvg(g.series)}</div>` +
    (g.b ? '<div class="pg-gl pg-gb"><span>60 seconds</span><span>0</span></div>' : '') + '</div>';
  const shape = (s) => [s.sig, s.groups.map((g) => g.cls + (g.cap ? '^' : '') + ':' + g.G.map((x) => x.id + (x.l != null ? '+' : '') + (x.b ? '_' : '') + x.series.map((y) => y.id + (y.cls || '') + (y.fill ? 'f' : '')).join('')).join(',')).join(';'),
    s.comp !== undefined, s.big.map((r) => r.map((c) => c[0] + (c[2] || '')).join(',')).join(';'), s.kv.map((x) => x[0]).join(',')].join('|');

  function buildPane(s, shp) {
    let h = '<div class="pp-head"><h2 class="pp-title" data-t="title"></h2><span class="pp-model" data-t="right"></span></div><div class="pp-graphs">';
    s.groups.forEach((g, gi) => {
      h += `<div class="pp-grp ${g.cls}">`;
      if (g.cap) h += `<div class="pg-gl"><span class="pg-l" data-t="cap${gi}.l"></span><span class="pg-r" data-t="cap${gi}.r"></span></div><div class="pp-cores" data-cols="${g.cols}">`;
      h += g.G.map(graphHtml).join('');
      if (g.cap) h += '</div>';
      h += '</div>';
    });
    h += '</div>';
    if (s.comp !== undefined) h += '<div class="pp-compw"><div class="pg-gl"><span>Memory composition</span></div><div class="pp-comp"><i class="seg u"></i><i class="seg mo"></i><i class="seg sb"></i><i class="seg fr"></i><span class="pp-compna" data-t="compna"></span></div></div>';
    h += '<div class="pp-stats"><div class="pp-big">' + s.big.map((r, i) => `<div class="pp-row">${r.map((c, j) => `<div class="pp-c"><span class="pp-cl">${c[2] ? swatch(c[2]) : ''}${esc(c[0])}</span><span class="pp-cv" data-t="b${i}.${j}"></span></div>`).join('')}</div>`).join('') + '</div>' +
      `<dl class="pp-kv">${s.kv.map((x, i) => `<div class="pp-kr"><dt>${esc(x[0])}</dt><dd data-t="k${i}"></dd></div>`).join('')}</dl></div>`;
    paneEl.innerHTML = h;
    P.t = new Map();
    for (const el of paneEl.querySelectorAll('[data-t]')) P.t.set(el.dataset.t, el);
    P.p = [];
    for (const g of s.groups) for (const x of g.G) {
      const box = paneEl.querySelector(`[data-g="${x.id}"]`);
      for (const y of x.series) P.p.push({ l: box.querySelector(`[data-s="${y.id}l"]`), a: box.querySelector(`[data-s="${y.id}a"]`), last: null, max: null });
    }
    for (const el of paneEl.querySelectorAll('.pp-cores')) el.style.gridTemplateColumns = `repeat(${el.dataset.cols}, minmax(0, 1fr))`;
    P.comp = s.comp !== undefined ? Array.from(paneEl.querySelectorAll('.pp-comp .seg')) : null;
    P.shape = shp;
  }
  const COMP = [
    ['inUse', 'In use', 'Memory used by processes, drivers, or the operating system'],
    ['modified', 'Modified', 'Memory whose contents must be written to disk before it can be used for another purpose'],
    ['standby', 'Standby', 'Memory that contains cached data and code that is not actively in use'],
    ['free', 'Free', 'Memory that is not currently in use, and that will be repurposed first when processes, drivers, or the operating system need more memory'],
  ];
  function patchComp(c, w) {
    const tot = c ? COMP.reduce((s, [k]) => s + (ok(c[k]) ? c[k] : 0), 0) : 0;
    const has = tot > 0;
    P.comp.forEach((el, i) => {
      const [k, name, words] = COMP[i];
      const v = has && ok(c[k]) ? c[k] : 0;
      const wd = has ? ((v / tot) * 100).toFixed(2) + '%' : '0%';
      if (el._w !== wd) { el.style.width = wd; el._w = wd; }
      const tip = has ? `${name} (${size(v)})\n${words}` : '';
      if (el._tip !== tip) { el.title = tip; el._tip = tip; }
      if (el.hidden === has) el.hidden = !has;
    });
    TM.setHtml(P.t.get('compna'), has ? '' : TM.na(w));
  }
  function patchPane(s) {
    const put = (k, h) => { const el = P.t.get(k); if (el) TM.setHtml(el, h == null ? '' : h); };
    put('title', s.head[0]); put('right', s.head[1]);
    let pi = 0;
    s.groups.forEach((g, gi) => {
      if (g.cap) { put(`cap${gi}.l`, g.cap[0]); put(`cap${gi}.r`, g.cap[1]); }
      for (const x of g.G) {
        if (x.l != null) { put(x.id + '.l', x.l); put(x.id + '.r', x.r); }
        for (const y of x.series) patchSeries(P.p[pi++], y.a, y.max);
      }
    });
    s.big.forEach((r, i) => r.forEach((c, j) => put(`b${i}.${j}`, c[1])));
    s.kv.forEach((x, i) => put('k' + i, x[1]));
    if (P.comp) patchComp(s.comp, s.compWhy);
  }

  function buildCards(ds) {
    listEl.innerHTML = ds.map((d, i) => `<div class="pc" role="option" id="pc-${i}" data-k="${esc(d.key)}" tabindex="-1" aria-selected="false">` +
      `<div class="pc-sp" aria-hidden="true">${seriesSvg(d.spark.map((s, j) => ({ id: 'p' + j, cls: s.cls, fill: !s.line })))}</div>` +
      `<div class="pc-tx"><span class="pc-t">${esc(d.title)}</span>${d.lines.map(() => '<span class="pc-l"></span>').join('')}</div></div>`).join('');
    C.cards = new Map();
    listEl.querySelectorAll('.pc').forEach((el, i) => {
      const d = ds[i];
      C.cards.set(d.key, { el, lines: Array.from(el.querySelectorAll('.pc-l')), s: d.spark.map((_, j) => ({ l: el.querySelector(`[data-s="p${j}l"]`), a: el.querySelector(`[data-s="p${j}a"]`), last: null, max: null })) });
    });
  }
  function patchCards(ds) {
    const shp = ds.map((d) => `${d.key}:${d.title}:${d.lines.length}:${d.spark.map((s) => s.cls || 'm').join('')}`).join('|');
    if (shp !== C.shape) { buildCards(ds); C.shape = shp; }
    for (const d of ds) {
      const c = C.cards.get(d.key);
      d.lines.forEach((h, j) => TM.setHtml(c.lines[j], h));
      if (!S.hideGraphs) d.spark.forEach((s, j) => patchSeries(c.s[j], s.a, s.max));
      const on = d === dev;
      if (c.on !== on) { c.on = on; c.el.setAttribute('aria-selected', String(on)); c.el.tabIndex = on ? 0 : -1; }
    }
  }

  function frame() {
    const app = document.getElementById('app');
    app.classList.toggle('perf-gsv', !!S.gsv);
    app.classList.toggle('perf-sumv', !!S.sumv && !S.gsv);
    root.classList.toggle('gsv', !!S.gsv);
    root.classList.toggle('sumv', !!S.sumv && !S.gsv);
    root.classList.toggle('nographs', !!S.hideGraphs);
  }
  function draw() {
    if (!root || !visible || TM.view !== 'performance') return;
    stat.draws++;
    frame();
    const p = m.perf || legacy(m);
    if (!p) {
      TM.setHtml(stateEl, m.error ? TM.stateHtml('error', m.error) : TM.stateHtml('loading', 'Reading the performance counters...'));
      stateEl.hidden = false; wrapEl.hidden = true; sp = null;
      return;
    }
    stateEl.hidden = true; wrapEl.hidden = false;
    devs = devices(p);
    dev = devs.find((d) => d.key === S.sel) || devs[0];
    patchCards(devs);
    oldEl.hidden = !p.old;
    if (p.old) TM.setHtml(oldEl, TM.warnLine('pf-oldl', "Disks, network and GPU: this Mantle's helper doesn't report them yet (it needs updating)."));
    const notes = p.old ? '' : listNotes(p);
    whyEl.hidden = !notes;
    TM.setHtml(whyEl, notes);
    sp = SPEC[dev.kind](dev.o);
    const shp = shape(sp);
    if (shp !== P.shape) buildPane(sp, shp);
    patchPane(sp);
  }
  function select(key, focus) {
    if (S.sel !== key) { S.sel = key; store.set('perf.sel', key); }
    draw();
    const c = focus && dev && C.cards.get(dev.key);
    if (c) c.el.focus({ preventScroll: false });
  }

  /* ---------------------------------------------------------------- menus */
  const viewSub = () => devs.map((d) => ({ label: d.title, radio: true, checked: !!dev && d.key === dev.key, act: () => select(d.key) }));
  function graphMenu() {
    const items = [];
    if (dev && dev.kind === 'cpu') {
      items.push({ label: 'Change graph to', sub: () => [
        { label: 'Overall utilization', radio: true, checked: S.cpuGraph !== 'logical', act: () => set('cpuGraph', 'overall') },
        { label: 'Logical processors', radio: true, checked: S.cpuGraph === 'logical', act: () => set('cpuGraph', 'logical') }] },
      { label: 'Show kernel times', checked: !!S.kernel, act: () => set('kernel', !S.kernel) }, { sep: true });
    }
    if (dev && dev.kind === 'gpu') {
      items.push({ label: 'Change graph to', sub: () => [
        { label: 'Single engine', radio: true, checked: S.gpuGraph === 'single', act: () => set('gpuGraph', 'single') },
        { label: 'Multiple engines', radio: true, checked: S.gpuGraph !== 'single', act: () => set('gpuGraph', 'multi') }] }, { sep: true });
    }
    items.push({ label: 'Graph summary view', checked: !!S.gsv, act: () => set('gsv', !S.gsv) }, { label: 'View', sub: viewSub }, { sep: true }, { label: 'Copy', key: 'Ctrl+C', act: copy });
    return items;
  }
  const listMenu = () => [
    { label: 'Hide graphs', checked: !!S.hideGraphs, act: () => set('hideGraphs', !S.hideGraphs) },
    { label: 'Summary view', checked: !!S.sumv, act: () => set('sumv', !S.sumv) }, { sep: true },
    { label: 'Copy', key: 'Ctrl+C', act: copy }];
  function enginePick(b) {
    const g = dev && dev.kind === 'gpu' ? dev.o : null;
    if (!g) return;
    const es = arr(g.engines), gid = g.id || 'gpu', slot = Number(b.dataset.slot), now = b.textContent.trim();
    TM.menu.open(es.map((e) => ({ label: e.name, radio: true, checked: e.name === now, act: () => {
      const a = arr(S.gpuEng[gid]).slice();
      for (let i = 0; i < Math.min(4, es.length); i++) if (!a[i]) a[i] = es[i].name;
      a[slot] = e.name;
      set('gpuEng', Object.assign({}, S.gpuEng, { [gid]: a }));
    } })), b, { anchor: b });
  }
  const menuAt = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + 24, y: r.top + Math.min(r.height, 40) }; };

  /* ---------------------------------------------------------------- Copy (Windows' text summary of the device shown) */
  const tmp = document.createElement('div');
  const txt = (h) => { tmp.innerHTML = h == null ? '' : h; return tmp.textContent.replace(/\s+/g, ' ').trim(); };
  function copyText() {
    if (!sp) return '';
    const L = [txt(sp.head[0]), '', '\t' + txt(sp.head[1]), ''];
    for (const [k, v] of sp.kv) L.push(`\t${k}\t${txt(v)}`);
    L.push('');
    for (const r of sp.big) for (const c of r) L.push(`\t${c[0]}\t${txt(c[1])}`);
    return L.join('\r\n') + '\r\n';
  }
  let copyNoted = false;
  async function copy() {
    const text = copyText();
    if (!text) { copyNoted = true; TM.note('Nothing was copied: the performance numbers have not arrived yet.'); return; }
    let reason = null;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('this window has no clipboard access');
      await navigator.clipboard.writeText(text);
    } catch (e) {
      reason = String((e && e.message) || e || 'the clipboard refused it');
      const back = document.activeElement;
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'pf-clip';
        document.body.appendChild(ta); ta.select();
        const did = document.execCommand('copy');
        ta.remove();
        if (did) reason = null;
      } catch (_) { /* keeps the first reason */ }
      if (back && back.focus) back.focus({ preventScroll: true });
    }
    if (reason) { copyNoted = true; TM.note(`Copy did not work (${reason.replace(/\.$/, '')}). Nothing was copied.`); }
    else if (copyNoted) { copyNoted = false; TM.note(null); }
  }
  async function resmon() { TM.say(await TM.run('openResmon', {}), 'Resource Monitor did not open'); }

  /* ---------------------------------------------------------------- the page */
  TM.page({
    id: 'performance', search: false,
    init(el) {
      root = el;
      root.innerHTML = '<div class="pf-state" hidden></div><div class="pf"><div class="pf-side">' +
        '<div class="pf-list" role="listbox" tabindex="-1" aria-label="Devices. Up and down to choose, the menu key for options."></div><div class="pf-old" hidden></div><div class="pf-why" hidden></div></div>' +
        '<div class="pf-pane" tabindex="0" aria-label="The chosen device. The menu key for options; double-click the graph for the graph summary view."></div></div>';
      stateEl = root.querySelector('.pf-state'); wrapEl = root.querySelector('.pf'); listEl = root.querySelector('.pf-list');
      oldEl = root.querySelector('.pf-old'); whyEl = root.querySelector('.pf-why'); paneEl = root.querySelector('.pf-pane');
      listEl.addEventListener('click', (e) => { const c = e.target.closest('.pc'); if (c) select(c.dataset.k, true); });
      listEl.addEventListener('dblclick', (e) => { if (e.target.closest('.pc')) set('sumv', !S.sumv); });
      listEl.addEventListener('contextmenu', (e) => { e.preventDefault(); const c = e.target.closest('.pc'); if (c) select(c.dataset.k, true); TM.menu.open(listMenu, { x: e.clientX, y: e.clientY }); });
      listEl.addEventListener('keydown', (e) => {
        if (!dev) return;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); TM.menu.open(listMenu, menuAt(C.cards.get(dev.key).el)); return; }
        const i = devs.indexOf(dev);
        const j = { ArrowDown: Math.min(devs.length - 1, i + 1), ArrowUp: Math.max(0, i - 1), Home: 0, End: devs.length - 1 }[e.key];
        if (j === undefined || e.altKey || e.ctrlKey) return;
        e.preventDefault();
        select(devs[j].key, true);
      });
      paneEl.addEventListener('contextmenu', (e) => { e.preventDefault(); TM.menu.open(graphMenu, { x: e.clientX, y: e.clientY }); });
      paneEl.addEventListener('dblclick', (e) => { if (e.target.closest('.pp-graphs') && !e.target.closest('.pg-pick')) set('gsv', !S.gsv); });
      paneEl.addEventListener('click', (e) => { const b = e.target.closest('.pg-pick'); if (b) enginePick(b); });
      paneEl.addEventListener('keydown', (e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); TM.menu.open(graphMenu, menuAt(paneEl.querySelector('.pp-graphs') || paneEl)); } });
      // the page's own keys: Ctrl+C copies (Windows), Esc leaves the summary views (the header is hidden in them)
      document.addEventListener('keydown', (e) => {
        if (TM.view !== 'performance' || !visible || TM.menu.isOpen() || !document.getElementById('dlg').hidden) return;
        if (e.key === 'Escape' && (S.gsv || S.sumv)) { e.preventDefault(); set(S.gsv ? 'gsv' : 'sumv', false); return; }
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C') && !/INPUT|TEXTAREA|SELECT/.test(tag) && !String(window.getSelection() || '')) { e.preventDefault(); copy(); }
      });
    },
    show() { visible = true; },
    hide() { visible = false; },
    render(mm) { m = mm || {}; visible = true; draw(); },
    commands() {
      return [
        { id: 'resmon', label: 'Open Resource Monitor', more: true, act: resmon },
        { id: 'copy', label: 'Copy', more: true, key: 'Ctrl+C', act: copy },
        { id: 'gsv', label: 'Graph summary view', more: true, checked: !!S.gsv, act: () => set('gsv', !S.gsv) },
      ];
    },
    focus() { const c = dev && C.cards.get(dev.key); if (c) c.el.focus(); else if (paneEl) paneEl.focus(); },
  });
}());
