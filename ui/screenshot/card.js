/* card.js - the card after a capture. Main sends `screenshot.card` with what happened; the page
 * owns the ~5 s timer (paused while the pointer or the keyboard focus is on the card, so it never
 * vanishes under a hand about to click) and asks main to act: open the file, copy its path, show
 * it in its folder, or put the card away. Main parks the window on `screenshot.cardDismiss`.
 *
 * NO SILENT FAILURES: a capture that was copied but not saved (or saved but not copied) says which
 * and why, in plain words, and the actions that need the missing file are disabled.
 */
(function () {
  'use strict';
  var G = window.ShotGeometry;
  var bridge = window.mantle;
  var $ = function (id) { return document.getElementById(id); };
  var card = $('card'), timer = $('timer');
  var LIFE_MS = 5000;
  var S = { seq: 0, info: null, left: LIFE_MS, runningSince: 0, raf: 0, hover: false, focus: false, keyboard: false, gone: true };
  window.__card = S;

  function send(verb, args) {
    if (!bridge) return Promise.resolve(null);
    return bridge.call('screenshot.' + verb, Object.assign({ seq: S.seq }, args || {})).catch(function () { return null; });
  }

  function paused() { return S.hover || S.focus; }

  function tick() {
    S.raf = 0;
    if (S.gone) return;
    var now = performance.now();
    if (!paused() && S.runningSince) { S.left -= now - S.runningSince; }
    S.runningSince = paused() ? 0 : now;
    timer.style.transform = 'scaleX(' + Math.max(0, S.left / LIFE_MS).toFixed(4) + ')';
    if (S.left <= 0) { dismiss('timeout'); return; }
    S.raf = requestAnimationFrame(tick);
  }

  function dismiss(why) {
    if (S.gone) return;
    S.gone = true;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    card.classList.remove('in');
    send('cardDismiss', { why: why });
  }

  function show(info) {
    if (!info) return;
    S.seq = info.seq; S.info = info; S.left = info.lifeMs || LIFE_MS; S.runningSince = performance.now();
    S.gone = false; S.hover = false; S.focus = false;
    var saved = !info.saveError && !!info.path, copied = !!info.copied;
    $('title').textContent = saved ? 'Screenshot saved' : copied ? 'Screenshot copied' : 'Screenshot not saved';
    $('name').textContent = saved ? info.name : (copied ? 'Copied to the clipboard only' : '');
    $('status').textContent = (saved && copied ? 'Copied to clipboard · ' : '') +
      (info.w && info.h ? G.sizeText(info.w, info.h) : '');
    var warn = [];
    if (info.saveError) warn.push('Not saved: ' + info.saveError);
    if (info.copyError) warn.push('Not copied: ' + info.copyError);
    $('warn').textContent = warn.join(' · ');
    $('warn').hidden = !warn.length;
    $('copy-path').disabled = !saved;
    $('folder').disabled = !saved;
    $('open').disabled = $('title').disabled = !saved;
    $('copy-path').textContent = 'Copy path';
    $('copy-path').classList.remove('done');
    var img = $('thumb');
    if (info.url) img.src = info.url; else img.removeAttribute('src');
    card.hidden = false;
    // The next frame, so the slide-in transition has a start to run from.
    requestAnimationFrame(function () { card.classList.add('in'); });
    if (!S.raf) S.raf = requestAnimationFrame(tick);
    send('cardShown', { h: card.offsetHeight, w: card.offsetWidth });
  }

  function clear() {
    S.gone = true;
    card.classList.remove('in');
    card.hidden = true;
    $('thumb').removeAttribute('src');
  }

  $('open').addEventListener('click', function () { send('cardOpen'); dismiss('opened'); });
  $('title').addEventListener('click', function () { send('cardOpen'); dismiss('opened'); });
  $('folder').addEventListener('click', function () { send('cardFolder'); dismiss('folder'); });
  $('dismiss').addEventListener('click', function () { dismiss('closed'); });
  $('copy-path').addEventListener('click', function () {
    send('cardCopyPath').then(function (r) {
      var b = $('copy-path');
      b.textContent = r && r.ok === false ? 'Not copied' : 'Path copied';
      if (!(r && r.ok === false)) b.classList.add('done');
    });
    S.left = Math.max(S.left, 2000);        // time to read "Path copied"
  });
  card.addEventListener('pointerenter', function () { S.hover = true; });
  card.addEventListener('pointerleave', function () { S.hover = false; });
  // Keyboard focus pauses the timer; a CLICK's focus does not (else a clicked Copy path would pin
  // the card on screen until the next click elsewhere).
  document.addEventListener('pointerdown', function () { S.keyboard = false; S.focus = false; }, true);
  card.addEventListener('focusin', function () { S.focus = !!S.keyboard; });
  card.addEventListener('focusout', function () { S.focus = false; });
  window.addEventListener('blur', function () { S.focus = false; });
  document.addEventListener('keydown', function (e) {
    S.keyboard = true;
    if (card.contains(document.activeElement)) S.focus = true;
    if (e.key === 'Escape') { e.preventDefault(); dismiss('Esc'); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !S.gone) {
      var list = Array.prototype.filter.call(card.querySelectorAll('button'), function (b) { return !b.disabled; });
      var i = list.indexOf(document.activeElement);
      var n = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1) + (i < 0 ? 1 : 0)) % list.length];
      if (n) { n.focus(); e.preventDefault(); }
    }
  });

  if (!bridge) return;
  bridge.on('screenshot.card', show);
  bridge.on('screenshot.cardClear', clear);
  send('cardLoaded');
}());
