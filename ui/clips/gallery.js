/* gallery.js - the Clips window's page (lane mantle-clips2, 2026-10-15).
 *
 * Main (lib/features/clips.js): clips.list {filter} -> {items, groups, counts, recording}; clips.thumbs
 * {names} -> {thumbs: {name: url}} (cached on disk); clips.trim {name, startMs, endMs} -> a NEW file
 * (lossless keyframe cut, else Windows' encoder, with clips.encoding {name, pct} pushes); clips.copy,
 * clips.share, clips.delete -> {undo}, clips.undo {token}, clips.folder, clips.win {op}. Pushes:
 * clips.changed (the folder changed), clips.focus {name} (open this one).
 * RAM: ONE shared <video> scrubs whichever card the mouse is on (made on hover, emptied on leave), the
 * viewer's <video> is emptied when it closes; thumbnails load as cards come into view.
 * KEYBOARD: arrows move between cards, Enter opens, Delete deletes (Undo: Ctrl+Z), Ctrl+C copies,
 * Ctrl+1/2/3 filter, Ctrl+W closes. In the viewer: Space plays, Left/Right 5 s, , and . one frame,
 * I / O set the trim at the play head, Enter saves the trimmed copy, Page Up/Down the next clip, Esc back.
 * window.__clips is for the tests.
 */
