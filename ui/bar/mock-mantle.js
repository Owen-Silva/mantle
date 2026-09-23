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

  /* ---- quick settings -------------------------------------------------
     Plausible values for a laptop on Wi-Fi. ?qs=fail breaks TWO parts (Bluetooth and brightness)
     with real-sounding reasons, because the panel's whole contract is that a part it cannot read
     renders muted WITH its reason rather than blank — and that path has to be eyeballable. */
  var QS_FAIL = q.get('qs') === 'fail';
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
    power:      { onBattery: true, percent: 72, minutesLeft: 184, saver: false, ok: true, reason: '' }
  };
  var qsWatching = false, qsTimer = 0;

  function qsSnapshot() {
    qsState.volume.level = volume.level;
    qsState.volume.muted = volume.muted;
    return {
      ok: true, reason: '',
      volume: qsState.volume, wifi: qsState.wifi, bluetooth: qsState.bluetooth,
      brightness: qsState.brightness, nightlight: qsState.nightlight, power: qsState.power
    };
  }

  function qsPush() {
    if (!qsWatching) return;
    emit('qs', qsSnapshot());
  }

  /* The real main pushes every 2s while the watch is on. The mock does the same, and stops dead
     when it is turned off — a mock that kept pushing would hide exactly the leak the watch is
     there to prevent. */
  function qsLoop() {
    if (qsTimer) clearTimeout(qsTimer);
    if (!qsWatching) return;
    qsTimer = setTimeout(function () { qsPush(); qsLoop(); }, 2000);
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
  function reply(channel, payload) {
    switch (channel) {
      case 'state.get':   return state();
      case 'sys.stats':   return { battery: { percent: 72, charging: false }, volume: { level: volume.level, muted: volume.muted } };
      case 'volume.get':  return { level: volume.level, muted: volume.muted };
      case 'volume.set':
        if (payload && typeof payload.level === 'number') volume.level = Math.max(0, Math.min(1, payload.level));
        if (payload && typeof payload.muted === 'boolean') volume.muted = payload.muted;
        return { ok: true, reason: '', level: volume.level, muted: volume.muted };

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

      case 'qs.watch':
        qsWatching = !!(payload && payload.on);
        qsLoop();
        return { ok: true, reason: '' };

      /* Every set answers with the value that actually took, and a part the mock cannot switch
         answers ok:false WITH a reason — the panel must show that reason, not just fail to move. */
      case 'qs.set': {
        var part = payload && payload.part, val = payload && payload.value;
        var st = {
          volume: qsState.volume, mute: qsState.volume, wifi: qsState.wifi,
          bluetooth: qsState.bluetooth, brightness: qsState.brightness
        }[part];
        if (!st) return { ok: false, part: part, reason: 'this shell does not know how to set "' + part + '"' };
        if (st.ok === false) return { ok: false, part: part, reason: st.reason };
        if (part === 'volume') { volume.level = Math.max(0, Math.min(1, val)); st.level = volume.level; val = st.level; }
        else if (part === 'mute') { volume.muted = !!val; st.muted = volume.muted; val = st.muted; }
        else if (part === 'brightness') { st.level = Math.max(0, Math.min(1, val)); val = st.level; }
        else {
          st.on = !!val; val = st.on;
          if (part === 'wifi' && !st.on) { st.connected = false; st.ssid = ''; }
          else if (part === 'wifi') { st.connected = true; st.ssid = 'Maple-5G'; }
        }
        setTimeout(qsPush, 0);                       // main pushes after every set, so the mock does too
        return { ok: true, part: part, value: val, reason: '' };
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
        else if (channel === 'state') cb(state());
      }, 30);
      return function off() {
        listeners[channel] = (listeners[channel] || []).filter(function (f) { return f !== cb; });
      };
    },

    call: function (channel, payload) {
      console.log('[mock] call', channel, payload || '');
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try { resolve(reply(channel, payload)); }
          catch (e) { console.warn('[mock] call rejected', channel, e.message); reject(e); }
        }, 30);
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
