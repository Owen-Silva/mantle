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
 */
(function () {
  'use strict';
  if (window.mantle) return;                 // the real bridge wins, always

  var flags = new URLSearchParams(location.search);
  var SIDECAR_DOWN = flags.get('state') === 'down';
  var ALWAYS_FAIL = flags.get('fail') === '1';

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

  var STATE = {
    mode: 'mock',
    sidecar: SIDECAR_DOWN
      ? { status: 'down', reason: 'sidecar exited: exit code 1' }
      : { status: 'ok', reason: '' },
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

  // a test can drive the visible event by hand
  window.__mockShow = function () { emit('launcher:visible', true); };
})();