(function () {
  'use strict';
  var mantle = window.mantle;
  var $ = function (id) { return document.getElementById(id); };
  var grid = $('grid'), empty = $('empty'), banner = $('banner'), viewer = $('viewer'), stage = $('stage');
  var vVideo = $('vVideo'), vImg = $('vImg'), vBig = $('vBig'), vPlay = $('vPlay'), vTime = $('vTime'), vTitle = $('vTitle'), vMeta = $('vMeta');
  var tl = $('tl'), tlRange = $('tlRange'), tlHead = $('tlHead'), tlIn = $('tlIn'), tlOut = $('tlOut'), vTrimInfo = $('vTrimInfo'), vNote = $('vNote');
  var aTrim = $('aTrim'), aReset = $('aReset');
  var toast = $('toast'), toastText = $('toastText'), toastUndo = $('toastUndo');
  var SPRING = 'linear(0, .096 2.4%, .33 5.4%, .62 9.3%, .84 13.6%, .96 18.3%, 1.02 23.5%, 1.035 28.4%, 1.03 33.6%, 1.012 41.9%, 1 52%, .997 64%, 1)';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var S = { filter: 'all', items: [], byName: {}, counts: {}, recording: null, thumbs: {}, asked: {}, sel: null, view: null,
    trim: null, busy: false, undo: null, toastT: null, listT: null, lists: 0, focusWant: null, encoding: null, error: null };
  var G = window.__clips = { state: function () { return snap(); } };

  function call(name, args) {
    if (!mantle || typeof mantle.call !== 'function') return Promise.resolve({ ok: false, why: 'this page lost its link to Mantle' });
    return mantle.call(name, args || {}).then(function (r) { return r || { ok: false, why: 'Mantle gave no answer' }; },
      function (e) { return { ok: false, why: (e && e.message) || String(e) }; });
  }
  function clock(ms, frac) {
    var t = Math.max(0, Number(ms) || 0), s = Math.floor(t / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60, two = function (n) { return (n < 10 ? '0' : '') + n; };
    var base = h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
    return frac ? base + '.' + Math.floor((t % 1000) / 100) : base;
  }
  function timeOf(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } }
  function why(r, d) { return (r && (r.why || r.reason)) || d; }
  function sentence(t) { t = String(t || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : ''; }

  /* ---- the list ---- */
  function load(keepScroll) {
    var top = grid.scrollTop;
    return call('clips.list', { filter: S.filter }).then(function (r) {
      S.lists++;
      if (!r || r.ok === false) { S.error = why(r, 'the Captures folder could not be read'); drawBanner(); return; }
      S.error = null;
      S.items = r.items || []; S.counts = r.counts || {}; S.recording = r.recording || null; S.folder = r.folder || '';
      S.byName = {}; S.items.forEach(function (it) { S.byName[it.name] = it; });
      draw(r.groups || []);
      if (keepScroll) grid.scrollTop = top;
      drawBanner();
      if (S.focusWant && S.byName[S.focusWant]) { var n = S.focusWant; S.focusWant = null; select(n, true); openView(n); }
    });
  }
  function drawBanner() { banner.hidden = !S.error; banner.textContent = S.error ? sentence(S.error) : ''; }
  var io = window.IntersectionObserver ? new IntersectionObserver(function (ents) {
    var want = [];
    ents.forEach(function (e) { if (e.isIntersecting) { var n = e.target.dataset.name; if (n && !S.thumbs[n] && !S.asked[n]) { S.asked[n] = 1; want.push(n); } io.unobserve(e.target); } });
    askThumbs(want);
  }, { root: grid, rootMargin: '300px 0px' }) : null;
  function askThumbs(names) {
    for (var i = 0; i < names.length; i += 12) {
      (function (part) {
        call('clips.thumbs', { names: part }).then(function (r) {
          var t = (r && r.thumbs) || {};
          part.forEach(function (n) { if (t[n]) { S.thumbs[n] = t[n]; paintThumb(n); } });
        });
      })(names.slice(i, i + 12));
    }
  }
  function paintThumb(n) {
    var el = grid.querySelector('.clip[data-name="' + cssq(n) + '"] img');
    if (!el || !S.thumbs[n]) return;
    if (el.getAttribute('src') !== S.thumbs[n]) { el.onload = function () { el.classList.add('ok'); }; el.src = S.thumbs[n]; }
  }
  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function draw(groups) {
    document.querySelectorAll('[data-count]').forEach(function (el) { var k = el.dataset.count; el.textContent = S.counts[k] ? String(S.counts[k]) : ''; });
    document.querySelectorAll('.sb').forEach(function (b) { var on = b.dataset.filter === S.filter; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    grid.textContent = '';
    var idx = 0;
    groups.forEach(function (g) {
      var h = document.createElement('h2'); h.className = 'day'; h.textContent = g.label; grid.appendChild(h);
      var box = document.createElement('div'); box.className = 'cards'; box.setAttribute('role', 'list');
      g.names.forEach(function (n) { var it = S.byName[n]; if (it) box.appendChild(card(it, idx++)); });
      grid.appendChild(box);
    });
    empty.hidden = S.items.length > 0 || !!S.error;
    grid.hidden = !S.items.length;
    if (!S.byName[S.sel]) S.sel = S.items.length ? S.items[0].name : null;
    roving();
  }
  function card(it, i) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'clip'; b.dataset.name = it.name; b.setAttribute('role', 'listitem');
    b.style.setProperty('--i', String(Math.min(i, 24)));
    var live = S.recording === it.name;
    var pic = document.createElement('span'); pic.className = 'pic';
    var img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; pic.appendChild(img);
    if (it.kind === 'video') {
      var chip = document.createElement('span'); chip.className = 'chip';
      if (live) { var d = document.createElement('i'); d.className = 'ld'; chip.appendChild(d); chip.appendChild(document.createTextNode('Recording')); }
      else chip.textContent = it.durationMs ? clock(it.durationMs) : 'Video';
      pic.appendChild(chip);
      var sc = document.createElement('i'); sc.className = 'scrub'; pic.appendChild(sc);
    } else {
      var k = document.createElement('span'); k.className = 'kind'; k.textContent = 'Screenshot'; pic.appendChild(k);
    }
    var cap = document.createElement('span'); cap.className = 'cap';
    var ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = it.title || it.name;
    var cm = document.createElement('span'); cm.className = 'cm'; cm.textContent = [timeOf(it.at), it.sizeWords].filter(Boolean).join(' \u00b7 ');
    cap.appendChild(ct); cap.appendChild(cm);
    b.appendChild(pic); b.appendChild(cap);
    b.title = it.name;
    b.setAttribute('aria-label', (it.title || it.name) + ', ' + (it.kind === 'video' ? (live ? 'recording' : 'video ' + (it.durationMs ? clock(it.durationMs) : '')) : 'screenshot') + ', ' + timeOf(it.at));
    if (S.thumbs[it.name]) { img.onload = function () { img.classList.add('ok'); }; img.src = S.thumbs[it.name]; }
    else if (io) io.observe(b); else askThumbs([it.name]);
    return b;
  }
  function cards() { return Array.prototype.slice.call(grid.querySelectorAll('.clip')); }
  function roving() { cards().forEach(function (c) { var on = c.dataset.name === S.sel; c.tabIndex = on ? 0 : -1; c.classList.toggle('sel', on); }); }
  function select(n, scroll) {
    S.sel = n; roving();
    var el = grid.querySelector('.clip[data-name="' + cssq(n) + '"]');
    if (el) { if (scroll) el.scrollIntoView({ block: 'nearest' }); if (document.activeElement !== el && !S.view) el.focus({ preventScroll: true }); }
  }
  function cols() {
    var c = cards(); if (c.length < 2) return 1;
    var top = c[0].offsetTop, n = 0;
    for (var i = 0; i < c.length && c[i].offsetTop === top; i++) n++;
    return Math.max(1, n);
  }
  function move(d) {
    var list = S.items.map(function (x) { return x.name; });
    var i = Math.max(0, list.indexOf(S.sel));
    var j = Math.max(0, Math.min(list.length - 1, i + d));
    if (list[j]) select(list[j], true);
  }

  /* ---- hover scrub: one shared <video> ---- */
  var scrub = { el: null, card: null, t: null, want: null, dur: 0 };
  function scrubStart(c) {
    var it = S.byName[c.dataset.name];
    if (!it || it.kind !== 'video' || !it.url || S.recording === it.name) return;
    clearTimeout(scrub.t);
    scrub.t = setTimeout(function () {
      if (!scrub.el) { scrub.el = document.createElement('video'); scrub.el.muted = true; scrub.el.preload = 'auto'; scrub.el.playsInline = true;
        scrub.el.addEventListener('seeked', function () { scrub.el.classList.add('on'); if (scrub.want !== null) { var w = scrub.want; scrub.want = null; seekScrub(w); } });
        scrub.el.addEventListener('loadedmetadata', function () { scrub.dur = scrub.el.duration || 0; if (scrub.want !== null) { var w = scrub.want; scrub.want = null; seekScrub(w); } });
      }
      scrub.card = c;
      c.querySelector('.pic').insertBefore(scrub.el, c.querySelector('.chip'));
      if (scrub.el.getAttribute('src') !== it.url) { scrub.el.classList.remove('on'); scrub.dur = 0; scrub.el.src = it.url; }
      c.classList.add('scrubbing');
    }, 120);
  }
  function seekScrub(f) {
    var v = scrub.el; if (!v) return;
    var bar = scrub.card && scrub.card.querySelector('.scrub'); if (bar) bar.style.width = (f * 100).toFixed(2) + '%';
    if (!scrub.dur || v.seeking) { scrub.want = f; return; }
    var t = Math.min(scrub.dur - 0.05, Math.max(0, f * scrub.dur));
    if (typeof v.fastSeek === 'function') v.fastSeek(t); else v.currentTime = t;
  }
  function scrubEnd() {
    clearTimeout(scrub.t);
    if (scrub.card) scrub.card.classList.remove('scrubbing');
    if (scrub.el) { scrub.el.pause(); scrub.el.classList.remove('on'); scrub.el.removeAttribute('src'); scrub.el.load(); if (scrub.el.parentNode) scrub.el.parentNode.removeChild(scrub.el); }
    scrub.card = null; scrub.want = null; scrub.dur = 0;
  }
  grid.addEventListener('pointerover', function (e) { var c = e.target.closest && e.target.closest('.clip'); if (c && c !== scrub.card) { scrubEnd(); scrubStart(c); } });
  grid.addEventListener('pointerleave', scrubEnd);
  grid.addEventListener('pointermove', function (e) {
    var c = e.target.closest && e.target.closest('.clip');
    if (!c) { if (scrub.card) scrubEnd(); return; }
    if (c !== scrub.card) return;
    var r = c.querySelector('.pic').getBoundingClientRect();
    seekScrub(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  });
  grid.addEventListener('click', function (e) { var c = e.target.closest && e.target.closest('.clip'); if (c) { select(c.dataset.name); openView(c.dataset.name, c); } });
  grid.addEventListener('scroll', function () { if (scrub.card) scrubEnd(); }, { passive: true });

  /* ---- the viewer ---- */
  function openView(n, fromCard) {
    var it = S.byName[n]; if (!it) return;
    scrubEnd();
    var first = !S.view;
    S.view = n; S.trim = null; note('');
    viewer.hidden = false;
    if (first && !reduce) { viewer.classList.remove('in'); void viewer.offsetWidth; viewer.classList.add('in'); }
    vTitle.textContent = it.title || it.name;
    vMeta.textContent = [new Date(it.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), it.kind === 'video' && it.durationMs ? clock(it.durationMs) : null,
      it.width && it.height ? it.width + '\u00d7' + it.height : null, it.sizeWords].filter(Boolean).join(' \u00b7 ');
    var video = it.kind === 'video';
    tl.classList.toggle('image', !video);
    vPlay.hidden = !video; vTime.hidden = !video; aTrim.hidden = !video; vTrimInfo.hidden = !video;
    vVideo.hidden = !video; vImg.hidden = video; vBig.hidden = !video;
    if (video) {
      if (vVideo.getAttribute('src') !== it.url) { vVideo.pause(); if (it.url) vVideo.src = it.url; else vVideo.removeAttribute('src'); vVideo.poster = S.thumbs[n] || ''; }
      S.trim = { a: 0, b: it.durationMs || 0, dur: it.durationMs || 0 };
    } else {
      vVideo.pause(); vVideo.removeAttribute('src'); vVideo.load();
      vImg.src = it.url || S.thumbs[n] || '';
    }
    var list = S.items.map(function (x) { return x.name; }), i = list.indexOf(n);
    $('vPrev').disabled = i <= 0; $('vNext').disabled = i < 0 || i >= list.length - 1;
    $('aDelete').disabled = S.recording === n; aTrim.disabled = true;
    drawTrim(); drawTime();
    // the card's picture flies to the stage on the spring
    if (fromCard && !reduce && stage.animate) {
      var from = fromCard.querySelector('.pic').getBoundingClientRect(), to = stage.getBoundingClientRect();
      if (from.width && to.width) {
        var sx = from.width / to.width, sy = from.height / to.height;
        stage.animate([{ transform: 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + sx + ',' + sy + ')', transformOrigin: '0 0', borderRadius: '14px' },
          { transform: 'none', transformOrigin: '0 0' }], { duration: 480, easing: SPRING });
      }
    }
    vBig.focus({ preventScroll: true });
  }
  function closeView() {
    if (!S.view) return;
    var n = S.view; S.view = null; S.trim = null;
    vVideo.pause(); vVideo.removeAttribute('src'); vVideo.removeAttribute('poster'); vVideo.load();
    vImg.removeAttribute('src');
    viewer.hidden = true;
    select(n, true);
    var el = grid.querySelector('.clip[data-name="' + cssq(n) + '"]'); if (el) el.focus({ preventScroll: true });
  }
  function step(d) { var list = S.items.map(function (x) { return x.name; }); var i = list.indexOf(S.view); if (list[i + d]) { openView(list[i + d]); select(list[i + d]); } }
  function durMs() { return (vVideo.duration && isFinite(vVideo.duration) ? vVideo.duration * 1000 : 0) || (S.trim && S.trim.dur) || 0; }
  function drawTime() {
    var d = durMs(), t = (vVideo.currentTime || 0) * 1000;
    vTime.textContent = clock(t) + ' / ' + clock(d);
    vPlay.classList.toggle('on', !vVideo.paused);
    vBig.hidden = vVideo.hidden || !vVideo.paused;
    tlHead.style.left = (d ? Math.min(100, t / d * 100) : 0) + '%';
  }
  function drawTrim() {
    if (!S.trim) return;
    var d = durMs() || S.trim.dur;
    if (d && !S.trim.dur) { S.trim.dur = d; S.trim.b = d; }
    if (d && S.trim.b > d) S.trim.b = d;
    var a = d ? S.trim.a / d * 100 : 0, b = d ? S.trim.b / d * 100 : 100;
    tlRange.style.left = a + '%'; tlRange.style.width = Math.max(0, b - a) + '%';
    tlIn.style.left = a + '%'; tlOut.style.left = b + '%';
    tlIn.setAttribute('aria-valuetext', clock(S.trim.a, true)); tlOut.setAttribute('aria-valuetext', clock(S.trim.b, true));
    var changed = d > 0 && (S.trim.a > 50 || S.trim.b < d - 50);
    var it = S.byName[S.view];
    aTrim.disabled = !changed || S.busy || !it || S.recording === it.name;
    aReset.hidden = !changed;
    vTrimInfo.textContent = changed ? clock(S.trim.a, true) + ' \u2013 ' + clock(S.trim.b, true) + ' (' + clock(S.trim.b - S.trim.a) + ')' : '';
  }
  ['timeupdate', 'play', 'pause', 'loadedmetadata', 'seeked', 'ended'].forEach(function (ev) { vVideo.addEventListener(ev, function () { drawTime(); if (ev === 'loadedmetadata') drawTrim(); }); });
  vVideo.addEventListener('timeupdate', function () { if (S.trim && !vVideo.paused && S.trim.b < durMs() - 50 && vVideo.currentTime * 1000 >= S.trim.b) { vVideo.pause(); vVideo.currentTime = S.trim.b / 1000; } });
  vVideo.addEventListener('error', function () { if (S.view) note('This clip cannot be played here (' + ((vVideo.error && vVideo.error.message) || 'the video could not be read') + '). Show in folder opens it with Windows.', true); });
  function playPause() {
    if (vVideo.hidden) return;
    if (vVideo.paused) {
      if (S.trim && (vVideo.currentTime * 1000 < S.trim.a - 1 || vVideo.currentTime * 1000 >= S.trim.b - 30)) vVideo.currentTime = S.trim.a / 1000;
      var p = vVideo.play(); if (p && p.catch) p.catch(function (e) { note('It did not play (' + e.message + ').', true); });
    } else vVideo.pause();
  }
  function seekBy(ms) { var d = durMs(); if (!d) return; vVideo.currentTime = Math.max(0, Math.min(d, vVideo.currentTime * 1000 + ms)) / 1000; drawTime(); }
  function setTrim(which, ms) {
    if (!S.trim) return; var d = durMs(); if (!d) return;
    var gap = Math.min(500, d / 4);
    if (which === 'a') S.trim.a = Math.max(0, Math.min(ms, S.trim.b - gap)); else S.trim.b = Math.min(d, Math.max(ms, S.trim.a + gap));
    drawTrim();
  }
  vBig.addEventListener('click', playPause);
  vPlay.addEventListener('click', playPause);
  vVideo.addEventListener('click', playPause);
  // the timeline: a click or drag on the track moves the play head; a handle drags the trim
  var drag = null;
  function msAt(x) { var r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * durMs(); }
  tl.addEventListener('pointerdown', function (e) {
    if (!durMs()) return;
    var h = e.target === tlIn ? 'a' : e.target === tlOut ? 'b' : null;
    drag = { h: h, id: e.pointerId };
    tl.setPointerCapture(e.pointerId);
    if (h) (h === 'a' ? tlIn : tlOut).classList.add('drag');
    onDrag(e);
    e.preventDefault();
  });
  function onDrag(e) { if (!drag) return; var ms = msAt(e.clientX); if (drag.h) { setTrim(drag.h, ms); vVideo.currentTime = (drag.h === 'a' ? S.trim.a : S.trim.b) / 1000; } else vVideo.currentTime = ms / 1000; drawTime(); }
  tl.addEventListener('pointermove', onDrag);
  tl.addEventListener('pointerup', function () { if (drag) { tlIn.classList.remove('drag'); tlOut.classList.remove('drag'); } drag = null; });
  [tlIn, tlOut].forEach(function (h) {
    h.addEventListener('keydown', function (e) {
      var w = h === tlIn ? 'a' : 'b', d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!d) return; e.preventDefault(); e.stopPropagation();
      setTrim(w, (w === 'a' ? S.trim.a : S.trim.b) + d * (e.shiftKey ? 100 : 1000));
    });
  });
  aReset.addEventListener('click', function () { if (S.trim) { S.trim.a = 0; S.trim.b = durMs(); drawTrim(); } });
  function note(t, bad) { vNote.hidden = !t; vNote.textContent = t || ''; vNote.classList.toggle('bad', !!bad); }

  /* ---- actions ---- */
  function trim() {
    var it = S.byName[S.view]; if (!it || !S.trim || aTrim.disabled) return;
    S.busy = true; aTrim.disabled = true; aTrim.textContent = 'Saving\u2026'; note('');
    var asked = { a: S.trim.a, b: S.trim.b };
    call('clips.trim', { name: it.name, startMs: Math.round(asked.a), endMs: Math.round(asked.b) }).then(function (r) {
      S.busy = false; S.encoding = null; aTrim.textContent = 'Save trimmed copy';
      if (!r || r.ok === false) { note(sentence(why(r, 'the trim did not work')), true); drawTrim(); return; }
      var how = r.lossless ? 'no quality lost' + (r.startMs < asked.a - 40 ? '; it starts at the keyframe at ' + clock(r.startMs, true) : '') : 're-encoded by Windows, because ' + (r.why || 'the clip could not be cut as it is');
      showToast('Saved \u201c' + r.name + '\u201d (' + how + '). The original is kept.', null);
      S.focusWant = null;
      load(true).then(function () { if (S.byName[r.name]) { openView(r.name); select(r.name, true); } });
    });
  }
  function copy(n) { call('clips.copy', { name: n }).then(function (r) { showToast(r.ok === false ? sentence('Not copied: ' + why(r, 'no reason given')) : 'Copied. Paste it into Discord or a chat.', null); }); }
  function share(n) { call('clips.share', { name: n }).then(function (r) { if (r.ok === false) showToast(sentence('The share sheet did not open: ' + why(r, 'no reason given')), null); }); }
  function del(n) {
    var it = S.byName[n]; if (!it || S.recording === n) return;
    call('clips.delete', { name: n }).then(function (r) {
      if (!r || r.ok === false) { showToast(sentence('Not deleted: ' + why(r, 'no reason given')), null); return; }
      var list = S.items.map(function (x) { return x.name; }), i = list.indexOf(n);
      var next = list[i + 1] || list[i - 1] || null;
      if (S.view === n) { if (next) openView(next); else closeView(); }
      S.sel = next;
      showToast('Moved \u201c' + (it.title || n) + '\u201d to the Recycle Bin.', r.undo || null);
      load(true);
    });
  }
  function undo() {
    var u = S.undo; if (!u) return;
    hideToast();
    call('clips.undo', { token: u }).then(function (r) { if (r.ok === false) showToast(sentence('Not restored: ' + why(r, 'no reason given')), null); else load(true); });
  }
  function showToast(text, undoToken) {
    clearTimeout(S.toastT);
    S.undo = undoToken;
    toastText.textContent = text; toastUndo.hidden = !undoToken;
    toast.hidden = false; toast.style.animation = 'none'; void toast.offsetWidth; toast.style.animation = '';
    S.toastT = setTimeout(hideToast, undoToken ? 8000 : 4500);
  }
  function hideToast() { clearTimeout(S.toastT); toast.hidden = true; S.undo = null; }
  toastUndo.addEventListener('click', undo);
  aTrim.addEventListener('click', trim);
  $('aCopy').addEventListener('click', function () { if (S.view) copy(S.view); });
  $('aShare').addEventListener('click', function () { if (S.view) share(S.view); });
  $('aDelete').addEventListener('click', function () { if (S.view) del(S.view); });
  $('aFolder').addEventListener('click', function () { call('clips.folder'); });
  $('folder').addEventListener('click', function () { call('clips.folder').then(function (r) { if (r.ok === false) showToast(sentence('The folder did not open: ' + why(r, 'no reason given')), null); }); });
  $('vBack').addEventListener('click', closeView);
  $('vPrev').addEventListener('click', function () { step(-1); });
  $('vNext').addEventListener('click', function () { step(1); });
  document.querySelectorAll('.sb').forEach(function (b) { b.addEventListener('click', function () { setFilter(b.dataset.filter); }); });
  document.querySelectorAll('.wc button').forEach(function (b) { b.addEventListener('click', function () { call('clips.win', { op: b.dataset.op }); }); });
  function setFilter(f) { if (S.filter === f) return; S.filter = f; closeView(); load(false); }

  document.addEventListener('keydown', function (e) {
    var k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (k === 'w' || k === 'W')) { e.preventDefault(); call('clips.win', { op: 'close' }); return; }
    if (ctrl && (k === 'z' || k === 'Z')) { if (S.undo) { e.preventDefault(); undo(); } return; }
    if (ctrl && (k === '1' || k === '2' || k === '3')) { e.preventDefault(); setFilter(['all', 'video', 'image'][+k - 1]); return; }
    var n = S.view || S.sel;
    if (ctrl && (k === 'c' || k === 'C')) { if (n) { e.preventDefault(); copy(n); } return; }
    if (k === 'Delete') { if (n) { e.preventDefault(); del(n); } return; }
    if (k === 'F5') { e.preventDefault(); load(true); return; }
    if (S.view) {
      if (k === 'Escape') { e.preventDefault(); closeView(); }
      else if (k === ' ' || k === 'k' || k === 'K') { if (e.target && e.target.tagName === 'BUTTON' && e.target !== vBig && e.target !== vPlay && k === ' ') return; e.preventDefault(); playPause(); }
      else if (k === 'ArrowLeft') { e.preventDefault(); seekBy(-5000); }
      else if (k === 'ArrowRight') { e.preventDefault(); seekBy(5000); }
      else if (k === ',') { e.preventDefault(); vVideo.pause(); seekBy(-1000 / 30); }
      else if (k === '.') { e.preventDefault(); vVideo.pause(); seekBy(1000 / 30); }
      else if (k === 'i' || k === 'I') { e.preventDefault(); setTrim('a', vVideo.currentTime * 1000); }
      else if (k === 'o' || k === 'O') { e.preventDefault(); setTrim('b', vVideo.currentTime * 1000); }
      else if (k === 'Enter' && !aTrim.disabled && (!e.target || e.target.tagName !== 'BUTTON' || e.target === vBig)) { e.preventDefault(); trim(); }
      else if (k === 'PageUp') { e.preventDefault(); step(-1); }
      else if (k === 'PageDown') { e.preventDefault(); step(1); }
      return;
    }
    if (!S.items.length) return;
    if (k === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (k === 'ArrowDown') { e.preventDefault(); move(cols()); }
    else if (k === 'ArrowUp') { e.preventDefault(); move(-cols()); }
    else if (k === 'Home') { e.preventDefault(); select(S.items[0].name, true); }
    else if (k === 'End') { e.preventDefault(); select(S.items[S.items.length - 1].name, true); }
    else if (k === 'Enter' && S.sel) { e.preventDefault(); var c = grid.querySelector('.clip[data-name="' + cssq(S.sel) + '"]'); openView(S.sel, c); }
  });

  function snap() {
    return {
      lists: S.lists, filter: S.filter, items: S.items.length, cards: cards().length, sel: S.sel, view: S.view, empty: !empty.hidden, error: S.error,
      thumbs: Object.keys(S.thumbs).length, painted: grid.querySelectorAll('.pic img.ok').length, scrub: scrub.card ? scrub.card.dataset.name : null,
      scrubSrc: !!(scrub.el && scrub.el.getAttribute('src')), trim: S.trim ? { a: S.trim.a, b: S.trim.b, dur: S.trim.dur } : null, canTrim: !aTrim.disabled,
      toast: toast.hidden ? null : { text: toastText.textContent, undo: !toastUndo.hidden }, note: vNote.hidden ? null : vNote.textContent,
      viewerSrc: !!vVideo.getAttribute('src'), encoding: S.encoding, focus: document.activeElement ? (document.activeElement.dataset.name || document.activeElement.id || document.activeElement.className) : null,
    };
  }

  if (!mantle || typeof mantle.on !== 'function') { S.error = 'this page lost its link to Mantle; close it and open Clips again'; drawBanner(); return; }
  mantle.on('clips.changed', function () { clearTimeout(S.listT); S.listT = setTimeout(function () { load(true); }, 250); });
  mantle.on('clips.focus', function (p) { if (!p || !p.name) return; if (S.byName[p.name]) { select(p.name, true); openView(p.name); } else S.focusWant = p.name; });
  mantle.on('clips.encoding', function (p) {
    if (!p || p.name !== S.view) return;
    S.encoding = p.pct;
    aTrim.textContent = 'Re-encoding ' + Math.round(p.pct || 0) + '%';
    note('This clip cannot be cut without re-encoding, so Windows\u2019 encoder is making the new file.', false);
  });
  load(false);
})();
