/* mock-mantle.js - plays main for the task manager page when it is opened over file:// without Electron
 * (headless shots: shoot.js; page tests: testkit.js). The real preload.js defines window.mantle first, so
 * under Electron this file does nothing. EVERY app, number, user and state here is MADE UP.
 * It mocks every field of the contract (mantle-wt/TM-SPEC.md) so each page draws before the data lane lands.
 *
 * Query:
 *   mock=apps (default) | expanded | game | protected | failed | hung | search | loading | error | nobridge
 *   view=<page id>          the page main opens on (processes, performance, apphistory, startup, users,
 *                           details, services, game, settings)
 *   nulls=1                 every optional (nullable) field is null: the em dashes and their reasons
 *   fail=a,b                those commands answer { ok:false, reason }
 *   admin=a,b               those commands answer { ok:false, needsAdmin:true, reason }
 *   missing=a,b             those commands do not exist (the bridge rejects 'no command "taskmgr.x"')
 *   old=1                   an OLD main: 'view' answers 'apps' for every page but game, and the model has
 *                           none of the new page data (perf, startup, users, details, services, apphistory)
 *   test=1                  model.test (a test Mantle: every action is a dry run)
 *   elev=none|stale|ok      model.elevated (default none: not set up)
 *   glass=active|inactive|dark   the stand-in for Windows' acrylic under the page
 *   paused=1                settings.updateSpeed 'paused'
 * needsConfirm: a write (endPid / priority / affinity / efficiency / uacVirt / dump) on a critical pid (4, 412, 640,
 *                         720, 860, 880) or act close/force on a Windows-processes row answers { ok:false, needsConfirm,
 *                         title, text, check?, button? } until it comes again with confirmed:true.
 * When the page has settled, <html data-shot="1">. window.__mockCalls lists every call made.
 * window.__mock = { S (the mutable state), model(), push() } for tests that need a state no query gives.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  const q = new URLSearchParams(location.search);
  const mode = q.get('mock') || 'apps';
  const list = (k) => (q.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const NULLS = q.get('nulls') === '1', OLD = q.get('old') === '1';
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

  /* ---------------------------------------------------------------- Processes rows (+ their new fields) */
  let n = 0;
  const PUB = { 'chrome.exe': 'Google LLC', 'Discord.exe': 'Discord Inc.', 'Code.exe': 'Microsoft Corporation', 'steam.exe': 'Valve Corporation', 'Notepad.exe': 'Microsoft Corporation', 'Spotify.exe': 'Spotify AB', 'Lively.exe': 'rocksdanister', 'OneDrive.exe': 'Microsoft Corporation', 'lghub.exe': 'Logitech, Inc.', 'vgtray.exe': 'Riot Games, Inc.', 'dwm.exe': 'Microsoft Corporation', 'explorer.exe': 'Microsoft Corporation', 'svchost.exe': 'Microsoft Corporation', 'electron.exe': 'Mantle' };
  const grp = (name, file, mem, cpu, o) => {
    n++;
    const pid = 1000 + n * 40;
    const count = (o && o.count) || 1;
    const kind = (o && o.kind) || 'app';
    const disk = cpu > 3 ? 1.6 * MB : cpu > 0.5 ? 0.12 * MB : 0;
    const net = file === 'chrome.exe' ? 410000 : file === 'Discord.exe' ? 24000 : file === 'steam.exe' ? 3000 : 0;
    const gpu = file === 'chrome.exe' ? 3.1 : file === 'dwm.exe' ? 2.4 : file === 'Code.exe' ? 0.4 : 0;
    const power = cpu > 5 ? 'High' : cpu > 1 ? 'Moderate' : cpu > 0.3 ? 'Low' : 'Very low';
    const fields = (p, i, c) => ({ disk: nn(c ? disk / count : disk), net: nn(c ? net / count : net), gpu: nn(c ? (i === 0 ? gpu : 0) : gpu), gpuEngine: nn(gpu ? 'GPU 0 - 3D' : null),
      status: null, efficiency: false, suspended: false, type: kind === 'mantle' ? 'app' : kind, publisher: nn(PUB[file] || null), pid: p, processName: file,
      cmdline: nn(`"C:\\Program Files\\Made Up\\${file}"${i ? ` --type=renderer --id=${i}` : ''}`), power: nn(power), powerTrend: nn(power === 'High' ? 'Moderate' : power) });
    const members = Array.from({ length: count }, (_, i) => Object.assign({ pid: pid + i, file, name: i === 0 ? name : `${name} (${file})`, mem: i === 0 ? Math.round(mem * 0.4) : Math.round((mem * 0.6) / Math.max(1, count - 1)), cpu: i === 1 ? cpu : 0, windows: i === 0 ? 1 : 0, title: i === 0 && o && o.title ? o.title : null }, fields(pid + i, i, true)));
    return Object.assign({ key: `${pid}|1`, identity: `c:\\apps\\${file}`, name, file, mem, cpu, count, windows: 1, kind, protected: null, game: false, handledBy: null, elevated: false,
      icon: null, iconWhy: 'No icon (made-up app)', canReveal: true, hung: false, actions: { close: true, force: true, trim: true, why: null }, state: null, members, path: `C:\\Program Files\\Made Up\\${file}` }, fields(pid, 0, false), o || {});
  };
  const LOCKED = { close: false, force: false, trim: false };
  const apps = [
    grp('Google Chrome', 'chrome.exe', 1843 * MB, 6.2, { count: 21, title: 'Made-up tab - Google Chrome' }),
    grp('Discord', 'Discord.exe', 412 * MB, 0.8, { count: 6 }),
    grp('Visual Studio Code', 'Code.exe', 655 * MB, 1.3, { count: 11 }),
    grp('Steam', 'steam.exe', 238 * MB, 0.2, { count: 4 }),
    grp('Notepad', 'Notepad.exe', 38 * MB, 0, {}),
  ];
  const background = [
    grp('Spotify', 'Spotify.exe', 312 * MB, 0.4, { count: 5, windows: 0, kind: 'background', handledBy: 'spotify' }),
    grp('Lively Wallpaper', 'Lively.exe', 146 * MB, 0.9, { count: 3, windows: 0, kind: 'background', protected: 'Lively, your wallpaper app: Mantle never closes it', actions: LOCKED }),
    grp('OneDrive', 'OneDrive.exe', 96 * MB, 0.1, { windows: 0, kind: 'background', efficiency: true, status: 'Efficiency mode' }),
    grp('Logitech G HUB', 'lghub.exe', 88 * MB, 0.3, { count: 3, windows: 0, kind: 'background', elevated: true }),
    grp('Vanguard tray notification', 'vgtray.exe', 7 * MB, 0, { windows: 0, kind: 'background', protected: "A game's anti-cheat: closing it stops the game from starting", actions: LOCKED, suspended: true, status: 'Suspended' }),
  ];
  const windows = [
    grp('Desktop Window Manager', 'dwm.exe', 120 * MB, 1.1, { windows: 0, kind: 'windows', protected: 'Part of Windows: Windows needs it running', actions: LOCKED }),
    grp('Windows Explorer', 'explorer.exe', 164 * MB, 0.4, { windows: 1, kind: 'windows', protected: "Windows' shell (Explorer): closing it takes the desktop and file windows with it", actions: LOCKED }),
    grp('Service Host: Windows Audio', 'svchost.exe', 31 * MB, 0.2, { windows: 0, kind: 'windows', protected: 'A Windows service: Windows needs it running', actions: LOCKED }),
    grp('Service Host: Network Service', 'svchost.exe', 28 * MB, 0, { windows: 0, kind: 'windows', protected: 'A Windows service: Windows needs it running', actions: LOCKED }),
    grp('Service Host: Diagnostic Policy', 'svchost.exe', 24 * MB, 0, { windows: 0, kind: 'windows', protected: 'A Windows service: Windows needs it running', actions: LOCKED }),
  ];
  const mantleRow = grp('Mantle', 'electron.exe', 273 * MB, 0.6, { count: 9, windows: 0, kind: 'mantle', protected: 'Mantle itself: close Mantle from its tray menu', actions: LOCKED, icon: 'mantle:self', iconWhy: null });
  if (mode === 'hung') { apps[4].hung = true; apps[4].status = 'Not responding'; }
  if (mode === 'failed') {
    apps[1].state = { state: 'still-running', why: 'Its window closed but it kept running in the background (probably in the tray). Force close ends it.' };
    apps[3].state = { state: 'failed', why: 'Not closed: access denied: it runs as administrator or is protected' };
    apps[2].state = { state: 'trimmed', before: 655 * MB, after: 214 * MB };
  }
  const allRows = () => [mantleRow].concat(apps, background, windows);

  /* ---------------------------------------------------------------- Performance */
  const hist = { cpu: wave(48, 22, 12, 5, 2), mem: wave(48, 64, 2, 11, 0.4) };
  const h60 = (base, amp, per, step) => wave(60, base, amp, per, step).map((v) => Math.min(100, v));
  const perf = () => ({
    cpu: { pct: 23, kernelPct: 6, hist: h60(22, 12, 5, 2), kernelHist: h60(6, 3, 4, 0.5), perCore: Array.from({ length: 8 }, (_, c) => h60(14 + c * 3, 10, 3 + c, 2)),
      name: '12th Gen Intel(R) Core(TM) i3-1215U', speedGHz: nn(2.83), baseGHz: nn(1.2), sockets: nn(1), cores: nn(6), logical: 8, virtualization: nn('Enabled'),
      l1KB: nn(544), l2KB: nn(4608), l3KB: nn(10240), procs: 247, threads: nn(3480), handles: nn(112345), uptimeSec: 3 * 86400 + 5 * 3600 + 23 * 60 + 11 },
    mem: { total: 16 * GB, used: 10.6 * GB, avail: 5.4 * GB, committed: 14.2 * GB, commitLimit: 22.5 * GB, cached: nn(4.9 * GB), pagedPool: nn(612 * MB), nonPagedPool: nn(498 * MB), compressed: nn(402 * MB),
      composition: NULLS ? null : { inUse: 10.4 * GB, modified: 0.2 * GB, standby: 4.7 * GB, free: 0.7 * GB }, hist: h60(64, 2, 11, 0.4), speedMTs: nn(4267), slotsUsed: nn(2), slotsTotal: nn(2), formFactor: nn('Row of chips'), hardwareReserved: nn(298 * MB) },
    disks: [
      { id: 'disk0', name: 'Disk 0 (C:)', model: nn('NVMe Made-Up SSD 512GB'), type: nn('SSD'), activePct: 3, respMs: nn(0.6), readBps: 1.2 * MB, writeBps: 420 * 1024, hist: h60(3, 3, 3, 1), readHist: h60(1, 1, 3, 0.3).map((v) => v * MB), writeHist: h60(0.4, 0.4, 4, 0.1).map((v) => v * MB), capacity: nn(512 * 1000 ** 3), formatted: nn(476 * GB), systemDisk: true, pageFile: true },
      { id: 'disk1', name: 'Disk 1 (D:)', model: nn('USB Made-Up Drive'), type: nn('HDD'), activePct: 0, respMs: nn(0), readBps: 0, writeBps: 0, hist: h60(0, 0.5, 6, 0), readHist: Array(60).fill(0), writeHist: Array(60).fill(0), capacity: nn(1000 ** 4), formatted: nn(931 * GB), systemDisk: false, pageFile: false },
    ],
    nets: [
      { id: 'wifi', name: 'Wi-Fi', adapter: 'Made-Up Wi-Fi 6 AX201', kind: 'Wi-Fi', sendBps: 26000, recvBps: 410000, sendHist: h60(30, 25, 4, 6).map((v) => v * 1000), recvHist: h60(400, 300, 5, 40).map((v) => v * 1000),
        ssid: nn('Made-Up Network'), connType: nn('802.11ax'), ipv4: nn('192.0.2.24'), ipv6: nn('fe80::1c2b:3a4d:5e6f:7a8b%14'), signal: nn(3) },
      { id: 'eth', name: 'Ethernet', adapter: 'Made-Up USB GbE', kind: 'Ethernet', sendBps: 0, recvBps: 0, sendHist: Array(60).fill(0), recvHist: Array(60).fill(0), ssid: null, connType: nn('Ethernet'), ipv4: null, ipv6: null, signal: null },
    ],
    gpus: [
      { id: 'gpu0', name: 'Intel(R) UHD Graphics', pct: 4, engines: [{ name: '3D', pct: 4, hist: h60(4, 4, 3, 1) }, { name: 'Copy', pct: 0, hist: h60(0, 1, 6, 0) }, { name: 'Video Encode', pct: 0, hist: Array(60).fill(0) }, { name: 'Video Decode', pct: 1, hist: h60(1, 1, 5, 0) }],
        dedicatedUsed: nn(0), dedicatedTotal: nn(128 * MB), sharedUsed: nn(612 * MB), sharedTotal: nn(5.9 * GB), dedHist: Array(60).fill(0), sharedHist: h60(3.8, 0.3, 9, 0.1),
        driverVersion: nn('31.0.101.5592'), driverDate: nn('2026-06-12'), directX: nn('DirectX 12 (FL 12.1)'), location: nn('PCI bus 0, device 2, function 0'), reserved: nn(0) },
    ],
  });

  /* ---------------------------------------------------------------- App history, Startup, Users, Details, Services */
  const apphistory = () => ({
    since: new Date(2026, 9, 1).getTime(), source: 'mantle', error: null,
    rows: [['Google Chrome', 41520, 2.1 * GB, 0, 0], ['Discord', 9300, 640 * MB, 0, 0], ['Visual Studio Code', 18200, 120 * MB, 0, 0], ['Spotify', 6100, 1.4 * GB, 0, 0], ['Steam', 2400, 8.2 * GB, 0, 0], ['Notepad', 120, 0, 0, 0], ['Microsoft Store', 300, 45 * MB, 0, 3]]
      .map(([name, cpu, net, metered, tiles]) => ({ name, identity: name.toLowerCase(), cpuTimeSec: cpu, net, metered, tiles: nn(tiles), nonMetered: net, downloads: nn(Math.round(net * 0.9)), uploads: nn(Math.round(net * 0.1)) })),
  });
  const startup = () => ({
    biosSec: nn(7.4), error: null,
    rows: [
      ['discord', 'Discord', 'Discord Inc.', true, 'High', 'Registry', 'Update.exe --processStart Discord.exe'],
      ['spotify', 'Spotify', 'Spotify AB', true, 'Medium', 'Registry', 'Spotify.exe --autostart --minimized'],
      ['steam', 'Steam', 'Valve Corporation', true, 'High', 'Registry', 'steam.exe -silent'],
      ['onedrive', 'Microsoft OneDrive', 'Microsoft Corporation', true, 'Medium', 'Registry', 'OneDrive.exe /background'],
      ['teams', 'Microsoft Teams', 'Microsoft Corporation', false, 'None', 'Task', 'ms-teams.exe msteams:system-initiated'],
      ['ghub', 'Logitech G HUB', 'Logitech, Inc.', true, 'Low', 'Registry', 'lghub.exe --background'],
      ['secui', 'Windows Security notification icon', 'Microsoft Corporation', true, 'Low', 'Registry', 'SecurityHealthSystray.exe'],
      ['lively', 'Lively Wallpaper', null, true, null, 'Folder', 'Lively.exe'],
    ].map(([item, name, pub, en, impact, type, cmd], i) => ({ item, name, publisher: nn(pub), enabled: en, impact: NULLS ? null : impact, type, diskIO: nn(impact === 'High' ? 38 * MB : 4 * MB), cpuMs: nn(impact === 'High' ? 2100 : 300),
      running: i < 4 || i === 5, disabledAt: en ? null : new Date(2026, 8, 3, 18, 2).getTime(), cmdline: cmd, path: `C:\\Program Files\\Made Up\\${cmd.split(' ')[0]}` })),
  });
  const users = () => ({
    rows: [{ session: 1, user: 'alex', fullName: nn('Alex Made-Up'), status: '', cpu: 14.3, mem: 6.9 * GB, disk: nn(1.7 * MB), net: nn(437000),
      procs: apps.concat(background).map((g) => ({ name: g.name, pid: g.pid, cpu: g.cpu, mem: g.mem, disk: g.disk, net: g.net, processName: g.file })) }],
  });
  const SYS = [['System', 4, 'SYSTEM', 0.3, 0.1, 'Windows Kernel'], ['Registry', 120, 'SYSTEM', 0, 12, 'Windows Registry'], ['smss.exe', 412, 'SYSTEM', 0, 0.4, 'Windows Session Manager'],
    ['csrss.exe', 640, 'SYSTEM', 0.1, 1.6, 'Client Server Runtime Process'], ['wininit.exe', 720, 'SYSTEM', 0, 1.1, 'Windows Start-Up Application'], ['services.exe', 860, 'SYSTEM', 0.1, 4.8, 'Services and Controller app'],
    ['lsass.exe', 880, 'SYSTEM', 0, 7.2, 'Local Security Authority Process'], ['svchost.exe', 1012, 'NETWORK SERVICE', 0, 9.8, 'Host Process for Windows Services'], ['svchost.exe', 1100, 'LOCAL SERVICE', 0.2, 6.1, 'Host Process for Windows Services']];
  const details = () => {
    const rows = [];
    const add = (name, pid, user, cpu, memMB, desc, extra) => rows.push(Object.assign({ pid, created: 1000 + pid, name, status: 'Running', user: nn(user), cpu, mem: memMB * MB, arch: nn('x64'), desc: nn(desc), path: nn(`C:\\Windows\\System32\\${name}`),
      sessionId: user === 'alex' ? 1 : 0, jobId: nn(null), cpuTimeSec: Math.round(cpu * 900 + pid / 10), cycles: nn(pid * 1e7), ws: memMB * 1.3 * MB, wsPeak: memMB * 1.8 * MB, wsDelta: 0, privateWs: memMB * MB, sharedWs: memMB * 0.3 * MB,
      commit: memMB * 1.2 * MB, pagedPool: nn(220 * 1024), npPool: nn(18 * 1024), pageFaults: pid * 31, pfDelta: 0, basePriority: 'Normal', handles: 200 + (pid % 900), threads: 4 + (pid % 30), userObjects: user === 'alex' ? 12 : 0, gdiObjects: user === 'alex' ? 30 : 0,
      ioReads: pid * 3, ioWrites: pid, ioOther: pid * 5, ioReadBytes: pid * 4096, ioWriteBytes: pid * 1024, ioOtherBytes: pid * 512, cmdline: nn(`${name}`), osContext: nn('Windows 10'), platform: '64 bit', elevated: user !== 'alex',
      uacVirt: user === 'alex' ? 'Disabled' : 'Not allowed', dep: 'Enabled', enterprise: nn('N/A'), powerThrottling: 'Disabled', shadowStack: nn('Compatible'), packageName: nn(null) }, extra || {}));
    for (const g of apps.concat(background)) for (const m of g.members) add(m.file, m.pid, 'alex', m.cpu, Math.round(m.mem / MB), g.name, { path: g.path, status: g.hung && m.pid === g.pid ? 'Not responding' : g.suspended ? 'Suspended' : 'Running' });
    for (const s of SYS) add(s[0], s[1], s[2], s[3], s[4], s[5]);
    return { rows, error: null };
  };
  const SVC = [['AudioSrv', 'Windows Audio', 1100, 'Manages audio for Windows-based programs.', 'Running', 'LocalServiceNetworkRestricted'], ['BITS', 'Background Intelligent Transfer Service', null, 'Transfers files in the background using idle network bandwidth.', 'Stopped', 'netsvcs'],
    ['Dhcp', 'DHCP Client', 1012, 'Registers and updates IP addresses and DNS records for this computer.', 'Running', 'LocalServiceNetworkRestricted'], ['Dnscache', 'DNS Client', 1012, 'Caches Domain Name System (DNS) names.', 'Running', 'NetworkService'],
    ['EventLog', 'Windows Event Log', 1100, 'Manages events and event logs.', 'Running', 'LocalServiceNetworkRestricted'], ['Spooler', 'Print Spooler', 2400, 'Spools print jobs and handles interaction with the printer.', 'Running', null],
    ['wuauserv', 'Windows Update', null, 'Enables the detection, download, and installation of updates for Windows and other programs.', 'Stopped', 'netsvcs'], ['WSearch', 'Windows Search', 3120, 'Provides content indexing and property caching for files, email and other content.', 'Running', null],
    ['SysMain', 'SysMain', 1100, 'Maintains and improves system performance over time.', 'Running', 'LocalSystemNetworkRestricted'], ['Themes', 'Themes', 1012, 'Provides user experience theme management.', 'Running', 'netsvcs'],
    ['XblGameSave', 'Xbox Live Game Save', null, 'This service syncs save data for Xbox Live save enabled games.', 'Stopped', 'netsvcs'], ['vgc', 'vgc', 5120, 'Made-up anti-cheat service.', 'Running', null]];
  const services = () => ({ rows: SVC.map(([name, display, pid, desc, status, group]) => ({ name, display, pid, desc: nn(desc), status, group: nn(group) })), error: null });

  /* ---------------------------------------------------------------- the model */
  const ticks = new Set(mode === 'game' ? ['c:\\apps\\chrome.exe', 'c:\\apps\\Discord.exe', 'c:\\apps\\Code.exe'] : []);
  const reopen = new Set(mode === 'game' ? ['c:\\apps\\Discord.exe', 'c:\\apps\\Code.exe'] : []);
  const S = {
    view: (q.get('view') || (mode === 'game' ? 'game' : 'processes')), auto: false,
    settings: { theme: 'system', startPage: 'processes', updateSpeed: q.get('paused') === '1' ? 'paused' : 'normal', alwaysOnTop: false, minimizeOnUse: false, hideWhenMinimized: false, fullAccountName: false, historyAllProcesses: false, askBeforeEfficiency: true },
    elevated: { none: { installed: false, stale: false, running: false, reason: 'Not set up yet' }, stale: { installed: true, stale: true, running: false, reason: 'Set up for an older Mantle: set it up again' }, ok: { installed: true, stale: false, running: true, reason: null } }[q.get('elev') || 'none'],
    apps, background, windows, mantleRow, details, services, startup,
  };
  function model() {
    const all = apps.concat(background);
    const prep = all.map((g) => {
      const why = g.handledBy === 'spotify' ? 'Handled by the Spotify card: it closes an idle Spotify when a game starts' : g.protected || null;
      return { key: g.key, identity: g.identity, name: g.name, mem: g.mem, kind: g.kind, tickable: !why, why, ticked: !why && ticks.has(g.identity), reopen: !why && reopen.has(g.identity),
        elevated: g.elevated, icon: null, reopenWhy: g.name === 'Visual Studio Code' && reopen.has(g.identity) ? 'Cannot reopen: A Store app: Mantle cannot start it from its exe (open it from Start after the game)' : null };
    });
    const v = S.view;
    const m = {
      at: Date.now(), test: q.get('test') === '1', error: mode === 'error' ? 'Mantle could not read the list of running apps (made-up reason). Trying again.' : null, view: OLD && v !== 'game' ? 'apps' : v,
      cpu: 23, hist, mem: { total: 16 * GB, avail: 5.4 * GB, used: 10.6 * GB }, cpus: 8, mantle: { mem: mantleRow.mem, count: 9, cpu: 0.6 },
      apps, background, windows, mantleRow, recent: mode === 'failed' ? [{ name: 'Notepad', text: 'Closed · freed about 38 MB', ok: true }] : [],
      prep: { rows: prep, absent: mode === 'game' ? [{ identity: 'c:\\apps\\obs64.exe', name: 'OBS Studio', reopen: false }] : [], auto: S.auto,
        lastFree: null, lastAuto: mode === 'game' ? { at: new Date(2026, 8, 27, 20, 5).getTime(), game: 'VALORANT', freed: 1260 * MB, results: [{ name: 'Google Chrome', state: 'closed' }, { name: 'Discord', state: 'still-running', why: 'Its window closed but it kept running in the background (probably in the tray). Force close ends it.' }], reopened: { results: [{ name: 'Discord', ok: true }] } } : null },
      loaded: mode !== 'loading' && mode !== 'error',
      look: { material: 'acrylic', icon: true, iconWhy: null, light: glass !== 'dark', lightWhy: glass === 'dark' ? "the glass is Windows' dark backdrop: the light frame was not set (mock)" : null },
    };
    if (OLD) return m;
    m.totals = { cpu: 23, mem: 66, disk: nn(3), net: nn(1), gpu: nn(4) };
    m.settings = Object.assign({}, S.settings);
    m.elevated = S.elevated;
    // the page data travels only while its page is on screen (cpu + mem always, for the header totals)
    const p = perf();
    m.perf = v === 'performance' ? p : { cpu: p.cpu, mem: p.mem };
    if (v === 'apphistory') m.apphistory = apphistory();
    if (v === 'startup') m.startup = S.startup();
    if (v === 'users') m.users = users();
    if (v === 'details') m.details = S.details();
    if (v === 'services') m.services = S.services();
    // tm-pg-au: apphistory + users. Query ah=srum|empty (App history's source / no rows), users=1 (only the one
    // user). Adds a non-app row (shown by Settings > historyAllProcesses), a row with a path, and a second,
    // disconnected user; alex is the current session. All made up.
    if (m.apphistory) {
      const A = m.apphistory;
      A.rows.forEach((r) => { if (r.name === 'Microsoft Store') r.path = 'C:\\Program Files\\WindowsApps\\MadeUp.Store\\WinStore.App.exe'; });
      A.rows.push({ name: 'Made-up Background Service', identity: 'made-up-bgsvc', app: false, cpuTimeSec: 905, net: 1.2 * MB, metered: 0, tiles: nn(0), nonMetered: 1.2 * MB, downloads: nn(MB), uploads: nn(0.2 * MB) });
      if (q.get('ah') === 'srum') A.source = 'srum';
      if (q.get('ah') === 'empty') A.rows = [];
      if (NULLS) { A.since = null; A.rows.forEach((r) => { r.net = null; r.metered = null; r.nonMetered = null; }); if (A.rows[0]) A.rows[0].why = { net: 'Made-up reason: this row says why its network is not known' }; }
    }
    if (m.users && q.get('users') !== '1') {
      m.users.rows[0].current = true;
      m.users.rows.push({ session: 2, user: 'jordan', fullName: nn('Jordan Made-Up'), status: 'Disconnected', cpu: 0, mem: 412 * MB, disk: nn(0), net: nn(0),
        procs: [{ name: 'Made-up Notes', pid: 5120, created: 6120, cpu: 0, mem: 180 * MB, disk: nn(0), net: nn(0), processName: 'notes.exe' },
          { name: 'Made-up Sync', pid: 5188, created: 6188, cpu: 0, mem: 232 * MB, disk: nn(0), net: nn(0), processName: 'sync.exe', path: 'C:\\Program Files\\Made Up\\sync.exe' }] });
    }
    return m;
  }
  const push = () => setTimeout(() => window.mantle.emit('taskmgr.model', model()), 10);
  window.__mock = { S, model, push };

  /* ---------------------------------------------------------------- Windows' confirm wording (made-up targets, Windows' words) */
  const CRIT = { 4: 'System', 412: 'smss.exe', 640: 'csrss.exe', 720: 'wininit.exe', 860: 'services.exe', 880: 'lsass.exe' };
  function needsConfirm(cmd, a) {
    const nm = CRIT[a.pid];
    const base = { ok: false, needsConfirm: true };
    if (cmd === 'endPid' && nm) return Object.assign(base, a.tree ? { title: `Do you want to end the process tree of '${nm}'?`, text: 'Ending this process tree will shut down the operating system immediately. You will lose all unsaved data. Are you sure you want to continue?', check: 'Abandon unsaved data and shut down.', button: 'Shut down' }
      : { title: `Do you want to end the system process '${nm}'?`, text: 'Ending this process will shut down the operating system immediately. You will lose all unsaved data. Are you sure you want to continue?', check: 'Abandon unsaved data and shut down.', button: 'Shut down' });
    if (cmd === 'priority' && nm) return Object.assign(base, { title: `Do you want to change the priority of '${nm}'?`, text: 'Changing the priority of certain processes could cause system instability.', button: 'Change priority' });
    if (cmd === 'affinity' && nm) return Object.assign(base, { title: `Do you want to change the affinity of '${nm}'?`, text: 'Changing the affinity of certain processes could cause system instability.', button: 'OK' });
    if ((cmd === 'uacVirt' || cmd === 'dump' || cmd === 'efficiency') && nm) return Object.assign(base, { title: `Do you want to change '${nm}'?`, text: 'Changing a system process could cause system instability.', button: 'Continue' });
    if (cmd === 'act' && (a.action === 'close' || a.action === 'force')) { const g = windows.find((x) => x.key === a.key); if (g) return Object.assign(base, { title: `Do you want to end ${g.name}?`, text: 'If an open program is associated with this process, it will close and you will lose any unsaved data. If you end a system process, it might result in system instability. Are you sure you want to continue?', button: 'End process' }); }
    return null;
  }

  /* ---------------------------------------------------------------- the commands */
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
      if (ADMIN.has(cmd)) return OK({ ok: false, needsAdmin: true, reason: 'Access is denied: Windows needs administrator rights for this (made-up reason).' });
      if (FAIL.has(cmd)) return OK({ ok: false, reason: `Made-up failure for ${cmd}.` });
      // a write aimed at a system or critical process: Windows' own warning words; the page asks, then resends confirmed
      if (!args.confirmed) { const c = needsConfirm(cmd, args); if (c) return OK(c); }
      switch (name) {
        case 'taskmgr.state': return Promise.resolve(model());
        case 'taskmgr.view': S.view = args.view === 'apps' ? 'processes' : args.view; push(); return OK({ view: OLD && S.view !== 'game' ? 'apps' : S.view });
        case 'taskmgr.tick':
          if (args.on !== undefined) { if (args.on) ticks.add(args.identity); else ticks.delete(args.identity); }
          if (args.reopen !== undefined) { if (args.reopen) reopen.add(args.identity); else reopen.delete(args.identity); }
          push(); return OK();
        case 'taskmgr.auto': S.auto = !!args.on; push(); return OK({ auto: S.auto });
        case 'taskmgr.act': return new Promise((r) => setTimeout(() => r({ ok: true, dryRun: true }), 150));
        case 'taskmgr.reveal': return DRY('Test Mantle: File Explorer was not opened.');
        case 'taskmgr.expand': push(); return OK({ key: args.key, open: !!args.open });
        case 'taskmgr.setting': if (args.key in S.settings) { S.settings[args.key] = args.value; push(); return OK({ key: args.key, value: args.value }); } return OK({ ok: false, reason: `No setting called "${args.key}".` });
        case 'taskmgr.runTask': return DRY(`Test Mantle: "${args.cmd}" was not run${args.admin ? ' (as administrator)' : ''}.`);
        case 'taskmgr.browse': return OK({ path: 'C:\\Program Files\\Made Up\\tool.exe' });
        case 'taskmgr.dump': return OK({ path: `C:\\Users\\alex\\AppData\\Local\\Temp\\made-up-${args.pid}.DMP` });
        case 'taskmgr.waitChain': return OK({ threads: [{ tid: 4012, state: 'Waiting', on: 'made-up.exe (PID 2244)' }] });
        case 'taskmgr.goToServices': return OK({ names: args.pid === 1012 ? ['Dhcp', 'Dnscache', 'Themes'] : [] });
        case 'taskmgr.elevatedSetup': S.elevated = { installed: true, stale: false, running: true, reason: null }; push(); return OK({ dryRun: true, reason: 'Test Mantle: no Windows prompt was shown.' });
        case 'settings.open': return Promise.reject(new Error('no command "settings.open" (mock)'));
        case 'taskmgr.sample': push(); return OK();
        default:
          if (args.dryRun) return DRY(`Test Mantle: ${cmd} was not done.`);
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
