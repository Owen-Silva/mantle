/* mock-mantle.js — a stand-in for main and the sidecar, so the Alt+Tab overlay can be looked at,
 * measured and screenshotted in a plain headless browser: no Electron, no sidecar, no keyboard
 * hook, and nothing ever switched on Owen's machine.
 *
 * It defines window.mantle ONLY when it is absent, so with the real preload it does nothing at all
 * and stays in the page (the launcher's pattern).
 *
 * WHAT IT PLAYS: main's half of one Alt+Tab. It lays the session out with the SAME
 * ui/switcher/layout.js main uses, puts #stage where main would put the window on a fake screen
 * the size of the viewport, paints a loud fake desktop behind it, hands the page the session, and
 * when the page reports its preview boxes (switcher.painted) it draws a fake "DWM picture" into
 * each box, letterboxed at the source window's shape exactly as lib/thumbs.js toPhysical() does.
 * The backdrop PNG is a crop of that same fake desktop, so the glass blurs what is really there.
 *
 * Query flags:
 *   ?n=14            how many windows (default 3)
 *   ?sel=5           move the selection there after the session (default: the sidecar's, 1)
 *   ?blur=0          no backdrop: the fallback tint and the "no blur: ..." foot line
 *   ?thumbs=fail     every preview fails, so the reasons inside the boxes can be looked at
 *   ?notice=1        the "could not switch" notice instead of a session
 *   ?bg=0            no fake desktop (transparent, like the real window)
 */
