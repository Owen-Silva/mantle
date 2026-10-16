/* screenrec.js - the recording pill and its end card (lane screenrec2, 2026-10-15). main
 * (lib/features/screenrec.js) sends screenrec.state {phase, startedAt, secs, words, ...}; this page shows:
 *   checking / starting   the pill: a hollow dot, "Starting…"
 *   recording             the pill: the breathing dot, the living timer (from startedAt, so it never
 *                         drifts or waits on main), Stop
 *   stopping              the pill: "Saving…"
 *   done / failed         the pill grows into the card: what was saved (or the reason, in plain words),
 *                         Open, Copy, Show in folder, close. The card closes itself after CARD_LIFE_MS,
 *                         held while the pointer is on it.
 * Clicks: the window lets every click through except over the shape (screenrec.pointer {over}).
 */
(function () {
  'use strict';
  var CARD_LIFE_MS = 12000;      // the card's life; held while hovered, at least LIFE_AFTER_MS after leaving
  var LIFE_AFTER_MS = 4000;
  var LEAVE_MS = 200;            // the exit fade, then main destroys the window
  var bridge = window.mantle || null;
  var $ = function (id) { return document.getElementById(id); };
  var shape = $('shape'), pill = $('pill'), card = $('card'), clock = $('clock'), stopBtn = $('stop');
  var S = { phase: 'idle', startedAt: 0, secs: 0, tick: null, life: null, lifeLeft: 0, lifeAt: 0, over: false, closing: false, mode: null, v: null };
  var api = window.__screenrec = { state: S, CARD_LIFE_MS: CARD_LIFE_MS };

  function call(name, args) {
    if (!bridge) return Promise.resolve(null);
    return Promise.resolve(bridge.call(name, args || {})).catch(function (e) { return { ok: false, reason: (e && e.message) || 'Mantle did not answer' }; });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clockText(secs) {
    var s = Math.max(0, Math.floor(secs || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(r) : m + ':' + pad2(r);
  }
  api.clockText = clockText;

  /* ---- size: the shape takes its face's own size (the spring is the CSS transition) ---------------- */
  function sizeTo(face) {
    var was = face.hidden;
    face.hidden = false;
    face.classList.add('measure');
    var w = Math.ceil(face.offsetWidth), h = Math.ceil(face.offsetHeight);
    face.classList.remove('measure');
    if (was && face !== activeFace()) face.hidden = true;
    shape.style.width = w + 'px';
    shape.style.height = h + 'px';
    return { w: w, h: h };
  }
  function activeFace() { return S.mode === 'card' ? card : pill; }

  function show() {
    if (!shape.hidden && !shape.classList.contains('leave')) return;
    shape.classList.remove('leave');
    shape.hidden = false;
    shape.classList.add('enter');
    void shape.offsetWidth;            // the entering state is laid out, so the spring runs from it
    requestAnimationFrame(function () { shape.classList.remove('enter'); });
  }

  /* ---- the pill ----------------------------------------------------------------------------------- */
  function stopTick() { if (S.tick) { clearTimeout(S.tick); S.tick = null; } }
  function tick() {
    stopTick();
    if (S.phase !== 'recording') return;
    var ms = Date.now() - S.startedAt;
    clock.textContent = clockText(ms / 1000);
    S.tick = setTimeout(tick, 1000 - (ms % 1000) + 8);   // on the second, so the digits turn evenly
  }
  function renderPill(v) {
    clearTimeout(S.life); S.life = null;   // a new recording over the last card: that card's close is off
    S.mode = 'pill';
    card.hidden = true;
    pill.hidden = false;
    pill.classList.remove('out');
    shape.classList.remove('is-card');
    pill.classList.toggle('starting', v.phase === 'checking' || v.phase === 'starting');
    pill.classList.toggle('stopping', v.phase === 'stopping');
    stopBtn.disabled = v.phase === 'stopping';
    stopBtn.title = v.phase === 'stopping' ? 'Saving the recording' : 'Stop recording (Win+Shift+S)';
    if (v.phase === 'recording') {
      S.startedAt = v.startedAt || (Date.now() - (v.secs || 0) * 1000);
      tick();
    } else {
      stopTick();
      clock.textContent = v.phase === 'stopping' ? 'Saving…' : 'Starting…';
    }
    sizeTo(pill);
    show();
  }

  /* ---- the card ----------------------------------------------------------------------------------- */
  function renderCard(v) {
    stopTick();
    var w = v.words || { title: v.phase === 'done' ? 'Recording saved' : 'Recording not saved', detail: v.error || '' };
    var warn = !!w.warn || v.phase !== 'done';
    $('title').textContent = w.title || '';
    $('detail').textContent = w.detail || '';
    $('name').textContent = warn ? '' : (w.name || v.name || '');
    var note = $('note');
    note.textContent = w.note || '';
    note.hidden = !w.note;
    $('actions').hidden = warn;
    setStatus('', false);
    card.classList.toggle('warn', warn);
    var fromPill = S.mode === 'pill' && !shape.hidden;
    S.mode = 'card';
    shape.classList.add('is-card');
    if (fromPill) {
      pill.classList.add('out');
      card.hidden = false;
      card.classList.add('out');
      sizeTo(card);
      setTimeout(function () { if (S.mode === 'card') { pill.hidden = true; card.classList.remove('out'); } }, 90);
    } else {
      pill.hidden = true;
      card.hidden = false;
      card.classList.remove('out');
      sizeTo(card);
      show();
    }
    armLife(CARD_LIFE_MS);
    if (!warn) setTimeout(function () { if (S.mode === 'card' && !S.over) try { $('open').focus({ preventScroll: true }); } catch (e) { /* fine */ } }, 0);
  }
  function setStatus(text, warn) {
    var s = $('status');
    s.textContent = text || '';
    s.classList.toggle('warn', !!warn);
    if (S.mode === 'card' && !shape.hidden) sizeTo(card);
  }

  /* ---- the card's life ---------------------------------------------------------------------------- */
  function armLife(ms) {
    clearTimeout(S.life);
    S.lifeLeft = ms; S.lifeAt = Date.now();
    S.life = S.over ? null : setTimeout(close, ms);
  }
  function close() {
    if (S.closing) return;
    S.closing = true;
    clearTimeout(S.life);
    stopTick();
    shape.classList.add('leave');
    setTimeout(function () { call('screenrec.cardClose'); S.closing = false; S.mode = null; shape.hidden = true; }, LEAVE_MS);
  }
  api.close = close;

  /* ---- the pointer: only the shape takes clicks ----------------------------------------------------- */
  shape.addEventListener('mouseenter', function () {
    S.over = true;
    call('screenrec.pointer', { over: true });
    if (S.mode === 'card') { clearTimeout(S.life); S.life = null; }
  });
  shape.addEventListener('mouseleave', function () {
    S.over = false;
    call('screenrec.pointer', { over: false });
    if (S.mode === 'card' && !S.closing) armLife(Math.max(LIFE_AFTER_MS, S.lifeLeft - (Date.now() - S.lifeAt)));
  });

  /* ---- buttons -------------------------------------------------------------------------------------- */
  stopBtn.addEventListener('click', function () {
    if (stopBtn.disabled) return;
    stopBtn.disabled = true;
    pill.classList.add('stopping');
    stopTick();
    clock.textContent = 'Saving…';
    sizeTo(pill);
    call('screenrec.pillStop').then(function (r) {
      if (r && r.ok === false) { stopBtn.disabled = false; pill.classList.remove('stopping'); tick(); }
    });
  });
  function act(id, verb, okWords) {
    $(id).addEventListener('click', function () {
      call('screenrec.' + verb).then(function (r) {
        if (r && r.ok === false) { setStatus(r.reason || 'that did not work', true); armLife(CARD_LIFE_MS); return; }
        if (okWords) { setStatus(okWords, false); armLife(CARD_LIFE_MS); }
        else close();
      });
    });
  }
  act('open', 'cardOpen', null);
  act('folder', 'cardFolder', null);
  act('copy', 'cardCopy', 'Copied: paste it into Discord or a chat');
  $('close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.mode === 'card') close(); });

  /* ---- main ----------------------------------------------------------------------------------------- */
  function render(v) {
    if (!v || typeof v !== 'object') return;
    S.v = v;
    S.phase = v.phase;
    S.closing = false;
    shape.classList.remove('leave');
    if (v.phase === 'done' || v.phase === 'failed') renderCard(v);
    else if (v.phase === 'checking' || v.phase === 'starting' || v.phase === 'recording' || v.phase === 'stopping') renderPill(v);
  }
  api.render = render;
  if (bridge && bridge.on) bridge.on('screenrec.state', render);
  call('screenrec.loaded');
})();
