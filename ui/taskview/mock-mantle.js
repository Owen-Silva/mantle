/* mock-mantle.js - a stand-in for main and the sidecar, so Task View can be looked at, measured and
 * screenshotted in a plain headless browser: no Electron, no sidecar, and nothing ever switched,
 * moved or closed on Owen's machine. Defines window.mantle ONLY when it is absent (the real
 * preload always wins), the switcher's pattern.
 *
 * WHAT IT PLAYS: main's half of one Win+Tab. It paints a loud fake desktop behind the page (the
 * real window is transparent over the real one, with the sidecar's blur-behind; here CSS
 * backdrop-filter stands in), hands the page a session of fake windows and desktops, and when the
 * page reports its preview boxes (taskview.painted) it draws a fake "DWM picture" into each box,
 * letterboxed at the fake window's own shape the way lib/thumbs.js toPhysical() does, in two
 * batches (the progressive fill). Desktop ops change the fake desktops and answer like main does.
 *
 * Query flags:
 *   ?n=9          windows on this desktop (default 7)       ?d=3       desktops (default 2)
 *   ?q=code       type this into the filter                  ?sel=4     select this window
 *   ?vd=registry  the strip read-only, with the reason       ?vd=fail   no desktops, with the reason
 *   ?thumbs=fail  every preview fails (reasons in the boxes) ?thumbs=none  pictures never arrive
 *   ?glass=0      no blur (the thicker fill + a foot line)   ?dark=1    a dark desktop behind
 *   ?zone=strip   Tab into the desktop strip                 ?rename=1  renaming desktop 1
 *   ?drag=1       a window dragged over desktop 2            ?notice=1  a failed action's toast
 *   ?long=1       very long titles and desktop names         ?bench=N   time N opens (ms each)
 */
