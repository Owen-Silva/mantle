/* card.js - the card after a capture. Main sends `screenshot.card` with what happened; the page
 * owns the card's timer (~7 s with a Save button, paused while the pointer or the keyboard focus is
 * on the card, or a Save is under way, so it never vanishes under a hand about to click) and asks
 * main to act: save it, open the file, copy its path, show it in its folder, or put the card away.
 * Main parks the window on `screenshot.cardDismiss`, and only then lets the capture go.
 *
 * WHAT IT SAYS (lane shot-save, 2026-10-14; Owen: "screenshots shouldnt all get saved to my
 * computer automatically only if i press a button in the popup that says save"). A capture is
 * COPIED, not saved: the title is the one fact a person acts on next - "Screenshot copied" (paste
 * it) - one quiet line gives its size, and Save is the card's one button (Ctrl+S with the card
 * focused). Pressed, it says "Saving..." and then, in plain words, where it went: "Saved to
 * Screenshots", with Show in folder and Copy path; the picture then opens the file. The picture is
 * drawn from the frozen frame main still holds (info.thumb pieces), so nothing is encoded for it.
 * With "Also save every screenshot automatically" on, the card says "Saved to Screenshots" on its
 * status line from the start, as before.
 *
 * NO SILENT FAILURES: a Save that fails says "Not saved: <why>" (main's plain words) and the button
 * says Try again; a clipboard that refused says "Not copied: <why>" and offers Save; the actions
 * that need a file appear only once there is one.
 */
