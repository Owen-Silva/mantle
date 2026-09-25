/* mock-mantle.js — a stand-in for the preload bridge, and ONLY when there isn't one.
 *
 * WHY this file exists: the bar has to be designed and eyeballed without Electron running (lane A
 * owns the main process; running Electron here would put a window over Owen's screen). So when the
 * page is opened straight off disk in a browser there is no `window.mantle`, and every
 * subscription would silently do nothing — the exact failure mode we refuse. This file fills that
 * hole with a fake bridge that behaves like the real one: same channel names, same payload shapes,
 * the same {ok, reason, …} reply envelope, async replies (30 ms, so code that assumes a
 * synchronous answer breaks here rather than in production), and a console line per call.
 *
 * WHY the `if (window.mantle) return` guard: inside Electron the preload has already installed
 * the real bridge before any page script runs. This file must never shadow it — a mock that
 * quietly replaced the real bridge would make a broken build look healthy.
 *
 * URL switches for eyeballing / manual poking:
 *   ?mock=1       explicit opt-in; the mock installs itself with or without it, this just documents intent
 *   ?bg=1         paint a loud wallpaper behind the page, MOCK ONLY (see below)
 *   ?reveal=0     never send the fake 'bar.reveal', so the flush (hidden) state can be inspected
 *   ?mode=pill    reveal as the floating pill (24px, bordered all round); ?mode=edge is the default
 *   ?hideAt=1800  send 'bar.hide' that many ms after load, to watch the fade out
 *   ?hidefx=1     loop it: hide, reveal, hide, reveal, one every 2s, for judging the exit by eye
 *                 (each hide carries ms:320 the way main does, so the page's own cap is exercised)
 *   ?apps=N       N pinned items instead of 12 (proves the centred row, the slide and the clip)
 *   ?qs=fail      Bluetooth and brightness come back ok:false, so the panel's muted-with-a-reason
 *                 path is on screen instead of having to be imagined
 *   ?wifi= ?scan= ?kbd= ?audio= ?mixer= ?bt= ?btwatch=   the Wi-Fi list, output picker, mixer and
 *                 Bluetooth device states (qs-more.js); listed at "quick settings, one level down" below
 *   ?net=X        the network readout: connected (default), no-internet, wifi-off, disconnected,
 *                 ethernet, error; __mockMain.net(X) pushes a change
 *   ?qsdelay=MS   qs.set answers that late, so the optimistic tile and its pending state show
 *   ?qsset=refuse every switch comes back refused with its part unchanged (the spring-back + note)
 *   ?state=down   sidecar reported down, so the amber status chip is on screen
 *   ?edge=top     pretend the bar is docked at the top (bar.js also honours this)
 *   ?media=X      now playing, in main's 'media' payload shape (main.js NOW PLAYING): playing,
 *                 paused, noctl (an app that refuses next/previous: greyed WITH reasons),
 *                 lessonplayer (only an LessonPlayer lesson: the LessonPlayer rule, NO CHIP at all), both (LessonPlayer
 *                 current AND a player: the chip shows the player), off (the old sidecar: a reason)
 *   ?pick=lessonplayer with media=both: as if LessonPlayer had been picked in the card's source switcher,
 *                 the one way left to see the LessonPlayer "controls off" card
 *   ?tray=1       a readable tray: a white icon, a coloured one, two hidden ones. A page that
 *                 sets window.__MOCK_TRAY__ before this file runs (ui/bar/shoot.js does, from a
 *                 real sidecar listing) gets that list instead, so real icons can be eyeballed
 *                 without committing anybody's tray to the repo.
 */
