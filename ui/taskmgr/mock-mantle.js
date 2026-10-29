/* mock-mantle.js - plays main for the task manager page when it is opened over file:// without Electron
 * (headless shots: shoot.js; page tests: testkit.js). The real preload.js defines window.mantle first, so
 * under Electron this file does nothing. EVERY app, number, user and state here is MADE UP.
 * It sends EXACTLY lib/features/taskmgr.js's model (field names, nesting, units) and its command replies:
 * no field lib does not send (mantle-wt/TM-SPEC.md "As built"). Units: bytes, bytes/s (disk, net), percent
 * 0..100, seconds (cpuTimeSec, uptimeSec), ms (cpuMs, at), ISO dates (since, disabledAt, lastRun, readAt,
 * driverDate YYYY-MM-DD), "0x" hex affinity masks; nets[].sendHist/recvHist are BITS/s.
 *
 * Query:
 *   mock=apps (default) | expanded | game | protected | failed | hung | search | loading | error | nobridge
 *   view=<page id>          the page main opens on (processes, performance, apphistory, startup, users,
 *                           details, services, game, settings)
 *   nulls=1                 every nullable field is null, with lib's why.<field> reason where lib sends one
 *   fail=a,b                those commands answer { ok:false, reason }
 *   admin=a,b               those commands answer { ok:false, needsAdmin:true, setup?, reason }
 *   missing=a,b             those commands do not exist (the bridge rejects 'no command "taskmgr.x"')
 *   old=1                   an OLD main: 'view' answers 'apps' for every page but game, and the model has
 *                           none of the new page data (perf, startup, users, details, services, apphistory)
 *   test=1                  model.test (a test Mantle: every action is a dry run)
 *   elev=none|stale|ok      model.elevated (default none: not set up)
 *   ah=srum|empty           App history's source (default mantle: Mantle's own record) / no rows
 *   users=1                 only the one (current) user
 *   glass=active|inactive|dark   the stand-in for Windows' acrylic under the page
 *   paused=1                settings.updateSpeed 'paused'
 * needsConfirm (lib's flat shape { ok:false, needsConfirm:true, title, text, check|null, button|null } + reason, kind,
 *   confirm, needsAdmin, dryRun; checked BEFORE dryRun): endPid / priority / affinity / uacVirt / dump on a critical
 *   pid (4, 412, 640, 720, 860, 880) (efficiency there is refused outright: unavailable, as Windows greys it), act
 *   close/force on a Windows-processes row, act force without confirmed, service stop/restart of a critical service,
 *   userDisconnect / userSignOff. Each answers until it comes again with confirmed:true.
 * When the page has settled, <html data-shot="1">. window.__mockCalls lists every call made.
 * window.__mock = { S (the mutable state), model(), push() } for tests that need a state no query gives.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  const q = new URLSearchParams(location.search);
  const mode = q.get('mock') || 'apps';
  const list = (k) => (q.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const NULLS = q.get('nulls') === '1', OLD = q.get('old') === '1', TEST = q.get('test') === '1';
  const FAIL = new Set(list('fail')), ADMIN = new Set(list('admin')), MISSING = new Set(list('missing'));
  /* The window's glass is Windows' acrylic, which no page can draw. The mock stands in for it: a soft
     blurred-wallpaper wash (active), Windows' light solid fallback (inactive), or the dark frame. Shots only. */
  const glass = q.get('glass') || 'active';
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const GLASS_BG = { active: 'linear-gradient(125deg, #c9d6ea 0%, #e6dcef 38%, #f1e3d6 62%, #cfe3dc 100%)', inactive: '#EEEEEE', dark: '#202020' };
  const DARK_BG = 'linear-gradient(125deg, #1d2430 0%, #2a2333 40%, #31291f 65%, #1c2a26 100%)';
  const paintGlass = () => { document.documentElement.style.background = dark() && glass !== 'inactive' ? DARK_BG : (GLASS_BG[glass] || GLASS_BG.active); };
  paintGlass();
  window.addEventListener('mantle-theme', paintGlass);
  document.addEventListener('DOMContentLoaded', paintGlass);
  const MANTLE_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="8" fill="#72ADCA"/></svg>');
  if (mode === 'nobridge') return;
  const MB = 1048576, GB = 1073741824;
  const nn = (v) => (NULLS ? null : v);
  const wave = (n, base, amp, per, step) => Array.from({ length: n }, (_, i) => Math.max(0, Math.round((base + amp * Math.sin(i / per) + ((i * 7) % 5) * (step || 1)) * 10) / 10));
  /* lib's own reasons (lib/features/_taskmgr-model.js), so an em dash's tooltip reads as it will in Mantle */
  const NET_WHY = "per-app network use needs Windows' event tracing as administrator. Set up administrator access to see it (Windows asks once)";
  const POWER_WHY = "Windows' power estimate comes from its energy estimation engine, which apps cannot read";
  const created = (pid) => String(133730000000000000 + pid * 1000);   // a FILETIME decimal string, as the sidecar sends
  const whyOf = (o) => ({ net: o.net === null ? NET_WHY : null, power: o.power === null ? POWER_WHY : null,
    disk: o.disk === null ? 'the first sample has no rate yet' : null, gpu: o.gpu === null ? 'GPU use is read on the Processes and Performance pages' : null });

  /* ---------------------------------------------------------------- Processes rows (lib's rowOf + rowExtras + iconRef) */
  let n = 0;
  const PUB = { 'chrome.exe': 'Google LLC', 'Discord.exe': 'Discord Inc.', 'Code.exe': 'Microsoft Corporation', 'steam.exe': 'Valve Corporation', 'Notepad.exe': 'Microsoft Corporation', 'Spotify.exe': 'Spotify AB', 'Lively.exe': 'rocksdanister', 'OneDrive.exe': 'Microsoft Corporation', 'lghub.exe': 'Logitech, Inc.', 'vgtray.exe': 'Riot Games, Inc.', 'dwm.exe': 'Microsoft Corporation', 'explorer.exe': 'Microsoft Corporation', 'svchost.exe': 'Microsoft Corporation', 'electron.exe': 'Mantle' };
  const grp = (name, file, mem, cpu, o) => {
    n++;
    const x = o || {};
    const pid = 1000 + n * 40;
    const count = x.count || 1;
    const kind = x.kind || 'app';
    const path = x.path !== undefined ? x.path : `C:\\Program Files\\Made Up\\${file}`;
    const disk = nn(cpu > 3 ? 1.6 * MB : cpu > 0.5 ? 0.12 * MB : 0);
    const net = nn(file === 'chrome.exe' ? 410000 : file === 'Discord.exe' ? 24000 : file === 'steam.exe' ? 3000 : 0);
    const gpu = nn(file === 'chrome.exe' ? 3.1 : file === 'dwm.exe' ? 2.4 : file === 'Code.exe' ? 0.4 : 0);
    const power = NULLS ? null : cpu > 5 ? 'High' : cpu > 1 ? 'Moderate' : cpu > 0.3 ? 'Low' : 'Very low';
    const windows = x.windows !== undefined ? x.windows : 1;
    const title = x.title || null;
    // lib's members (sent only while the row is expanded): pid, created, file, mem, cpu, windows, name, path, title,
    // status, suspended, disk, net, gpu, gpuEngine, why {net, disk, gpu}, titles?[{hwnd, title, state}]
    const members = Array.from({ length: count }, (_, i) => {
      const m = { pid: pid + i, created: created(pid + i), file, mem: i === 0 ? Math.round(mem * 0.4) : Math.round((mem * 0.6) / Math.max(1, count - 1)), cpu: i === 1 ? cpu : 0,
        windows: i === 0 ? windows : 0, name, path, title: i === 0 ? title : null, status: null, suspended: false,
        disk: disk === null ? null : disk / count, net: net === null ? null : net / count, gpu: gpu === null ? null : i === 0 ? gpu : 0, gpuEngine: gpu && i === 0 ? 'GPU 0 - 3D' : null };
      m.why = { net: m.net === null ? NET_WHY : null, disk: m.disk === null ? 'the first sample has no rate yet' : null, gpu: m.gpu === null ? 'GPU use is read on the Processes and Performance pages' : null };
      if (i === 0 && windows > 0 && title) m.titles = [{ hwnd: String(70000 + pid), title, state: 'normal' }];
      return m;
    });
    const prot = x.protected || null;
    const row = {
      key: `${pid}|${created(pid)}`, identity: path ? path.toLowerCase() : `file:${file.toLowerCase()}`, name, file, mem, cpu, count, windows, title, hung: false,
      canReveal: !!path, path: path || null, kind, protected: prot, game: false, handledBy: x.handledBy || null, elevated: !!x.elevated,
      members, actions: prot ? { close: false, force: false, trim: false, why: prot } : { close: true, force: true, trim: true, why: null }, state: null,
      disk, gpu, gpuEngine: gpu ? 'GPU 0 - 3D' : null, net, status: x.status || null, efficiency: !!x.efficiency, suspended: !!x.suspended,
      type: kind === 'mantle' ? 'app' : kind, publisher: nn(PUB[file] || null), pid, processName: file, cmdline: nn(`"${path || file}"`),
      power, powerTrend: NULLS ? null : power === 'High' ? 'Moderate' : power,
      icon: x.icon || null, iconWhy: x.icon ? null : 'No icon (made-up app)',
    };
    row.why = whyOf(row);
    return row;
  };
  const apps = [
    grp('Google Chrome', 'chrome.exe', 1843 * MB, 6.2, { count: 21, title: 'Made-up tab - Google Chrome' }),
    grp('Discord', 'Discord.exe', 412 * MB, 0.8, { count: 6, title: 'Made-up channel - Discord' }),
    grp('Visual Studio Code', 'Code.exe', 655 * MB, 1.3, { count: 11, title: 'made-up.js - Visual Studio Code' }),
    grp('Steam', 'steam.exe', 238 * MB, 0.2, { count: 4, title: 'Steam' }),
    grp('Notepad', 'Notepad.exe', 38 * MB, 0, { title: 'Untitled - Notepad' }),
  ];
  const background = [
    grp('Spotify', 'Spotify.exe', 312 * MB, 0.4, { count: 5, windows: 0, kind: 'background', handledBy: 'spotify' }),
    grp('Lively Wallpaper', 'Lively.exe', 146 * MB, 0.9, { count: 3, windows: 0, kind: 'background', protected: 'Lively, your wallpaper app: Mantle never closes it' }),
    grp('OneDrive', 'OneDrive.exe', 96 * MB, 0.1, { windows: 0, kind: 'background', efficiency: true, status: 'Efficiency mode' }),
    // no path: Windows would not let Mantle open it (it runs as administrator), so canReveal is false
    grp('Logitech G HUB', 'lghub.exe', 88 * MB, 0.3, { count: 3, windows: 0, kind: 'background', elevated: true, path: null }),
    grp('Vanguard tray notification', 'vgtray.exe', 7 * MB, 0, { windows: 0, kind: 'background', protected: "A game's anti-cheat: closing it stops the game from starting", suspended: true, status: 'Suspended' }),
  ];
  const WIN_PATH = (f) => `C:\\Windows\\${f === 'explorer.exe' ? '' : 'System32\\'}${f}`;
  const windows = [
    grp('Desktop Window Manager', 'dwm.exe', 120 * MB, 1.1, { windows: 0, kind: 'windows', protected: 'Part of Windows: Windows needs it running', path: WIN_PATH('dwm.exe') }),
    grp('Windows Explorer', 'explorer.exe', 164 * MB, 0.4, { windows: 1, kind: 'windows', title: 'File Explorer', protected: "Windows' shell (Explorer): closing it takes the desktop and file windows with it", path: WIN_PATH('explorer.exe') }),
    grp('Service Host: Windows Audio', 'svchost.exe', 31 * MB, 0.2, { windows: 0, kind: 'windows', protected: 'A Windows service: Windows needs it running', path: WIN_PATH('svchost.exe') }),
    grp('Service Host: Network Service', 'svchost.exe', 28 * MB, 0, { windows: 0, kind: 'windows', protected: 'A Windows service: Windows needs it running', path: WIN_PATH('svchost.exe') }),
    grp('Service Host: Diagnostic Policy', 'svchost.exe', 24 * MB, 0, { windows: 0, kind: 'windows', protected: 'A Windows service: Windows needs it running', path: WIN_PATH('svchost.exe') }),
  ];
  const mantleRow = grp('Mantle', 'electron.exe', 273 * MB, 0.6, { count: 9, windows: 0, kind: 'mantle', protected: 'Mantle itself: close Mantle from its tray menu', icon: 'mantle:self' });
  if (mode === 'hung') { apps[4].hung = true; apps[4].status = 'Not responding'; apps[4].members[0].status = 'Not responding'; }
  if (mode === 'failed') {
    apps[1].state = { at: Date.now(), state: 'still-running', why: 'Its window closed but it kept running in the background (probably in the tray). Force close ends it.' };
    apps[3].state = { at: Date.now(), state: 'failed', why: 'Not closed: access denied: it runs as administrator or is protected' };
    apps[2].state = { at: Date.now(), state: 'trimmed', before: 655 * MB, after: 214 * MB, why: null };
  }
  const allRows = () => [mantleRow].concat(apps, background, windows);
  const byKey = (k) => allRows().find((g) => g.key === k) || null;

  /* ---------------------------------------------------------------- Performance (lib's perfModel) */
  const hist = { cpu: wave(48, 22, 12, 5, 2), mem: wave(48, 64, 2, 11, 0.4) };
  const h60 = (base, amp, per, step) => wave(60, base, amp, per, step).map((v) => Math.min(100, v));
  const why = (o, keys, words) => { const w = {}; for (const k of keys) if (o[k] === null) w[k] = words || 'Windows did not say (made-up reason)'; return w; };
  const CPU_KEYS = ['pct', 'kernelPct', 'speedGHz', 'procs', 'threads', 'handles', 'uptimeSec', 'name', 'baseGHz', 'sockets', 'cores', 'logical', 'virtualization', 'l1KB', 'l2KB', 'l3KB'];
  const MEM_KEYS = ['total', 'used', 'avail', 'committed', 'commitLimit', 'cached', 'pagedPool', 'nonPagedPool', 'compressed', 'composition', 'speedMTs', 'slotsUsed', 'slotsTotal', 'formFactor', 'hardwareReserved'];
  const perf = (full) => {
    // off the Performance page lib sends the live counters only: the hardware facts are null, no why
    const cpu = { name: full ? '12th Gen Intel(R) Core(TM) i3-1215U' : null, speedGHz: nn(2.83), baseGHz: full ? nn(1.2) : null, sockets: full ? nn(1) : null, cores: full ? nn(6) : null,
      virtualization: full ? nn('Enabled') : null, l1KB: full ? nn(544) : null, l2KB: full ? nn(4608) : null, l3KB: full ? nn(10240) : null, kernelPct: nn(6),
      pct: 23, perCore: full ? Array.from({ length: 8 }, (_, c) => h60(14 + c * 3, 10, 3 + c, 2)) : null, procs: 247, threads: nn(3480), handles: nn(112345),
      uptimeSec: 3 * 86400 + 5 * 3600 + 23 * 60 + 11, hist: h60(22, 12, 5, 2), logical: 8 };
    const mem = { cached: nn(4.9 * GB), pagedPool: nn(612 * MB), nonPagedPool: nn(498 * MB), compressed: full ? nn(402 * MB) : null,
      composition: NULLS ? null : { inUse: 10.4 * GB, modified: 0.2 * GB, standby: 4.7 * GB, free: 0.7 * GB },
      speedMTs: full ? nn(4267) : null, slotsUsed: full ? nn(2) : null, slotsTotal: full ? nn(2) : null, formFactor: full ? nn('Row of chips') : null, hardwareReserved: full ? nn(298 * MB) : null,
      total: 16 * GB, used: 10.6 * GB, avail: 5.4 * GB, committed: 14.2 * GB, commitLimit: 22.5 * GB, hist: h60(64, 2, 11, 0.4) };
    const out = { cpu, mem, disks: null, nets: null, gpus: null, npus: null, error: null };
    if (!full) return out;
    cpu.kernelHist = h60(6, 3, 4, 0.5);
    cpu.perCoreKernel = NULLS ? null : Array.from({ length: 8 }, (_, c) => h60(3 + c, 2, 4 + c, 0.5));
    cpu.why = why(cpu, CPU_KEYS);
    mem.why = why(mem, MEM_KEYS);
    const disk = (d) => Object.assign(d, { why: why(d, ['model', 'type', 'activePct', 'respMs', 'readBps', 'writeBps', 'capacity', 'formatted', 'systemDisk', 'pageFile']) });
    out.disks = [
      disk({ id: 'disk0', name: 'Disk 0 (C:)', model: nn('NVMe Made-Up SSD 512GB'), type: nn('SSD'), activePct: 3, respMs: nn(0.6), readBps: 1.2 * MB, writeBps: 420 * 1024, capacity: nn(512 * 1000 ** 3), formatted: nn(476 * GB), systemDisk: true, pageFile: true,
        bus: nn('NVMe'), removable: false, hist: h60(3, 3, 3, 1), readHist: h60(1, 1, 3, 0.3).map((v) => v * MB), writeHist: h60(0.4, 0.4, 4, 0.1).map((v) => v * MB) }),
      disk({ id: 'disk1', name: 'Disk 1 (D:)', model: nn('USB Made-Up Drive'), type: nn('HDD'), activePct: 0, respMs: nn(0), readBps: 0, writeBps: 0, capacity: nn(1000 ** 4), formatted: nn(931 * GB), systemDisk: false, pageFile: false,
        bus: nn('USB'), removable: true, hist: h60(0, 0.5, 6, 0), readHist: Array(60).fill(0), writeHist: Array(60).fill(0) }),
    ];
    const NET_KEYS = ['sendBps', 'recvBps', 'ssid', 'connType', 'ipv4', 'ipv6', 'signal', 'linkBps', 'connected'];
    out.nets = [
      // sendBps/recvBps BYTES/s; sendHist/recvHist BITS/s; linkBps bits/s; signal percent 0..100
      { id: 'wifi', name: 'Wi-Fi', adapter: 'Made-Up Wi-Fi 6 AX201', kind: 'Wi-Fi', sendBps: 26000, recvBps: 410000, ssid: nn('Made-Up Network'), connType: nn('802.11ax'), ipv4: nn('192.0.2.24'), ipv6: nn('fe80::1c2b:3a4d:5e6f:7a8b%14'),
        signal: nn(72), linkBps: nn(866700000), connected: true, sendHist: h60(30, 25, 4, 6).map((v) => v * 8000), recvHist: h60(400, 300, 5, 40).map((v) => v * 8000) },
      // an unplugged adapter: Windows' "Not connected" card
      { id: 'eth', name: 'Ethernet', adapter: 'Made-Up USB GbE', kind: 'Ethernet', sendBps: 0, recvBps: 0, ssid: null, connType: nn('Ethernet'), ipv4: null, ipv6: null, signal: null, linkBps: null, connected: false,
        sendHist: Array(60).fill(0), recvHist: Array(60).fill(0) },
    ].map((x) => Object.assign(x, { why: why(x, NET_KEYS, x.connected === false ? 'Not connected' : null) }));
    out.listWhy = { disks: null, nets: null };
    const eng = (name, pct, hh) => ({ name, pct, hist: hh });
    out.gpus = [{ id: 'gpu0', name: 'Intel(R) UHD Graphics', pct: 4, engines: [eng('3D', 4, h60(4, 4, 3, 1)), eng('Copy', 0, h60(0, 1, 6, 0)), eng('Video Encode', 0, Array(60).fill(0)), eng('Video Decode', 1, h60(1, 1, 5, 0))],
      dedicatedUsed: nn(0), dedicatedTotal: nn(128 * MB), sharedUsed: nn(612 * MB), sharedTotal: nn(5.9 * GB),
      dedHist: NULLS ? Array(60).fill(null) : Array(60).fill(0), sharedHist: NULLS ? Array(60).fill(null) : h60(10.1, 0.8, 9, 0.1),   // percent of their total
      driverVersion: nn('31.0.101.5592'), driverDate: nn('2026-06-12'), directX: nn('DirectX 12 (FL 12.1)'), location: nn('PCI bus 0, device 2, function 0'), reserved: nn(0),
      kind: 'gpu', index: 0, hist: h60(4, 4, 3, 1) }];
    out.npus = [];
    for (const g of out.gpus) g.why = why(g, ['id', 'name', 'pct', 'dedicatedUsed', 'dedicatedTotal', 'sharedUsed', 'sharedTotal', 'driverVersion', 'driverDate', 'directX', 'location', 'reserved'], 'not reported by the sidecar');
    out.gpuWhy = null;
    return out;
  };

  /* ---------------------------------------------------------------- App history, Startup, Users, Details, Services */
  const AH_WHY = { net: "per-app network use needs Windows' event tracing as administrator; set up administrator access to see Windows' own App history", tiles: 'Windows keeps no tile-update count that apps can read' };
  const STORE = (exe) => `C:\\Program Files\\WindowsApps\\MadeUp.${exe.replace(/\.exe$/i, '')}_1.0.0.0_x64__8wekyb3d8bbwe\\${exe}`;
  const AH_ROWS = [['Google Chrome', 'chrome.exe', 41520, 2.1 * GB, false], ['Discord', 'Discord.exe', 9300, 640 * MB, false], ['Visual Studio Code', 'Code.exe', 18200, 120 * MB, false],
    ['Spotify', 'Spotify.exe', 6100, 1.4 * GB, false], ['Steam', 'steam.exe', 2400, 8.2 * GB, false], ['Notepad', 'Notepad.exe', 120, 0, true], ['Microsoft Store', 'WinStore.App.exe', 300, 45 * MB, true], ['Photos', 'Photos.exe', 860, 12 * MB, true]];
  const apphistory = (all) => {
    if (q.get('ah') === 'srum') {
      // Windows' own (SRUM, through the administrator helper): identity is a package name or an NT path
      const rows = AH_ROWS.map(([name, exe, cpu, net, store]) => {
        const r = { name, identity: store ? `MadeUp.${exe.replace(/\.exe$/i, '')}_8wekyb3d8bbwe!App` : `\\device\\harddiskvolume3\\program files\\made up\\${exe.toLowerCase()}`,
          cpuTimeSec: cpu, net: nn(net), metered: nn(0), tiles: nn(0), nonMetered: nn(net), downloads: nn(Math.round(net * 0.9)), uploads: nn(Math.round(net * 0.1)),
          app: store, path: store ? null : `C:\\Program Files\\Made Up\\${exe}` };
        if (!r.path) r.why = { path: "a Store app: Windows keeps its files in a protected folder, so there is no one file to show" };
        return r;
      }).concat([{ name: 'Made-up Background Service', identity: 'MadeUpBgSvc', cpuTimeSec: 905, net: nn(1.2 * MB), metered: nn(0), tiles: nn(0), nonMetered: nn(1.2 * MB), downloads: nn(MB), uploads: nn(0.2 * MB),
        app: false, path: null, why: { path: 'a Windows entry, not a file' } }]);
      return { since: NULLS ? null : '2026-10-01T00:00:00Z', rows: rows.filter((r) => all || r.app), source: 'srum', scope: 'currentUser',
        meteredBasis: 'Metered = bytes over cellular (WWAN) adapters: SRUM records the adapter, not whether a network was set as metered (made-up words)',
        readAt: '2026-10-28T12:00:00Z', notes: [], error: null };
    }
    // Mantle's own record: CPU time only; every network column null with why; the note says whose record it is
    const rows = AH_ROWS.map(([name, exe, cpu, , store]) => {
      const path = store ? STORE(exe) : `C:\\Program Files\\Made Up\\${exe}`;
      return { name, identity: path.toLowerCase(), cpuTimeSec: cpu, app: store, path, net: null, metered: null, tiles: null, nonMetered: null, downloads: null, uploads: null,
        why: { net: AH_WHY.net, metered: AH_WHY.net, nonMetered: AH_WHY.net, downloads: AH_WHY.net, uploads: AH_WHY.net, tiles: AH_WHY.tiles } };
    }).concat([{ name: 'made-up-tool', identity: 'file:made-up-tool.exe', cpuTimeSec: 905, app: false, path: null, net: null, metered: null, tiles: null, nonMetered: null, downloads: null, uploads: null,
      why: { net: AH_WHY.net, metered: AH_WHY.net, nonMetered: AH_WHY.net, downloads: AH_WHY.net, uploads: AH_WHY.net, tiles: AH_WHY.tiles, path: "Windows did not let Mantle see where this app's file is" } }]);
    return { since: '2026-10-01T07:00:00.000Z', rows: rows.filter((r) => all || r.app).sort((a, b) => b.cpuTimeSec - a.cpuTimeSec), source: 'mantle', error: null, why: Object.assign({}, AH_WHY),
      note: "Mantle's own record (CPU time only), kept since it started. Windows keeps the full App history for administrators: set up administrator access to see it." };
  };
  const elevOk = () => S.elevated.installed && !S.elevated.stale;
  const startup = () => ({
    biosSec: nn(7.4), error: null,
    why: { impact: elevOk() ? 'Windows has not measured this one yet ("Not measured")' : "Windows measures startup impact itself and keeps it for administrators. Set up administrator access to let Mantle do this (Windows asks once).",
      lastRun: elevOk() ? 'Windows has no record of this app running since it was installed or since Windows last cleared its record' : 'Windows keeps when each startup app last ran for administrators. Set up administrator access to let Mantle do this (Windows asks once).' },
    rows: [
      ['hkcu-run|Discord', 'Discord', 'Discord Inc.', true, 'High', 'Registry, this user', 'Update.exe --processStart Discord.exe'],
      ['hkcu-run|Spotify', 'Spotify', 'Spotify AB', true, 'Medium', 'Registry, this user', 'Spotify.exe --autostart --minimized'],
      ['hkcu-run|Steam', 'Steam', 'Valve Corporation', true, 'High', 'Registry, this user', 'steam.exe -silent'],
      ['hkcu-run|OneDrive', 'Microsoft OneDrive', 'Microsoft Corporation', true, 'Medium', 'Registry, this user', 'OneDrive.exe /background'],
      ['hkcu-run|MadeUpChat', 'Made-up Chat', 'Made Up Inc.', false, 'None', 'Registry, this user', 'madeupchat.exe --system-initiated'],
      ['hklm-run|LGHUB', 'Logitech G HUB', 'Logitech, Inc.', true, 'Low', 'Registry, all users', 'lghub.exe --background'],
      ['hklm-run|SecurityHealth', 'Windows Security notification icon', 'Microsoft Corporation', true, 'Low', 'Registry, all users', 'SecurityHealthSystray.exe'],
      ['user-folder|Lively.lnk', 'Lively Wallpaper', null, true, null, 'Startup folder, this user', 'Lively.exe'],
    ].map(([item, name, pub, en, impact, type, cmd], i) => ({ item, name, publisher: nn(pub), enabled: en, impact: NULLS || !elevOk() ? null : impact, type,
      diskIO: NULLS || !elevOk() ? null : impact === 'High' ? 38 * MB : 4 * MB, cpuMs: NULLS || !elevOk() ? null : impact === 'High' ? 2100 : 300,
      running: i < 4 || i === 5, disabledAt: en ? null : '2026-09-03T18:02:00.000Z', lastRun: NULLS || !elevOk() ? null : '2026-10-28T08:15:00Z',
      cmdline: cmd, path: `C:\\Program Files\\Made Up\\${cmd.split(' ')[0]}`, canToggle: true, reason: null })),
  });
  const users = () => {
    const proc = (g) => ({ pid: g.pid, created: created(g.pid), name: g.name, processName: g.file, path: g.path, cpu: g.cpu, mem: g.mem, disk: g.disk, net: g.net, gpu: g.gpu, gpuEngine: g.gpuEngine,
      icon: g.icon, iconWhy: g.iconWhy });
    const SN = "Windows' session name (Console, RDP-Tcp#n) is not read by Mantle yet";
    const CL = 'Not read by Mantle yet (Windows shows a client name only for a remote session)';
    const rows = [{ session: 1, user: 'alex', fullName: nn('Alex Made-Up'), status: null, current: true, sessionName: null, client: null, cpu: 14.3, mem: 6.9 * GB, disk: nn(1.7 * MB), net: nn(437000), gpu: nn(5.9), gpuEngine: NULLS ? null : 'GPU 0 - 3D',
      procs: apps.concat(background).map(proc) }];
    if (q.get('users') !== '1') {
      rows.push({ session: 2, user: 'jordan', fullName: nn('Jordan Made-Up'), status: 'Disconnected', current: false, sessionName: null, client: null, cpu: 0, mem: 412 * MB, disk: nn(0), net: nn(0), gpu: nn(0), gpuEngine: null,
        procs: [{ pid: 5120, created: created(5120), name: 'Made-up Notes', processName: 'notes.exe', path: null, cpu: 0, mem: 180 * MB, disk: nn(0), net: nn(0), gpu: nn(0), gpuEngine: null, icon: null, iconWhy: null },
          { pid: 5188, created: created(5188), name: 'Made-up Sync', processName: 'sync.exe', path: 'C:\\Program Files\\Made Up\\sync.exe', cpu: 0, mem: 232 * MB, disk: nn(0), net: nn(0), gpu: nn(0), gpuEngine: null, icon: null, iconWhy: null }] });
    }
    for (const u of rows) u.why = { net: u.net === null ? NET_WHY : null, gpu: u.gpu === null ? 'GPU use is read on the Processes, Performance and Users pages' : null, sessionName: SN, client: CL };
    return { rows, error: null };
  };
  const SYS = [['System', 4, 'SYSTEM', 0.3, 0.1, 'NT Kernel & System'], ['Registry', 120, 'SYSTEM', 0, 12, null], ['smss.exe', 412, 'SYSTEM', 0, 0.4, 'Windows Session Manager'],
    ['csrss.exe', 640, 'SYSTEM', 0.1, 1.6, 'Client Server Runtime Process'], ['wininit.exe', 720, 'SYSTEM', 0, 1.1, 'Windows Start-Up Application'], ['services.exe', 860, 'SYSTEM', 0.1, 4.8, 'Services and Controller app'],
    ['lsass.exe', 880, 'SYSTEM', 0, 7.2, 'Local Security Authority Process'], ['svchost.exe', 1012, 'NETWORK SERVICE', 0, 9.8, 'Host Process for Windows Services'], ['svchost.exe', 1100, 'LOCAL SERVICE', 0.2, 6.1, 'Host Process for Windows Services']];
  const details = () => {
    const rows = [];
    const add = (name, pid, user, cpu, memMB, desc, extra) => {
      const mine = user === 'alex';
      const r = Object.assign({ key: `${pid}|${created(pid)}`, pid, created: created(pid), name, status: 'Running', user: nn(user), cpu, mem: memMB * MB, arch: nn('x64'), desc: nn(desc), path: nn(`C:\\Windows\\System32\\${name}`),
        packageName: null, sessionId: mine ? 1 : 0, jobId: null, cpuTimeSec: Math.round(cpu * 900 + pid / 10), cycles: nn(pid * 1e7), ws: memMB * 1.3 * MB, wsPeak: memMB * 1.8 * MB, wsDelta: 0, privateWs: memMB * MB, sharedWs: memMB * 0.3 * MB,
        commit: memMB * 1.2 * MB, pagedPool: nn(220 * 1024), npPool: nn(18 * 1024), pageFaults: pid * 31, pfDelta: 0, basePriority: 'Normal', handles: 200 + (pid % 900), threads: 4 + (pid % 30), userObjects: mine ? 12 : 0, gdiObjects: mine ? 30 : 0,
        ioReads: pid * 3, ioWrites: pid, ioOther: pid * 5, ioReadBytes: pid * 4096, ioWriteBytes: pid * 1024, ioOtherBytes: pid * 512, cmdline: nn(name), osContext: nn('Windows 10'), platform: '64 bit', elevated: !mine,
        uacVirt: mine ? 'Disabled' : 'Not allowed', dep: 'Enabled', enterprise: nn('N/A'), powerThrottling: 'Disabled', shadowStack: nn('Compatible'), efficiency: false, needsAdmin: false, why: null, unread: [] }, extra || {});
      // jobId is admin-only; a null field's reason is the row's one why string (+ unread[] names the fields not read)
      r.unread = Object.keys(r).filter((k) => r[k] === null && k !== 'why' && k !== 'packageName');
      if (r.unread.length) r.why = NULLS ? 'Windows did not let Mantle read these fields (made-up reason)' : 'the job object is readable only as administrator';
      rows.push(r);
    };
    for (const g of apps.concat(background)) for (const m of g.members) add(m.file, m.pid, 'alex', m.cpu, Math.round(m.mem / MB), g.name, { path: nn(g.path), status: g.hung && m.pid === g.pid ? 'Not responding' : g.suspended ? 'Suspended' : 'Running', efficiency: g.efficiency });
    for (const s of SYS) add(s[0], s[1], s[2], s[3], s[4], s[5]);
    return { rows, error: null };
  };
  const SVC = [['AudioSrv', 'Windows Audio', 1100, 'Manages audio for Windows-based programs.', 'Running', 'LocalServiceNetworkRestricted', 'Automatic'], ['BITS', 'Background Intelligent Transfer Service', null, 'Transfers files in the background using idle network bandwidth.', 'Stopped', 'netsvcs', 'Manual'],
    ['Dhcp', 'DHCP Client', 1012, 'Registers and updates IP addresses and DNS records for this computer.', 'Running', 'LocalServiceNetworkRestricted', 'Automatic'], ['Dnscache', 'DNS Client', 1012, 'Caches Domain Name System (DNS) names.', 'Running', 'NetworkService', 'Automatic'],
    ['EventLog', 'Windows Event Log', 1100, 'Manages events and event logs.', 'Running', 'LocalServiceNetworkRestricted', 'Automatic'], ['Spooler', 'Print Spooler', 2400, 'Spools print jobs and handles interaction with the printer.', 'Running', null, 'Automatic'],
    ['wuauserv', 'Windows Update', null, 'Enables the detection, download, and installation of updates for Windows and other programs.', 'Stopped', 'netsvcs', 'Manual'], ['WSearch', 'Windows Search', 3120, 'Provides content indexing and property caching for files, email and other content.', 'Running', null, 'Automatic (delayed)'],
    ['SysMain', 'SysMain', 1100, 'Maintains and improves system performance over time.', 'Running', 'LocalSystemNetworkRestricted', 'Automatic'], ['Themes', 'Themes', 1012, 'Provides user experience theme management.', 'Running', 'netsvcs', 'Automatic'],
    ['XblGameSave', 'Xbox Live Game Save', null, 'This service syncs save data for Xbox Live save enabled games.', 'Stopped', 'netsvcs', 'Disabled'], ['vgc', 'vgc', 5120, 'Made-up anti-cheat service.', 'Running', null, 'Manual']];
  const CRIT_SVC = new Set(['Dhcp', 'EventLog', 'Dnscache']);
  const services = () => ({ rows: SVC.map(([name, display, pid, desc, status, group, startType]) => {
    const r = { name, display, pid, desc: nn(desc), status, group: nn(group), startType: nn(startType) };
    if (mode === 'failed' && name === 'Spooler') r.lastOp = { op: 'stop', ok: false, reason: 'needs administrator: open Services (made-up reason)', at: Date.now() - 4000 };
    return r;
  }), error: null, elevated: false });

  /* ---------------------------------------------------------------- the model (lib's model()) */
  const ticks = new Set(mode === 'game' ? ['c:\\program files\\made up\\chrome.exe', 'c:\\program files\\made up\\discord.exe', 'c:\\program files\\made up\\code.exe'] : []);
  const reopen = new Set(mode === 'game' ? ['c:\\program files\\made up\\discord.exe', 'c:\\program files\\made up\\code.exe'] : []);
  const S = {
    view: (q.get('view') || (mode === 'game' ? 'game' : 'processes')), auto: false, expanded: new Set(),
    settings: { theme: 'system', startPage: 'processes', updateSpeed: q.get('paused') === '1' ? 'paused' : 'normal', alwaysOnTop: false, minimizeOnUse: false, hideWhenMinimized: false, fullAccountName: false, historyAllProcesses: false, askBeforeEfficiency: true },
    elevated: { none: { installed: false, stale: false, running: false, reason: 'Not set up yet (made-up words)', version: null }, stale: { installed: true, stale: true, running: false, reason: 'Set up for an older Mantle: set it up again (made-up words)', version: '0.9.0' }, ok: { installed: true, stale: false, running: true, reason: null, version: '1.0.0' } }[q.get('elev') || 'none'],
    apps, background, windows, mantleRow, details, services, startup,
  };
  const rowOut = (g) => Object.assign({}, g, { members: S.expanded.has(g.key) ? g.members : null });
  function model() {
    const v = S.view;
    const prep = v !== 'game' ? [] : apps.concat(background).filter((g) => g.kind === 'app' || g.kind === 'background' || g.handledBy === 'spotify').map((g) => {
      const why = g.handledBy === 'spotify' ? 'Handled by the Spotify card: it closes an idle Spotify when a game starts' : g.protected || null;
      const re = !why && reopen.has(g.identity);
      return { key: g.key, identity: g.identity, name: g.name, mem: g.mem, kind: g.kind, tickable: !why, why, ticked: !why && ticks.has(g.identity), reopen: re, elevated: g.elevated,
        icon: g.icon, iconWhy: g.iconWhy, state: g.state, reopenWhy: re && g.name === 'Visual Studio Code' ? 'A Store app: Mantle cannot start it from its exe (open it from Start after the game)' : null, reopenChecked: re };
    });
    const memNow = { total: 16 * GB, avail: 5.4 * GB, used: 10.6 * GB, load: 66, commit: 14.2 * GB, commitLimit: 22.5 * GB };
    const m = {
      at: Date.now(), test: TEST, error: mode === 'error' ? 'Mantle could not read the list of running apps (made-up reason). Trying again.' : null, view: OLD && v !== 'game' ? 'apps' : v, chord: 'Ctrl+Shift+Esc',
      mem: memNow, cpu: 23, hist, cpus: 8, method: 'NtQuerySystemInformation(SystemProcessInformation).WorkingSetPrivateSize', sampleMs: S.settings.updateSpeed === 'paused' ? 0 : 1000,
      mantle: { mem: mantleRow.mem, count: 9, cpu: 0.6 },
      apps: apps.map(rowOut), background: background.map(rowOut), windows: windows.map(rowOut), mantleRow: rowOut(mantleRow),
      recent: mode === 'failed' ? [{ name: 'Notepad', text: 'Closed · freed about 38 MB', ok: true, at: Date.now() - 20000 }] : [],
      prep: { rows: prep, absent: mode === 'game' ? [{ identity: 'c:\\program files\\made up\\obs64.exe', name: 'OBS Studio', reopen: false }] : [], auto: S.auto,
        lastFree: null, lastAuto: mode === 'game' ? { at: new Date(2026, 8, 27, 20, 5).getTime(), game: 'VALORANT', none: null, freed: 1260 * MB, reopen: [], dryRun: false,
          results: [{ name: 'Google Chrome', mem: 1260 * MB, ok: true, why: null, state: 'closed' }, { name: 'Discord', mem: 412 * MB, ok: true, why: 'Its window closed but it kept running in the background (probably in the tray). Force close ends it.', state: 'still-running' }],
          reopened: { at: new Date(2026, 8, 27, 21, 40).getTime(), results: [{ name: 'Discord', ok: true }] } } : null,
        reopenPending: null },
      loaded: mode !== 'loading' && mode !== 'error',
      // lib's S.look once the window's frame was set: frame 'light'|'dark', hwnd a number (the window's handle)
      look: { material: glass === 'dark' ? 'none' : 'acrylic', icon: true, iconWhy: null, light: true, lightWhy: null, frame: glass === 'dark' ? 'dark' : 'light', hwnd: 461738 },
    };
    if (OLD) return m;
    m.totals = { cpu: 23, mem: 66, disk: nn(3), net: nn(1), gpu: nn(4) };
    m.totals.why = { disk: m.totals.disk === null ? 'not read yet (the first sample is on its way)' : null, net: m.totals.net === null ? 'not read yet (the first sample is on its way)' : null, gpu: m.totals.gpu === null ? 'Windows gave no GPU reading this time' : null };
    // the page data travels only while its page is on screen (null otherwise); cpu + mem always, for the header totals
    m.perf = perf(v === 'performance');
    const all = !!S.settings.historyAllProcesses;
    m.startup = v === 'startup' ? S.startup() : null;
    m.details = v === 'details' ? S.details() : null;
    m.services = v === 'services' ? S.services() : null;
    m.users = v === 'users' ? users() : null;
    m.apphistory = v === 'apphistory' ? apphistory(all) : null;
    if (m.apphistory && q.get('ah') === 'empty') m.apphistory.rows = [];
    m.settings = Object.assign({}, S.settings);
    m.admin = { elevated: elevOk() };
    m.elevated = Object.assign({}, S.elevated);
    return m;
  }
  const push = () => setTimeout(() => window.mantle.emit('taskmgr.model', model()), 10);
  window.__mock = { S, model, push };

  /* ---------------------------------------------------------------- Windows' confirm words (sidecar TaskMgr.ConfirmText; made-up targets) */
  const CRIT = { 4: 'System', 412: 'smss.exe', 640: 'csrss.exe', 720: 'wininit.exe', 860: 'services.exe', 880: 'lsass.exe' };
  const SHUT = 'Ending this process will shut down the operating system immediately. You will lose all unsaved data. Are you sure you want to continue?';
  const SYS_TEXT = 'If an open program is associated with this process, it will close and you will lose any unsaved data. If you end a system process, it might result in system instability. Are you sure you want to continue?';
  // lib's answer(): the sidecar's reply fields + ok, reason, needsAdmin, needsConfirm, dryRun (+ title, text, check, button when it confirms)
  const ans = (x) => Object.assign({ ok: true, reason: null, needsAdmin: false, needsConfirm: false, dryRun: true }, x || {});
  const confirmOf = (a, kind, c, extra) => Object.assign({ ok: false, reason: c.title, needsAdmin: false, needsConfirm: true, dryRun: TEST || !!a.dryRun, kind,
    confirm: { title: c.title, body: c.text, check: c.check || null, button: c.button || null }, title: c.title, text: c.text, check: c.check || null, button: c.button || null }, extra || {});
  function needsConfirm(cmd, a) {
    const nm = CRIT[a.pid];
    const pidx = { pid: a.pid };
    if (cmd === 'endPid' && nm) return confirmOf(a, 'critical', a.tree ? { title: `Do you want to end the process tree of '${nm}'?`, text: SHUT, check: 'Abandon unsaved data and shut down.', button: 'Shut down' }
      : { title: `Do you want to end the system process '${nm}'?`, text: SHUT, check: 'Abandon unsaved data and shut down.', button: 'Shut down' }, pidx);
    if (cmd === 'priority' && nm) return confirmOf(a, 'critical', { title: `Do you want to change the priority of '${nm}'?`, text: 'Changing the priority of certain processes could cause system instability.', button: 'Change priority' }, pidx);
    if (cmd === 'affinity' && nm) return confirmOf(a, 'critical', { title: `Do you want to change the affinity of '${nm}'?`, text: 'Changing which processors a system process can run on could cause system instability.', button: 'Change affinity' }, pidx);
    if (cmd === 'uacVirt' && nm) return confirmOf(a, 'critical', { title: `Do you want to change the virtualization state of '${nm}'?`, text: 'Changing the virtualization state of a process could cause it to fail or work incorrectly.', button: 'Change virtualization' }, pidx);
    if (cmd === 'dump' && nm) return confirmOf(a, 'critical', { title: `Create a memory dump of '${nm}'?`, text: "The dump file holds everything in this process's memory, which can include passwords and other secrets.", button: 'Create dump file' }, pidx);
    if (cmd === 'act' && (a.action === 'close' || a.action === 'force')) {
      const g = windows.find((x) => x.key === a.key);
      if (g) return confirmOf(a, 'system', { title: `Do you want to end '${g.file}'?`, text: SYS_TEXT, button: 'End process' }, { pid: g.pid });
      const r = byKey(a.key);
      if (r && a.action === 'force' && !r.protected) {
        return { ok: false, needsConfirm: true, title: `Do you want to force close ${r.name}?`, text: `${r.name} ends at once, without a chance to save. Anything unsaved in it is lost.`,
          check: null, button: 'Force close', reason: 'Force close needs the confirm in the window first.', needsAdmin: false, dryRun: TEST || !!a.dryRun };
      }
    }
    if (cmd === 'service' && (a.op === 'stop' || a.op === 'restart') && CRIT_SVC.has(a.name)) {
      const s = SVC.find((x) => x[0] === a.name);
      return { ok: false, op: a.op, name: a.name, state: null, startType: null, dryRun: TEST || !!a.dryRun, reason: 'needs confirmation: Windows needs this service running', needsAdmin: false, needsConfirm: true,
        title: `${a.op === 'stop' ? 'Stop' : 'Restart'} ${s ? s[1] : a.name}?`, text: 'Windows needs this service running (made-up words standing in for Mantle\'s warning).', check: null, button: a.op === 'stop' ? 'Stop service' : 'Restart service' };
    }
    if (cmd === 'userDisconnect' || cmd === 'userSignOff') {
      const user = a.session === 2 ? 'jordan' : 'alex';
      const so = cmd === 'userSignOff';
      return { ok: false, op: so ? 'signoff' : 'disconnect', session: a.session, user, dryRun: TEST || !!a.dryRun, reason: 'needs confirmation', state: a.session === 2 ? 'disconnected' : 'active', needsAdmin: false, needsConfirm: true,
        title: so ? 'Sign out user' : 'Disconnect user', text: so ? `Do you want to sign out ${user}? Any unsaved data for the user may be lost.` : `Do you want to disconnect ${user}?`, check: null, button: so ? 'Sign out user' : 'Disconnect user' };
    }
    return null;
  }

  /* ---------------------------------------------------------------- the commands (lib's reply shapes; a test-mode main answers dry runs) */
  const handlers = {};
  window.__mockCalls = [];
  const OK = (x) => new Promise((r) => setTimeout(() => r(Object.assign({ ok: true }, x || {})), 60));
  const DRY = (why) => OK({ dryRun: true, reason: why });
  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    emit(ev, p) { (handlers[ev] || []).forEach((fn) => fn(p)); },
    call(name, args) {
      args = args || {};
      window.__mockCalls.push({ name, args });
      const cmd = name.replace(/^taskmgr\./, '');
      if (MISSING.has(cmd) || (OLD && !['state', 'view', 'expand', 'act', 'free', 'tick', 'auto', 'win', 'windowsTaskManager', 'reveal', 'sample'].includes(cmd) && name.startsWith('taskmgr.'))) return Promise.reject(new Error(`no command "${name}"`));
      if (ADMIN.has(cmd)) {
        const r = { ok: false, needsAdmin: true, reason: 'needs administrator: access is denied (made-up reason)' };
        if (!elevOk()) { r.setup = true; r.reason += '. Set up administrator access to let Mantle do this (Windows asks once).'; }
        return OK(r);
      }
      if (FAIL.has(cmd)) return OK({ ok: false, reason: `Made-up failure for ${cmd}.` });
      // needsConfirm is checked BEFORE dryRun: Windows' own warning words; the page asks, then resends confirmed
      if (!args.confirmed) { const c = needsConfirm(cmd, args); if (c) return OK(c); }
      const dry = TEST || !!args.dryRun;
      const pidArgs = { pid: args.pid };
      switch (name) {
        case 'taskmgr.state': return Promise.resolve(model());
        case 'taskmgr.view': S.view = args.view === 'apps' ? 'processes' : args.view; push(); return OK({ view: OLD && S.view !== 'game' ? 'apps' : S.view });
        case 'taskmgr.tick':
          if (args.on !== undefined) { if (args.on) ticks.add(args.identity); else ticks.delete(args.identity); }
          if (args.reopen !== undefined) { if (args.reopen) reopen.add(args.identity); else reopen.delete(args.identity); }
          push(); return OK({ identity: args.identity, on: ticks.has(args.identity), reopen: reopen.has(args.identity) });
        case 'taskmgr.auto': S.auto = !!args.on; push(); return OK({ auto: S.auto });
        case 'taskmgr.expand': if (args.open && byKey(args.key)) S.expanded.add(args.key); else S.expanded.delete(args.key); push(); return OK({ key: args.key, open: S.expanded.has(args.key) });
        case 'taskmgr.act': {
          const g = byKey(args.key);
          if (!g) return OK({ ok: false, reason: 'That row is gone (it exited or the list changed); nothing was done.' });
          if (args.action === 'trim') return new Promise((r) => setTimeout(() => r({ ok: true, dryRun: true, before: g.mem, after: Math.round(g.mem * 0.4), trimmed: g.count }), 150));
          if (g.kind === 'windows') return OK(ans({ pid: g.pid, dryRun: true }));   // endpid on its root (confirmed)
          if (g.protected) return OK({ ok: false, reason: g.protected });
          return new Promise((r) => setTimeout(() => r({ ok: true, dryRun: true, key: g.key, name: g.name, mem: g.mem, how: args.action === 'force' ? 'taskkill_force' : 'wm_close', why: 'Test Mantle: nothing was closed.', command: null }), 150));
        }
        case 'taskmgr.reveal': return DRY('Test Mantle: File Explorer was not opened.');
        case 'taskmgr.setting': if (args.key in S.settings) { S.settings[args.key] = args.value; push(); return OK({ key: args.key, value: args.value }); } return OK({ ok: false, reason: `"${String(args.key).slice(0, 40)}" is not a Task Manager setting` });
        case 'taskmgr.runTask': return OK({ reason: null, dryRun: true, would: `ShellExecuteEx "${args.cmd}"${args.admin ? ' (runas)' : ''} (made up)` });
        case 'taskmgr.browse': return OK({ path: 'C:\\Program Files\\Made Up\\tool.exe' });
        case 'taskmgr.endPid': return OK(ans(pidArgs));
        case 'taskmgr.priority': return OK(ans({ pid: args.pid, cls: args.cls, before: 'normal' }));
        case 'taskmgr.affinity': return OK(ans({ pid: args.pid, mask: args.mask, before: '0xFF' }));
        case 'taskmgr.affinityGet': return OK(ans({ pid: args.pid, mask: '0xFF', systemMask: '0xFF', logical: 8, dryRun: false }));
        case 'taskmgr.efficiency':
          if (CRIT[args.pid]) return OK({ ok: false, reason: "refused: a critical Windows process; Windows' Task Manager greys Efficiency mode out for it, and so does Mantle", needsAdmin: false, needsConfirm: false, dryRun: dry, pid: args.pid, unavailable: true });
          return OK(ans({ pid: args.pid, on: !!args.on, before: !args.on, would: 'power throttling (made up)' }));
        case 'taskmgr.uacVirt': return OK(ans({ pid: args.pid, on: !!args.on, before: 'Disabled', state: 'Disabled' }));
        case 'taskmgr.dump': return OK(ans({ pid: args.pid, path: `C:\\Users\\alex\\AppData\\Local\\Temp\\made-up-${args.pid}.DMP`, would: 'MiniDumpWriteDump(MiniDumpWithFullMemory) into the path' }));
        // the sidecar's WCT shape, passed through by lib unchanged
        case 'taskmgr.waitChain': return OK({ reason: null, needsAdmin: false, pid: args.pid, threadCount: 3, truncated: false, blocked: 1, deadlocks: 0,
          threads: [{ tid: 4012, waiting: true, deadlock: false, chain: [{ type: 'Thread', status: 'Blocked', pid: args.pid, tid: 4012, waitTime: 5200 }, { type: 'CriticalSection', status: 'Owned', name: null }, { type: 'Thread', status: 'Running', pid: 2244, tid: 2290, waitTime: 0 }] }] });
        case 'taskmgr.goToServices': return OK({ names: args.pid === 1012 ? ['Dhcp', 'Dnscache', 'Themes'] : [] });
        case 'taskmgr.service': return OK({ op: args.op, name: args.name, state: args.op === 'stop' ? 'Running' : 'Stopped', startType: 'Manual', dryRun: true, reason: `it is ${args.op === 'stop' ? 'running' : 'not running'} (made-up dry run)`, needsAdmin: false, needsConfirm: false });
        case 'taskmgr.userDisconnect': case 'taskmgr.userSignOff': case 'taskmgr.userConnect':
          return OK({ op: cmd === 'userConnect' ? 'connect' : cmd === 'userSignOff' ? 'signoff' : 'disconnect', session: args.session, user: args.session === 2 ? 'jordan' : 'alex', dryRun: true, reason: 'Test Mantle: nothing was done.', state: 'active', needsAdmin: false, needsConfirm: false });
        case 'taskmgr.startupSet': return OK({ reason: null, needsAdmin: false, dryRun: true, item: null });
        case 'taskmgr.properties': return OK({ reason: null, dryRun: true });
        case 'taskmgr.openLocation': return DRY('Test Mantle: File Explorer was not opened.');
        case 'taskmgr.switchTo': return OK({ reason: null, dryRun: true, hwnd: '70440', op: args.op || 'switch' });
        case 'taskmgr.searchOnline': return OK({ dryRun: true, url: `https://www.bing.com/search?q=${encodeURIComponent(args.name || '')}` });
        case 'taskmgr.restartExplorer': return OK({ reason: null, needsAdmin: false, dryRun: true });
        case 'taskmgr.elevatedSetup':
          if (TEST) return OK({ dryRun: true, reason: 'Test Mantle: Windows was not asked for administrator access.', elevated: Object.assign({}, S.elevated) });
          S.elevated = { installed: true, stale: false, running: false, reason: null, version: '1.0.0' }; push();
          return OK({ elevated: Object.assign({}, S.elevated) });
        case 'taskmgr.clearHistory': push(); return OK();
        case 'taskmgr.refresh': push(); return OK();
        case 'taskmgr.sample': push(); return OK({ groups: allRows().length });
        case 'settings.open': return Promise.reject(new Error('no command "settings.open" (mock)'));
        default:
          if (dry) return DRY(`Test Mantle: ${cmd} was not done.`);
          return OK();
      }
    },
  };
  window.addEventListener('load', () => {
    window.mantle.emit('taskmgr.icons', { 'mantle:self': MANTLE_ICON });
    setTimeout(() => {
      const click = (sel) => { const el = document.querySelector(sel); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
      if (mode === 'expanded') click(`[data-key="${apps[0].key}"] [data-act="expand"]`);
      if (mode === 'search') { const i = document.getElementById('q'); i.value = 'zzz'; i.dispatchEvent(new Event('input', { bubbles: true })); }
      setTimeout(() => { document.documentElement.dataset.ready = '1'; document.documentElement.dataset.shot = '1'; }, 250);
    }, 80);
  });
}());
