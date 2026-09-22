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
      tray: { status: 'unavailable', watch: false, reason: 'explorer exposes 0 legacy tray buttons on this build' },
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

      case 'tray.click':
      case 'open':
      case 'shell.restore':
      case 'shell.quit':
      case 'bar.popover':
        return { ok: true, reason: '', mock: true };
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
        else if (channel === 'tray') cb([]);          // tray unavailable on this build
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