(function () {
  'use strict';
  if (window.mantle) return;                 // the real bridge wins, always

  var flags = new URLSearchParams(location.search);
  var N = Math.max(0, Number(flags.get('n') || 3));
  var SW = window.innerWidth;
  var SH = window.innerHeight;
  var listeners = {};
  var mock = window.__mock = { painted: [], sessionAt: 0, ready: false, lay: null, rect: null };

  function emit(name, payload) {
    (listeners[name] || []).slice().forEach(function (cb) {
      try { cb(payload); } catch (err) { console.error('mock: ' + name + ' handler threw: ' + err.message); }
    });
  }

  /* ---- the fake desktop, drawn ONCE on a canvas: the wallpaper AND the backdrop's source ---- */
  var desk = document.createElement('canvas');
  desk.width = SW; desk.height = SH;
  (function paintDesk() {
    var g = desk.getContext('2d');
    var grad = g.createLinearGradient(0, 0, SW, SH);
    var stops = ['#2f6fe0', '#b23fd0', '#d64545', '#e0a059', '#1f8f4e', '#2f6fe0'];
    for (var i = 0; i < stops.length; i++) grad.addColorStop(i / (stops.length - 1), stops[i]);
    g.fillStyle = grad; g.fillRect(0, 0, SW, SH);
    // hard edges: what a blur is judged on
    g.fillStyle = '#0b0d10'; g.fillRect(SW * 0.30, 0, 40, SH);
    g.fillStyle = '#ffffff'; g.fillRect(SW * 0.62, SH * 0.10, 28, SH * 0.8);
    // two app windows left open on the desktop
    function win(x, y, w, h, bar, fill) {
      g.fillStyle = fill; g.fillRect(x, y, w, h);
      g.fillStyle = bar; g.fillRect(x, y, w, 30);
      g.fillStyle = 'rgba(0,0,0,.18)';
      for (var r = 0; r < 6; r++) g.fillRect(x + 20, y + 50 + r * 26, w * (0.4 + (r % 3) * 0.15), 12);
    }
    win(SW * 0.06, SH * 0.08, SW * 0.46, SH * 0.62, '#dfe3ea', '#f7f8fa');
    win(SW * 0.48, SH * 0.30, SW * 0.44, SH * 0.58, '#202226', '#2b2d31');
  })();
  if (flags.get('bg') !== '0') {
    document.documentElement.style.background = 'url(' + desk.toDataURL('image/png') + ') 0 0 / 100% 100% no-repeat';
  }

  /* ---- the windows ---------------------------------------------------------------------------- */
  var PNG = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZklEQVR42mNgwAHaVhz6T03MQAygtqUkOQYmGVE1haYYqyPoZTlOR9DTcmRHDA4H0Dv4MaJh1AGD2gGP3nyjGh51wGgiHE0Do4lwNBGOOmA0EQ5eB4y2igdFx2TAu2aDonM6UN1zAP63YfFRSPEOAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjUlEQVR42mNgwAFW9O36T03MQAygtqUkOQYmWZXQQ1OM1RH0shynI+hpObIjBocD6B38GNEw5Bzw7sU3vJimDiBkOSmOINkBxFpOrCNIcgAxFpDqCKIdQKrPiFU/NB1ATk4ZdcDwcsDIzAUDXhANiqJ4UFRGg6I6Hp4totFW8aDomAx412xQdE4HqnsOAJKtNle3/gOLAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiklEQVR42mNgwAH61s36T03MQAygtqUkOQYmmdCQQ1OM1RH0shynI+hpObIjBocD6B38GNEw5B3w7MuLEewAkOUwPPIcgGw5OY4Y2g7AZjmpjhi6DsBnOSmOGJoOIMZyYh0x9BxAiuXEOGJoOYAcywk5Ymg5YHi3iEZbxYOiYzLgXbNB0TkdqO45AA7o0MjhAICxAAAAAElFTkSuQmCC',
  ];
  var TITLES = [
    'Inbox - Outlook',
    'LessonPlayer - Algebra II - Unit 4, Lesson 12: Solving Systems of Three Linear Equations in Three Variables by Elimination and Substitution (Part 2 of 3) - Video Lecture with Captions',
    'mantle - main.js - Visual Studio Code',
    'Spotify Premium',
    'Windows PowerShell',
    'Downloads',
    'Discord | #general | Book Club 2026-27 Season Planning, Conference Schedule and Ride Share Coordination Thread',
    'Calculator',
    'Settings',
    'Microsoft Edge - New tab',
    'Notepad - untitled.txt',
    'Task Manager',
    'Photos - IMG_20260921_184455.jpg',
    'Paint',
  ];
  var SHAPES = [[16, 9], [16, 10], [4, 3], [3, 4], [21, 9], [16, 9]];
  function item(i) {
    var t = TITLES[i % TITLES.length] + (i >= TITLES.length ? ' (' + (1 + Math.floor(i / TITLES.length)) + ')' : '');
    var it = { hwnd: String(100000 + i * 16), title: t, pid: 4000 + i, minimized: i === 5, hung: i === 9 };
    if (i % 4 === 3) { it.icon = null; it.iconReason = 'no icon (mock: Windows had no icon for it)'; }
    else it.icon = PNG[i % PNG.length];
    return it;
  }
  var LIST = [];
  for (var i = 0; i < N; i++) LIST.push(item(i));

  /* ---- where main would put the window: centred on the fake screen ----------------------------- */
  var Lay = null;
  var lay = null;
  var rect = null;
  function placeStage(w, h) {
    rect = { x: Math.round((SW - w) / 2), y: Math.round((SH - h) / 2), w: w, h: h };
    var st = document.getElementById('stage').style;
    st.left = rect.x + 'px'; st.top = rect.y + 'px'; st.width = w + 'px'; st.height = h + 'px';
    st.right = 'auto'; st.bottom = 'auto';
    mock.rect = rect;
  }

  /* ---- fake DWM pictures, letterboxed like lib/thumbs.js toPhysical() ------------------------ */
  var layer = null;
  function drawPictures(boxes) {
    if (layer) layer.remove();
    layer = document.createElement('div');
    layer.style.position = 'fixed'; layer.style.inset = '0'; layer.style.pointerEvents = 'none'; layer.style.zIndex = '10';
    boxes.forEach(function (b, k) {
      var idx = LIST.findIndex(function (it) { return it.hwnd === b.hwnd; });
      var shape = SHAPES[idx % SHAPES.length];
      var s = Math.min(b.w / shape[0], b.h / shape[1]);
      var w = shape[0] * s, h = shape[1] * s;
      var pic = document.createElement('div');
      var ps = pic.style;
      ps.position = 'fixed';
      ps.left = (b.x + (b.w - w) / 2) + 'px'; ps.top = (b.y + (b.h - h) / 2) + 'px';
      ps.width = w + 'px'; ps.height = h + 'px';
      var dark = idx % 3 === 1;
      ps.background = dark ? '#1f2125' : '#fbfbfc';
      ps.overflow = 'hidden';
      var bar = document.createElement('div');
      bar.style.height = Math.max(6, h * 0.09) + 'px';
      bar.style.background = dark ? '#2c2f35' : ['#e6e9ef', '#dbe7ff', '#f3e3d3'][idx % 3];
      pic.appendChild(bar);
      for (var r = 0; r < 5; r++) {
        var line = document.createElement('div');
        line.style.height = Math.max(2, h * 0.05) + 'px';
        line.style.margin = Math.max(2, h * 0.05) + 'px ' + (w * 0.08) + 'px 0';
        line.style.width = (35 + ((idx * 7 + r * 13) % 45)) + '%';
        line.style.background = dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)';
        pic.appendChild(line);
      }
      if (idx % 5 === 2) {           // a photo-ish block, so colour shows through
        var ph = document.createElement('div');
        ph.style.margin = (h * 0.06) + 'px ' + (w * 0.08) + 'px';
        ph.style.height = (h * 0.3) + 'px';
        ph.style.background = 'linear-gradient(135deg, #4a90e2, #50e3c2)';
        pic.appendChild(ph);
      }
      layer.appendChild(pic);
    });
    document.body.appendChild(layer);
  }

  function backdropPNG() {
    var o = 14;
    var x = rect.x + lay.margin - o, y = rect.y + lay.margin - o;
    var w = lay.panelW + 2 * o, h = lay.panelH + 2 * o;
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w / 4)); c.height = Math.max(1, Math.round(h / 4));
    c.getContext('2d').drawImage(desk, x, y, w, h, 0, 0, c.width, c.height);
    return { png: c.toDataURL('image/png'), w: c.width, h: c.height };
  }

  function startSession() {
    Lay = window.SwitcherLayout;
    lay = Lay.layout(LIST.length, SW, SH);
    mock.lay = lay;
    placeStage(lay.w, lay.h);
    mock.sessionAt = performance.now();
    emit('switcher.session', { seq: 1, sel: LIST.length >= 2 ? 1 : 0, current: 0, backwards: false, tracking: true, list: LIST, lay: lay });
    if (flags.get('blur') === '0') {
      setTimeout(function () { emit('switcher.backdrop', { seq: 1, png: null, reason: 'mock: the capture lane said the screen could not be read' }); }, 20);
    } else {
      setTimeout(function () { var b = backdropPNG(); emit('switcher.backdrop', { seq: 1, png: b.png, w: b.w, h: b.h, ms: 21 }); }, 20);
    }
    var sel = flags.get('sel');
    if (sel !== null) setTimeout(function () { emit('switcher.move', { seq: 1, sel: Number(sel), key: 'next' }); }, 60);
  }

  /*
   * ?bench=K: K sessions back to back, the way main runs them (session, the page draws, painted,
   * end, the next one), with the viewport AS the window (shoot.js sizes it from layout.js) and no
   * fake desktop, so what is timed is this page and nothing the mock paints around it.
   */
  function startBench(k) {
    Lay = window.SwitcherLayout;
    lay = Lay.layout(LIST.length, Number(flags.get('sw')) || 1920, Number(flags.get('sh')) || 1080);
    mock.lay = lay;
    rect = { x: 0, y: 0, w: SW, h: SH };
    mock.rect = rect;
    mock.bench = [];
    var seq = 100;
    var next = function () {
      if (mock.bench.length >= k) { mock.benchDone = true; return; }
      seq++;
      mock.sessionAt = performance.now();
      mock.onPainted = function (ms) {
        mock.bench.push(ms);
        mock.onPainted = null;
        emit('switcher.end', { seq: seq, why: 'bench' });
        setTimeout(next, 30);
      };
      emit('switcher.session', { seq: seq, sel: 1, current: 0, backwards: false, tracking: true, list: LIST, lay: lay });
      var b = backdropPNG();
      emit('switcher.backdrop', { seq: seq, png: b.png, w: b.w, h: b.h, ms: 21 });
    };
    next();
  }

  function startNotice() {
    Lay = window.SwitcherLayout;
    var n = Lay.notice();
    lay = n;
    rect = { x: Math.round((SW - n.w) / 2), y: Math.round(SH - n.h - 120), w: n.w, h: n.h };
    var st = document.getElementById('stage').style;
    st.left = rect.x + 'px'; st.top = rect.y + 'px'; st.width = n.w + 'px'; st.height = n.h + 'px';
    st.right = 'auto'; st.bottom = 'auto';
    emit('switcher.notice', {
      id: 1,
      title: 'Could not switch to "Task Manager"',
      text: 'Windows refused to bring it to the front (SetForegroundWindow and the focus ladder both failed); Windows also reports that window as not responding',
      lay: n,
    });
  }

  window.mantle = {
    on: function (name, cb) {
      (listeners[name] = listeners[name] || []).push(cb);
      return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== cb; }); };
    },
    call: function (name, args) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (name === 'switcher.ready') {
            mock.ready = true;
            if (flags.get('bench')) startBench(Number(flags.get('bench')));
            else if (flags.get('notice') === '1') startNotice();
            else startSession();
            resolve({ ok: true });
          } else if (name === 'switcher.painted') {
            if (args && args.notice) { mock.painted.push({ notice: args.notice }); resolve({ ok: true }); return; }
            if (mock.onPainted) {
              if (args.why === 'session') mock.onPainted(args.ms);
              resolve({ ok: true, stale: args.why !== 'session' });
              return;
            }
            mock.painted.push({ ms: args.ms, why: args.why, boxes: args.boxes, vw: args.vw, vh: args.vh, at: performance.now() - mock.sessionAt });
            var fail = flags.get('thumbs') === 'fail';
            if (!fail) drawPictures(args.boxes || []);
            var thumbs = (args.boxes || []).map(function (b) {
              return fail
                ? { hwnd: b.hwnd, ok: false, reason: 'no picture: Windows is hiding it: it is on another virtual desktop, or it is a suspended Store app' }
                : { hwnd: b.hwnd, ok: true, reason: null, minimized: false };
            });
            emit('switcher.thumbs', { seq: 1, ok: true, reason: null, thumbs: thumbs });
            resolve({ ok: true, thumbs: thumbs.length });
          } else if (name === 'switcher.pick') {
            mock.picked = args;
            resolve({ ok: true, granted: true });
          } else {
            resolve({ ok: true });
          }
        }, 0);
      });
    },
  };
})();
