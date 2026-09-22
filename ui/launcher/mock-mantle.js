/* mock-mantle.js — a stand-in for lane B's preload bridge.
 *
 * WHY it exists: the launcher has to be looked at, measured and screenshotted
 * without running Electron, without the sidecar, and without ever opening a
 * real app on Owen's machine. Loading index.html straight from disk gets you a
 * fully working launcher against fake data.
 *
 * It defines window.mantle ONLY when it is absent, so the moment the real
 * preload is there this file does nothing at all and can stay in the page.
 *
 * Query flags for the visual checks:
 *   ?state=down  the sidecar is down, so the notice line appears
 *   ?fail=1      every launch fails, so the inline reason appears under a row
 *   ?bg=1        paints a loud wallpaper behind the page, so a screenshot can
 *                show what the glass actually lets through
 *   ?blur=0      no backdrop is ever sent and the State piece says it is not ok,
 *                which is the fallback pane (--lg-fill-fb) plus the "no blur: …"
 *                line in the footer — the failure must be visible, not silent
 */
(function () {
  'use strict';
  if (window.mantle) return;                 // the real bridge wins, always

  var flags = new URLSearchParams(location.search);
  var SIDECAR_DOWN = flags.get('state') === 'down';
  var ALWAYS_FAIL = flags.get('fail') === '1';
  var NO_BLUR = flags.get('blur') === '0';

  /* The page itself paints nothing outside the panel — html and body stay
     transparent so DWM's blur-behind is what you see. In MOCK MODE ONLY there
     is no desktop behind the window, so ?bg=1 stands in with a deliberately
     awful wallpaper: bright, saturated, high-frequency. If text still reads
     over that, it reads over anything. Set through CSSOM rather than a <style>
     tag because the page's CSP allows the first and blocks the second. */
  if (flags.get('bg') === '1') {
    document.documentElement.style.background =
      'repeating-linear-gradient(115deg, #ff7a45 0px, #ffd166 90px, #fff2e0 150px, ' +
      '#8ef0c8 210px, #6bb7ff 280px, #c79bff 340px, #ff7a45 420px)';
  }

  /* Five real 32x32 PNGs (generated, not stolen from Windows) so the icon
     column is exercised with actual bitmaps; every other row falls back to a
     letter tile or a drawn glyph, which is the common case on a cold index. */
  var PNG = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZklEQVR42mNgwAHaVhz6T03MQAygtqUkOQYmGVE1haYYqyPoZTlOR9DTcmRHDA4H0Dv4MaJh1AGD2gGP3nyjGh51wGgiHE0Do4lwNBGOOmA0EQ5eB4y2igdFx2TAu2aDonM6UN1zAP63YfFRSPEOAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjUlEQVR42mNgwAFW9O36T03MQAygtqUkOQYmWZXQQ1OM1RH0shynI+hpObIjBocD6B38GNEw5Bzw7sU3vJimDiBkOSmOINkBxFpOrCNIcgAxFpDqCKIdQKrPiFU/NB1ATk4ZdcDwcsDIzAUDXhANiqJ4UFRGg6I6Hp4totFW8aDomAx412xQdE4HqnsOAJKtNle3/gOLAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiklEQVR42mNgwAH61s36T03MQAygtqUkOQYmmdCQQ1OM1RH0shynI+hpObIjBocD6B38GNEw5B3w7MuLEewAkOUwPPIcgGw5OY4Y2g7AZjmpjhi6DsBnOSmOGJoOIMZyYh0x9BxAiuXEOGJoOYAcywk5Ymg5YHi3iEZbxYOiYzLgXbNB0TkdqO45AA7o0MjhAICxAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42mNgwAEOLWr4T03MQAygtqUkOQYmOaUkiKYYqyPoZTlOR9DTcmRHDA4H0Dv4MaJh1AHEOODbm3tYMalqRh0w6oCh64DRcmC0IBp1wKgDRgsimreMR3areFB0TAa8azYoOqcD1T0HAJysFCcGQ3zhAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZklEQVR42mNgwAFK+tb9pyZmIAZQ21KSHAOTdEtooCnG6gh6WY7TEfS0HNkRg8MB9A5+jGgYdcCgdsC9Vz+ohkcdMJoIR9PAaCIcTYSjDhhNhIPXAaOt4kHRMRnwrtmg6JwOVPccANP+l/YfOp/4AAAAAElFTkSuQmCC',
  ];

  function mk(kind, name, subtitle, icon, path) {
    return {
      id: kind + ':' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      kind: kind, name: name, subtitle: subtitle,
      path: path || name, icon: icon || null,
    };
  }

  var ITEMS = [
    // apps — the first five carry real bitmaps, the rest fall back to letters
    mk('app', 'Chrome', 'Google', PNG[0], 'C:\\ProgramData\\...\\Chrome.lnk'),
    mk('app', 'Visual Studio Code', 'Visual Studio Code', PNG[1], 'C:\\Users\\user\\...\\Code.lnk'),
    mk('app', 'Spotify', 'Spotify', PNG[2], 'C:\\Users\\user\\...\\Spotify.lnk'),
    mk('app', 'Windows Terminal', 'Start Menu (you)', PNG[3], 'C:\\Users\\user\\...\\Terminal.lnk'),
    mk('app', 'Steam', 'Steam', PNG[4], 'C:\\ProgramData\\...\\Steam.lnk'),
    mk('app', 'Character Map', 'Windows Tools', null, 'C:\\ProgramData\\...\\charmap.lnk'),
    mk('app', 'Calculator', 'Accessories', null, 'C:\\ProgramData\\...\\calc.lnk'),
    mk('app', 'Discord', 'Discord Inc.', null, 'C:\\Users\\user\\...\\Discord.lnk'),
    mk('app', 'Notepad', 'Accessories', null, 'C:\\ProgramData\\...\\notepad.lnk'),
    mk('app', 'OBS Studio', 'OBS Studio', null, 'C:\\ProgramData\\...\\obs.lnk'),
    mk('app', 'Photoshop 2025', 'Adobe', null, 'C:\\ProgramData\\...\\ps.lnk'),
    mk('app', 'Task Scheduler', 'Windows Tools', null, 'C:\\ProgramData\\...\\taskschd.lnk'),
    mk('app', 'Blender', 'blender.org', null, 'C:\\ProgramData\\...\\blender.lnk'),
    mk('app', 'Zoom Workplace', 'Zoom', null, 'C:\\Users\\user\\...\\zoom.lnk'),

    // commands — Owen's own PowerShell functions
    mk('command', 'dash', 'PowerShell profile'),
    mk('command', 'bot', 'PowerShell profile'),
    mk('command', 'northwind', 'PowerShell profile'),
    mk('command', 'axiom', 'PowerShell profile'),
    mk('command', 'gpush', 'PowerShell profile'),
    mk('command', 'jarvis', 'PowerShell profile'),
    mk('command', 'qwarm', 'PowerShell profile'),
    mk('command', 'claude', 'PowerShell profile'),

    // settings
    mk('setting', 'Display', 'Settings', null, 'ms-settings:display'),
    mk('setting', 'Sound', 'Settings', null, 'ms-settings:sound'),
    mk('setting', 'Bluetooth & devices', 'Settings', null, 'ms-settings:bluetooth'),
    mk('setting', 'Wi-Fi', 'Settings', null, 'ms-settings:network-wifi'),
    mk('setting', 'Windows Update', 'Settings', null, 'ms-settings:windowsupdate'),
    mk('setting', 'Default apps', 'Settings', null, 'ms-settings:defaultapps'),
    mk('setting', 'Startup apps', 'Settings', null, 'ms-settings:startupapps'),
    mk('setting', 'Windows Security', 'Settings', null, 'ms-settings:windowsdefender'),
  ];

  /* The counts are the ones a real machine reports, not the length of the fake
     list: the footer's job is to look like the real footer, numbers and all. */
  var SOURCES = [
    { name: 'apps', count: 212, status: 'ok', reason: '' },
    {
      name: 'commands', count: 14, status: 'error',
      reason: 'profile not found at C:\\Users\\user\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    },
    { name: 'settings', count: 26, status: 'ok', reason: '' },
  ];

  var KIND_ORDER = { app: 0, command: 1, setting: 2, url: 3 };

  function looksLikeUrl(q) {
    if (/^https?:\/\//i.test(q)) return true;
    if (/\s/.test(q)) return false;
    return /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?:[/:?#].*)?$/i.test(q);
  }

  function score(item, q) {
    var name = item.name.toLowerCase(), sub = (item.subtitle || '').toLowerCase();
    if (name === q) return 1000;
    if (name.indexOf(q) === 0) return 900 - Math.min(80, name.length - q.length);
    var words = name.split(/[^a-z0-9]+/);
    for (var i = 0; i < words.length; i++) if (words[i] && words[i].indexOf(q) === 0) return 800;
    if (sub.indexOf(q) === 0) return 500;
    var subWords = sub.split(/[^a-z0-9]+/);
    for (var j = 0; j < subWords.length; j++) if (subWords[j] && subWords[j].indexOf(q) === 0) return 460;
    // subsequence
    var si = 0, first = -1, last = -1;
    for (var k = 0; k < q.length; k++) {
      var at = name.indexOf(q[k], si);
      if (at === -1) return -1;
      if (first === -1) first = at;
      last = at; si = at + 1;
    }
    return Math.max(0, 200 - (last - first + 1 - q.length) * 6 - first * 2) + 200;
  }

  function search(q) {
    var query = String(q || '').trim().toLowerCase();
    if (!query) {
      var cmds = ITEMS.filter(function (i) { return i.kind === 'command'; });
      var apps = ITEMS.filter(function (i) { return i.kind === 'app'; });
      return cmds.slice(0, 12).concat(apps.slice(0, Math.max(0, 12 - cmds.length)));
    }
    var scored = [];
    ITEMS.forEach(function (it) {
      var s = score(it, query);
      if (s >= 0) scored.push({ it: it, s: s });
    });
    scored.sort(function (a, b) {
      return (b.s - a.s) ||
        (KIND_ORDER[a.it.kind] - KIND_ORDER[b.it.kind]) ||
        a.it.name.localeCompare(b.it.name);
    });
    var out = scored.map(function (x) { return x.it; });
    if (looksLikeUrl(query)) {
      out.unshift(mk('url', 'Open ' + String(q).trim(), 'in your browser', null,
        /^https?:/i.test(q) ? q : 'https://' + q));
    }
    return out.slice(0, 12);
  }

  var listeners = {};
  function emit(event, payload) {
    (listeners[event] || []).forEach(function (cb) { try { cb(payload); } catch (e) { /* a bad listener is the page's problem */ } });
  }

  /* THE BACKDROP main would photograph. The launcher's glass is a live picture of the screen
     behind the window, blurred in CSS — there is no screen behind a file:// page, so the mock
     paints one: a deliberately loud gradient with hard-edged blocks in it, at the size main sends
     (the 680x460 window's rect downscaled 4x). If the blur, the clip and the tint are all
     working, that comes through the glass as soft colour; if any of them is not, it is obvious at
     a glance. Drawn on a canvas and handed over as a PNG data URL, exactly the shape of the real
     payload. ONE frame, then it stops: a mock may not leave a timer running for ever. */
  var BD_W = 170, BD_H = 115;                  // 680x460 at BACKDROP_SCALE 4

  function backdropPNG() {
    var c = document.createElement('canvas');
    c.width = BD_W; c.height = BD_H;
    var g = c.getContext('2d');
    var grad = g.createLinearGradient(0, 0, BD_W, BD_H);
    var stops = ['#2f6fe0', '#b23fd0', '#d64545', '#e0a059', '#1f8f4e', '#2f6fe0'];
    for (var i = 0; i < stops.length; i++) grad.addColorStop(i / (stops.length - 1), stops[i]);
    g.fillStyle = grad; g.fillRect(0, 0, BD_W, BD_H);
    /* hard blocks and a dark band: edges are what a blur is judged on */
    g.fillStyle = '#0b0d10'; g.fillRect(BD_W * 0.30, 0, 22, BD_H);
    g.fillStyle = '#ffffff'; g.fillRect(BD_W * 0.58, BD_H * 0.15, 16, BD_H * 0.7);
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, BD_H - 18, BD_W, 18);
    return c.toDataURL('image/png');
  }

  var STATE = {
    mode: 'mock',
    sidecar: SIDECAR_DOWN
      ? { status: 'down', reason: 'sidecar exited: exit code 1' }
      : { status: 'ok', reason: '' },
    /* main's own report about that picture, merged per window exactly as State.backdrop is:
       {on, ok, ms, reason}. Only ok:false is a line in the launcher. */
    backdrop: {
      launcher: NO_BLUR
        ? { on: false, ok: false, ms: 0, fps: 0,
            reason: 'mock: ?blur=0, so nothing behind the launcher is being photographed' }
        : { on: true, ok: true, ms: 7, fps: 4,
            reason: 'mock: a synthetic strip stands in for the screen behind the launcher' },
    },
  };

  window.mantle = {
    mock: true,
    call: function (name, args) {
      args = args || {};
      switch (name) {
        case 'apps.index': return Promise.resolve({ items: ITEMS, sources: SOURCES });
        case 'apps.search': return Promise.resolve(search(args.q));
        case 'apps.launch':
          if (ALWAYS_FAIL) return Promise.resolve({ ok: false, reason: 'spawn ENOENT: wt.exe not found' });
          return Promise.resolve({ ok: true });
        case 'launcher.hide':
          document.documentElement.dataset.mockHidden = '1';   // visible to a test, invisible on screen
          return Promise.resolve();
        case 'open': return Promise.resolve({ ok: true });
        default: return Promise.reject(new Error('the mock bridge has no "' + name + '"'));
      }
    },
    on: function (event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      // the real bridge replays the current state on subscribe; so does this
      if (event === 'state') setTimeout(function () { cb(STATE); }, 0);
      return function () {
        listeners[event] = (listeners[event] || []).filter(function (f) { return f !== cb; });
      };
    },
  };

  /* 300ms after load, which is when main's first frame lands (it captures once just before the
     window is shown), then the State that says the capture is healthy. Nothing repeats. */
  if (!NO_BLUR) setTimeout(function () {
    emit('launcher.backdrop', {
      png: backdropPNG(), w: BD_W, h: BD_H,
      rect: { x: 620, y: 310, w: 680, h: 460 },   // physical px of the launcher's rect
      ms: 7,
    });
    emit('state', STATE);
  }, 300);

  // a test can drive the visible event by hand
  window.__mockShow = function () { emit('launcher:visible', true); };
})();