(function () {
  'use strict';

  if (window.mantle) return;                 // real bridge present: do nothing at all.

  var q = new URLSearchParams(location.search);
  var SIDECAR_DOWN = q.get('state') === 'down';
  var REVEAL = q.get('reveal') !== '0';
  var MODE = q.get('mode') === 'pill' ? 'pill' : 'edge';
  var HIDE_AT = parseInt(q.get('hideAt'), 10) || 0;
  var HIDE_FX = q.get('hidefx') === '1';     // loop hide/reveal so the exit can be watched repeatedly
  /* 12 pins + the 2 running below = the 14 icons the live bar actually has, which is the count
     that overflowed at 1120px. The mock has to be able to reproduce that or the fit rule is
     untested. ?apps=N overrides it. */
  var PIN_COUNT = q.get('apps') === null ? 12 : Math.max(0, parseInt(q.get('apps'), 10) || 0);

  /* Northwind's --dur-nav / the hide budget main works to. The mock sends them the way main does, so
     the page is never the thing that decides how long the morph lasts. */
  var DUR_IN = 560, DUR_OUT = 320;

  /* ?bg=1 — a stand-in wallpaper, and ONLY here inside the mock, so nothing in the shipped bar
     can ever paint outside the bar element. In Electron the window is transparent and DWM blurs
     the real desktop behind it; on disk there is nothing behind the page at all, so a view over
     white would make the glass look solid and any contrast judgement meaningless. These are
     saturated, hostile colours on purpose: if the text survives THIS, a wallpaper is no threat.
     Painted on <html> only; <body> stays transparent. */
  if (q.get('bg') === '1') {
    document.documentElement.style.background =
      'linear-gradient(90deg,#0b0d10 0%,#2f6fe0 12%,#0b0d10 22%,#d64545 34%,#1f8f4e 46%,' +
      '#0b0d10 56%,#b23fd0 68%,#e0a059 80%,#0b0d10 90%,#2f6fe0 100%)';
    console.log('[mock] ?bg=1: wallpaper stand-in painted on <html> (mock only)');
  }

  /* Two genuine 32x32 PNGs (generated, not placeholders) so the icon path is exercised with
     real bitmaps; two items carry icon:null + an iconReason so the letter tile and its
     explanation are exercised too. Real Windows icons arrive from the sidecar as PNG data URLs. */
  var ICON_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiklEQVR42mNgGIxA28r1Py3wgFpOlCNobTleR9DLcqyOoLflGI4YdQA+RUVrT4HxgDgAZjmtHEGyA6jtCJKigBaOIDoR0soRJOUCWjiC5GxIbUeQVQ5Q0xFDzwEDGgUDmggHNBsOaEFErOUbtu7HiYd2ZTTg1fFoi2hYt4wHX8dkUHTNBkXnlN4AAH64+BZg5hbDAAAAAElFTkSuQmCC';
  var ICON_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAlUlEQVR42u2X3Q2AMAiEO4zvvruJ2zmam+gAbcodBrg0NuGpgfuaUH5aUzzHvj0RVioOQUSLTyGyxIcQ2eIdBON0X+fUwgAsYQ8IDMCKoxAQABOYhTABPK9ifGgAb6K6AKwgX+8pADQpmRhuACbzf4A1AUqSsOQblhciiVJc3owk2rHEQCIxki03GestJhKrmcRymn1e2n9aWzMoGqMAAAAASUVORK5CYII=';

  /* The eight pinned apps Owen would actually have, in taskbar order, then two apps that are
     running but not pinned (after the hairline). One window is the active one. */
  /* The three window counts a taskbar has to get right are 0, 1 and "several", so the fixtures
     cover all three: Edge has 3 (one of them minimized) and is therefore the action:'list' case,
     Code has 1, Spotify/Steam/Notion have 0. `aumid` rides along the way the real items do, and
     'app:Microsoft.WindowsCalculator…' is a packaged-app pin, whose id is not an exe path. */
  var PINNED = [
    { id: 'edge',    name: 'Microsoft Edge',  exe: 'msedge.exe',   aumid: 'MSEdge', icon: ICON_A,
      wins: ['Mantle build brief — Edge', 'Windows 11 shell docs — Edge', 'Northwind — example.com — Edge'], min: 2 },
    { id: 'code',    name: 'Visual Studio Code', exe: 'Code.exe',  aumid: 'Microsoft.VisualStudioCode', icon: ICON_B, wins: ['mantle — bar.js — Visual Studio Code'], active: 0 },
    { id: 'app:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: 'Calculator', exe: '', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', icon: ICON_A, wins: [] },
    { id: 'term',    name: 'Terminal',        exe: 'wt.exe',       aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', icon: ICON_A, wins: ['Windows PowerShell'] },
    { id: 'files',   name: 'File Explorer',   exe: 'explorer.exe', icon: null, iconReason: 'the sidecar could not extract an icon from explorer.exe (access denied)', wins: [] },
    { id: 'spotify', name: 'Spotify',         exe: 'Spotify.exe',  icon: ICON_B, wins: [] },
    { id: 'mail',    name: 'Mail',            exe: 'olk.exe',      icon: null, iconReason: 'packaged app: no icon path in the .lnk', wins: ['Inbox (14) — Mail'] },
    { id: 'steam',   name: 'Steam',           exe: 'steam.exe',    icon: ICON_A, wins: [] },
    { id: 'notion',  name: 'Notion',          exe: 'Notion.exe',   icon: ICON_B, wins: [] },
    /* the four that overflowed live in build 20: at 1120px, 12 pins + 2 running need 582px in a
       728px span, so the dock must SLIDE left and stay whole rather than cut Riot in half. */
    { id: 'riot',    name: 'Riot Client',     exe: 'RiotClientServices.exe', aumid: 'RiotClient', icon: ICON_A, wins: [] },
    { id: 'comet',   name: 'Comet',           exe: 'Comet.exe',    aumid: 'Comet', icon: ICON_B, wins: [] },
    { id: 'discord', name: 'Discord',         exe: 'Discord.exe',  aumid: 'Discord', icon: ICON_A, wins: ['#general — Discord'] },
    { id: 'obs',     name: 'OBS Studio',      exe: 'obs64.exe',    aumid: 'OBS', icon: ICON_B, wins: [] }
  ];
  var RUNNING = [
    { id: 'settings', name: 'Settings',   exe: 'SystemSettings.exe', icon: ICON_B, wins: ['Settings'] },
    { id: 'taskmgr',  name: 'Task Manager', exe: 'Taskmgr.exe',      icon: ICON_A, wins: ['Task Manager'] }
  ];

  var nextHwnd = 100000;
  function build(list, kind) {
    return list.slice(0, kind === 'pinned' ? PIN_COUNT : list.length).map(function (a, i) {
      return {
        id: a.id, name: a.name, kind: kind, exe: a.exe, aumid: a.aumid || '',
        icon: a.icon || null,
        iconReason: a.icon ? '' : (a.iconReason || 'no icon and no reason was given'),
        windows: a.wins.map(function (t, j) {
          return {
            hwnd: (a._h || (a._h = (nextHwnd += 17))) + j,
            title: t,
            active: a.active === j,
            minimized: a.min === j
          };
        })
      };
    });
  }
  var items = build(PINNED, 'pinned').concat(build(RUNNING, 'running'));

  /* The flat window list the 'windows' channel carries: the same handles the items above hold, so
     the dots the bar repaints from this push agree with what bar.pinned said. */
  function flatWindows() {
    var out = [];
    items.forEach(function (it) {
      it.windows.forEach(function (w) { out.push({ hwnd: w.hwnd, title: w.title, active: w.active, foreground: w.active, minimized: !!w.minimized }); });
    });
    return out;
  }

  /* ?jl=<scenario> - lib/features/jumplist.js replies, in the sidecar's shape (sidecar/JumpList.cs):
       (default)  Pinned 2, Recent 6, Tasks 3        long   Pinned 5, Recent 12, a named list 8, Tasks 4 (scrolls)
       none       an app that publishes no jump list  error  the read failed        off   switched off in the tray
       part       Tasks read, the recent items failed ms=N  answer after N ms (default 40) */
  var JL = q.get('jl') || '';
  var JL_MS = parseInt(q.get('jlms'), 10) || 40;
  function jlItems(n, prefix, kind, icon, names) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = names && names[i % names.length] ? names[i % names.length] + (i >= names.length ? ' (' + (i + 1) + ')' : '') : prefix + ' ' + (i + 1);
      out.push({ title: t, tip: 'C:\\Users\\owen\\Documents\\' + t, icon: i % 3 === 2 ? null : icon, item: (kind === 'task' ? 'c:1:' : 'a:') + (i + 1), kind: kind, pinned: prefix === 'pinned', canRemove: kind === 'item' && prefix !== 'pinned' });
    }
    return out;
  }
  function jumpList() {
    var DOCS = ['Q3 project plan.xlsx', 'Meeting notes v2.docx', 'Mantle design.md', 'Lease agreement.pdf', 'Screenshot 2026-09-24.png', 'Contacts list.csv', 'Budget.xlsx', 'Proposal draft - final.docx'];
    var TASKS = [{ title: 'New window' }, { title: 'New InPrivate window' }, { title: 'Open a new tab in a very long named profile that has to be cut short' }];
    var tasks = TASKS.map(function (t, i) { return { title: t.title, tip: 'msedge.exe --new-window', icon: ICON_A, item: 'c:1:' + i, kind: 'task', pinned: false, canRemove: false }; });
    var r = { ok: true, appid: 'MSEdge', hash: 'ccba5a5986c77e43', how: 'window', cached: false, ms: { total: 12 }, none: null, error: null, note: null, sections: [] };
    if (JL === 'off') return { ok: false, off: true, reason: 'jump lists are switched off in the tray' };
    if (JL === 'error') return { ok: false, reason: 'its recent items could not be read (the file is busy: The process cannot access the file because it is being used by another process.)' };
    if (JL === 'none') { r.none = "this app doesn't publish one"; return r; }
    if (JL === 'part') { r.sections = [{ name: 'Tasks', kind: 'tasks', items: tasks }]; r.error = 'its recent items could not be read (not a compound file (0x80030050))'; return r; }
    var long = JL === 'long';
    r.sections.push({ name: 'Pinned', kind: 'pinned', items: jlItems(long ? 5 : 2, 'pinned', 'item', ICON_B, DOCS.slice(3)) });
    r.sections.push({ name: 'Recent', kind: 'recent', items: jlItems(long ? 12 : 6, 'recent', 'item', ICON_B, DOCS) });
    if (long) r.sections.push({ name: 'Most visited', kind: 'custom', items: jlItems(8, 'Site', 'link', ICON_A, ['GitHub', 'Northwind dashboard', 'LessonPlayer', 'YouTube', 'Sports scores', 'Gmail', 'Robinhood', 'Claude']) });
    r.sections.push({ name: 'Tasks', kind: 'tasks', items: long ? tasks.concat([{ sep: true }, { title: 'Settings', tip: 'msedge.exe edge://settings', icon: ICON_A, item: 'c:1:9', kind: 'task' }]) : tasks });
    return r;
  }

  function state() {
    return {
      mode: 'test',
      edge: q.get('edge') === 'top' ? 'top' : 'bottom',
      /* These shapes are lane A's State contract, not the mock's invention: sidecar.status is
         'ok' | 'starting' | 'down', tray.status is 'ok' | 'unavailable', hotkey.winTap and
         tray.watch are booleans, bar is {mode, revealed, reason}. If the contract moves again,
         this object moves with it — a mock that drifts from the bridge is worse than no mock,
         because the bar then looks healthy in a shot and silent in production (it cost exactly
         that: the status chips vanished from one round of screenshots before anyone noticed). */
      sidecar: SIDECAR_DOWN
        ? { status: 'down', reason: 'sidecar exited: exit code 1' }
        : { status: 'ok', reason: '' },
      taskbar: { hidden: true, reason: '' },        // test mode never touches the real taskbar
      desktop: { attached: true, reason: '' },
      tray: TRAY
        ? { status: 'ok', watch: true, reason: TRAY.length + ' notification-area items (mock)' }
        : { status: 'unavailable', watch: false, reason: 'explorer exposes 0 legacy tray buttons on this build' },
      hotkey: { winTap: false, reason: 'test mode: hook not installed' },
      bar: { mode: MODE, revealed: revealed, reason: '' }
    };
  }

  var volume = { level: 0.42, muted: false };
  /* The speaker as main sends it (volume.get, and the 'volume' push since 2026-09-23): whole
     percentages 0-100, the sidecar's scale. The mock kept 0-1 inside and sent that out, so its
     first frame read "Volume 0%". */
  function volumeReading() { return { ok: true, level: Math.round(volume.level * 100), muted: volume.muted, reason: null }; }

  /* ---- the battery (2026-09-23) -----------------------------------------
     Readings in exactly the sidecar's shape (sidecar/Battery.cs), so the words and the glyph are
     drawn by the real ui/bar/battery.js. ?battery=<name> picks one; __mockMain.battery(name)
     pushes another, the way main does on a plug or an unplug. The default is the look the mock
     always had (72 %, on battery, 3 hr 4 min left), so the older shots do not move. `plugged` is
     the case the old readout got wrong: on AC, held at a charge limit, NOT charging. */
  var BATTERY = {
    battery:   { percent: 72, ac: false, secondsLeft: 184 * 60 },
    charging:  { percent: 72, ac: true, charging: true },
    plugged:   { percent: 60, ac: true },
    full:      { percent: 100, ac: true },
    unplugged: { percent: 72, ac: false, reason: 'Windows has not estimated the time left yet' },
    saver:     { percent: 18, ac: false, secondsLeft: 47 * 60, saver: true, low: true },
    unknown:   { percent: null, ac: true, reason: 'Windows does not know the battery percentage yet' },
    none:      { percent: null, ac: true, present: false, reason: 'this machine has no battery, so it always runs on mains power' },
    error:     { ok: false, reason: 'Windows would not report the power status (GetSystemPowerStatus failed, Win32 error 5)' }
  };
  function batteryReading(name) {
    var b = BATTERY[name] || BATTERY.battery;
    if (b.ok === false) {
      return { ok: false, present: null, percent: null, ac: null, charging: false, secondsLeft: null, saver: false,
        onBattery: false, minutesLeft: null, hasBattery: null, reason: b.reason };
    }
    var secs = typeof b.secondsLeft === 'number' ? b.secondsLeft : null;
    return {
      ok: true, present: b.present !== false, percent: b.percent, ac: b.ac, charging: !!b.charging,
      secondsLeft: secs, saver: !!b.saver, low: !!b.low, critical: false,
      onBattery: b.ac === false, minutesLeft: secs === null ? null : Math.floor(secs / 60), hasBattery: b.present !== false,
      reason: b.reason || null
    };
  }
  var batteryNow = batteryReading(q.get('battery') || 'battery');

  /* ---- the network readout (2026-09-23) ----------------------------------
     Readings in exactly the sidecar's shape (sidecar/NetState.cs), so the words and the glyph are
     drawn by the real ui/bar/net.js. ?net=<name> picks one; __mockMain.net(name) pushes another,
     the way main does when the route or the internet changes. The default is the laptop on Wi-Fi
     with internet - what the fixed drawing always showed - so the older shots do not move. */
  var NET = {
    connected:     { state: 'connected', kind: 'wifi', internet: true },
    'no-internet': { state: 'no-internet', kind: 'wifi', internet: false, local: true, connectivity: 0x22 },
    'wifi-off':    { state: 'wifi-off', kind: 'none', internet: false, wifiOn: false },
    disconnected:  { state: 'disconnected', kind: 'none', internet: false, wifiOn: true },
    ethernet:      { state: 'connected', kind: 'ethernet', internet: true, adapter: 'Ethernet' },
    error:         { ok: false, reason: 'the network is not being read: the sidecar exited (code 1)' }
  };
  function netReading(name) {
    var n = NET[name] || NET.connected;
    if (n.ok === false) return { ok: false, state: 'unknown', kind: 'none', internet: null, reason: n.reason, via: 'mock' };
    var up = n.kind === 'wifi';
    var wifi = n.kind === 'ethernet'
      ? { present: null, on: null, connected: false, ssid: null, signal: 0, band: null, reason: 'not read: the internet goes through Ethernet' }
      : { present: true, on: n.wifiOn !== false, connected: up, ssid: up ? 'Maple-5G' : null,
          signal: up ? 82 : 0, band: up ? '5 GHz' : null, reason: null };
    return {
      ok: true, state: n.state, kind: n.kind, internet: n.internet, local: !!n.local,
      connectivity: typeof n.connectivity === 'number' ? n.connectivity : (n.internet ? 0x440 : 0),
      adapter: n.kind === 'none' ? null : (n.adapter || 'Wi-Fi'), adapterType: n.kind === 'none' ? null : n.kind,
      wifi: wifi, reason: null, via: 'mock', ms: 0
    };
  }
  var netNow = netReading(q.get('net') || 'connected');
  function netPush(name) { netNow = netReading(name); emit('net', netNow); return netNow; }

  /* ---- quick settings -------------------------------------------------
     Plausible values for a laptop on Wi-Fi. ?qs=fail breaks TWO parts (Bluetooth and brightness)
     with real-sounding reasons, because the panel's whole contract is that a part it cannot read
     renders muted WITH its reason rather than blank — and that path has to be eyeballable. */
  var QS_FAIL = q.get('qs') === 'fail';
  /* ?qsdelay=<ms>: qs.set answers that late (a radio under load took 260-510 ms, measured
     2026-09-23), so the optimistic tile and its pending state can be seen and timed.
     ?qsset=refuse: every switch is turned down with its part read back unchanged, the way the
     sidecar reports a switch Windows would not make, so the spring-back and its note show. */
  var QS_DELAY = Math.max(0, Number(q.get('qsdelay')) || 0);
  var QS_REFUSE = q.get('qsset') === 'refuse';
  var qsState = {
    volume:     { level: volume.level, muted: volume.muted, ok: true, reason: '' },
    wifi:       { present: true, on: true, connected: true, ssid: 'Maple-5G', signal: 82, band: '5 GHz', ok: true, reason: '' },
    bluetooth:  QS_FAIL
      ? { present: true, on: false, via: '', ok: false, reason: 'the Bluetooth radio did not answer within 3s (Get-PnpDevice timed out)' }
      : { present: true, on: true, via: 'PowerShell', ok: true, reason: '' },
    brightness: QS_FAIL
      ? { present: false, level: null, ok: false, reason: 'this display exposes no WmiMonitorBrightness instance (desktop monitor)' }
      : { present: true, level: 0.66, ok: true, reason: '' },
    nightlight: { present: true, on: false, ok: true, reason: '' },
    power:      batteryNow                  // the sidecar's `power` is the battery reading (Battery.cs)
  };
  if (netNow.ok && netNow.wifi.on === false) { qsState.wifi.on = false; qsState.wifi.connected = false; qsState.wifi.ssid = ''; }
  var qsWatching = false, qsTimer = 0;

  function qsSnapshot() {
    qsState.volume.level = volume.level;
    qsState.volume.muted = volume.muted;
    /* qs.get reports levels 0-100 (the sidecar's own scale; bar.js divides by 100). The mock keeps
       0-1 inside, and until 2026-09-23 sent that straight out, so the panel read "0%" and "1%". */
    var pct = function (part) {
      return typeof part.level === 'number' ? Object.assign({}, part, { level: Math.round(part.level * 100) }) : part;
    };
    return {
      ok: true, reason: '',
      volume: pct(qsState.volume), wifi: qsState.wifi, bluetooth: qsState.bluetooth,
      brightness: pct(qsState.brightness), nightlight: qsState.nightlight, power: qsState.power
    };
  }

  function qsPush() {
    if (!qsWatching) return;
    emit('qs', qsSnapshot());
  }

  /* The real watch (2026-09-23; it was a 2 s re-read) pushes every part once when it starts, then
     only what changes. The mock does the same - one push when the watch goes on, one per change
     after - and stops dead when it is turned off: a mock that kept pushing would hide exactly the
     leak the watch is there to prevent. */
  function qsLoop() {
    if (qsTimer) clearTimeout(qsTimer);
    qsTimer = 0;
    if (!qsWatching) return;
    qsTimer = setTimeout(function () { qsTimer = 0; qsPush(); }, 60);
  }

  /* ---- quick settings, one level down (ui/bar/qs-more.js) -------------------------------
     Main's qs.wifi.* / qs.audio.* / qs.keyboard replies, in the sidecar's shapes (sidecar/Wlan.cs,
     sidecar/AudioMixer.cs). The network names are made up: nobody's real neighbours in the repo.
       ?wifi=list (default) | connecting | failed | off | none | empty | error
       ?scan=hold     the scan never finishes, so "Scanning…" can be looked at
       ?kbd=refused   qs.keyboard says no, as it does in a test instance
       ?audio=1|4     playback devices (default 2)
       ?mixer=0|3|8|error   apps with sound (default 3); 8 brings the long names
     THE MOCK NEVER KEEPS A WI-FI PASSWORD: qs.wifi.connect checks the sidecar's rule (8-63
     printable characters, or 64 hex digits), then drops it; the call log redacts it; and whether a
     connect fails depends on the NETWORK ("Cafe WiFi" always does), never on what was typed. */
  var WIFI = q.get('wifi') || 'list';
  var SCAN_HOLD = q.get('scan') === 'hold';
  var KBD_REFUSED = q.get('kbd') === 'refused';
  var AUDIO_N = q.get('audio') === '1' ? 1 : q.get('audio') === '4' ? 4 : 2;
  var MIXER = q.get('mixer') || '3';

  function hexOf(s) {
    var b = new TextEncoder().encode(s || ''), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase();
    return out;
  }
  var ENT_WHY = 'it uses enterprise (802.1X) sign-in - a user name and password or a certificate - which Windows\' own Wi-Fi list asks for';
  var wifiNets = [
    { ssid: 'Maple-5G', security: 'WPA3-Personal', kind: 'personal', signal: 82, known: true, connected: WIFI !== 'connecting' },
    { ssid: 'Maple-Guest', security: 'WPA2-Personal', kind: 'personal', signal: 74, known: true },
    { ssid: 'xfinitywifi', security: 'Open', kind: 'open', signal: 40, known: true },
    { ssid: 'Cafe WiFi', security: 'WPA2-Personal', kind: 'personal', signal: 88 },
    { ssid: 'NETGEAR-4F2A', security: 'WPA3-Personal', kind: 'personal', signal: 55 },
    { ssid: 'CoffeeHouse Free WiFi', security: 'Open', kind: 'open', signal: 47 },
    { ssid: 'Lakeview Plaza Staff Network (5 GHz) - Building B', security: 'WPA2-Enterprise', kind: 'settings', signal: 36 },
    { ssid: 'DIRECT-bm-EPSON-ET-2800 Series', security: 'WPA2-Personal', kind: 'personal', signal: 18 },
    { ssid: '', security: 'WPA2-Personal', kind: 'personal', signal: 30, hidden: true }
  ];
  var wifiConnecting = WIFI === 'connecting' ? 'Maple-5G' : null;   // Windows is mid-join on it
  var wifiLast = WIFI === 'failed'
    ? { op: 'connect', ok: false, ssid: 'Cafe WiFi', reason: 'PSK mismatch suspected (the profile Mantle had just saved for it was removed again)', at: Date.now() - 40000 }
    : null;

  function wifiRow(n) {
    var action, why = null;
    if (n.connected) action = 'disconnect';
    else if (n.hidden) { action = 'settings'; why = 'it hides its name, and joining it means typing that name, which Windows\' own Wi-Fi list asks for'; }
    else if (n.known) action = 'connect';
    else if (n.kind === 'open') action = 'open';
    else if (n.kind === 'personal') action = 'password';
    else { action = 'settings'; why = ENT_WHY; }
    return {
      ssid: n.hidden ? null : n.ssid, hex: n.hidden ? '' : hexOf(n.ssid), hidden: !!n.hidden, signal: n.signal,
      secure: n.kind !== 'open', security: n.security, known: !!n.known, connected: !!n.connected,
      connecting: !n.connected && wifiConnecting === n.ssid, action: action, why: why
    };
  }

  function wifiList() {
    var base = { iface: null, networks: [], connecting: null, last: null, scannedAgoMs: null, readMs: 3 };
    if (WIFI === 'none') return Object.assign(base, { ok: true, present: false, on: false, reason: 'this machine has no Wi-Fi adapter' });
    if (WIFI === 'error') return Object.assign(base, { ok: false, present: true, on: false, reason: 'the Wi-Fi networks could not be read (WlanGetAvailableNetworkList: The group or resource is not in the correct state to perform the requested operation)' });
    if (WIFI === 'off' || qsState.wifi.on === false) return Object.assign(base, { ok: true, present: true, on: false, reason: 'the Wi-Fi radio is switched off' });
    var nets = WIFI === 'empty' ? [] : wifiNets.slice();
    // the sidecar's order: connected, saved, the rest, hidden last; each by signal
    function rank(n) { return n.connected ? 0 : n.hidden ? 3 : n.known ? 1 : 2; }
    nets.sort(function (a, b) { return rank(a) - rank(b) || b.signal - a.signal; });
    return Object.assign(base, {
      ok: true, present: true, on: true, reason: null,
      iface: { name: 'Intel(R) Wi-Fi 6E AX211 160MHz', state: wifiConnecting ? 'associating' : 'connected', count: 1 },
      networks: nets.map(wifiRow),
      connecting: wifiConnecting ? { ssid: wifiConnecting, ms: 1800 } : null,
      last: wifiLast ? { op: wifiLast.op, ok: wifiLast.ok, ssid: wifiLast.ssid, reason: wifiLast.reason, agoMs: Date.now() - wifiLast.at } : null,
      scannedAgoMs: 2500
    });
  }

  function later(ms, value) { return new Promise(function (res) { setTimeout(function () { res(value); }, ms); }); }

  /* the same rule as Wlan.CheckPassword: a mock that accepted what the sidecar refuses would hide
     the refusal path. The value itself is looked at here and nowhere else, then dropped. */
  function mockPasswordProblem(pw) {
    if (pw.length === 64 && /^[0-9a-fA-F]{64}$/.test(pw)) return null;
    if (pw.length < 8) return 'a Wi-Fi password is at least 8 characters';
    if (pw.length > 63) return 'a Wi-Fi password is at most 63 characters (or exactly 64 hex digits)';
    if (!/^[\x20-\x7e]+$/.test(pw)) return 'a Wi-Fi password may only use the printable ASCII characters (letters, digits, spaces and symbols)';
    return null;
  }

  function wifiConnect(p) {
    var hasPw = typeof p.password === 'string' && p.password.length > 0;
    var pwBad = hasPw ? mockPasswordProblem(p.password) : null;
    delete p.password;
    var n = null;
    wifiNets.forEach(function (x) { if (!x.hidden && (p.hex ? hexOf(x.ssid) === p.hex : x.ssid === p.ssid)) n = x; });
    var label = 'Mantle could not connect to "' + (p.ssid || 'that network') + '"';
    if (!n) return { ok: false, reason: label + ': "' + (p.ssid || p.hex) + '" is not in range any more (it is not in Windows\' list of networks); refresh and try again' };
    if (pwBad) return { ok: false, reason: label + ': wlan connect: ' + pwBad };
    var out = function (ok, reason, code) {
      wifiLast = { op: 'connect', ok: ok, ssid: n.ssid, reason: reason, at: Date.now() };
      return {
        ok: ok, op: 'connect', ssid: n.ssid, connected: ok, code: code || 0, codeHex: '0x' + (code || 0).toString(16),
        ms: 1400, wifi: { ok: true, present: true, on: true, connected: ok, ssid: ok ? n.ssid : 'Maple-5G' }, reason: reason
      };
    };
    if (n.kind === 'settings') return later(300, out(false, ENT_WHY, 0));
    if (n.kind === 'personal' && !n.known && !hasPw) return later(300, out(false, '"' + n.ssid + '" needs its password', 0));
    if (n.kind === 'open' && hasPw) return later(300, out(false, '"' + n.ssid + '" is an open network: it takes no password', 0));
    wifiConnecting = n.ssid;
    return later(1400, null).then(function () {
      wifiConnecting = null;
      if (n.ssid === 'Cafe WiFi') return out(false, 'PSK mismatch suspected (the profile Mantle had just saved for it was removed again)', 0x48014);
      wifiNets.forEach(function (x) { x.connected = x === n; });
      n.known = true;
      qsState.wifi.connected = true; qsState.wifi.ssid = n.ssid; qsState.wifi.signal = n.signal;
      setTimeout(qsPush, 0);
      return out(true, null, 0);
    });
  }

  function wifiDisconnect() {
    var was = null;
    wifiNets.forEach(function (x) { if (x.connected) { was = x.ssid; x.connected = false; } });
    qsState.wifi.connected = false; qsState.wifi.ssid = '';
    setTimeout(qsPush, 0);
    wifiLast = { op: 'disconnect', ok: true, ssid: was, reason: null, at: Date.now() };
    return later(500, { ok: true, op: 'disconnect', ssid: was, connected: false, code: 0, codeHex: '0x0', ms: 480, wifi: { ok: true, present: true, on: true, connected: false }, reason: null });
  }

  var audioDevs = [
    { id: '{0.0.0.00000000}.{mock-0001-speakers}', name: 'Speakers (Realtek(R) Audio)' },
    { id: '{0.0.0.00000000}.{mock-0002-headset}', name: 'Headphones (WH-1000XM4 Stereo)' },
    { id: '{0.0.0.00000000}.{mock-0003-monitor}', name: 'DELL S2721DGF (NVIDIA High Definition Audio)' },
    { id: '{0.0.0.00000000}.{mock-0004-usb}', name: 'Speakers (USB Audio CODEC)' }
  ].slice(0, AUDIO_N);
  var audioDefault = audioDevs[0].id;
  var audioCalls = AUDIO_N === 4 ? audioDevs[1].id : audioDevs[0].id;   // with 4, calls stay on the headset

  function audioDevices() {
    var list = audioDevs.map(function (d) {
      return {
        id: d.id, name: d.name, isDefault: d.id === audioDefault,
        roles: { console: d.id === audioDefault, multimedia: d.id === audioDefault, communications: d.id === audioCalls }
      };
    });
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return { ok: true, devices: list, defaultId: audioDefault, readMs: 4, reason: null };
  }

  /* A real icon is a PNG data URL from the sidecar; two made-up ones here exercise the <img> path,
     and the rest exercise the letter-with-a-reason path. */
  function appIcon(color) {
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<circle cx="8" cy="8" r="7" fill="' + color + '"/><path d="M4.5 6.2c2.4-.8 4.9-.6 7 .6M5 8.4c2-.6 4-.4 5.7.5M5.6 10.5c1.5-.4 3-.3 4.3.4" ' +
      'fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>');
  }
  var mixApps = [
    { key: 'system', pid: 0, system: true, name: 'System Sounds', path: null, active: false, level: 100, muted: false, sessions: 1 },
    { key: 'pid:4120', pid: 4120, name: 'Spotify', path: 'C:\\Users\\user\\AppData\\Roaming\\Spotify\\Spotify.exe', active: true, level: 64, muted: false, sessions: 1, icon: appIcon('#1db954') },
    { key: 'pid:9876', pid: 9876, name: 'Microsoft Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', active: false, level: 100, muted: false, sessions: 3, icon: appIcon('#2f6fe0') },
    { key: 'pid:5512', pid: 5512, name: 'LessonPlayer Learning Accelerator - Algebra II, Unit 4 Lesson 14 video player', path: 'C:\\Program Files\\LessonPlayer\\LessonPlayer.exe', active: true, level: 80, muted: false, sessions: 1, iconReason: 'no icon (LessonPlayer.exe: the mock bridge has no icons)' },
    { key: 'pid:2231', pid: 2231, name: 'Discord', path: 'C:\\Users\\user\\AppData\\Local\\Discord\\app-1.0.9212\\Discord.exe', active: false, level: 45, muted: true, sessions: 2, iconReason: 'no icon (Discord.exe: the mock bridge has no icons)' },
    { key: 'pid:7710', pid: 7710, name: 'Minecraft Launcher', path: 'C:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe', active: false, level: 100, muted: false, sessions: 1, iconReason: 'no icon (Minecraft.exe: the mock bridge has no icons)' },
    { key: 'sid:190233', pid: 0, name: 'Windows Audio Device Graph Isolation host process for a shared session', path: null, active: false, level: 100, muted: false, sessions: 1, iconReason: 'no icon: Windows gave no program path for this app' },
    { key: 'pid:3302', pid: 3302, name: 'Zoom Workplace', path: 'C:\\Users\\user\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe', active: true, level: 72, muted: false, sessions: 1, iconReason: 'no icon (Zoom.exe: the mock bridge has no icons)' }
  ];
  mixApps = MIXER === '0' ? [] : MIXER === '8' ? mixApps : mixApps.slice(0, 3);

  function audioSessions() {
    var dev = audioDevs.filter(function (d) { return d.id === audioDefault; })[0];
    if (MIXER === 'error') {
      return { ok: false, device: { id: dev.id, name: dev.name }, sessions: [], readMs: 3,
        reason: 'the apps playing sound cannot be read: the output device refused the session manager (HRESULT 0x88890004)' };
    }
    return { ok: true, device: { id: dev.id, name: dev.name }, sessions: mixApps.map(function (a) { return Object.assign({}, a); }), readMs: 6, reason: null };
  }

  function audioSession(p) {
    var a = mixApps.filter(function (x) { return x.key === (p && p.key); })[0];
    if (!a) return { ok: false, key: p && p.key, session: null, ms: 5, reason: 'that app has no audio session on the current output any more (it may have stopped or closed)' };
    if (typeof p.level === 'number') a.level = Math.max(0, Math.min(100, Math.round(p.level)));
    if (typeof p.muted === 'boolean') a.muted = p.muted;
    var row = Object.assign({}, a);
    delete row.icon; delete row.iconReason;       // main decorates icons on sessions, not on a set's reply
    return { ok: true, key: a.key, session: row, ms: 5, reason: null };
  }

  /* ---- quick settings, one level down: Bluetooth (2026-09-23) --------------------------------
     Main's qs.bt.* replies in the sidecar's shape (sidecar/BtDevices.cs), and its 'btdevices' push
     after a connect or disconnect, the way the sidecar's DeviceWatcher sends one. The kinds and
     every reason are the real ones measured on Owen's machine; the product names are generic.
       ?bt=6 (default) | 0 | 1 | connecting | failed | off | none | long | error
         connecting   the sidecar has a connect in flight when the view opens (a panel that closed
                      mid-connect), and a new Connect never answers, so "Connecting…" can be held
         failed       every Connect answers ok:false with the sidecar's own after-12-s reason
         off / none   the radio is off / there is no adapter (the Bluetooth tile agrees)
       ?btwatch=fail  the watch will not start, so the view's 3 s re-read and its note show */
  var BT = q.get('bt') || '6';
  var BT_WATCH_FAIL = q.get('btwatch') === 'fail';
  var btWatching = false;
  var BT_NO_ROUTE = 'Mantle can connect and disconnect audio devices only; Windows connects this one itself when it is used';
  function btDev(mac, name, kind, o) {
    var audio = kind === 'headphones' || kind === 'speaker';
    return Object.assign({
      id: 'Bluetooth#Bluetooth02:00:5e:00:00:01-' + mac, name: name, kind: kind, kindFrom: kind === 'other' ? null : 'class',
      connected: false, battery: null, batteryWhy: null, audio: audio, canConnect: audio,
      connectWhy: audio ? null : BT_NO_ROUTE, le: false, address: mac, cod: null, appearance: null, category: null
    }, o || {});
  }
  function btPreset(name) {
    if (name === '0' || name === 'none' || name === 'error') return [];
    if (name === '1') return [btDev('02:00:5e:10:00:01', 'WH-CH520', 'headphones', { connected: true, battery: 80 })];
    if (name === 'long') {
      return [
        btDev('02:00:5e:10:00:01', 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones', 'headphones', { connected: true, battery: 100 }),
        btDev('02:00:5e:10:00:02', 'Bose QuietComfort Ultra Earbuds — Living Room Second Pairing', 'headphones'),
        btDev('02:00:5e:10:00:03', 'Logitech MX Keys S Combo for Mac, Business Edition (Office)', 'keyboard',
          { connected: true, battery: 9, le: true, kindFrom: 'appearance' }),
        btDev('02:00:5e:10:00:04', 'Pixel 8 Pro — Work Profile Hotspot Phone', 'phone'),
        btDev('02:00:5e:10:00:05', 'Living Room TV (Android TV) in the Downstairs Den', 'other')
      ];
    }
    return [
      btDev('02:00:5e:10:00:01', 'WH-CH520', 'headphones', { connected: true, battery: 80 }),
      btDev('02:00:5e:10:00:06', 'MX Master 3S', 'mouse', { connected: true, battery: 45, le: true, kindFrom: 'appearance' }),
      btDev('02:00:5e:10:00:03', 'Keys-To-Go 2', 'keyboard',
        { connected: true, batteryWhy: 'this device does not report its battery to Windows', le: true, kindFrom: 'appearance' }),
      btDev('02:00:5e:10:00:02', 'JBL Flip 6', 'speaker'),
      btDev('02:00:5e:10:00:07', 'Xbox Wireless Controller', 'gamepad'),
      btDev('02:00:5e:10:00:05', 'Living Room TV', 'other')
    ];
  }
  var btDevs = btPreset(BT);
  if (BT === 'off') qsState.bluetooth.on = false;
  if (BT === 'none') { qsState.bluetooth.present = false; qsState.bluetooth.on = false; }

  function btList() {
    var base = { busy: null, last: null, watching: btWatching, watchReason: null, ms: { radio: 19, paired: 18, battery: 15, audio: 12, total: 26 } };
    if (BT === 'error') {
      return Object.assign(base, { ok: false, present: true, on: null, radioReason: null, devices: [],
        reason: 'Windows\' paired-device list did not answer within 3 s' });
    }
    if (BT === 'none' || qsState.bluetooth.present === false) {
      return Object.assign(base, { ok: true, present: false, on: false, radioReason: 'this machine has no Bluetooth radio', devices: [],
        reason: 'this machine has no Bluetooth radio' });
    }
    var on = qsState.bluetooth.on !== false;
    var devs = btDevs.map(function (d) {
      var x = Object.assign({}, d);
      if (!on) { x.connected = false; }
      if (!x.connected) { x.battery = null; x.batteryWhy = null; }
      return x;
    });
    devs.sort(function (a, b) { return a.connected === b.connected ? 0 : a.connected ? -1 : 1; });   // connected first, as the sidecar sends them
    if (BT === 'connecting') base.busy = { device: btDevs[3] ? btDevs[3].id : '', name: btDevs[3] ? btDevs[3].name : '', op: 'connect', ms: 1800 };
    return Object.assign(base, { ok: true, present: true, on: on, radioReason: null, devices: devs, reason: null });
  }

  function btToggle(p, connect) {
    var op = connect ? 'connect' : 'disconnect';
    var d = btDevs.filter(function (x) { return x.id === (p && p.device); })[0];
    if (!d) return { ok: false, op: op, device: p && p.device, name: null, connected: null, reason: 'Windows does not know that Bluetooth device (the device did not answer)' };
    if (BT === 'connecting') return new Promise(function () {});        // held, for a look at "Connecting…"
    return new Promise(function (res) {
      setTimeout(function () {
        if (BT === 'failed' && connect) {
          res({ ok: false, op: op, device: d.id, name: d.name, connected: false, sent: 2, waitedMs: 12000,
            reason: 'Windows asked ' + d.name + ' to connect, but it was still not connected after 12 s (it may be off, out of range, or connected to another device)' });
          return;
        }
        d.connected = connect;
        if (connect && d.kind === 'headphones') d.battery = 70;
        else if (connect && d.battery === null) d.batteryWhy = 'this device does not report its battery to Windows';
        res({ ok: true, op: op, device: d.id, name: d.name, connected: connect, sent: 2, waitedMs: 1500, reason: null });
        if (btWatching) setTimeout(function () { emit('btdevices', Object.assign({ ev: 'btdevices', why: 'a device changed' }, btList())); }, 60);
      }, 1500);                                  // a real connect measured 1-3 s; long enough to see
    });
  }

  /* The bridge copies arguments when it sends them (structured clone), and the log must never
     print a password: both done here, once, for every call. */
  function redacted(payload) {
    if (!payload || typeof payload !== 'object' || !('password' in payload)) return payload || '';
    var copy = Object.assign({}, payload);
    copy.password = '[redacted]';
    return copy;
  }
  /* ---- now playing ----------------------------------------------------
     main's 'media' payload, built the way main.js builds it (NOW PLAYING): sessions, the one
     shown (full, with `can`, timeline and artwork), the pick and why, and the LessonPlayer guard. The
     art is painted on a canvas here, not shipped: it only has to be a real PNG data URL. */
  var MEDIA = q.get('media') || '';
  /* ?pick=lessonplayer starts as if Owen had picked LessonPlayer in the card's source switcher (the only
     way to reach the controls-off card now that LessonPlayer alone shows no chip at all). */
  var mediaPick = q.get('pick') === 'lessonplayer' ? 'Contoso.LessonPlayer_8wekyb3d8bbwe!App' : null;
  var mediaAt = Date.now();

  function tile(size, colors, glyph) {
    var c = document.createElement('canvas'); c.width = size; c.height = size;
    var g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, colors[0]); grad.addColorStop(1, colors[1]);
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    if (glyph) {
      g.fillStyle = 'rgba(255,255,255,.9)';
      g.font = '600 ' + Math.round(size * 0.55) + 'px Segoe UI, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(glyph, size / 2, size / 2 + size * 0.04);
    } else {
      g.fillStyle = 'rgba(255,255,255,.22)';
      g.beginPath(); g.arc(size * 0.68, size * 0.36, size * 0.26, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(11,14,26,.35)'; g.fillRect(0, size * 0.72, size, size * 0.28);
    }
    return c.toDataURL('image/png');
  }
  var SPOT_ICON = null, ACEL_ICON = null, ART = null;
  function icons() {
    if (ART) return;
    SPOT_ICON = tile(32, ['#1ed760', '#169c46'], 'S');
    ACEL_ICON = tile(32, ['#2b6cb0', '#1a4a80'], 'A');
    ART = tile(96, ['#e0a059', '#b23fd0'], null);
  }

  var SPOTIFY = { aumid: 'Spotify.exe', app: { name: 'Spotify', icon: null }, title: 'Midnight City', artist: 'M83',
    album: "Hurry Up, We're Dreaming", status: 'playing', playing: true, lessonplayer: false,
    can: { play: true, pause: true, toggle: true, next: true, previous: true, stop: false, seek: true },
    timeline: { available: true, durationMs: 243000, positionMs: 71000, positionNowMs: 71000 }, rate: 1 };
  var LESSONPLAYER = { aumid: 'Contoso.LessonPlayer_8wekyb3d8bbwe!App', app: { name: 'LessonPlayer', icon: null }, title: 'LessonPlayer',
    artist: 'Student', album: null, status: 'playing', playing: true, lessonplayer: true,
    can: { play: true, pause: true, toggle: true, next: false, previous: false, stop: false, seek: false },
    timeline: { available: false, reason: 'LessonPlayer does not publish a position or length' }, rate: 1 };
  var RADIO = { aumid: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', app: { name: 'Media Player', icon: null },
    title: 'Morning news bulletin', artist: 'BBC Radio 4', album: null, status: 'playing', playing: true, lessonplayer: false,
    can: { play: false, pause: true, toggle: true, next: false, previous: false, stop: true, seek: false },
    timeline: { available: false, reason: 'Media Player does not publish a position or length' }, rate: 1 };

  function mediaSessions() {
    icons();
    SPOTIFY.app.icon = SPOT_ICON; SPOTIFY.artwork = ART;
    LESSONPLAYER.app.icon = ACEL_ICON; LESSONPLAYER.artwork = null; LESSONPLAYER.artworkReason = 'LessonPlayer publishes no thumbnail';
    if (MEDIA === 'playing') return [SPOTIFY];
    if (MEDIA === 'paused') { SPOTIFY.status = 'paused'; SPOTIFY.playing = false; return [SPOTIFY]; }
    if (MEDIA === 'noctl') return [RADIO];
    if (MEDIA === 'lessonplayer') return [LESSONPLAYER];
    if (MEDIA === 'both') return [LESSONPLAYER, SPOTIFY];
    return [];
  }

  function mediaPayload() {
    var guard = { on: true, reason: "LessonPlayer lesson \u00b7 controls off so a stray click can't pause it",
      how: 'Mantle leaves LessonPlayer alone while you record lessons; start Mantle with --lessonplayer-media-controls to allow them' };
    if (MEDIA === 'off')
      return { ok: false, present: false, reason: 'this sidecar exe has no "media" command yet (run npm run build:sidecar)',
        guard: guard, sessions: [], shown: null, pick: null, events: false };
    var all = mediaSessions();
    /* Owen's call (2026-09-22), as main.js makes it: when the only session is LessonPlayer there is no
       chip at all, and a pick of LessonPlayer does not outlive the other player. */
    if (all.length && all.every(function (s) { return s.lessonplayer; })) {
      mediaPick = null;
      return { ok: true, present: true, reason: 'only an LessonPlayer lesson has a media session, so the now-playing chip stays hidden (the LessonPlayer rule)',
        rev: 1, guard: guard,
        sessions: all.map(function (s) { return { aumid: s.aumid, app: s.app, title: s.title, artist: s.artist, status: s.status, playing: s.playing, current: true, lessonplayer: s.lessonplayer }; }),
        shown: null, pick: { aumid: null, by: 'lessonplayer-only' }, events: true, eventsReason: null };
    }
    var cur = all[0] || null;               // Windows' current: the first, as the fixtures are ordered
    var shown = null, by = null;
    var picked = mediaPick && all.filter(function (s) { return s.aumid === mediaPick; })[0];
    if (picked) { shown = picked; by = 'you'; }
    else if (cur && !cur.lessonplayer) { shown = cur; by = 'current'; }
    else if (all.some(function (s) { return !s.lessonplayer; })) { shown = all.filter(function (s) { return !s.lessonplayer; })[0]; by = 'lessonplayer-rule'; }
    else if (cur) { shown = cur; by = 'current'; }
    var full = null;
    if (shown) {
      full = JSON.parse(JSON.stringify(shown));
      // the sidecar's estimate at read time: the mock's clock moves it the way the real one does
      if (full.timeline && full.timeline.available && full.playing)
        full.timeline.positionNowMs = Math.min(full.timeline.durationMs, full.timeline.positionMs + (Date.now() - mediaAt));
      full.controls = full.lessonplayer ? { ok: false, reason: guard.reason, how: guard.how } : { ok: true, reason: null, how: null };
    }
    return {
      ok: true, present: all.length > 0, reason: all.length ? null : 'nothing is playing: no app has a media session open',
      rev: 1, guard: guard,
      sessions: all.map(function (s) { return { aumid: s.aumid, app: s.app, title: s.title, artist: s.artist, status: s.status, playing: s.playing, current: s === cur, lessonplayer: s.lessonplayer }; }),
      shown: full, pick: full ? { aumid: full.aumid, by: by } : null, events: true, eventsReason: null
    };
  }

  /* Plays along for a player (flips play/pause, so the glyph can be watched changing) and refuses
     what main refuses: an LessonPlayer target, a missing AUMID, a button the app does not accept. */
  function mediaControl(p) {
    var s = mediaSessions().filter(function (x) { return x.aumid === p.aumid; })[0];
    if (!p.aumid) return { ok: false, reason: 'media.control needs the AUMID of the session the button belongs to, so a press can never land on a different app' };
    if (!s) return { ok: false, reason: 'nothing to control: no media session from ' + p.aumid + ' is open' };
    if (s.lessonplayer) return { ok: false, reason: "LessonPlayer lesson \u00b7 controls off so a stray click can't pause it. (mock: main refuses this whatever the page sends)" };
    if (p.action === 'toggle') {
      if (s.timeline && s.timeline.available && s.playing) s.timeline.positionMs = Math.min(s.timeline.durationMs, s.timeline.positionMs + (Date.now() - mediaAt));
      mediaAt = Date.now();
      s.playing = !s.playing; s.status = s.playing ? 'playing' : 'paused';
      setTimeout(function () { emit('media', mediaPayload()); }, 60);
      return { ok: true, action: p.action, via: 'toggle', aumid: s.aumid };
    }
    if (!s.can[p.action]) return { ok: false, reason: s.app.name + ' does not accept ' + p.action + ' right now' };
    return { ok: true, action: p.action, aumid: s.aumid, mock: true };
  }

  /* ---- tray ------------------------------------------------------------
     ?tray=1: the UIA tray's shape {id, title, icon, exe, promoted, clickable, reason}. The white
     glyph is the case bar.js puts on a plate; the two hidden ones are what the overflow lists. */
  var TRAY = null;
  if (Array.isArray(window.__MOCK_TRAY__)) TRAY = window.__MOCK_TRAY__;
  else if (q.get('tray') === '1') {
    var glyph = function (fg, bg, shape) {
      var c = document.createElement('canvas'); c.width = 20; c.height = 20;
      var g = c.getContext('2d');
      if (bg) { g.fillStyle = bg; g.beginPath(); g.arc(10, 10, 9, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = fg; g.fillStyle = fg; g.lineWidth = 2;
      if (shape === 'ring') { g.beginPath(); g.arc(10, 10, 6, 0.4, Math.PI * 1.8); g.stroke(); g.fillRect(13, 3, 4, 4); }
      else { g.fillRect(5, 5, 10, 10); }
      return c.toDataURL('image/png');
    };
    var HID = 'is in Windows\' hidden-icons flyout, which only exists while that flyout is open, and Mantle never opens it on your screen. Turn it On under Settings > Personalization > Taskbar > Other system tray icons and Mantle can click it (your own taskbar stays auto-hidden).';
    TRAY = [
      { id: 'n:1', title: 'Windows Update: restart required', icon: glyph('#ffffff', null, 'ring'), exe: 'C:\\WINDOWS\\UUS\\amd64\\MoNotificationUx.exe', promoted: true, clickable: true, reason: null },
      { id: 'n:2', title: 'OneDrive', icon: glyph('#2f6fe0', null, 'box'), exe: 'OneDrive.exe', promoted: true, clickable: true, reason: null },
      { id: 'n:3', title: 'Tailscale', icon: glyph('#ffffff', null, 'box'), exe: 'tailscale-ipn.exe', promoted: false, clickable: false, reason: 'Tailscale ' + HID },
      { id: 'n:4', title: 'Windows Security', icon: glyph('#1f8f4e', '#e6f4ea', 'box'), exe: 'SecurityHealthSystray.exe', promoted: false, clickable: false, reason: 'Windows Security ' + HID }
    ];
  }

  /* ?notifs=X — the notification centre (ui/bar/notifications.js), in main's 'notifications'
     payload shape (lib/notifications.js): some (three apps, pictures, two unread), many (enough to
     scroll), plain (no database: text only, and the reason at the bottom), off (the list cannot be
     read: muted bell, chip, reason), none (default: the empty state). Dismiss, clear and open
     play along on this list, so every button can be pressed in a browser. */
  var NOTIFS = q.get('notifs') || 'none';
  var ntfList = (function () {
    var now = Date.now(), m = 60000;
    var chat = tile(32, ['#2f6fe0', '#6d8ff0'], 'D'), mail = tile(32, ['#1f8f4e', '#6cc39a'], 'S'), sec = tile(32, ['#3a4250', '#6b7688'], 'W');
    var base = [
      { id: 104, aumid: 'com.squirrel.Discord.Discord', app: 'Discord', icon: chat, timeMs: now - 2 * m, title: 'Alex', body: 'are you still coming to dinner tonight? we moved it to 7', attribution: '#general', logo: tile(64, ['#b23fd0', '#e0a059'], 'M'), logoCircle: true, opens: 'app', unread: true },
      { id: 103, aumid: 'com.squirrel.Discord.Discord', app: 'Discord', icon: chat, timeMs: now - 26 * m, title: 'Jordan', body: 'sent a picture', attribution: '#clips', hero: tile(180, ['#2f6fe0', '#1f8f4e']), opens: 'app', unread: true },
      { id: 101, aumid: 'com.readdle.SparkDesktop', app: 'Spark', icon: mail, timeMs: now - 3 * 60 * m, title: 'Calendar update', body: 'Your Saturday meeting has moved to 8:15 AM.\nReply to confirm.', opens: 'app', unread: false },
      { id: 37517, aumid: 'Windows.Defender.SecurityCenter', app: 'Windows Security', icon: sec, timeMs: now - 2 * 24 * 60 * m, title: 'Virus & threat protection', body: 'Windows Security scanned your device. No action needed.', opens: 'protocol', unread: false },
      { id: 90, aumid: 'NotifyIconGeneratedAumid_2221369545442751248', app: 'A notification-area icon', icon: null, timeMs: now - 5 * 60 * m, title: 'Sync paused', body: 'Resume from the tray icon.', opens: 'none', opensWhy: 'it came from a notification-area icon, and Windows gives other apps no way to click one', unread: false },
    ];
    if (NOTIFS === 'many') for (var i = 0; i < 8; i++) base.push({ id: 200 + i, aumid: 'com.readdle.SparkDesktop', app: 'Spark', icon: mail, timeMs: now - (4 + i) * 60 * m, title: 'Newsletter ' + (i + 1), body: 'Something long enough to wrap onto a second line of the card, as mail previews do.', opens: 'app', unread: i < 2 });
    if (NOTIFS === 'plain') base.forEach(function (t) { t.logo = null; t.hero = null; t.attribution = null; });
    return (NOTIFS === 'none' || NOTIFS === 'off') ? [] : base;
  })();
  function ntfPayload() {
    if (NOTIFS === 'off') return { ok: false, available: false, reason: 'Windows is not letting apps read your notifications (Settings > Privacy & security > Notifications > Let apps access your notifications is off)', toasts: [], unread: 0, count: 0 };
    return {
      ok: true, available: true, reason: null, access: 'Allowed', via: NOTIFS === 'plain' ? 'listener' : 'listener+database', rev: 1,
      count: ntfList.length, unread: ntfList.filter(function (t) { return t.unread; }).length, toasts: ntfList,
      detail: NOTIFS === 'plain' ? "text only, and new notifications show within 5 s rather than at once: Windows' notification database is not laid out the way Mantle knows (a Windows update may have changed it)" : null,
      seenNote: null,
    };
  }
  function ntfDrop(ids) {
    var removed = [];
    ntfList = ntfList.filter(function (t) { if (ids.indexOf(t.id) >= 0) { removed.push(t.id); return false; } return true; });
    setTimeout(function () { emit('notifications', ntfPayload()); }, 60);
    return { ok: true, reason: null, removed: removed, missing: [], failed: [] };
  }

  var revealed = false;
  var listeners = Object.create(null);

  function emit(channel, payload) {
    var ls = listeners[channel];
    if (!ls) return;
    for (var i = 0; i < ls.length; i++) { try { ls[i](payload); } catch (e) { console.error('[mock] listener threw on', channel, e); } }
  }

  function isActiveHwnd(hwnd) {
    var hit = false;
    items.forEach(function (it) { it.windows.forEach(function (w) { if (w.hwnd === hwnd && w.active) hit = true; }); });
    return hit;
  }

  function focus(hwnd) {
    items.forEach(function (it) {
      it.windows.forEach(function (w) {
        w.active = (w.hwnd === hwnd);
        if (w.active) w.minimized = false;      // focusing a minimized window restores it
      });
    });
  }

  /* Replies. Anything not listed rejects by name, which is what the real bridge should also do:
     a typo in a channel name must surface in the UI, never resolve to undefined. */
  /* ---- power mode (osd lane, 2026-09-24): main's powermode.* over sidecar/PowerMode.cs, in its shape.
       ?pm=balanced (default) | efficiency | performance | battery | saver | hone | error | refuse | slow
         saver    Owen's machine on battery (2026-09-25): Best performance chosen for battery, Energy saver on
                  (it turns on at 100%), so Windows runs efficiency and PowerMode.cs locks the switch
         hone     the plan Owen's machine is on (2026-09-24): muted, with PowerMode.cs's own reason
         error    the plan cannot be read
         refuse   every change is refused with the passive sidecar's reason (springs back)
         slow     a set takes 1.5 s, so pending can be seen
       A set answers with the state READ BACK, and pushes 'powermode' as the sidecar's listener does. */
  var PM = q.get('pm') || 'balanced';
  var pmState = PM === 'error'
    ? { ok: false, mode: null, available: false, reason: 'Windows would not say which power plan is active (error 5)' }
    : PM === 'saver'
      ? { ok: true, mode: 'performance', overlay: 'ded574b5-45a0-4f42-8737-46345c09c238', inForce: 'efficiency', available: true, settable: false,
          by: 'dc', configured: { ac: 'balanced', battery: 'performance' },
          plan: { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced', balanced: true }, source: 'battery', saver: true, saverLevel: 1, saverAt: 100,
          reason: 'Energy saver is on, so Windows runs Best power efficiency and the power mode can’t be set; Best performance (your choice on battery) comes back when it is off. ' +
            'It is set to turn on at 100% battery, so it is on whenever this PC is unplugged: to change that, open Settings > System > Power & battery > Energy saver and turn off "Always use energy saver" (or lower "Turn energy saver on automatically")' }
    : PM === 'hone'
      ? { ok: true, mode: 'balanced', overlay: '00000000-0000-0000-0000-000000000000', available: false,
          plan: { guid: '44444444-4444-4444-4444-444444444452', name: 'Hone Ultimate Power Plan V5', balanced: false }, source: 'ac', saver: false,
          reason: 'Power mode works only on the Balanced power plan, and this PC is on "Hone Ultimate Power Plan V5". Switch to Balanced in Control Panel > Power Options to use it' }
      : { ok: true, mode: PM === 'efficiency' || PM === 'performance' ? PM : 'balanced', available: true,
          plan: { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced', balanced: true },
          source: PM === 'battery' ? 'battery' : 'ac', saver: false, reason: null };
  function powerSet(p) {
    var want = p && p.mode;
    if (want !== 'efficiency' && want !== 'balanced' && want !== 'performance') throw new Error('powermode.set needs mode: "efficiency", "balanced" or "performance"');
    if (!pmState.ok || !pmState.available || pmState.settable === false) return { ok: false, mode: want, state: Object.assign({}, pmState), reason: pmState.reason };
    if (PM === 'refuse' && want !== pmState.mode)
      return { ok: false, mode: want, state: Object.assign({}, pmState), reason: 'refused: sidecar is passive (test mode): it would have changed the power mode from ' + pmState.mode + ' to ' + want };
    pmState = Object.assign({}, pmState, { mode: want });
    setTimeout(function () { emit('powermode', Object.assign({ via: 'set' }, pmState)); }, 5);
    return { ok: true, mode: want, same: false, state: Object.assign({}, pmState), reason: null };
  }
  // The installed PLANS (2026-09-24, Owen's machine: Balanced + Hone). powermode.plan switches between
  // them as PowerMode.cs SetPlan does: the state READ BACK, and a 'powermode' push; ?pm=refuse refuses.
  var PM_BAL = '381b4222-f694-41f0-9685-ff5bb260df2e', PM_HONE = '44444444-4444-4444-4444-444444444452';
  function pmPlans(active) {
    return [{ guid: PM_BAL, name: 'Balanced', active: active === PM_BAL, balanced: true },
      { guid: PM_HONE, name: 'Hone Ultimate Power Plan V5', active: active === PM_HONE, balanced: false }];
  }
  if (pmState.ok) pmState.plans = pmPlans(pmState.available ? PM_BAL : PM_HONE);
  function powerPlan(p) {
    var want = p && p.plan;
    if (want !== PM_BAL && want !== PM_HONE) throw new Error('powermode.plan: no installed power plan has the GUID ' + want);
    var cur = pmState.available ? PM_BAL : PM_HONE;
    if (PM === 'refuse' && want !== cur)
      return { ok: false, plan: want, same: false, state: Object.assign({}, pmState), reason: 'refused: sidecar is passive (test mode): it would have switched the power plan from "' + (cur === PM_BAL ? 'Balanced' : 'Hone Ultimate Power Plan V5') + '" to "' + (want === PM_BAL ? 'Balanced' : 'Hone Ultimate Power Plan V5') + '"' };
    var bal = want === PM_BAL;
    pmState = Object.assign({}, pmState, {
      available: bal, plans: pmPlans(want),
      plan: { guid: want, name: bal ? 'Balanced' : 'Hone Ultimate Power Plan V5', balanced: bal },
      reason: bal ? null : 'Power mode works only on the Balanced power plan, and this PC is on "Hone Ultimate Power Plan V5". Choose the Balanced plan to use it',
    });
    setTimeout(function () { emit('powermode', Object.assign({ via: 'plan' }, pmState)); }, 5);
    return { ok: true, plan: want, same: want === cur, state: Object.assign({}, pmState), reason: null };
  }
  window.__mockPower = function (mode) {       // a change made in Windows Settings, for the harness
    pmState = Object.assign({}, pmState, { mode: mode });
    emit('powermode', Object.assign({ via: 'mode' }, pmState));
  };

  function reply(channel, payload) {
    switch (channel) {
      case 'state.get':   return state();
      case 'sys.stats':   return { battery: { percent: 72, charging: false }, volume: volumeReading() };
      case 'battery.get': return batteryNow;
      case 'volume.get':  return volumeReading();
      case 'volume.set':                           // 0-100, as main passes it to the sidecar
        if (payload && typeof payload.level === 'number') volume.level = Math.max(0, Math.min(100, payload.level)) / 100;
        if (payload && typeof payload.muted === 'boolean') volume.muted = payload.muted;
        setTimeout(function () { emit('volume', volumeReading()); }, 0);
        return volumeReading();

      case 'bar.pinned':  return { ok: true, reason: '', items: items };
      case 'bar.hover':
        /* The real main hides the bar on its own timer; the mock just records it, so a pointer
           leaving the page during a manual poke does not make the bar vanish mid-inspection. */
        return { ok: true, reason: '' };
      /* Windows 11 semantics, and the mock answers with the same four actions main does, because
         the renderer BRANCHES on this reply: 'list' is the one it has to act on itself. */
      case 'bar.open': {
        var it = null;
        items.forEach(function (x) { if (x.id === (payload && payload.id)) it = x; });
        if (!it) return { ok: false, reason: 'no pinned item with id "' + (payload && payload.id) + '"' };
        if (payload && payload.fresh) return { ok: true, reason: '', action: 'launched' };
        if (it.windows.length > 1) return { ok: true, reason: '', action: 'list' };
        if (!it.windows.length) return { ok: true, reason: '', action: 'launched' };
        var one = it.windows[0];
        var wasActive = one.active;
        if (wasActive) { one.minimized = true; one.active = false; }
        else { one.minimized = false; focus(one.hwnd); }
        setTimeout(function () { emit('windows', flatWindows()); emit('bar.pinned', { ok: true, reason: '', items: items }); }, 0);
        return { ok: true, reason: '', action: wasActive ? 'minimize' : 'focus' };
      }
      case 'bar.window': {
        var hwnd = payload && payload.hwnd, action = payload && payload.action;
        if (action === 'close') {
          items.forEach(function (x) { x.windows = x.windows.filter(function (w) { return w.hwnd !== hwnd; }); });
        } else if (action === 'minimize' || (action === 'toggle' && isActiveHwnd(hwnd))) {
          /* toggle on the ACTIVE window is minimize — the same thing the taskbar does, and the
             renderer sends 'toggle' for exactly that row. */
          items.forEach(function (x) { x.windows.forEach(function (w) { if (w.hwnd === hwnd) { w.minimized = true; w.active = false; } }); });
        } else {
          focus(hwnd);
        }
        setTimeout(function () { emit('windows', flatWindows()); emit('bar.pinned', { ok: true, reason: '', items: items }); }, 0);
        return { ok: true, reason: '' };
      }
      case 'qs.get': return qsSnapshot();
      case 'net.get': return netNow;

      case 'osd.mixer': case 'osd.show': return { ok: true, shown: false, test: true, reason: null };   // ui/osd is its own page
      case 'powermode.get': return Object.assign({}, pmState);
      case 'powermode.plan': {
        var pp = powerPlan(payload);
        if (PM === 'slow') return new Promise(function (res) { setTimeout(function () { res(pp); }, 1500); });
        return pp;
      }
      case 'powermode.set': {
        var pr = powerSet(payload);
        if (PM === 'slow') return new Promise(function (res) { setTimeout(function () { res(pr); }, 1500); });
        return pr;
      }
      case 'qs.watch':
        qsWatching = !!(payload && payload.on);
        qsLoop();
        return { ok: true, watching: qsWatching, via: 'mock', leaseMs: 60000, reason: '' };

      /* one level down (qs-more.js): the Wi-Fi list, the output picker, the mixer */
      case 'qs.wifi.list': return wifiList();
      case 'qs.wifi.scan': {
        if (SCAN_HOLD) return new Promise(function () {});          // "Scanning…" held for a look
        var scanned = wifiList();
        scanned.scan = WIFI === 'off' || WIFI === 'none' || WIFI === 'error'
          ? { ok: false, ms: 2, reason: scanned.reason }
          : { ok: true, ms: 900, reason: null };
        return later(900, scanned);
      }
      case 'qs.wifi.connect': return wifiConnect(payload || {});
      case 'qs.wifi.disconnect': return wifiDisconnect();
      case 'jumplist.get': return new Promise(function (res) { setTimeout(function () { res(jumpList()); }, JL_MS); });
      case 'jumplist.open': case 'jumplist.remove': case 'jumplist.close': case 'jumplist.pin':
        console.log('[mock] ' + channel + ' ' + JSON.stringify(payload).slice(0, 160));
        return { ok: true, dryRun: true, reason: 'mock: nothing was run' };
      case 'qs.keyboard':
        if (payload && payload.on && KBD_REFUSED)
          return { ok: false, focused: false, reason: 'a test instance never takes the keyboard from whoever is at the machine, so a password cannot be typed here' };
        return { ok: true, focused: !!(payload && payload.on), note: null, restored: null, reason: null };
      case 'qs.audio.devices': return audioDevices();
      case 'qs.audio.default': {
        var dev = audioDevs.filter(function (d) { return d.id === (payload && payload.device); })[0];
        if (!dev) return { ok: false, reason: 'the output device could not be changed: audio default: no active playback device has that id (it may have been unplugged or disabled)' };
        audioDefault = dev.id; audioCalls = dev.id;
        setTimeout(qsPush, 0);
        return later(120, Object.assign(audioDevices(), {
          ok: true, id: dev.id, name: dev.name, noop: false,
          roles: { console: true, multimedia: true, communications: true },
          hr: { console: '0x00000000', multimedia: '0x00000000', communications: '0x00000000' }, ms: 41
        }));
      }
      case 'qs.audio.sessions': return audioSessions();
      case 'qs.audio.session': return audioSession(payload || {});

      /* one level down: the paired Bluetooth devices */
      case 'qs.bt.list': return btList();
      case 'qs.bt.watch':
        if (BT_WATCH_FAIL && payload && payload.on) {
          return { ok: false, watching: false, reason: 'Windows\' device watcher did not start (HRESULT 0x80070005: Access is denied)' };
        }
        btWatching = !!(payload && payload.on);
        return { ok: true, watching: btWatching, started: btWatching, leaseMs: 90000, events: 0, reason: null };
      case 'qs.bt.connect': return btToggle(payload, true);
      case 'qs.bt.disconnect': return btToggle(payload, false);

      /* Every set answers with the value that actually took, and a part the mock cannot switch
         answers ok:false WITH a reason — the panel must show that reason, not just fail to move.
         main.js's contract (2026-09-23): levels go in as WHOLE percentages 0-100 (a 0-1 fraction
         is refused, as main refuses it), and the reply carries `value` in those units plus
         `state`, the whole part read back as qs.get shows it. This mock used to take 0-1, which
         is how the panel sending fractions to a 0-100 main went unnoticed. */
      case 'qs.set': {
        var part = payload && payload.part, val = payload && payload.value;
        var st = {
          volume: qsState.volume, mute: qsState.volume, wifi: qsState.wifi,
          bluetooth: qsState.bluetooth, brightness: qsState.brightness, nightlight: qsState.nightlight
        }[part];
        if (!st) return { ok: false, part: part, value: null, state: null, reason: 'this shell does not know how to set "' + part + '"' };
        if (st.ok === false) return { ok: false, part: part, value: null, state: null, reason: st.reason };
        if (QS_REFUSE && (part === 'wifi' || part === 'bluetooth' || part === 'nightlight'))
          return { ok: false, part: part, value: null, state: qsSnapshot()[part],
            reason: 'Windows did not make the switch (mock ?qsset=refuse: the radio answered AccessDenied)' };
        if ((part === 'volume' || part === 'brightness') &&
            !(Number.isInteger(Number(val)) && Number(val) >= 0 && Number(val) <= 100))
          return { ok: false, part: part, value: null, state: null, reason: part + ' must be a whole number from 0 to 100' };
        if (part === 'volume') { volume.level = Number(val) / 100; st.level = volume.level; val = Math.round(st.level * 100); }
        else if (part === 'mute') { volume.muted = !!val; st.muted = volume.muted; val = st.muted; }
        else if (part === 'brightness') { st.level = Number(val) / 100; val = Math.round(st.level * 100); }
        else {
          st.on = !!val; val = st.on;
          if (part === 'wifi' && !st.on) { st.connected = false; st.ssid = ''; }
          else if (part === 'wifi') { st.connected = true; st.ssid = 'Maple-5G'; }
        }
        setTimeout(qsPush, 0);                       // main pushes after every set, so the mock does too
        if (part === 'volume' || part === 'mute') setTimeout(function () { emit('volume', volumeReading()); }, 0);
        // the readout follows the radio a moment later, as the sidecar's route watch sees it
        if (part === 'wifi') setTimeout(function () { netPush(st.on ? 'connected' : 'wifi-off'); }, 250);
        var back = qsSnapshot()[part === 'mute' ? 'volume' : part];
        return { ok: true, part: part, value: val, state: back, reason: null };
      }

      case 'sys.keys':
        /* win+a and win+n are the two combos the bar sends. Anything else is a bug worth seeing,
           and an unknown combo must come back ok:false WITH a reason, never a silent success. */
        if (payload && (payload.combo === 'win+a' || payload.combo === 'win+n')) {
          console.log('[mock] sys.keys', payload.combo, '— a real shell would open the Windows flyout here');
          return { ok: true, reason: '' };
        }
        return { ok: false, reason: 'combo "' + (payload && payload.combo) + '" is not one this shell knows how to send' };

      case 'tray.list':
        if (TRAY) return TRAY;
        // The unavailable case is the interesting one: the bar must say WHY the tray is empty.
        throw new Error(state().tray.reason);

      /* The M button is the mock's replay control: hide, then reveal again, so the whole motion
         can be watched as many times as it takes without reloading. In Electron this opens the
         real launcher and none of this runs. */
      case 'launcher.show':
        setTimeout(function () {
          revealed = false;
          emit('bar.hide', { why: 'mock: replay', ms: DUR_OUT });
          setTimeout(function () {
            revealed = true;
            emit('bar.reveal', { why: 'mock: replay', mode: MODE, ms: DUR_IN });
            setTimeout(function () { if (revealed) sendBackdrops(); }, 300 + DUR_IN);
          }, DUR_OUT + 260);
        }, 0);
        return { ok: true, reason: '', mock: true };

      case 'media.get': return mediaPayload();
      case 'notifs.get': return ntfPayload();
      case 'notifs.seen':
        ntfList.forEach(function (t) { if (((payload && payload.ids) || []).indexOf(t.id) >= 0) t.unread = false; });
        setTimeout(function () { emit('notifications', ntfPayload()); }, 60);
        return { ok: true, reason: null };
      case 'notifs.remove': return ntfDrop((payload && payload.ids) || []);
      case 'notifs.clear':
        return ntfDrop(ntfList.filter(function (t) { return !payload || !payload.aumid || t.aumid === payload.aumid; }).map(function (t) { return t.id; }));
      case 'notifs.open': {
        var t = ntfList.filter(function (x) { return x.id === (payload && payload.id); })[0];
        if (!t) return { ok: false, reason: 'that notification is not in the list Mantle is showing (it may have just gone)' };
        if (t.opens === 'none') return { ok: false, reason: t.opensWhy };
        ntfDrop([t.id]);
        return { ok: true, via: t.opens, dismissed: true, note: t.opens === 'app' ? 'Windows would also have told ' + t.app + ' which notification was clicked; Mantle cannot pass that on yet' : null, reason: null };
      }
      case 'media.select':
        mediaPick = (payload && payload.aumid) || null;
        return mediaPayload();
      case 'media.control': return mediaControl(payload || {});
      case 'tray.click':
      case 'open':
      case 'shell.restore':
      case 'shell.quit':
      case 'bar.popover':
        return { ok: true, reason: '', mock: true };
      // The flyout's live previews are drawn by DWM from Electron main; a browser page has no
      // compositor to ask. Every card says so, which is also how the reason text gets eyeballed.
      case 'bar.thumbs':
        return {
          ok: true, reason: null, mock: true,
          thumbs: ((payload && payload.items) || []).map(function (e) {
            return { hwnd: String(e.hwnd), ok: false, reason: 'no live picture in the mock bridge: in Mantle, DWM draws the window here' };
          }),
        };
      default:
        throw new Error('unknown channel "' + channel + '" (mock bridge)');
    }
  }

  window.mantle = {
    mode: 'mock',                                   // bar.js shows this, so a mock is never mistaken for the real thing

    /* on(): every channel replays its current value once on subscribe, because the bar is a
       readout — it must be correct the instant it is created, not after the next change. */
    on: function (channel, cb) {
      (listeners[channel] || (listeners[channel] = [])).push(cb);
      setTimeout(function () {
        if (channel === 'bar.backdrop') return;       // pushed only while the bar is up, never replayed
        if (channel === 'windows') cb(flatWindows());
        else if (channel === 'bar.pinned') cb({ ok: true, reason: '', items: items });
        else if (channel === 'tray') cb(TRAY || []);  // [] = tray unavailable on this build
        else if (channel === 'media') { if (MEDIA) cb(mediaPayload()); }   // main replays only once it has read
        else if (channel === 'notifications') cb(ntfPayload());
        else if (channel === 'battery') cb(batteryNow);
        else if (channel === 'volume') cb(volumeReading());
        else if (channel === 'net') cb(netNow);
        else if (channel === 'qs') cb(qsSnapshot());     // main replays its last whole picture
        else if (channel === 'state') cb(state());
      }, 30);
      return function off() {
        listeners[channel] = (listeners[channel] || []).filter(function (f) { return f !== cb; });
      };
    },

    call: function (channel, payload) {
      console.log('[mock] call', channel, redacted(payload));
      /* A copy, taken now: the real bridge serialises the arguments the moment it is called, so a
         caller that deletes a password right after calling must not change what the mock gets. */
      payload = payload && typeof payload === 'object' ? structuredClone(payload) : payload;
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try { resolve(reply(channel, payload)); }
          catch (e) { console.warn('[mock] call rejected', channel, e.message); reject(e); }
        }, channel === 'qs.set' && QS_DELAY ? QS_DELAY : 30);
      });
    }
  };

  /* The reveal main would send when the pointer hits the bottom edge, carrying the same three
     fields: why, the shape it is holding the window in, and the duration it is animating that
     window over. 300ms so the page is settled first and the detach is visible to a human. */
  if (REVEAL) setTimeout(function () {
    revealed = true;
    emit('bar.reveal', { why: 'mock: pointer at the bottom edge', mode: MODE, ms: DUR_IN });
  }, 300);

  /* HARNESS HOOK (2026-09-23): ui/bar/check-reveal.js sends main's hide and reveal at exact
     moments, because the bug it reproduces lives in the gap between the reveal event and the
     pill's first frame, and a click-driven replay (the M button) is too loosely timed for that.
     Mock only: inside Electron this file returned at the top and there is no such object. */
  window.__mockMain = {
    reveal: function (why) { revealed = true; emit('bar.reveal', { why: why || 'mock: harness reveal', mode: MODE, ms: DUR_IN }); },
    hide: function (why) { revealed = false; emit('bar.hide', { why: why || 'mock: harness hide', ms: DUR_OUT }); },
    /* A plug, an unplug, a charge limit reached: main pushes the new reading, and the panel's
       `power` part reads the same one. */
    battery: function (name) {
      batteryNow = batteryReading(name);
      qsState.power = batteryNow;
      emit('battery', batteryNow);
      qsPush();
      return batteryNow;
    },
    /* The route or the internet changed (a cable, the radio, the router): main pushes 'net'. The
       Wi-Fi tile follows, as the qs watch would push it. */
    net: function (name) {
      var r = netPush(name);
      if (r.ok && r.wifi && typeof r.wifi.on === 'boolean') {
        qsState.wifi.on = r.wifi.on; qsState.wifi.connected = !!r.wifi.connected; qsState.wifi.ssid = r.wifi.ssid || '';
        qsPush();
      }
      return r;
    },
    /* The volume keys, Windows' flyout, another app: main pushes 'volume' whether or not the
       panel is open. level is 0-100. */
    volume: function (level, muted) {
      if (typeof level === 'number') volume.level = Math.max(0, Math.min(100, level)) / 100;
      if (typeof muted === 'boolean') volume.muted = muted;
      emit('volume', volumeReading());
      qsPush();
      return volumeReading();
    },
    /* A part changed elsewhere (the brightness keys, Windows' own flyout) and the watch pushed it.
       Levels are 0-100, as main sends them. Pushed whether or not the watch is on: the harness
       says when. */
    qsPushNow: function (over) {
      Object.keys(over || {}).forEach(function (k) {
        var p = Object.assign({}, over[k]);
        if ((k === 'volume' || k === 'brightness') && typeof p.level === 'number') p.level = p.level / 100;
        qsState[k] = Object.assign({}, qsState[k] || {}, p);
        if (k === 'volume') { volume.level = qsState.volume.level; volume.muted = !!qsState.volume.muted; }
      });
      var snap = qsSnapshot();
      emit('qs', snap);
      return snap;
    },
    /* The sidecar's watch pushing a changed list (a device connected, the radio switched). */
    bt: function (name) {
      BT = name;
      btDevs = btPreset(name);
      qsState.bluetooth.on = name !== 'off' && name !== 'none';
      qsState.bluetooth.present = name !== 'none';
      var r = btList();
      emit('btdevices', Object.assign({ ev: 'btdevices', why: 'mock: harness push' }, r));
      return r;
    }
  };

  /* THE BACKDROP main would photograph. There is no screen behind a file:// page, so the mock
     paints one: a deliberately loud gradient with hard-edged blocks in it, at the size main would
     send (the bar's rect downscaled 4x). If the blur, the clip and the tint are all working, that
     strip comes out as soft colour through the glass; if any of them is not, it is obvious at a
     glance. Drawn on a canvas and handed over as a PNG data URL, exactly the shape of the real
     payload. Six frames, then it stops: a mock may not leave a timer running for ever. */
  function stripPNG(shift) {
    var w = 360, h = 12, c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, w, 0);
    var stops = ['#2f6fe0', '#b23fd0', '#d64545', '#e0a059', '#1f8f4e', '#2f6fe0'];
    for (var i = 0; i < stops.length; i++) grad.addColorStop(i / (stops.length - 1), stops[(i + shift) % stops.length]);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    /* two hard blocks and a dark band: edges are what a blur is judged on */
    g.fillStyle = '#0b0d10'; g.fillRect(w * 0.34, 0, 26, h);
    g.fillStyle = '#ffffff'; g.fillRect(w * 0.58, 0, 14, h);
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, h - 4, w, 4);
    return c.toDataURL('image/png');
  }

  function sendBackdrops() {
    var n = 0;
    (function frame() {
      if (!revealed || n >= 6) return;
      emit('bar.backdrop', {
        png: stripPNG(n), w: 360, h: 12,
        rect: { x: 0, y: 1012, w: 1440, h: 48 },   // physical px of the bar's rest rect
        ms: Date.now()
      });
      n++;
      setTimeout(frame, 250);                       // main sends ~4 a second
    })();
  }
  /* 300ms after the reveal lands, which is what main does: nothing arrives during the morph. */
  if (REVEAL) setTimeout(function () { if (revealed) sendBackdrops(); }, 300 + DUR_IN);

  /* …and the hide, for watching the fade out. Main drops the window 20ms after the page is done. */
  if (HIDE_AT) setTimeout(function () {
    revealed = false;
    emit('bar.hide', { why: 'mock: pointer left the bar', ms: DUR_OUT });
  }, HIDE_AT);

  /* ?hidefx=1: the exit on a loop, one event every 2s, so the slide-down can be watched over and
     over without chasing the pointer. This one IS allowed to run for ever — it is an opt-in debug
     switch and looping is the whole point. Each hide is sent with main's real ms (320); the page
     caps it to 300 itself, so this also proves the cap. Backdrops are re-sent on each reveal
     because the page drops the strip on the way out. */
  if (HIDE_FX) setInterval(function () {
    if (revealed) {
      revealed = false;
      emit('bar.hide', { why: 'mock: hidefx loop', ms: DUR_OUT });
    } else {
      revealed = true;
      emit('bar.reveal', { why: 'mock: hidefx loop', mode: MODE, ms: DUR_IN });
      setTimeout(function () { if (revealed) sendBackdrops(); }, DUR_IN);
    }
  }, 2000);

  console.log('[mock] window.mantle installed (no real bridge found) — pinned:', PIN_COUNT,
    'running:', RUNNING.length, 'mode:', MODE, 'reveal:', REVEAL,
    'hideAt:', HIDE_AT || 'never', 'hidefx:', HIDE_FX, 'sidecar down:', SIDECAR_DOWN);
})();
