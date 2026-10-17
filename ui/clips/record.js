/* record.js - the Win+G Record panel's page (lane mantle-clips2, 2026-10-15).
 *
 * Main (lib/features/clips.js) pushes clips.state {open?, seq?, rec, app, plan, mic, screenrec, now}
 * on every open and every change, and clips.hide when it hides the window. The page draws it, keeps
 * the running clock (one timer, only while recording AND shown), and asks main for the rest:
 *   clips.state            the same + the last clip {name, kind, title, at, thumb}
 *   clips.record           Record / Stop (Windows' Win+Alt+R; never into a game)
 *   clips.mic {on}         Windows' "record audio from the microphone" setting
 *   clips.open {from, name?}   the gallery (the panel hides)
 *   clips.close {why}      hide; clips.size {h} the card's height, so the window is the card + margin
 *   clips.painted {seq, how}   the first frame of an open, for the open time main measures
 *   screenrec.start        Mantle's own region/window recorder (only while that command exists)
 * KEYBOARD: the window is focusable:false (it never takes the keyboard from the app being recorded),
 * so live it is a mouse surface; when it holds focus (a test), R records, M the mic, O opens Clips,
 * Esc closes, Tab walks the buttons. window.__clipsPanel is for the tests.
 */
(function () {
  'use strict';
  var mantle = window.mantle;
  var $ = function (id) { return document.getElementById(id); };
  var card = $('card'), rec = $('rec'), recLabel = $('recLabel'), clockEl = $('clock'), statusText = $('statusText');
  var hint = $('hint'), hintText = $('hintText'), warn = $('warn'), app = $('app');
  var mic = $('mic'), micNote = $('micNote'), region = $('region'), openBtn = $('open');
  var last = $('last'), lastImg = $('lastImg'), lastTitle = $('lastTitle'), lastWhen = $('lastWhen'), noLast = $('noLast');
  var S = { state: null, shown: false, tick: null, busy: false, note: '', lastClip: null, sentH: 0, paints: 0 };
  var P = window.__clipsPanel = { state: function () { return snapshot(); }, calls: 0 };

  function call(name, args) {
    P.calls++;
    if (!mantle || typeof mantle.call !== 'function') return Promise.resolve({ ok: false, why: 'this page lost its link to Mantle' });
    return mantle.call(name, args || {}).then(function (r) { return r || { ok: false, why: 'Mantle gave no answer' }; },
      function (e) { return { ok: false, why: (e && e.message) || String(e) }; });
  }
  function clock(ms) {
    var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
  }
  function ago(ms) {
    var d = Date.now() - (Number(ms) || 0);
    if (!(ms > 0)) return '';
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d < 86400000) return Math.round(d / 3600000) + ' h ago';
    try { return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch (_) { return ''; }
  }
  // main's clock and this page's may differ by a few ms; the offset is taken from each push's `now`
  var skew = 0;

  /* ---- drawing ---- */
  function draw() {
    var s = S.state || {};
    var r = s.rec || {}, plan = s.plan || {};
    var on = !!r.on, pending = !!r.pending && !on;
    card.classList.toggle('recording', on);
    card.classList.toggle('pending', pending);
    rec.classList.toggle('on', on);
    rec.classList.toggle('pending', pending);
    app.textContent = s.app || '';
    var hinting = plan.how === 'hint';
    var canPress = !S.busy && !pending && (plan.can || (on && !hinting));
    rec.disabled = !canPress;
    var label = on ? 'Stop' : 'Record';
    recLabel.textContent = label;
    rec.title = on ? 'Stop (R)' : hinting ? 'Press Win+Alt+R: Mantle never sends keys to a game' : plan.can ? 'Record (R)' : (plan.why || 'Nothing to record');
    rec.setAttribute('aria-label', label + (s.app ? ' ' + s.app : ''));
    var words;
    if (on) words = r.by === 'windows' ? 'Recording (started in Windows)' : 'Recording' + (s.app ? ' ' + s.app : '');
    else if (pending) words = 'Starting Windows’ recorder…';
    else if (hinting) words = 'A game is in front';
    else if (plan.can) words = 'Ready to record' + (s.app ? ' ' + s.app : '');
    else words = sentence(plan.why || 'Nothing to record');
    statusText.textContent = words;
    hint.hidden = !hinting;
    hintText.textContent = hinting ? (on ? 'Press them to stop. Mantle never sends keys to a game.' : 'Press them to record. Mantle never sends keys to a game.') : '';
    var bad = S.note || r.why || '';
    warn.hidden = !bad;
    warn.textContent = bad ? sentence(bad) : '';
    mic.setAttribute('aria-checked', s.mic ? 'true' : 'false');
    mic.setAttribute('aria-disabled', s.mic === null || s.mic === undefined ? 'true' : 'false');
    micNote.textContent = S.micNote || (s.mic === null || s.mic === undefined ? 'unknown' : '');
    region.hidden = !s.screenrec;
    drawClock();
    drawLast();
    clockLoop();
    sendSize();
  }
  function sentence(t) { t = String(t || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/\s*$/, '') + (/[.!?]$/.test(t) ? '' : '.') : ''; }
  function drawClock() {
    var r = (S.state && S.state.rec) || {};
    clockEl.textContent = r.on && r.since ? clock(Date.now() + skew - r.since) : '0:00';
  }
  function clockLoop() {
    var r = (S.state && S.state.rec) || {};
    var want = S.shown && r.on && r.since;
    if (!want) { clearTimeout(S.tick); S.tick = null; return; }
    if (S.tick) return;
    var next = function () {
      drawClock();
      var el = Date.now() + skew - r.since;
      S.tick = setTimeout(next, 1000 - (el % 1000) + 8);   // on the second, so 0:09 -> 0:10 is never late
    };
    next();
  }
  function drawLast() {
    var l = S.lastClip;
    last.hidden = !l;
    noLast.hidden = !!l;
    if (!l) return;
    last.classList.toggle('video', l.kind === 'video');
    lastTitle.textContent = l.title || l.name;
    lastWhen.textContent = ago(l.at);
    last.title = 'Open ' + (l.title || l.name) + ' in Clips';
    if (l.thumb) { if (lastImg.getAttribute('src') !== l.thumb) lastImg.src = l.thumb; lastImg.hidden = false; } else { lastImg.hidden = true; lastImg.removeAttribute('src'); }
  }
  function sendSize() {
    // offsetHeight: the open's pop (a scale) and the bar's lift (a transform) never change what is asked for
    var h = card.offsetHeight;
    if (!h || card.hidden || h === S.sentH) return;
    S.sentH = h;
    call('clips.size', { h: h });
  }

  /* ---- main's pushes ---- */
  function take(s) {
    if (!s) return;
    if (typeof s.now === 'number') skew = s.now - Date.now();
    S.state = Object.assign({}, S.state || {}, s);   // a reply may carry only part (clips.state's last)
    if (s.last !== undefined) S.lastClip = s.last;
  }
  function onState(s) {
    take(s);
    var opening = s && s.open === true;
    if (opening) show(s.seq);
    else draw();
  }
  function show(seq) {
    var fresh = !S.shown;
    S.shown = true;
    S.note = ''; S.micNote = '';
    card.hidden = false;
    card.classList.remove('in');
    void card.offsetWidth;            // the spring runs again on every open
    card.classList.add('in');
    draw();
    if (window.MantleHudBackdrop && fresh) window.MantleHudBackdrop.request('shown', { hold: true });
    // the first frame with the panel on it (its rAF, then the task after it), and a timer in
    // case frames are not being made at all (then main hears "timer" and the number says so)
    var said = false;
    // the last clip (its thumbnail) and a fresh look at the window in front: asked for only AFTER the
    // first frame is reported, so its sidecar round trip and folder read never sit in front of that frame
    var refresh = function () { call('clips.state').then(function (r) { if (r && r.ok !== false && S.shown) { take(r); draw(); } }); };
    var say = function (how) { if (said) return; said = true; S.paints++; call('clips.painted', { seq: seq, how: how }); refresh(); };
    requestAnimationFrame(function () { setTimeout(function () { say('frame'); }, 0); });   // after the frame with the panel is made
    setTimeout(function () { say('timer'); }, 250);
  }
  function hide() {
    S.shown = false;
    card.classList.remove('in');
    clockLoop();
  }

  /* ---- what Owen does ---- */
  function act(p, then) {
    S.busy = true; draw();
    return p.then(function (r) {
      S.busy = false;
      if (r && r.state) take(r.state);
      S.note = r && r.ok === false ? (r.why || r.reason || 'Mantle said no') : '';
      if (then) then(r);
      draw();
      return r;
    });
  }
  function record() { if (!rec.disabled) act(call('clips.record')); }
  function toggleMic() {
    var cur = !!(S.state && S.state.mic);
    act(call('clips.mic', { on: !cur }), function (r) {
      if (r && r.ok !== false && S.state) { S.state.mic = typeof r.mic === 'boolean' ? r.mic : !cur; S.micNote = r.note || ''; }
    });
  }
  function openClips(name) { call('clips.open', name ? { from: 'panel', name: name } : { from: 'panel' }); }
  rec.addEventListener('click', record);
  mic.addEventListener('click', toggleMic);
  openBtn.addEventListener('click', function () { openClips(null); });
  last.addEventListener('click', function () { if (S.lastClip) openClips(S.lastClip.name); });
  $('x').addEventListener('click', function () { call('clips.close', { why: 'its close button' }); });
  region.addEventListener('click', function () {
    call('clips.close', { why: 'Record a region or window' }).then(function () { return call('screenrec.start', { from: 'clips' }); })
      .then(function (r) { if (r && r.ok === false) { S.note = 'Mantle’s recorder did not start (' + (r.why || r.reason || 'no reason given') + ')'; draw(); } });
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); call('clips.close', { why: 'Esc' }); }
    else if ((k === 'r' || k === 'R') && !e.repeat) { e.preventDefault(); record(); }
    else if ((k === 'm' || k === 'M') && !e.repeat) { e.preventDefault(); toggleMic(); }
    else if ((k === 'o' || k === 'O') && !e.repeat) { e.preventDefault(); openClips(null); }
  });
  if (window.ResizeObserver) new ResizeObserver(function () { sendSize(); }).observe(card);
  /* lane corner-follow: main's clips.lift {px, kind, ms} glides the card above the bar's pill and back
     (ui/shared/bar-follow.js on #lift). Dark: the baked backdrop is drawn at the card's box when it was baked,
     and a shot taken with the bar up has the pill in it, so one fresh picture is asked for once a glide that moved
     the card has landed (ui/shared/bar-follow.js reshoot). */
  var follow = window.MantleBarFollow ? window.MantleBarFollow.attach($('lift'), {
    event: 'clips.lift', shown: function () { return S.shown; },
    backdrop: 'the record panel glided with the bar',
  }) : null;
  P.lift = function () { return follow ? follow.lift() : 0; };

  function snapshot() {
    return {
      shown: S.shown, hidden: card.hidden, recording: card.classList.contains('recording'), pending: card.classList.contains('pending'),
      button: { label: recLabel.textContent, disabled: rec.disabled, on: rec.classList.contains('on') },
      clock: clockEl.textContent, status: statusText.textContent, hint: hint.hidden ? null : hintText.textContent,
      warn: warn.hidden ? null : warn.textContent, mic: mic.getAttribute('aria-checked') === 'true', region: !region.hidden,
      last: last.hidden ? null : { title: lastTitle.textContent, when: lastWhen.textContent, img: !lastImg.hidden }, app: app.textContent,
      ticking: !!S.tick, sentH: S.sentH, paints: S.paints,
    };
  }

  if (!mantle || typeof mantle.on !== 'function') {
    card.hidden = false;
    S.note = 'This page lost its link to Mantle; close it and press Win+G again';
    draw();
    return;
  }
  mantle.on('clips.state', onState);
  mantle.on('clips.hide', hide);
})();
