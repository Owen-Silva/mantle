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
 *   ?files=down  launcher.files answers the way it does when the WSearch service is
 *                stopped, so the reason line in the Files group can be looked at
 *   ?files=slow  the index takes 6 s: the Files group's pending line
 *   ?mode=search&q=…  opened the way Win+S opens it (launcher.open), with that query typed
 *
 * The Win+S commands (search.files / search.openFile / search.copy / search.web) are here too,
 * and like power they are ALWAYS dry runs: nothing is opened, nothing touches a clipboard.
 *
 * Power rows (Lock, Sleep, Hibernate, Restart, Shut down, Sign out) are in the fake
 * index, and launcher.power here is ALWAYS a dry run: it answers the command the real
 * one would run, exactly as a --test Mantle does, and never runs anything.
 */
(function () {
  'use strict';
  if (window.mantle) return;                 // the real bridge wins, always

  var flags = new URLSearchParams(location.search);
  var SIDECAR_DOWN = flags.get('state') === 'down';
  var ALWAYS_FAIL = flags.get('fail') === '1';
  var RUN_HIST = flags.get('runhist') === '0' ? [] : ['perfmon /report', '%appdata%\\.minecraft', 'SystemPropertiesPerformance.exe', 'git', '%appdata%'];
  var RUN_DIR = [{ text: '%appdata%\\.minecraft\\', dir: true }, { text: '%appdata%\\Microsoft\\', dir: true }, { text: '%appdata%\\npm\\', dir: true }];
  var NO_BLUR = flags.get('blur') === '0';
  var FILES_DOWN = flags.get('files') === 'down';
  // ?files=slow  the index takes 6 s, so the Files group's "Searching your files" line can be seen
  var FILES_SLOW = flags.get('files') === 'slow';
  // ?mode=search opens as Win+S does (launcher.open {mode:'search'}), ?q=... types it
  var OPEN_MODE = flags.get('mode');
  var OPEN_Q = flags.get('q');

  /* The page itself paints nothing outside the panel — html and body stay
     transparent so DWM's blur-behind is what you see. In MOCK MODE ONLY there
     is no desktop behind the window, so ?bg=1 stands in with a deliberately
     awful wallpaper: bright, saturated, high-frequency. If text still reads
     over that, it reads over anything. Set through CSSOM rather than a <style>
     tag because the page's CSP allows the first and blocks the second. */
  /* SCENE MODE, MOCK ONLY (lane see-glass-b, 2026-10-09): a harness sets window.__mockScene =
     {url: a 1920x1080 picture as a data URL} in an init script. The page then sits over that
     picture as the window would at LAUNCHER_RECT, and the backdrop main would send is the same
     picture cropped to that rect and downscaled 4x. Without __mockScene nothing here changes. */
  var SCENE = window.__mockScene && window.__mockScene.url ? window.__mockScene : null;
  var LAUNCHER_RECT = { x: 620, y: 310, w: 680, h: 460 };
  var sceneImg = null, sceneWait = null;
  if (SCENE) {
    sceneWait = [];
    sceneImg = new Image();
    sceneImg.onload = function () { var w = sceneWait; sceneWait = null; w.forEach(function (f) { f(); }); };
    sceneImg.src = SCENE.url;
    document.documentElement.style.background = 'url("' + SCENE.url + '") ' + (-LAUNCHER_RECT.x) + 'px ' +
      (-LAUNCHER_RECT.y) + 'px / 1920px 1080px no-repeat';
  }
  function whenScene(fn) { if (sceneWait) sceneWait.push(fn); else fn(); }

  if (!SCENE && flags.get('bg') === '1') {
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
    mk('setting', 'Night light', 'Settings', null, 'ms-settings:nightlight'),
    mk('setting', 'Colors', 'Settings', null, 'ms-settings:colors'),
    mk('setting', 'Background', 'Settings', null, 'ms-settings:personalization-background'),
    mk('setting', 'Screen and sleep', 'Settings', null, 'ms-settings:powersleep'),
  ];

  /* the power rows, shaped like lib/launcher-index.js source 4 builds them */
  function pw(action, name, subtitle, glyph, keywords, confirm) {
    var it = mk('power', name, subtitle, null, action);
    it.glyph = glyph; it.keywords = keywords; it.confirm = confirm || null;
    return it;
  }
  ITEMS.push(
    pw('lock', 'Lock', 'Session', 'lock', ['lock screen', 'lock computer', 'lock pc']),
    pw('sleep', 'Sleep', 'Power', 'sleep', ['suspend', 'standby']),
    pw('hibernate', 'Hibernate', 'Power', 'hibernate', ['hibernation']),
    pw('restart', 'Restart', 'Power · asks first', 'restart', ['reboot', 'restart computer', 'restart pc'], 'Press Enter again to restart'),
    pw('shutdown', 'Shut down', 'Power · asks first', 'power', ['shutdown', 'turn off', 'power off', 'switch off'], 'Press Enter again to shut down'),
    pw('signout', 'Sign out', 'Session · asks first', 'signout', ['log out', 'logout', 'log off', 'logoff', 'sign off', 'signout'], 'Press Enter again to sign out')
  );
  var POWER_RUN = {
    lock: '"C:\\WINDOWS\\System32\\rundll32.exe" user32.dll,LockWorkStation',
    restart: '"C:\\WINDOWS\\System32\\shutdown.exe" /r /t 0',
    shutdown: '"C:\\WINDOWS\\System32\\shutdown.exe" /s /t 0',
    signout: '"C:\\WINDOWS\\System32\\shutdown.exe" /l',
    hibernate: '"C:\\WINDOWS\\System32\\shutdown.exe" /h',
  };

  /* A fake slice of the Windows Search index: what launcher.files would hand back, already
     scored on lib/launcher-index.js's file scale (500 + name score / 5, so at most 700). */
  var FILES = [
    ['report.docx', '~\\Documents', 'file'],
    ['Report - term 1 budget.pdf', '~\\Documents\\taxes', 'file'],
    ['repos', '~', 'folder'],
    ['final report draft.docx', '~\\OneDrive\\Documents', 'file'],
    ['taxes', '~\\Documents', 'folder'],
    ['tax-notes.md', '~\\Documents\\taxes\\2025', 'file'],
    ['chrome-profile', '~\\some-app', 'folder'],
    ['Steam screenshots', '~\\Pictures', 'folder'],
  ];
  function fileSearch(q) {
    var query = String(q || '').trim().toLowerCase();
    var out = [];
    FILES.forEach(function (f) {
      var s = score({ name: f[0].replace(/\.[^.]{1,8}$/, ''), subtitle: '' }, query);
      if (s < 0) return;
      out.push({
        id: 'file:' + f[0].toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        kind: 'file', name: f[0], subtitle: f[1],
        path: 'C:\\Users\\user' + f[1].slice(1) + '\\' + f[0],
        icon: null, glyph: f[2], isDir: f[2] === 'folder',
        score: 500 + Math.round(s / 5),
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 8);
  }

  /* The counts are the ones a real machine reports, not the length of the fake
     list: the footer's job is to look like the real footer, numbers and all. */
  var SOURCES = [
    { name: 'apps', count: 212, status: 'ok', reason: '' },
    {
      name: 'commands', count: 14, status: 'error',
      reason: 'profile not found at C:\\Users\\user\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    },
    { name: 'settings', count: 26, status: 'ok', reason: '' },
    { name: 'power', count: 6, status: 'ok', reason: '' },
  ];

  var KIND_ORDER = { app: 0, command: 1, setting: 2, power: 3, url: 4, file: 5 };

  /* lib/launcher-index.js's scorePower, same numbers: whole name/keyword 1000, nothing under
     three letters, a prefix 700-760 (below an app that starts the same way), a word 690, the
     group word 650. */
  function scorePower(item, q) {
    var words = [item.name.toLowerCase()].concat(item.keywords || []);
    var i;
    for (i = 0; i < words.length; i++) if (words[i] === q) return 1000;
    if (q.length < 3) return -1;
    var best = -1;
    for (i = 0; i < words.length; i++) {
      if (words[i].indexOf(q) === 0) best = Math.max(best, 760 - Math.min(60, words[i].length - q.length));
      else if (words[i].split(/\s+/).some(function (p) { return p.indexOf(q) === 0; })) best = Math.max(best, 690);
    }
    if (best >= 0) return best;
    var group = (item.subtitle || '').toLowerCase().split(/[^a-z]+/)[0];
    return (group === 'power' || group === 'session') && group.indexOf(q) === 0 ? 650 : -1;
  }

  function looksLikeUrl(q) {
    if (/^https?:\/\//i.test(q)) return true;
    if (/\s/.test(q)) return false;
    return /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?:[/:?#].*)?$/i.test(q);
  }

  function score(item, q) {
    if (item.kind === 'power') return scorePower(item, q);
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
    var out = scored.map(function (x) { return Object.assign({}, x.it, { score: x.s }); });
    if (looksLikeUrl(query)) {
      var u = mk('url', 'Open ' + String(q).trim(), 'in your browser', null,
        /^https?:/i.test(q) ? q : 'https://' + q);
      u.score = 1100;
      out.unshift(u);
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
    if (SCENE) {
      g.drawImage(sceneImg, LAUNCHER_RECT.x, LAUNCHER_RECT.y, LAUNCHER_RECT.w, LAUNCHER_RECT.h, 0, 0, BD_W, BD_H);
      return c.toDataURL('image/png');
    }
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
        case 'launcher.power': {
          var p = ITEMS.filter(function (i) { return i.kind === 'power' && i.path === args.action; })[0];
          if (!p) return Promise.resolve({ ok: false, reason: 'there is no power action called "' + args.action + '"' });
          if (p.confirm && args.confirmed !== true) return Promise.resolve({ ok: false, reason: p.name + ' asks first: press Enter on it twice' });
          if (args.action === 'sleep') {
            return Promise.resolve({ ok: true, dryRun: true,
              reason: 'dry run: would call SetSuspendState(FALSE, FALSE, FALSE) in the sidecar after 400 ms (Modern Standby (S0 low power idle))' });
          }
          return Promise.resolve({ ok: true, dryRun: true, reason: 'dry run: would run ' + POWER_RUN[args.action] });
        }
        case 'search.files':
        case 'launcher.files':
          // a real index answers in 50-300 ms on Owen's machine; 90 keeps the merge visible
          return new Promise(function (resolve) {
            setTimeout(function () {
              if (FILES_DOWN) {
                resolve({ ok: false, q: args.q, items: [],
                  reason: 'the Windows Search service (WSearch) is Stopped (start type Automatic (delayed)), so there is no file index to ask. Start it in services.msc' });
                return;
              }
              var hits = fileSearch(args.q);
              resolve({ ok: true, q: args.q, items: hits, ms: 84, reason: '' });
            }, FILES_SLOW ? 6000 : 90);
          });
        case 'search.copy': {
          var C = window.MantleCalc;
          var r = C ? C.evaluate(args.expr) : null;
          if (!r) return Promise.resolve({ ok: false, reason: '"' + args.expr + '" is not a calculation, so there is no answer to copy' });
          if (!r.ok) return Promise.resolve({ ok: false, reason: r.reason });
          return Promise.resolve({ ok: true, dryRun: true, copied: r.copy, reason: 'dry run: would copy ' + r.copy });
        }
        case 'search.web':
          return Promise.resolve({ ok: true, dryRun: true,
            url: 'https://www.google.com/search?q=' + encodeURIComponent(args.q).replace(/%20/g, '+'),
            reason: 'dry run: would open https://www.google.com/search?q=' + encodeURIComponent(args.q).replace(/%20/g, '+') + ' in your browser' });
        case 'search.openFile':
        case 'launcher.openFile':
          return Promise.resolve({ ok: true, dryRun: true,
            reason: 'dry run: would ' + (args.reveal ? 'show ' + args.path + ' in its folder' : 'open ' + args.path) });
        /* Win+R / Win+X (lane keysrun): main's run.* and quicklinks.open, ALWAYS dry runs. ?runcancel=1:
           an admin run comes back as a refused UAC prompt; ?runhist=0: no history yet. */
        case 'run.history': return Promise.resolve({ items: RUN_HIST.slice() });
        case 'run.complete': {
          var tl = String(args.typed || '').toLowerCase();
          return Promise.resolve({ typed: args.typed, items: RUN_DIR.filter(function (p) { return p.text.toLowerCase().indexOf(tl) === 0; }) });
        }
        case 'run.exec': {
          var line = String(args.line || '').trim();
          if (!line) return Promise.resolve({ ok: false, reason: 'Type a program, folder, document or website.' });
          if (/^notarealprogram\b/i.test(line)) return Promise.resolve({ ok: false, how: 'exec', reason: 'Windows can\'t find "notarealprogram". Check the spelling, then try again.' });
          if (args.admin && flags.get('runcancel') === '1') return Promise.resolve({ ok: false, how: 'exec', reason: 'You said no to the administrator prompt, so "' + line.split(' ')[0] + '" didn\'t run.' });
          RUN_HIST = [line].concat(RUN_HIST.filter(function (h) { return h.toLowerCase() !== line.toLowerCase(); }));
          var isDir = /^%appdata%|^[a-z]:\\$/i.test(line) && line.indexOf(' ') < 0;
          return Promise.resolve({ ok: true, dryRun: true, how: isDir ? 'folder' : 'exec',
            reason: 'dry run: would ' + (isDir ? 'open Mantle Files at ' : args.admin ? 'run as administrator ' : 'open ') + line });
        }
        case 'quicklinks.open': {
          var QLm = window.MantleQuickLinks;
          var ql = QLm && QLm.byId(args.link);
          if (!ql || !ql.run) return Promise.resolve({ ok: false, reason: 'That quick link isn\'t one Mantle knows.' });
          return Promise.resolve({ ok: true, dryRun: true, link: ql.id, reason: 'dry run: would open ' + QLm.parse(ql.label).text });
        }
        case 'launcher.show': emit('launcher:visible', true); return Promise.resolve({ visible: true });
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
  if (!NO_BLUR) setTimeout(function () { whenScene(function () {
    emit('launcher.backdrop', {
      png: backdropPNG(), w: BD_W, h: BD_H,
      rect: { x: 620, y: 310, w: 680, h: 460 },   // physical px of the launcher's rect
      ms: 7,
    });
    emit('state', STATE);
  }); }, 300);

  // a test can drive the visible event by hand
  window.__mockShow = function () { emit('launcher:visible', true); };
  window.__mockHide = function () { emit('launcher:visible', false); };
  // any event main sends (launcher.keyboard, a launcher.open over an open launcher)
  window.__mockEmit = function (name, payload) { emit(name, payload); };
  // Win+S's path: main sends launcher.open {mode, query} and then shows the window
  window.__mockOpen = function (mode, query) {
    emit('launcher.open', { mode: mode || 'search', query: query || '', from: 'mock' });
    emit('launcher:visible', true);
  };
  if (OPEN_MODE || OPEN_Q) setTimeout(function () { window.__mockOpen(OPEN_MODE || 'search', OPEN_Q || ''); }, 50);
})();
