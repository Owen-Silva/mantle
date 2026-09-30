/* mock-mantle.js - main and the sidecar, played in a plain browser, so the screenshot overlay can
 * be looked at, driven and measured headless (ui/screenshot/shoot.js) with NO picture of anyone's
 * screen: the "frozen frame" is a fake desktop drawn here on a canvas.
 *
 * Defines window.mantle ONLY when it is absent: under Electron the real preload wins and this file
 * does nothing (the launcher's and the switcher's pattern).
 *
 * Query flags:
 *   ?mode=rect|window|full|text   the starting mode (default rect)
 *   ?ocr=off                 Windows' OCR is unavailable: Copy text is disabled, with the reason
 *   ?monx=-1920&mony=0       this monitor's physical origin (a second monitor left of the primary)
 *   ?cursor=x,y              where the pointer is, in this page's CSS px (guides / hover)
 *   ?problem=1               main could not give this monitor a frame: the failure panel
 *   ?dark=1                  a dark fake desktop
 * The monitor's physical size is the viewport times devicePixelRatio: run the page at the scale
 * under test (shoot.js does 1, 1.25, 1.5 and 2).
 */
(function () {
  'use strict';
  if (window.mantle) return;

  var q = new URLSearchParams(location.search);
  var listeners = {};
  var mock = window.__mock = { calls: [], ready: null, frame: null };
  var dpr = window.devicePixelRatio || 1;
  var W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
  var MX = Number(q.get('monx') || 0), MY = Number(q.get('mony') || 0);
  var dark = q.get('dark') === '1';

  function emit(name, payload) {
    (listeners[name] || []).slice().forEach(function (cb) {
      try { cb(payload); } catch (err) { console.error('mock: ' + name + ' handler threw: ' + err.message); }
    });
  }

  // The fake windows, in PHYSICAL px relative to this monitor, topmost first.
  var WINS = [
    { x: 0.52, y: 0.18, w: 0.36, h: 0.46, title: 'Notes', tint: '#F6F2E8' },
    { x: 0.12, y: 0.10, w: 0.48, h: 0.62, title: 'Browser', tint: '#FFFFFF' },
    { x: 0.30, y: 0.52, w: 0.40, h: 0.34, title: 'Terminal', tint: '#1E2230' },
  ].map(function (w, i) {
    return { hwnd: String(1000 + i), kind: 'window', title: w.title, tint: w.tint,
      x: Math.round(w.x * W), y: Math.round(w.y * H), w: Math.round(w.w * W), h: Math.round(w.h * H) };
  });

  function paintDesktop() {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    var bg = g.createLinearGradient(0, 0, W, H);
    if (dark) { bg.addColorStop(0, '#1B2233'); bg.addColorStop(1, '#3A2E4F'); }
    else { bg.addColorStop(0, '#9CC3E6'); bg.addColorStop(0.55, '#D9C9EE'); bg.addColorStop(1, '#F1D6C4'); }
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    var u = dpr;
    // bottom-to-top so the first listed window is drawn last (on top)
    WINS.slice().reverse().forEach(function (w) {
      g.fillStyle = 'rgba(14,18,38,.18)'; g.fillRect(w.x + 4 * u, w.y + 8 * u, w.w, w.h);
      g.fillStyle = w.tint; g.fillRect(w.x, w.y, w.w, w.h);
      var darkWin = w.tint === '#1E2230';
      g.fillStyle = darkWin ? '#2A3042' : '#ECEEF3'; g.fillRect(w.x, w.y, w.w, 32 * u);
      g.fillStyle = darkWin ? '#C9D1E4' : '#333A4E';
      g.font = (12 * u) + 'px Segoe UI, sans-serif';
      g.fillText(w.title, w.x + 12 * u, w.y + 21 * u);
      g.fillStyle = darkWin ? 'rgba(160,220,170,.8)' : 'rgba(51,58,78,.28)';
      for (var y = w.y + 52 * u, k = 0; y < w.y + w.h - 16 * u; y += 18 * u, k++) {
        g.fillRect(w.x + 16 * u, y, (w.w - 32 * u) * (0.45 + 0.5 * ((k * 37) % 11) / 11), 7 * u);
      }
    });
    return c.toDataURL('image/png');
  }

  function toCss(v) { var a = String(v || '').split(',').map(Number); return a.length === 2 && a.every(isFinite) ? { x: a[0], y: a[1] } : null; }

  window.mantle = {
    call: function (name, args) {
      mock.calls.push({ name: name, args: args, at: performance.now() });
      if (name === 'screenshot.ready') mock.ready = args;
      return Promise.resolve({ ok: true });
    },
    on: function (name, cb) {
      (listeners[name] = listeners[name] || []).push(cb);
      return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== cb; }); };
    },
    pathForFile: function () { return ''; },
  };

  window.addEventListener('load', function () {
    var cur = toCss(q.get('cursor'));
    var mon = { index: 0, x: MX, y: MY, w: W, h: H, scale: dpr, primary: MX === 0 && MY === 0 };
    var wins = WINS.map(function (w) { return { hwnd: w.hwnd, kind: w.kind, x: w.x + MX, y: w.y + MY, w: w.w, h: w.h }; });
    wins.push({ hwnd: '1', kind: 'desktop', x: MX, y: MY, w: W, h: H });
    mock.frame = {
      seq: 1, grab: 7, mode: q.get('mode') || 'rect', monitor: mon, windows: wins,
      src: q.get('problem') === '1' ? null : paintDesktop(),
      cursor: cur ? { x: MX + Math.floor(cur.x * dpr), y: MY + Math.floor(cur.y * dpr) } : null,
      problem: q.get('problem') === '1' ? 'Windows did not give Mantle a picture of this screen, so it cannot be captured here. Use another screen, or press Esc.' : null,
      ocr: q.get('ocr') === 'off'
        ? { available: false, why: 'Windows has no text recognition installed: add a language in Windows Settings > Time & language > Language & region' }
        : { available: true, lang: 'en-US' },
    };
    emit('screenshot.frame', mock.frame);
  });
  window.__mockEmit = emit;
}());
