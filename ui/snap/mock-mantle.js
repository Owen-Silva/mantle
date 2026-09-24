/* mock-mantle.js - a stand-in for main and the sidecar, so the snap window can be looked at,
 * measured and screenshotted in a plain headless browser: no Electron, no sidecar, no keyboard
 * hook, and no window on Owen's machine ever moved.
 *
 * It defines window.mantle ONLY when it is absent, so with the real preload it does nothing.
 *
 * WHAT IT PLAYS: main's half. It paints a fake desktop behind the page (the real window is
 * transparent), sends one snap.show, and when the page reports its preview boxes (snap.painted)
 * it draws a fake "DWM picture" into each, letterboxed at the source window's shape exactly as
 * lib/thumbs.js toPhysical() does. Everything the page calls is kept in window.__mock.
 *
 * Query flags:
 *   ?mode=picker|assist|notice   (default assist)
 *   ?n=5              how many windows Snap Assist offers (default 4)
 *   ?sel=2            the selected window
 *   ?zone=right half  the zone's name
 *   ?thumbs=fail      every picture fails, so the reasons inside the boxes can be seen
 *   ?dark=1           a dark desktop behind the pane
 *   ?bg=0             no fake desktop at all
 */
(function () {
  'use strict';
  if (window.mantle) return;

  var q = new URLSearchParams(location.search);
  var MODE = q.get('mode') || 'assist';
  var N = Math.max(0, Number(q.get('n') || 4));
  var DARK = q.get('dark') === '1';
  var listeners = {};
  var mock = window.__mock = { painted: [], picks: [], dismissed: [], shown: null };

  function emit(name, payload) {
    (listeners[name] || []).slice().forEach(function (cb) {
      try { cb(payload); } catch (err) { console.error('mock: ' + name + ' handler threw: ' + err.message); }
    });
  }

  var APPS = [
    { exe: 'Code.exe', title: 'snap.js - mantle - Visual Studio Code', c: '#2b6fd6', ar: 16 / 10 },
    { exe: 'chrome.exe', title: 'Pull request #412 - Google Chrome', c: '#d6452b', ar: 16 / 9 },
    { exe: 'explorer.exe', title: 'Downloads', c: '#d6a52b', ar: 4 / 3 },
    { exe: 'Spotify.exe', title: 'Spotify Premium', c: '#1f9e55', ar: 16 / 10 },
    { exe: 'WindowsTerminal.exe', title: 'PowerShell', c: '#333a4e', ar: 16 / 10 },
    { exe: 'Discord.exe', title: '#general - Discord', c: '#5865f2', ar: 16 / 10 },
    { exe: 'notepad.exe', title: 'notes.txt - Notepad', c: '#6b7280', ar: 3 / 4 },
    { exe: 'Figma.exe', title: 'Mantle bar - Figma', c: '#a259ff', ar: 16 / 9 },
  ];

  function icon(color) {
    var c = document.createElement('canvas');
    c.width = c.height = 32;
    var g = c.getContext('2d');
    g.fillStyle = color;
    g.beginPath();
    if (g.roundRect) g.roundRect(2, 2, 28, 28, 7); else g.rect(2, 2, 28, 28);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.fillRect(9, 9, 14, 3);
    g.fillRect(9, 15, 10, 3);
    g.fillRect(9, 21, 12, 3);
    return c.toDataURL('image/png');
  }

  function desktop() {
    if (q.get('bg') === '0') return;
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:-1;background:' + (DARK
      ? 'radial-gradient(1200px 700px at 20% 10%, #2b3350, #10131d)'
      : 'radial-gradient(1200px 700px at 20% 10%, #b9cdf0, #7d95c7 60%, #5d6f9a)');
    document.body.insertBefore(d, document.body.firstChild);
  }

  /** Where DWM would put the picture inside a box: the source's shape, centred (thumbs.js toPhysical). */
  function fit(box, ar) {
    var w = box.w, h = w / ar;
    if (h > box.h) { h = box.h; w = h * ar; }
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w: w, h: h };
  }

  function picture(box, app) {
    var r = fit(box, app.ar);
    var p = document.createElement('div');
    p.className = '__mockpic';
    p.style.cssText = 'position:fixed;pointer-events:none;z-index:10;left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w +
      'px;height:' + r.h + 'px;background:' + (DARK ? '#1d2230' : '#f4f6fb') + ';border-radius:4px;overflow:hidden;';
    // CSSOM, not style="" attributes: the page's CSP (style-src file:) blocks inline attributes.
    [['0', '0', '100%', '14%', app.c], ['8%', '8%', '60%', '6%', null], ['5%', '8%', '44%', '6%', null]].forEach(function (s) {
      var d = document.createElement('div');
      d.style.margin = s[0] + ' ' + s[1] + ' 0';
      d.style.width = s[2];
      d.style.height = s[3];
      d.style.background = s[4] || (DARK ? '#39405a' : '#d9deea');
      p.appendChild(d);
    });
    document.body.appendChild(p);
  }

  window.mantle = {
    call: function (cmd, args) {
      if (cmd === 'snap.painted') {
        mock.painted.push(args);
        Array.prototype.forEach.call(document.querySelectorAll('.__mockpic'), function (e) { e.remove(); });
        var fail = q.get('thumbs') === 'fail';
        var res = (args.boxes || []).map(function (b) {
          var app = APPS[Number(b.hwnd) % APPS.length];
          if (!fail) picture(b, app);
          return { hwnd: b.hwnd, ok: !fail, reason: fail ? 'no picture: DWM reports the window as 0 x 0, so there is nothing to draw' : null };
        });
        if (args.mode === 'assist') setTimeout(function () { emit('snap.thumbs', { seq: args.seq, ok: true, reason: null, thumbs: res }); }, 0);
      } else if (cmd === 'snap.pick') mock.picks.push(args);
      else if (cmd === 'snap.dismiss') mock.dismissed.push(args);
      return Promise.resolve({ ok: true });
    },
    on: function (name, cb) {
      (listeners[name] = listeners[name] || []).push(cb);
      return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== cb; }); };
    },
  };

  window.addEventListener('DOMContentLoaded', function () {
    desktop();
    setTimeout(function () {
      var p;
      if (MODE === 'picker') p = { seq: 1, mode: 'picker', app: { exe: 'Code.exe', title: 'snap.js - mantle' } };
      else if (MODE === 'notice') {
        p = { seq: 1, mode: 'notice', title: 'Could not snap Taskmgr.exe',
              text: 'Taskmgr.exe is running as administrator and Mantle is not, so Windows will not let Mantle move it ' +
                    '(User Interface Privilege Isolation). Run Mantle as administrator to snap it.' };
      } else {
        var cands = [];
        for (var i = 0; i < N; i++) {
          var a = APPS[i % APPS.length];
          cands.push({ hwnd: String(1000 + i), title: a.title, exe: a.exe, icon: i === 3 ? null : icon(a.c), minimized: i === 2 });
        }
        p = { seq: 1, mode: 'assist', zone: { name: q.get('zone') || 'right half' }, candidates: cands, sel: Number(q.get('sel') || 0), left: 0 };
      }
      mock.shown = p;
      emit('snap.show', p);
    }, 0);
  });
})();