(function () {
  'use strict';
  var G = window.ShotGeometry;
  var bridge = window.mantle;
  var $ = function (id) { return document.getElementById(id); };
  var card = $('card'), timer = $('timer');
  var LIFE_MS = 7000;
  var OUT_MS = 260;                        // the slide-out before main parks the window (card.css #card.out: --lg-dur-out)
  var THUMB_PX = { w: 208, h: 132 };       // the picture box (104 x 66 CSS px) at 2x: drawn no bigger than this
  var S = { seq: 0, info: null, life: LIFE_MS, left: LIFE_MS, runningSince: 0, to: 0, raf: 0, hover: false, focus: false,
    keyboard: false, saving: false, gone: true, outTimer: 0, thumbToken: 0, thumbDrawn: 0 };
  window.__card = S;

  function send(verb, args) {
    if (!bridge) return Promise.resolve(null);
    return bridge.call('screenshot.' + verb, Object.assign({ seq: S.seq }, args || {})).catch(function () { return null; });
  }

  function paused() { return S.hover || S.focus || S.saving; }

  /* THE TIMER. The deadline is a setTimeout (it runs in a hidden window too: a test's card times
     out like Owen's); the shrinking hairline is only paint, on animation frames. Every change of
     hover, focus or saving comes through sync(), which books the time spent and re-arms. */
  function sync() {
    var now = performance.now();
    if (S.runningSince) S.left -= now - S.runningSince;
    var wasHeld = card.classList.contains('paused');
    var held = paused();
    S.runningSince = held || S.gone ? 0 : now;
    clearTimeout(S.to);
    S.to = 0;
    if (S.gone) return;
    card.classList.toggle('paused', held);
    if (held !== wasHeld) send('cardHold', { held: held, left: Math.max(0, Math.round(S.left)) });
    if (!held) {
      if (S.left <= 0) { dismiss('timeout'); return; }
      S.to = setTimeout(sync, Math.max(16, S.left));
    }
    if (!S.raf) S.raf = requestAnimationFrame(paint);
  }
  function leftNow() { return S.runningSince ? S.left - (performance.now() - S.runningSince) : S.left; }
  function paint() {
    S.raf = 0;
    if (S.gone) return;
    timer.style.transform = 'scaleX(' + Math.max(0, Math.min(1, leftNow() / S.life)).toFixed(4) + ')';
    if (!paused()) S.raf = requestAnimationFrame(paint);
  }
  /** At least `ms` left from now (time to read an answer). */
  function extend(ms) { sync(); if (S.left < ms) { S.left = ms; S.life = Math.max(S.life, ms); } sync(); }

  /** Put the card away: it slides out, THEN main parks the window. The seq is this card's own,
   *  taken now, so a newer card that arrives during the slide-out is never the one put away. */
  function dismiss(why) {
    if (S.gone) return;
    S.gone = true;
    clearTimeout(S.to);
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    var seq = S.seq;
    card.classList.remove('in');
    card.classList.add('out');
    clearTimeout(S.outTimer);
    S.outTimer = setTimeout(function () {
      if (bridge) bridge.call('screenshot.cardDismiss', { seq: seq, why: why }).catch(function () { return null; });
    }, reducedMotion() ? 120 : OUT_MS);   // reduced motion: the 120 ms fade (lane mantle-motion)
  }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function folderWords(info) {
    return info.folderName ? 'Saved to ' + info.folderName : 'Saved';
  }

  function begin(info) {
    clearTimeout(S.outTimer);
    clearTimeout(S.to);
    S.seq = info.seq; S.info = info; S.life = S.left = info.lifeMs || LIFE_MS; S.runningSince = 0;
    S.gone = false; S.hover = false; S.focus = false; S.saving = false; S.opening = 0;
    card.classList.remove('out', 'paused', 'just-saved');
    card.classList.toggle('text-card', info.kind === 'text');
  }
  function reveal() {
    card.hidden = false;
    // The next frame, so the slide-in transition has a start to run from.
    requestAnimationFrame(function () { card.classList.add('in'); });
    sync();
    sent = { w: card.offsetWidth, h: card.offsetHeight };
    send('cardShown', { h: sent.h, w: sent.w });
  }
  /* The card is as wide as what is on it (card.css), so ANY change of words can change its size ("Copy
     path" -> "Path copied", a warn line): a ResizeObserver tells main every time, so the window always
     fits the card and never cuts it or leaves glass where it used to reach. */
  var sent = { w: 0, h: 0 };
  function resized() {
    var w = card.offsetWidth, h = card.offsetHeight;
    if (card.hidden || S.gone || !w || !h || (w === sent.w && h === sent.h)) return;
    sent = { w: w, h: h };
    send('cardSize', { h: h, w: w });
  }
  if (window.ResizeObserver) new ResizeObserver(function () { resized(); }).observe(card);
  function warnLine(parts) {
    $('warn').textContent = parts.join(' · ');
    $('warn').hidden = !parts.length;
  }

  /* THE PICTURE: the selection, cut out of the frozen frame's per-monitor BMPs (main's thumbPieces)
     onto a canvas no bigger than the box shows at 2x. Only the card that asked draws (the token). */
  function drawThumb(info) {
    var c = $('pic'), g = c.getContext('2d'), t = info.thumb, token = ++S.thumbToken;
    S.thumbDrawn = 0;
    card.classList.remove('has-pic');
    g.clearRect(0, 0, c.width, c.height);
    if (!t || !t.pieces || !t.pieces.length || !(t.w > 0 && t.h > 0)) return false;
    var k = Math.min(1, Math.max(THUMB_PX.w / t.w, THUMB_PX.h / t.h));
    c.width = Math.max(1, Math.round(t.w * k)); c.height = Math.max(1, Math.round(t.h * k));
    t.pieces.forEach(function (p) {
      var img = new Image();
      img.onload = function () {
        if (token !== S.thumbToken) return;
        g.drawImage(img, p.sx, p.sy, p.sw, p.sh, p.dx * k, p.dy * k, p.sw * k, p.sh * k);
        S.thumbDrawn++;
        card.classList.add('has-pic');
      };
      img.src = p.url;
    });
    return true;
  }

  function show(info) {
    if (!info) return;
    begin(info);
    if (info.kind === 'text') { showText(info); return; }
    var img = $('thumb');
    // the frame's pieces when main still holds the frame; else the saved file (or nothing)
    if (!drawThumb(info) && info.url) img.src = info.url; else img.removeAttribute('src');
    $('save').textContent = 'Save';
    $('save').disabled = false;
    $('copy-path').textContent = 'Copy path';
    $('copy-path').classList.remove('done', 'bad');
    render();
    reveal();
  }

  /** Everything the card says and offers, from S.info (again after a Save). */
  function render() {
    var info = S.info;
    var saved = !!info.path, copied = !!info.copied;
    var canSave = !!info.canSave && !saved;
    var size = info.w && info.h ? G.sizeText(info.w, info.h) : '';
    // info.title / info.note: a card that is not about a capture (Mantle's overlay could not come
    // forward and Windows' Snipping Tool was opened instead) says so in its own words.
    var title, status;
    if (info.title) { title = info.title; status = ''; }
    else if (saved && info.justSaved) { title = folderWords(info); status = [size, copied ? 'also copied' : ''].filter(Boolean).join(' · '); }
    else { title = copied ? 'Screenshot copied' : saved ? 'Screenshot saved' : 'Screenshot not copied'; status = [saved ? folderWords(info) : '', size].filter(Boolean).join(' · '); }
    $('title').textContent = title;
    $('name').textContent = '';
    $('status').textContent = status;
    var warn = [];
    if (info.note) warn.push(info.note);
    if (info.saveError) warn.push('Not saved: ' + info.saveError);
    if (info.copyError) warn.push('Not copied: ' + info.copyError);
    warnLine(warn);
    var pic = !!(info.thumb && info.thumb.pieces && info.thumb.pieces.length) || !!info.url;
    card.classList.toggle('no-file', !pic && !saved);
    card.classList.toggle('no-actions', !canSave && !saved);
    card.classList.toggle('just-saved', !!info.justSaved);
    $('save').hidden = !canSave;
    $('save').classList.toggle('retry', !!info.saveError);
    $('copy-path').hidden = $('folder').hidden = !saved;
    $('copy-path').disabled = $('folder').disabled = !saved;
    $('open').disabled = !saved;
    $('open').title = saved ? 'Open ' + (info.name || 'the screenshot') : 'Copied: press Save to keep it as a file';
    $('open').setAttribute('aria-label', saved ? 'Open the screenshot' : 'The screenshot');
  }

  /* The Copy text card (ocr lane, 2026-09-27): "Copied 3 lines" and the first ~40 characters, or
     "No text found in that area" (nothing was copied), or "Text not copied" with the reason. No
     thumbnail and no file actions: nothing is saved, and no Save is offered. The text is only ever
     shown, never logged. */
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
    card.classList.add('no-file', 'no-actions');
    card.classList.remove('just-saved', 'has-pic');
    S.thumbToken++;
    $('save').hidden = true;
    $('open').disabled = $('copy-path').disabled = $('folder').disabled = true;
    $('thumb').removeAttribute('src');
    reveal();
  }

  function clear() {
    S.gone = true;
    clearTimeout(S.outTimer);
    clearTimeout(S.to);
    S.thumbToken++;
    card.classList.remove('in', 'out');
    card.hidden = true;
    $('thumb').removeAttribute('src');
    var c = $('pic');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    c.width = c.height = 1;                // the picture's pixels go with the card
  }

  /* Every action works once per card: a double-click on the picture opened the file TWICE (the
     second click reached main after the card was already put away, and main still knew the path). */
  function act(fn) { return function (e) { if (S.gone || (e.currentTarget && e.currentTarget.disabled)) return; fn(); }; }

  /* SAVE: main writes the cut it copied (the frame it held for this card) into the save folder. The
     card holds still while it works, then says where it went, or why not with the button kept. */
  function save(via) {
    var seq = S.seq, b = $('save');
    if (S.gone || S.saving || !S.info || !S.info.canSave || S.info.path) return;
    S.saving = true;
    sync();
    b.disabled = true;
    b.textContent = 'Saving…';
    send('cardSave', { via: via }).then(function (r) {
      if (S.gone || S.seq !== seq) return;
      S.saving = false;
      if (r && r.ok) {
        Object.assign(S.info, { path: r.path || S.info.path || true, name: r.name || S.info.name, folderName: r.folderName || S.info.folderName,
          url: r.url || S.info.url, canSave: false, saveError: null, justSaved: true });
        if (r.w && r.h) { S.info.w = r.w; S.info.h = r.h; }
        render();
        extend(4000);                      // time to read where it went
        var f = $('folder');
        if (S.keyboard && card.contains(document.activeElement)) f.focus();   // the keyboard lands on the next useful thing
      } else {
        S.info.saveError = (r && r.reason) || 'Mantle did not answer: try again';
        render();
        b.disabled = false;
        b.textContent = 'Try again';
        extend(6000);                      // time to read why
      }
      resized();
    });
  }
  $('save').addEventListener('click', act(function () { save('button'); }));

  // Open: the card goes once Windows has the file; if it could not open it, the card STAYS and says why
  // (before, it was put away at the click, and a failed open was only a log line: a silent failure).
  $('open').addEventListener('click', act(function () {
    var seq = S.seq;
    if (S.opening === seq) return;         // a double-click: the first click is already opening it
    S.opening = seq;
    extend(2000);
    send('cardOpen').then(function (r) {
      if (S.opening === seq) S.opening = 0;
      if (S.gone || S.seq !== seq) return;
      if (r && r.ok === false) { warnLine(['Not opened: ' + (r.reason || 'no reason was given')]); extend(4000); resized(); return; }
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
    extend(2000);                          // time to read "Path copied"
  }));
  card.addEventListener('pointerenter', function () { S.hover = true; sync(); });
  card.addEventListener('pointerleave', function () { S.hover = false; sync(); });
  // Keyboard focus pauses the timer; a CLICK's focus does not (else a clicked Copy path would pin
  // the card on screen until the next click elsewhere).
  document.addEventListener('pointerdown', function () { S.keyboard = false; if (S.focus) { S.focus = false; sync(); } }, true);
  card.addEventListener('focusin', function () { S.focus = !!S.keyboard; sync(); });
  card.addEventListener('focusout', function () { S.focus = false; sync(); });
  window.addEventListener('blur', function () { if (S.focus) { S.focus = false; sync(); } });
  document.addEventListener('keydown', function (e) {
    S.keyboard = true;
    if (card.contains(document.activeElement) && !S.focus) { S.focus = true; sync(); }
    if (e.key === 'Escape') { e.preventDefault(); dismiss('Esc'); return; }
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey) && !S.gone) { e.preventDefault(); save('key'); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !S.gone) {
      var list = Array.prototype.filter.call(card.querySelectorAll('button'), function (b) { return !b.disabled && b.offsetParent !== null; });
      var i = list.indexOf(document.activeElement);
      // Nothing focused yet: Right starts at the first control, Left at the last (Right started at the SECOND).
      var n = i < 0 ? list[e.key === 'ArrowRight' ? 0 : list.length - 1] : list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      if (n) { n.focus(); e.preventDefault(); }
    }
  });

  /** What the card shows, for tests (lib/features/screenshot.test.js --electron, shoot.js). Words and flags only. */
  window.__cardState = function () {
    var vis = function (id) { var el = $(id); return !el.hidden && el.offsetParent !== null; };
    return { title: $('title').textContent, status: $('status').textContent, warn: $('warn').hidden ? '' : $('warn').textContent,
      save: vis('save') ? { label: $('save').textContent, disabled: $('save').disabled } : null,
      folder: vis('folder') ? $('folder').textContent : null, copyPath: vis('copy-path'), open: !$('open').disabled,
      pic: S.thumbDrawn, left: Math.round(leftNow()), paused: card.classList.contains('paused'), gone: S.gone };
  };

  if (!bridge) return;
  // dark: one picture of what is behind the card per show; main waits for it to leave its parking spot
  bridge.on('screenshot.card', function (p) { show(p); if (window.MantleHudBackdrop) window.MantleHudBackdrop.request('shown', { hold: true }); });
  bridge.on('screenshot.cardClear', clear);
  send('cardLoaded');
}());
