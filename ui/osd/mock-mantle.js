/* mock-mantle.js - a stand-in for main and the sidecar, so the volume pop-up can be looked at,
 * measured and screenshotted in a plain headless browser: no Electron, no sidecar, and nothing
 * ever changed on Owen's machine. It defines window.mantle ONLY when it is absent, so with the
 * real preload it does nothing at all (the switcher's and the launcher's pattern).
 *
 * WHAT IT PLAYS (query string):
 *   kind=volume|brightness   level=0-100   muted=1   dead=1 (the level cannot be read, with the reason)
 *   expand=1                 the panel open, as the bar's right-click opens it
 *   apps=3 (default) | 0 | 6 | 9 | error      which apps are playing sound
 *   refuse=1                 every set is refused with the passive sidecar's own reason
 *   below=1                  a top-docked bar: the pop-up hangs below it
 *   bg=split (default) | dark | light        the fake desktop behind the transparent window
 *   churn=1                  an app starts and another stops while the panel is open
 */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  var KIND = q.get('kind') === 'brightness' ? 'brightness' : 'volume';
  var LEVEL = q.has('level') ? Number(q.get('level')) : KIND === 'brightness' ? 70 : 62;
  var MUTED = q.get('muted') === '1';
  var DEAD = q.get('dead') === '1';
  var APPS = q.get('apps') || '3';
  var REFUSE = q.get('refuse') === '1';
  var BG = q.get('bg') || 'split';
  var CHURN = q.get('churn') === '1';

  /* the fake desktop: a loud split so contrast is measured over the worst of both */
  var bgs = {
    split: 'linear-gradient(90deg, #0c0f1a 0 50%, #f5f7fb 50% 100%)',
    dark: 'linear-gradient(135deg, #10131f, #2a2f45)',
    light: 'linear-gradient(135deg, #ffffff, #dfe6f2)',
  };
  document.documentElement.style.background = bgs[BG] || bgs.split;

  function icon(color) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<rect x="1" y="1" width="14" height="14" rx="3.5" fill="' + color + '"/>' +
      '<path d="M5 5.5v5l4.5-2.5z" fill="#fff"/></svg>');
  }
  var ALL = [
    { key: 'pid:4120', pid: 4120, name: 'Spotify', path: 'C:\\Users\\user\\AppData\\Roaming\\Spotify\\Spotify.exe', active: true, level: 64, muted: false, sessions: 1, icon: icon('#1db954') },
    { key: 'pid:9876', pid: 9876, name: 'Microsoft Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', active: true, level: 100, muted: false, sessions: 3, icon: icon('#2f6fe0') },
    { key: 'pid:2231', pid: 2231, name: 'Discord', path: 'C:\\Users\\user\\AppData\\Local\\Discord\\app-1.0.9212\\Discord.exe', active: true, level: 45, muted: true, sessions: 2, iconReason: 'no icon (Discord.exe: the mock has none)' },
    { key: 'pid:5512', pid: 5512, name: 'LessonPlayer Learning Accelerator - Algebra II, Unit 4 Lesson 14 video player', path: 'C:\\Program Files\\LessonPlayer\\LessonPlayer.exe', active: true, level: 80, muted: false, sessions: 1, icon: icon('#c2410c') },
    { key: 'pid:3302', pid: 3302, name: 'Zoom Workplace', path: 'C:\\Users\\user\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe', active: true, level: 72, muted: false, sessions: 1, icon: icon('#0b5cff') },
    { key: 'system', pid: 0, system: true, name: 'System Sounds', path: null, active: true, level: 100, muted: false, sessions: 1 },
    { key: 'pid:7710', pid: 7710, name: 'Minecraft Launcher', path: 'C:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe', active: true, level: 90, muted: false, sessions: 1, icon: icon('#3f7d20') },
    { key: 'pid:8801', pid: 8801, name: 'VLC media player', path: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', active: true, level: 55, muted: false, sessions: 1, icon: icon('#f08c00') },
    { key: 'pid:1203', pid: 1203, name: 'Microsoft Teams', path: 'C:\\Users\\user\\AppData\\Local\\Microsoft\\Teams\\ms-teams.exe', active: true, level: 100, muted: false, sessions: 1, icon: icon('#5b5fc7') },
    { key: 'pid:6120', pid: 6120, name: 'Steam', path: 'C:\\Program Files (x86)\\Steam\\steam.exe', active: false, level: 100, muted: false, sessions: 1, icon: icon('#1b2838') },
  ];
  var n = APPS === 'error' ? 3 : Math.max(0, Math.min(10, Number(APPS) || 0));
  var apps = ALL.slice(0, n);
  if (n > 0) apps.push(ALL[9]);                     // an idle app: the panel must not list it

  var state = {
    volume: DEAD ? { ok: false, level: null, muted: false, reason: 'no playback device is enabled (Windows reports none)' }
                 : { ok: true, level: LEVEL, muted: MUTED, reason: null },
    brightness: DEAD ? { ok: false, level: null, present: false, reason: 'this display does not report a brightness control' }
                     : { ok: true, level: LEVEL, present: true, reason: null },
  };
  var listeners = {};
  var mock = window.__mock = { calls: [], sizes: [], faded: 0, state: state };
  function emit(ch, p) { (listeners[ch] || []).forEach(function (f) { try { f(p); } catch (e) { console.error(e); } }); }

  var REASON = 'refused: sidecar is passive (test mode): only a session of a process the test harness started may be changed';

  function reply(ch, p) {
    switch (ch) {
      case 'osd.size': mock.sizes.push(p); return { ok: true };
      case 'osd.faded': mock.faded++; return { ok: true };
      case 'qs.set': {
        var part = p.part === 'mute' ? 'volume' : p.part;
        if (REFUSE) return { ok: false, part: p.part, value: p.value, state: Object.assign({}, state[part]), reason: REASON.replace(': only a session of a process the test harness started may be changed', ': it would have changed the ' + p.part) };
        if (p.part === 'mute') state.volume.muted = !!p.value;
        else state[part].level = p.value;
        return { ok: true, part: p.part, value: p.value, state: Object.assign({}, state[part]), reason: null };
      }
      case 'qs.audio.sessions':
        if (APPS === 'error')
          return { ok: false, device: { id: 'x', name: 'Speakers (Realtek(R) Audio)' }, sessions: [], readMs: 3,
            reason: 'the apps playing sound cannot be read: the output device refused the session manager (HRESULT 0x88890004)' };
        return { ok: true, device: { id: 'x', name: 'Speakers (Realtek(R) Audio)' }, sessions: apps.map(function (a) { return Object.assign({}, a); }), readMs: 6, reason: null };
      case 'qs.audio.session': {
        var a = apps.filter(function (x) { return x.key === p.key; })[0];
        if (!a) return { ok: false, key: p.key, session: null, reason: 'that app has no audio session on the current output any more (it may have stopped or closed)' };
        if (REFUSE) { var cur = Object.assign({}, a); delete cur.icon; return { ok: false, key: p.key, session: cur, reason: REASON }; }
        if (typeof p.level === 'number') a.level = p.level;
        if (typeof p.muted === 'boolean') a.muted = p.muted;
        var row = Object.assign({}, a); delete row.icon; delete row.iconReason;
        return { ok: true, key: p.key, session: row, ms: 4, reason: null };
      }
      default: throw new Error('unknown channel "' + ch + '" (osd mock bridge)');
    }
  }

  window.mantle = {
    mode: 'mock',
    on: function (ch, cb) {
      (listeners[ch] = listeners[ch] || []).push(cb);
      return function () { listeners[ch] = listeners[ch].filter(function (f) { return f !== cb; }); };
    },
    call: function (ch, p) {
      mock.calls.push(ch);
      p = p && typeof p === 'object' ? JSON.parse(JSON.stringify(p)) : p;
      return new Promise(function (resolve, reject) {
        setTimeout(function () { try { resolve(reply(ch, p)); } catch (e) { reject(e); } }, 20);
      });
    },
  };

  /* main's half: the key arrives 40 ms after the page is up, the way the hook's report would */
  window.addEventListener('load', function () { setTimeout(function () {
    emit('osd.show', { kind: KIND, state: Object.assign({}, state[KIND]), expand: q.get('expand') === '1', below: q.get('below') === '1', via: 'mock' });
  }, 40); });
  if (CHURN) {
    setTimeout(function () { apps[0].active = false; apps.push(Object.assign({}, ALL[7])); }, 400);
  }
  mock.emit = emit;
})();
