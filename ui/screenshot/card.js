/* card.js - the card after a capture. Main sends `screenshot.card` with what happened; the page
 * owns the ~5 s timer (paused while the pointer or the keyboard focus is on the card, so it never
 * vanishes under a hand about to click) and asks main to act: open the file, copy its path, show
 * it in its folder, or put the card away. Main parks the window on `screenshot.cardDismiss`.
 *
 * WHAT IT SAYS (lane capture-shot, 2026-09-29: minimal, obvious): the title is the one fact a
 * person acts on next - "Screenshot copied" (paste it) - and ONE quiet line says where the file
 * went and its size ("Saved to Screenshots · 1280 × 720"). The file name was a second line that
 * nobody acts on (it is a date); it is the picture's tooltip now. The picture is the one big
 * target: it looks clickable (hover ring + open glyph) and opens the screenshot; the title is
 * plain text now (it was a button that looked like a label).
 *
 * NO SILENT FAILURES: a capture that was copied but not saved (or saved but not copied) says which
 * and why, in plain words (main sends them plain: lib/features/screenshot.js plainError), and the
 * actions that need the missing file are disabled.
 */
(function () {
  'use strict';
  var G = window.ShotGeometry;
  var bridge = window.mantle;
  var $ = function (id) { return document.getElementById(id); };
  var card = $('card'), timer = $('timer');
  var LIFE_MS = 5000;
  var OUT_MS = 260;                        // the slide-out before main parks the window (card.css #card.out: --lg-dur-out)
  var S = { seq: 0, info: null, left: LIFE_MS, runningSince: 0, raf: 0, hover: false, focus: false, keyboard: false, gone: true, outTimer: 0 };
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
    card.classList.toggle('paused', paused());
    if (S.left <= 0) { dismiss('timeout'); return; }
    S.raf = requestAnimationFrame(tick);
  }

  /** Put the card away: it slides out, THEN main parks the window. The seq is this card's own,
   *  taken now, so a newer card that arrives during the slide-out is never the one put away. */
  function dismiss(why) {
    if (S.gone) return;
    S.gone = true;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    var seq = S.seq;
    card.classList.remove('in');
    card.classList.add('out');
    clearTimeout(S.outTimer);
    S.outTimer = setTimeout(function () {
      if (bridge) bridge.call('screenshot.cardDismiss', { seq: seq, why: why }).catch(function () { return null; });
    }, reducedMotion() ? 0 : OUT_MS);
  }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function folderWords(info) {
    return info.folderName ? 'Saved to ' + info.folderName : 'Saved';
  }

  function begin(info) {
    clearTimeout(S.outTimer);
    S.seq = info.seq; S.info = info; S.left = info.lifeMs || LIFE_MS; S.runningSince = performance.now();
    S.gone = false; S.hover = false; S.focus = false;
    card.classList.remove('out', 'paused');
    card.classList.toggle('text-card', info.kind === 'text');
  }
  function reveal() {
    card.hidden = false;
    // The next frame, so the slide-in transition has a start to run from.
    requestAnimationFrame(function () { card.classList.add('in'); });
    if (!S.raf) S.raf = requestAnimationFrame(tick);
    send('cardShown', { h: card.offsetHeight, w: card.offsetWidth });
  }
  function warnLine(parts) {
    $('warn').textContent = parts.join(' · ');
    $('warn').hidden = !parts.length;
  }

  function show(info) {
    if (!info) return;
    begin(info);
    if (info.kind === 'text') { showText(info); return; }
    var saved = !info.saveError && !!info.path, copied = !!info.copied;
    var size = info.w && info.h ? G.sizeText(info.w, info.h) : '';
    // info.title / info.note: a card that is not about a capture (Mantle's overlay could not come
    // forward and Windows' Snipping Tool was opened instead) says so in its own words.
    $('title').textContent = info.title || (copied ? 'Screenshot copied' : saved ? 'Screenshot saved' : 'Screenshot not saved');
    $('name').textContent = '';
    $('status').textContent = info.title ? '' : [saved ? folderWords(info) : '', size].filter(Boolean).join(' · ');
    var warn = [];
    if (info.note) warn.push(info.note);
    if (info.saveError) warn.push('Not saved: ' + info.saveError);
    if (info.copyError) warn.push('Not copied: ' + info.copyError);
    warnLine(warn);
    card.classList.toggle('no-file', !saved);
    $('copy-path').disabled = !saved;
    $('folder').disabled = !saved;
    $('open').disabled = !saved;
    $('open').title = saved ? 'Open ' + (info.name || 'the screenshot') : '';
    $('copy-path').textContent = 'Copy path';
    $('copy-path').classList.remove('done');
    var img = $('thumb');
    if (info.url) img.src = info.url; else img.removeAttribute('src');
    reveal();
  }

  /* The Copy text card (ocr lane, 2026-09-27): "Copied 3 lines" and the first ~40 characters, or
     "No text found in that area" (nothing was copied), or "Text not copied" with the reason. No
     thumbnail and no file actions: nothing was saved. The text is only ever shown, never logged. */
  function showText(info) {
    var t = info.text || {};
    var copied = !!info.copied && t.lines > 0;
    $('title').textContent = info.title || (copied ? t.headline : info.textError || info.copyError ? 'Text not copied' : 'No text found in that area');
    $('name').textContent = copied && t.preview ? '“' + t.preview + '”' : '';
    $('status').textContent = copied ? 'Plain text on the clipboard' : (info.textError || info.copyError ? '' : 'Nothing was copied: try a larger area');
    var warn = [];
    // The title already says "Text not copied": the line under it is just the reason, as a sentence.
    var why = info.title ? function (r) { return 'Not copied: ' + r; } : function (r) { return String(r).charAt(0).toUpperCase() + String(r).slice(1); };
    if (info.textError) warn.push(why(info.textError));
    if (info.copyError) warn.push(why(info.copyError));
    warnLine(warn);
    card.classList.add('no-file');
    $('open').disabled = $('copy-path').disabled = $('folder').disabled = true;
    $('thumb').removeAttribute('src');
    reveal();
  }

  function clear() {
    S.gone = true;
    clearTimeout(S.outTimer);
    card.classList.remove('in', 'out');
    card.hidden = true;
    $('thumb').removeAttribute('src');
  }

  /* Every action works once per card: a double-click on the picture opened the file TWICE (the
     second click reached main after the card was already put away, and main still knew the path). */
  function act(fn) { return function (e) { if (S.gone || (e.currentTarget && e.currentTarget.disabled)) return; fn(); }; }
  // Open: the card goes once Windows has the file; if it could not open it, the card STAYS and says why
  // (before, it was put away at the click, and a failed open was only a log line: a silent failure).
  $('open').addEventListener('click', act(function () {
    var seq = S.seq;
    if (S.opening === seq) return;         // a double-click: the first click is already opening it
    S.opening = seq;
    S.left = Math.max(S.left, 2000);
    send('cardOpen').then(function (r) {
      if (S.opening === seq) S.opening = 0;
      if (S.gone || S.seq !== seq) return;
      if (r && r.ok === false) { warnLine(['Not opened: ' + (r.reason || 'no reason was given')]); S.left = Math.max(S.left, 4000); return; }
      dismiss('opened');
    });
  }));
  $('folder').addEventListener('click', act(function () { send('cardFolder'); dismiss('folder'); }));
  $('dismiss').addEventListener('click', act(function () { dismiss('closed'); }));
  $('copy-path').addEventListener('click', act(function () {
    var b = $('copy-path');
    if (b.classList.contains('done')) return;          // copied already: a second click adds nothing
    send('cardCopyPath').then(function (r) {
      var failed = !!(r && r.ok === false);
      b.textContent = failed ? 'Not copied' : 'Path copied';
      b.classList.toggle('done', !failed);
      b.classList.toggle('bad', failed);
      if (failed && r.reason) b.title = 'Not copied: ' + r.reason;
    });
    S.left = Math.max(S.left, 2000);        // time to read "Path copied"
  }));
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
      var list = Array.prototype.filter.call(card.querySelectorAll('button'), function (b) { return !b.disabled && b.offsetParent !== null; });
      var i = list.indexOf(document.activeElement);
      // Nothing focused yet: Right starts at the first control, Left at the last (Right started at the SECOND).
      var n = i < 0 ? list[e.key === 'ArrowRight' ? 0 : list.length - 1] : list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      if (n) { n.focus(); e.preventDefault(); }
    }
  });

  if (!bridge) return;
  bridge.on('screenshot.card', show);
  bridge.on('screenshot.cardClear', clear);
  send('cardLoaded');
}());