(function () {
  'use strict';
  if (window.mantle) return;

  var F = new URLSearchParams(location.search);
  var N = Math.max(0, Number(F.has('n') ? F.get('n') : 7));
  var D = Math.max(1, Number(F.get('d') || 2));
  var DARK = F.get('dark') === '1';
  /* SCENE MODE, MOCK ONLY (lane see-glass-b, 2026-10-09): a harness sets window.__mockScene = {url} (a
     1920x1080 picture as a data URL) in an init script; it becomes the desktop behind the page, and the
     stand-in blur-behind also darkens by the sidecar's default acrylic tint (60% black, Glass.cs
     DefaultTint 0x99000000) so the page's fill is judged over what DWM really hands it. Without
     __mockScene nothing here changes. */
  var SCENE = window.__mockScene && window.__mockScene.url ? window.__mockScene : null;
  var LONG = F.get('long') === '1';
  var listeners = {};
  function emit(name, payload) { (listeners[name] || []).forEach(function (cb) { cb(payload); }); }

  var APPS = [
    ['Outlook', 'Inbox - alex@example.com - Outlook', '#1a64c8', 1.6],
    ['Code', 'taskview.js - mantle - Visual Studio Code', '#2a2f3a', 1.78],
    ['Spotify', 'Spotify Premium', '#1c8c4a', 1.6],
    ['Terminal', 'Windows PowerShell', '#20242e', 1.5],
    ['Explorer', 'Downloads - File Explorer', '#d9a520', 1.45],
    ['Notepad', 'README.md - Notepad', '#6a7890', 1.3],
    ['Calculator', 'Calculator', '#505a70', 0.62],
    ['Browser', 'Alex Kim - portfolio - Browser', '#6a4ad8', 1.78],
    ['Discord', '#general - Discord', '#5865f2', 1.6],
    ['Photos', 'IMG_2291.jpg - Photos', '#b04a70', 1.5],
    ['Excel', 'Budget 2026.xlsx - Excel', '#1e7a45', 1.7],
    ['Teams', 'Chat | Microsoft Teams', '#4b53bc', 1.6],
  ];
  function icon(letter, color) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="7" width="32" height="32" fill="' + color +
              '"/><text x="16" y="22" font-family="Segoe UI,Arial" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">' + letter + '</text></svg>';
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }
  function win(k, desk) {
    var a = APPS[k % APPS.length];
    var title = a[1] + (k >= APPS.length ? ' (' + (Math.floor(k / APPS.length) + 1) + ')' : '');
    if (LONG) title = title + ' - a very long window title that keeps going so the caption has to cut it off cleanly';
    return { hwnd: String(1000 + k), title: title, app: a[0], icon: k === 5 ? null : icon(a[0][0], a[2]),
             iconReason: k === 5 ? 'no icon: Mantle has no program path for this window yet' : null,
             minimized: k === 4, hung: k === 3 && N > 6, desktop: desk, color: a[2], aspect: a[3] };
  }

  var desks = [];
  for (var d = 0; d < D; d++) {
    var named = d === 1;
    desks.push({ id: 'D' + d + '000000-0000-0000-0000-000000000000', index: d, named: named,
                 name: named ? (LONG ? 'Side projects, the long-named desktop for everything' : 'Projects') : 'Desktop ' + (d + 1) });
  }
  var current = desks[0].id;
  var items = [];
  for (var i = 0; i < N; i++) items.push(win(i, current));
  var others = [];
  for (var j = 0; j < D - 1; j++) for (var k2 = 0; k2 < 2 + j; k2++) others.push(win(N + j * 3 + k2, desks[j + 1].id));

  function desktopsPayload() {
    var vd = F.get('vd');
    if (vd === 'fail') return { ok: false, source: 'none', reason: 'explorer did not answer a desktop call within 800 ms', canWrite: false, writeReason: 'explorer did not answer a desktop call within 800 ms', current: null, list: [] };
    var list = desks.map(function (x, i) { return { id: x.id, index: i, named: x.named, name: x.named ? x.name : 'Desktop ' + (i + 1) }; });
    if (vd === 'registry') {
      var why = 'this is Windows build 10.0.27000, and Mantle only has the desktop-switching layout for build 10.0.26200 (it changes between builds, and guessing could run the wrong command)';
      return { ok: true, source: 'registry', reason: 'read from the registry because ' + why, canWrite: false, writeReason: why, current: current, list: list };
    }
    return { ok: true, source: 'com', reason: null, canWrite: true, writeReason: null, current: current, list: list };
  }
  function strip(w) { return { hwnd: w.hwnd, title: w.title, app: w.app, icon: w.icon, iconReason: w.iconReason, minimized: w.minimized, hung: w.hung, desktop: w.desktop }; }
  function state() { return { list: items.map(strip), desktops: desktopsPayload(), others: others.map(strip) }; }

  // ---- the fake desktop behind, and the fake DWM pictures over the boxes -----------------------
  var back = document.createElement('canvas');
  var pics = document.createElement('canvas');
  function setupCanvases() {
    var W = window.innerWidth, H = window.innerHeight;
    [back, pics].forEach(function (c) { c.width = W; c.height = H; c.style.cssText = 'position:fixed;left:0;top:0;width:' + W + 'px;height:' + H + 'px;pointer-events:none;'; });
    back.style.zIndex = '-1';
    pics.style.zIndex = '50';
    var g = back.getContext('2d');
    var grad = g.createLinearGradient(0, 0, W, H);
    if (DARK) { grad.addColorStop(0, '#0d1424'); grad.addColorStop(1, '#2a1838'); } else { grad.addColorStop(0, '#3d7bd9'); grad.addColorStop(0.55, '#e0a060'); grad.addColorStop(1, '#c04a70'); }
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    // some app windows on the desktop, so the frost has something to blur
    var wins = [[0.06, 0.1, 0.5, 0.62, DARK ? '#1b1f2a' : '#fdfdfd'], [0.42, 0.28, 0.5, 0.6, DARK ? '#23283a' : '#f3f5f9'], [0.2, 0.55, 0.3, 0.35, '#1c8c4a']];
    wins.forEach(function (w) {
      g.fillStyle = w[4]; g.fillRect(w[0] * W, w[1] * H, w[2] * W, w[3] * H);
      g.fillStyle = DARK ? '#39405a' : '#d4d9e4'; g.fillRect(w[0] * W, w[1] * H, w[2] * W, 30);
    });
    // The desktop goes on <html>'s background, BEHIND <body>, so body's backdrop-filter (standing in
    // for the sidecar's blur-behind) really blurs it; a child canvas would paint over the blur.
    document.documentElement.style.background = SCENE ? 'url("' + SCENE.url + '") 0 0 / 100% 100% no-repeat'
      : 'url(' + back.toDataURL() + ') 0 0 / 100% 100% no-repeat';
    if (!document.body.contains(pics)) document.body.appendChild(pics);
  }

  function drawPic(g, box, w) {
    var ar = w.aspect || 1.6;
    var bw = box.w, bh = box.h, dw = bw, dh = bw / ar;
    if (dh > bh) { dh = bh; dw = bh * ar; }
    var x = box.x + (bw - dw) / 2, y = box.y + (bh - dh) / 2;
    g.fillStyle = '#ffffff'; g.fillRect(x, y, dw, dh);
    g.fillStyle = w.color; g.fillRect(x, y, dw, Math.max(8, dh * 0.09));
    g.fillStyle = 'rgba(20,24,38,.10)';
    for (var r = 0; r < 6; r++) g.fillRect(x + dw * 0.06, y + dh * (0.2 + r * 0.11), dw * (0.5 + 0.3 * ((r * 37) % 10) / 10), Math.max(3, dh * 0.035));
    g.fillStyle = w.color; g.globalAlpha = 0.35; g.fillRect(x + dw * 0.64, y + dh * 0.2, dw * 0.3, dh * 0.5); g.globalAlpha = 1;
  }

  var seq = 0, boxes = [], timers = [];
  function paintPics(upTo) {
    var g = pics.getContext('2d');
    g.clearRect(0, 0, pics.width, pics.height);
    var thumbs = [];
    boxes.forEach(function (b, n) {
      var w = null;
      for (var i = 0; i < items.length; i++) if (items[i].hwnd === b.hwnd) w = items[i];
      if (!w) return;
      if (F.get('thumbs') === 'fail') { thumbs.push({ hwnd: b.hwnd, ok: false, reason: 'DwmRegisterThumbnail answered 0x80070006 (the handle is invalid)' }); return; }
      if (n >= upTo) return;
      if (w.minimized) { thumbs.push({ hwnd: b.hwnd, ok: true, minimized: true }); return; }
      drawPic(g, b, w);
      thumbs.push({ hwnd: b.hwnd, ok: true, minimized: false });
    });
    var fail = F.get('thumbs') === 'fail';
    emit('taskview.thumbs', { seq: seq, ok: !fail, reason: fail ? 'every preview failed to register (mock)' : null, thumbs: thumbs });
  }

  function open() {
    seq++;
    setupCanvases();
    pics.getContext('2d').clearRect(0, 0, pics.width, pics.height);
    var glass = F.get('glass') === '0' ? { ok: false, reason: 'SetWindowCompositionAttribute was refused (mock)' } : { ok: true };
    document.body.style.backdropFilter = glass.ok ? 'blur(28px) saturate(150%)' + (SCENE ? ' brightness(.4)' : '') : '';
    var s = state();
    s.seq = seq; s.glass = glass;
    window.__mock.openAt = performance.now();
    emit('taskview.open', s);
  }

  window.__mock = { calls: [], get items() { return items; }, get desks() { return desks; }, get current() { return current; }, open: open };

  window.mantle = {
    on: function (name, cb) { (listeners[name] = listeners[name] || []).push(cb); return function () {}; },
    call: function (name, args) {
      window.__mock.calls.push({ name: name, args: args });
      if (name === 'taskview.painted') {
        window.__mock.paintedAt = performance.now();
        window.__mock.boxes = boxes = args.boxes || [];
        timers.forEach(clearTimeout); timers = [];
        if (F.get('thumbs') !== 'none') {
          timers.push(setTimeout(function () { paintPics(6); }, 16));
          timers.push(setTimeout(function () { paintPics(1e9); }, 60));
        }
        return Promise.resolve({ ok: true });
      }
      if (name === 'taskview.activate' || name === 'taskview.dismiss') return Promise.resolve({ ok: true, mock: 'recorded, nothing switched' });
      if (name === 'taskview.close') {
        items = items.filter(function (w) { return w.hwnd !== args.hwnd; });
        setTimeout(function () { emit('taskview.update', { seq: seq, list: items.map(strip) }); }, 30);
        return Promise.resolve({ ok: true });
      }
      if (name === 'taskview.desk') return desk(args);
      return Promise.reject(new Error('mock: ' + name + ' is not something main answers'));
    },
  };

  function find(id) { for (var i = 0; i < desks.length; i++) if (desks[i].id === id) return i; return -1; }
  function desk(a) {
    var r = function () { var s = state(); s.seq = seq; return s; };
    if (a.op === 'create') {
      var id = 'D' + desks.length + '000000-0000-0000-0000-00000000000' + desks.length;
      desks.push({ id: id, index: desks.length, named: false, name: '' });
      var s1 = r(); s1.created = id;
      return Promise.resolve(s1);
    }
    var at = find(a.desktop);
    if (at < 0) return Promise.reject(new Error('that desktop no longer exists'));
    if (a.op === 'switch') { current = a.desktop; setTimeout(function () { emit('taskview.end', { seq: seq, why: 'switched desktop' }); }, 30); return Promise.resolve(r()); }
    if (a.op === 'rename') { desks[at].named = !!a.name; desks[at].name = a.name; return Promise.resolve(r()); }
    if (a.op === 'remove') {
      if (desks.length < 2) return Promise.reject(new Error('Windows always keeps one desktop, so the last one cannot be removed'));
      var to = desks[at > 0 ? at - 1 : 1].id;
      others.forEach(function (w) { if (w.desktop === a.desktop) w.desktop = to; });
      if (a.desktop === current) { current = to; items.forEach(function (w) { w.desktop = to; }); }
      desks.splice(at, 1);
      return Promise.resolve(r());
    }
    if (a.op === 'move') {
      var w = null;
      items = items.filter(function (x) { if (x.hwnd === a.hwnd) { w = x; return false; } return true; });
      if (!w) return Promise.reject(new Error('that window has closed'));
      w.desktop = a.desktop; others.push(w);
      return Promise.resolve(r());
    }
    return Promise.reject(new Error('mock: unknown desktop op ' + a.op));
  }

  function key(k, extra) {
    var e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {}));
    document.dispatchEvent(e);
  }
  function pointer(type, x, y, target) {
    (target || document.elementFromPoint(x, y) || document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
  }

  window.addEventListener('load', function () {
    var bench = Number(F.get('bench') || 0);
    if (bench) {
      var times = [];
      for (var b = 0; b < bench; b++) {
        var t0 = performance.now();
        open();
        document.body.getBoundingClientRect();            // force the layout the open caused
        times.push(performance.now() - t0);
      }
      times.sort(function (x, y) { return x - y; });
      window.__mock.bench = { median: times[Math.floor(times.length / 2)], max: times[times.length - 1] };
      return;
    }
    open();
    var q = F.get('q');
    if (q) for (var c = 0; c < q.length; c++) key(q[c]);
    var sel = Number(F.get('sel') || 0);
    for (var m = 0; m < sel; m++) key('ArrowRight');
    if (F.get('zone') === 'strip') { key('Tab'); key('ArrowRight'); }
    if (F.get('rename') === '1') {
      var d1 = document.querySelectorAll('.desk')[1] || document.querySelector('.desk');
      if (d1) d1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
    if (F.get('notice') === '1') emit('taskview.notice', { seq: seq, text: 'Windows does not allow that window to move to another desktop' });
    if (F.get('drag') === '1') {
      setTimeout(function () {
        var t = document.querySelector('.tile .cap');
        var dk = document.querySelectorAll('.desk')[1];
        if (!t || !dk) return;
        var a = t.getBoundingClientRect(), z = dk.getBoundingClientRect();
        pointer('pointerdown', a.left + 30, a.top + 10, t);
        pointer('pointermove', a.left + 60, a.top - 20);
        pointer('pointermove', z.left + z.width / 2, z.top + z.height / 2);
      }, 120);
    }
  });
})();
