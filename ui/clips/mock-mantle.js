/* mock-mantle.js - plays main for the Clips pages when they are opened over file:// without Electron
 * (headless shots, the morning screenshots). The real preload.js defines window.mantle first, so under
 * Electron this file does nothing. NOTHING HERE IS FROM OWEN'S MACHINE: every clip is a stand-in with
 * a drawn picture (an SVG made here), never one of his captures.
 *
 * record.html  ?mock=ready (default) | recording | starting | game | none | failed | nolast
 *              &screenrec=1 (the "Record a region or window" row)   &theme=dark   &dark=1
 * index.html   ?mock=gallery (default) | empty | error              &theme=dark   &dark=1
 * window.__mockCalls records what the page asked main for ([name, args]).
 */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  var page = /record\.html$/i.test(location.pathname) ? 'record' : 'gallery';
  var mode = q.get('mock') || (page === 'record' ? 'ready' : 'gallery');
  if (q.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('mock');
    if (q.get('dark') === '1' || q.get('theme') === 'dark') document.body.classList.add('dark');
  });
  if (mode === 'none-link') return;

  /* stand-in pictures: calm drawn scenes, 16:9 */
  var SCENES = [
    ['#2f4a6d', '#88a6c8', '#f2c58a'], ['#3b3f58', '#8d86b5', '#e8b3a4'], ['#28463f', '#79a597', '#e9d9a6'],
    ['#4a3b33', '#b98f74', '#f0d4b0'], ['#263445', '#5f7d99', '#cbd8e4'], ['#3e2f47', '#9a7aa8', '#f4c9d6'],
    ['#33402c', '#8fa47a', '#efe2b8'], ['#2d3540', '#6b7c8f', '#e3e7ec'],
  ];
  function svg(i, kind) {
    var c = SCENES[i % SCENES.length];
    var body;
    if (i % 4 === 1) {   // a stand-in app window: a title bar and lines
      body = '<rect x="38" y="26" width="244" height="130" rx="8" fill="' + c[2] + '" opacity=".92"/><rect x="38" y="26" width="244" height="18" rx="8" fill="' + c[0] + '" opacity=".55"/>' +
        '<rect x="54" y="58" width="120" height="7" rx="3.5" fill="' + c[0] + '" opacity=".5"/><rect x="54" y="74" width="190" height="7" rx="3.5" fill="' + c[0] + '" opacity=".3"/>' +
        '<rect x="54" y="90" width="160" height="7" rx="3.5" fill="' + c[0] + '" opacity=".3"/><rect x="54" y="116" width="64" height="20" rx="5" fill="' + c[1] + '"/>';
    } else if (i % 4 === 2) {   // hills
      body = '<circle cx="232" cy="60" r="22" fill="' + c[2] + '"/><path d="M0 128 C60 92 110 102 160 122 S260 96 320 112 V180 H0Z" fill="' + c[0] + '" opacity=".75"/>' +
        '<path d="M0 150 C80 124 150 140 220 150 S300 140 320 146 V180 H0Z" fill="' + c[0] + '"/>';
    } else if (i % 4 === 3) {   // blocks
      body = '<rect x="30" y="92" width="44" height="88" fill="' + c[0] + '" opacity=".8"/><rect x="82" y="64" width="52" height="116" fill="' + c[0] + '"/>' +
        '<rect x="142" y="104" width="38" height="76" fill="' + c[0] + '" opacity=".7"/><rect x="188" y="52" width="58" height="128" fill="' + c[0] + '" opacity=".9"/><rect x="254" y="86" width="40" height="94" fill="' + c[0] + '" opacity=".75"/>' +
        '<circle cx="70" cy="44" r="16" fill="' + c[2] + '"/>';
    } else {   // a horizon
      body = '<circle cx="210" cy="96" r="30" fill="' + c[2] + '"/><rect y="112" width="320" height="68" fill="' + c[0] + '" opacity=".85"/><rect y="124" width="320" height="2" fill="' + c[2] + '" opacity=".5"/>';
    }
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c[1] + '"/><stop offset="1" stop-color="' + c[2] + '"/></linearGradient></defs>' +
      '<rect width="320" height="180" fill="url(#g)"/>' + body + '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }
  var now = Date.now();
  var H = 3600000, D = 86400000;
  var ITEMS = [
    ['Mantle stand-in', 'video', 0.6 * H, 41000, 38.2], ['Stand-in app window', 'video', 1.4 * H, 128000, 96], ['Stand-in hills', 'image', 2.2 * H, null, 0.9],
    ['Stand-in skyline', 'video', 5 * H, 9000, 7.4], ['Mantle stand-in', 'video', D + 2 * H, 312000, 214], ['Stand-in app window', 'image', D + 3 * H, null, 1.2],
    ['Stand-in horizon', 'video', D + 6 * H, 64000, 51], ['Stand-in hills', 'video', 3 * D, 22000, 17.9], ['Stand-in skyline', 'image', 3 * D + H, null, 0.7],
    ['Mantle stand-in', 'video', 6 * D, 186000, 140], ['Stand-in horizon', 'image', 6 * D + 2 * H, null, 1.4],
  ].map(function (a, i) {
    var at = now - a[2];
    return { name: a[0] + ' ' + i + (a[1] === 'video' ? '.mp4' : '.png'), kind: a[1], title: a[0], at: at, durationMs: a[3], width: 1920, height: 1080,
      size: a[4] * 1048576, sizeWords: (a[4] < 10 ? a[4].toFixed(1) : Math.round(a[4])) + ' MB', url: null, mtimeMs: at, growing: false, _i: i };
  });
  function dayLabel(ms) {
    var d = new Date(ms), t = new Date(now);
    var key = function (x) { return x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate(); };
    if (key(d) === key(t)) return 'Today';
    if (key(d) === key(new Date(now - D))) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function list(filter) {
    var shown = ITEMS.filter(function (it) { return !filter || filter === 'all' || it.kind === filter; });
    var groups = [];
    shown.forEach(function (it) { var l = dayLabel(it.at); if (!groups.length || groups[groups.length - 1].label !== l) groups.push({ label: l, names: [] }); groups[groups.length - 1].names.push(it.name); });
    return { ok: true, folder: 'C:\\Users\\you\\Videos\\Captures', items: shown, groups: groups,
      counts: { all: ITEMS.length, video: ITEMS.filter(function (i) { return i.kind === 'video'; }).length, image: ITEMS.filter(function (i) { return i.kind === 'image'; }).length }, recording: null };
  }

  var recState = function () {
    var plan = { can: true, how: 'keys', why: 'records this window with Windows\u2019 own recorder (Win+Alt+R)' };
    var rec = { on: false, since: null, pending: false, by: null, why: null };
    var app = 'Mantle stand-in';
    if (mode === 'recording') rec = { on: true, since: now - 83000, pending: false, by: 'mantle', why: null };
    if (mode === 'starting') rec.pending = true;
    if (mode === 'game') { plan = { can: false, how: 'hint', game: 'game', why: 'Mantle never sends keys to a game' }; app = 'Stand-in game'; }
    if (mode === 'none') { plan = { can: false, how: 'none', why: 'Windows cannot record the desktop or File Explorer' }; app = null; }
    if (mode === 'failed') rec.why = 'Windows did not start a recording within 15 s (Game Bar may be off in Settings > Gaming, or this app cannot be recorded)';
    return { rec: rec, app: app, plan: plan, mic: mode === 'recording', screenrec: q.get('screenrec') === '1', now: Date.now() };
  };
  var lastClip = mode === 'nolast' ? null : { name: ITEMS[0].name, kind: 'video', title: ITEMS[0].title, at: ITEMS[0].at, thumb: svg(0) };

  var calls = window.__mockCalls = [];
  var subs = {};
  window.mantle = {
    call: function (name, args) {
      calls.push([name, args]);
      if (name === 'clips.state') return Promise.resolve(Object.assign({ ok: true, last: lastClip }, recState()));
      if (name === 'clips.list') {
        if (mode === 'empty') return Promise.resolve({ ok: true, folder: 'C:\\Users\\you\\Videos\\Captures', items: [], groups: [], counts: { all: 0, video: 0, image: 0 } });
        if (mode === 'error') return Promise.resolve({ ok: false, why: 'the Captures folder could not be read (EPERM: operation not permitted)' });
        return Promise.resolve(list(args && args.filter));
      }
      if (name === 'clips.thumbs') {
        var out = {};
        ((args && args.names) || []).forEach(function (n) { var it = ITEMS.find(function (x) { return x.name === n; }); out[n] = it ? svg(it._i) : null; });
        return Promise.resolve({ ok: true, thumbs: out });
      }
      if (name === 'clips.delete') return Promise.resolve({ ok: true, undo: 'u1' });
      return Promise.resolve({ ok: true });
    },
    on: function (ev, cb) {
      (subs[ev] = subs[ev] || []).push(cb);
      if (ev === 'clips.state' && page === 'record') setTimeout(function () { cb(Object.assign({ open: true, seq: 1 }, recState())); }, 0);
      return function () { subs[ev] = (subs[ev] || []).filter(function (f) { return f !== cb; }); };
    },
  };
})();
