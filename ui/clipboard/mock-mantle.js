/* mock-mantle.js — a stand-in for main and the sidecar, so the Win+V panel can be looked at,
 * measured and screenshotted in a plain headless browser: no Electron, no sidecar, no hook, and
 * the user's clipboard never read or written. Every item below is an invented fixture.
 *
 * It defines window.mantle ONLY when it is absent, so with the real preload it does nothing.
 *
 * Query flags:
 *   ?n=6            how many fixture items (0 = the empty panel; up to 40)
 *   ?q=text         type this into the filter after the panel opens
 *   ?sel=3          move the selection down this many rows
 *   ?banner=admin   the administrator-window caveat (also: off, observe, pins, skipped, private)
 *   ?notice=1       the "Copied, not pasted" notice
 *   ?dark=1         a DARK desktop and a dark app behind the panel (the contrast case)
 *   ?bg=0           no fake desktop (transparent, like the real window)
 */
(function () {
  'use strict';
  if (window.mantle) return;

  var flags = new URLSearchParams(location.search);
  var N = Math.max(0, Math.min(40, Number(flags.has('n') ? flags.get('n') : 6)));
  var DARK = flags.get('dark') === '1';
  var listeners = {};
  var mock = window.__mock = { calls: [], painted: null, pasted: null, closed: 0 };

  function emit(name, payload) {
    (listeners[name] || []).slice().forEach(function (cb) {
      try { cb(payload); } catch (err) { console.error('mock: ' + name + ' handler threw: ' + err.message); }
    });
  }

  // A picture thumbnail drawn here, the way the sidecar would send one (a small JPEG data URL).
  function thumb(w, h, a, b) {
    var c = document.createElement('canvas');
    var k = Math.min(1, 480 / w, 180 / h);
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    var g = c.getContext('2d');
    var gr = g.createLinearGradient(0, 0, c.width, c.height);
    gr.addColorStop(0, a); gr.addColorStop(1, b);
    g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillRect(c.width * 0.08, c.height * 0.16, c.width * 0.5, c.height * 0.12);
    g.fillRect(c.width * 0.08, c.height * 0.38, c.width * 0.72, c.height * 0.08);
    g.fillRect(c.width * 0.08, c.height * 0.52, c.width * 0.64, c.height * 0.08);
    return c.toDataURL('image/jpeg', 0.85);
  }

  var now = Date.now();
  var FIX = [
    { kind: 'text', text: 'const panel = placePanel(caret, workArea);\nif (!panel.fits) panel.flipAbove();\nreturn panel;', ago: 20e3 },
    { kind: 'image', w: 1920, h: 1080, colors: ['#5B6CF0', '#9AD0EC'], ago: 4 * 60e3 },
    { kind: 'text', text: 'https://example.com/docs/getting-started#install', ago: 9 * 60e3, pinned: true },
    { kind: 'files', files: ['C:\\Users\\example\\Documents\\Quarterly report.pdf', 'C:\\Users\\example\\Pictures\\Trip',
                             'C:\\Users\\example\\Documents\\notes.txt', 'C:\\Users\\example\\Documents\\budget.xlsx'], ago: 40 * 60e3 },
    { kind: 'text', text: 'Meeting moved to Thursday at 3 pm, same room. Bring the printed agenda and the two draft proposals we talked about on Monday so we can compare them side by side.', rich: true, ago: 2 * 3600e3 },
    { kind: 'text', text: '\n\n    indented first line after blanks\n\tand a tabbed second line\nthird\nfourth\nfifth', ago: 26 * 3600e3 },
  ];
  var items = [];
  for (var i = 0; i < N; i++) {
    var f = FIX[i % FIX.length];
    var it = { id: 'c' + (i + 1), kind: f.kind, ts: now - f.ago - i * 1000, pinned: !!f.pinned, rich: !!f.rich, bytes: 100 };
    if (f.text != null) {
      it.text = i >= FIX.length ? f.text + ' (' + (i + 1) + ')' : f.text;
      it.chars = it.text.length;
      it.lines = it.text.split('\n').length;
    }
    if (f.kind === 'image') { it.w = f.w; it.h = f.h; it.thumb = thumb(f.w, f.h, f.colors[0], f.colors[1]); }
    if (f.kind === 'files') {
      it.files = f.files.map(function (p) { return { name: p.split('\\').pop(), path: p }; });
      it.fileCount = f.files.length + 3;
    }
    items.push(it);
  }

  function listObj() {
    var pinned = items.filter(function (x) { return x.pinned; }).length;
    var b = flags.get('banner');
    return {
      ok: true, rev: 1, source: 'mantle', mode: b === 'off' ? 'off' : (b === 'observe' ? 'observe' : 'history'),
      error: b === 'off' ? 'Windows refused the clipboard listener (error 5)' : null,
      pinsError: b === 'pins' ? 'the pinned items could not be saved (UnauthorizedAccessException)' : null,
      count: items.length, pinned: pinned, items: items.slice(),
      stats: { recent: b === 'skipped' ? [{ result: 'skipped', reason: 'busy' }] : (b === 'private' ? [{ result: 'skipped', reason: 'private' }] : []) },
    };
  }

  var handlers = {
    'clipboard.paste': function (a) { mock.pasted = a.item; return { ok: true, pasted: true }; },
    'clipboard.pin': function (a) {
      items.forEach(function (x) { if (x.id === a.item) x.pinned = !!a.pinned; });
      return listObj();
    },
    'clipboard.delete': function (a) { items = items.filter(function (x) { return x.id !== a.item; }); return listObj(); },
    'clipboard.clear': function () { items = items.filter(function (x) { return x.pinned; }); return listObj(); },
    'clipboard.close': function () { mock.closed++; return {}; },
    'clipboard.painted': function (a) { mock.painted = a; return {}; },
    'clipboard.glass': function (a) { mock.glass = a; return {}; },
  };

  window.mantle = {
    call: function (name, args) {
      mock.calls.push(name);
      var h = handlers[name];
      if (!h) return Promise.reject(new Error('mock: no handler for ' + name));
      return Promise.resolve(h(args || {}));
    },
    on: function (name, cb) {
      (listeners[name] = listeners[name] || []).push(cb);
      return function () { listeners[name] = (listeners[name] || []).filter(function (x) { return x !== cb; }); };
    },
    pathForFile: function () { return ''; },
  };

  // ---- the fake screen: a desktop and the app window the user was typing in, with a caret -------
  function paintScreen() {
    if (flags.get('bg') === '0') return;
    var root = document.documentElement;
    root.style.background = DARK
      ? 'radial-gradient(1200px 700px at 20% 10%, #1d2433, #07090f)'
      : 'radial-gradient(1200px 700px at 20% 10%, #c9d6ee, #7f93b8)';
    var app = document.createElement('div');
    app.style.cssText = 'position:fixed;left:6%;top:7%;width:70%;height:78%;border-radius:10px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.35);background:' + (DARK ? '#1e1f24' : '#ffffff') + ';' +
      'font:14px/1.7 Consolas,monospace;color:' + (DARK ? '#c8ccd4' : '#24292f') + ';padding:48px 40px;overflow:hidden';
    var lines = [];
    for (var k = 0; k < 30; k++) lines.push('  line ' + (k + 1) + ': some document text the panel floats over');
    app.textContent = lines.join('\n');
    app.style.whiteSpace = 'pre';
    document.body.insertBefore(app, document.body.firstChild);
    var caret = document.createElement('div');
    caret.style.cssText = 'position:fixed;width:2px;height:18px;background:' + (DARK ? '#fff' : '#000') + ';left:' +
      (window.innerWidth * 0.30) + 'px;top:' + (window.innerHeight * 0.30) + 'px';
    document.body.insertBefore(caret, app.nextSibling);
    mock.caret = { x: window.innerWidth * 0.30, y: window.innerHeight * 0.30 + 18, h: 18 };
  }

  function placeStage() {
    var stage = document.getElementById('stage');
    var CM = window.ClipModel;
    var anchor = mock.caret || { x: 40, y: 40, h: 0 };
    var r = CM.place(anchor, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    mock.rect = r;
    stage.style.cssText = 'position:fixed;left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
  }

  window.addEventListener('DOMContentLoaded', function () {
    paintScreen();
    placeStage();
    var b = flags.get('banner');
    var arm = { ok: true, hwnd: '1234', elevated: b === 'admin', selfElevated: false };
    emit('clipboard.show', { list: listObj(), arm: arm,
      notice: flags.get('notice') === '1'
        ? { title: 'Copied, not pasted', text: 'Windows does not let Mantle type into an administrator window. It is on the clipboard: press Ctrl+V', ms: 600000 }
        : null });
    var qv = flags.get('q');
    if (qv) {
      var input = document.getElementById('q');
      input.value = qv;
      input.dispatchEvent(new Event('input'));
    }
    var sel = Number(flags.get('sel') || 0);
    for (var s = 0; s < sel; s++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    mock.ready = true;
  });
}());
