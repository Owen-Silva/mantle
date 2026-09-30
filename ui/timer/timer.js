/* timer.js - the "Timer done" pop-up's page (lane tbtimer, 2026-09-27; snooze/restart and the calm
 * layout, lane topbar-timer, 2026-09-29). Main (lib/features/timer.js) pushes timer.done
 * { label, totalMs, endAt, whileOff, asleep, during, snoozeOf, snoozes, mute, closeInMs } once, after
 * the page has loaded. The page draws the card, plays a soft two-note chime with Web Audio (unless
 * `mute`: a --test run never makes a sound) and reports it (timer.chime { ok, muted, reason }); a
 * chime that could not play is said on the card itself.
 *
 * ONE PRIMARY ACTION: "Dismiss" (accent). Quiet ones beside it: "+1 min" / "+5 min" (snooze: the
 * same timer rings again that much later) and "Restart" (the same length again). Every action names
 * the finish it answers (endAt), so a double click or a stale window cannot run it twice. Main closes
 * the window on success; a refusal is said on the card and the buttons come back.
 *
 * KEYBOARD: the window is made focusable:false (it must never take the keyboard from what Owen is
 * typing), so live it is a mouse surface. Should it ever hold focus (a test, a later change), Esc
 * dismisses and Tab walks the buttons. window.__timer is for a test reading the hidden --test window.
 */
(function () {
  'use strict';
  var C = window.TimerCore;
  var mantle = window.mantle;
  var card = document.getElementById('card');
  var title = document.getElementById('title');
  var sub = document.getElementById('sub');
  var restart = document.getElementById('restart');
  var dismiss = document.getElementById('dismiss');
  var snoozeBtns = Array.prototype.slice.call(document.querySelectorAll('[data-snooze]'));
  var buttons = snoozeBtns.concat([restart, dismiss]);
  var life = document.getElementById('life');
  var cur = null, base = '', soundNote = '', actNote = '', chimed = false, busy = false;
  var T = window.__timer = { shown: false, title: '', sub: '', sound: null, soundReason: null, busy: false };

  function at(ms) {
    if (C && C.timeOfDay) return C.timeOfDay(ms);
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function len(ms) { return C ? C.labelFor(ms) : Math.round((Number(ms) || 0) / 60000) + ' min'; }

  function drawSub() {
    // The card has room for two lines under the title. With nothing wrong the sub line may take both;
    // a failure takes the second as its own warn line (the sub line keeps one), so the reason is always
    // ON the card, never clipped away. Two failures (a chime, then a click): the newest one shows,
    // and the tooltip holds every word.
    sub.textContent = '';
    var b = document.createElement('span');
    b.className = 'base';
    b.textContent = base;
    sub.appendChild(b);
    var n = actNote || soundNote;
    sub.classList.toggle('warned', !!n);
    if (n) {
      var s = document.createElement('span');
      s.className = 'bad';
      s.textContent = n;
      sub.appendChild(s);
    }
    sub.title = [base, soundNote, actNote].filter(Boolean).join('\n');
    T.sub = sub.textContent;
  }

  function setBusy(on) {
    busy = on; T.busy = on;
    buttons.forEach(function (b) { b.disabled = on; });
  }

  /** "Ended at 9:14 PM" / "25 min timer · ended at 9:14 PM" (a named timer) / "Snoozed 5 min · ended
   * at 9:19 PM", then why it is late news: ", while Mantle was off" / ", while VALORANT.exe ran" /
   * ", while the PC was asleep". */
  function subLine(p) {
    var pre = '';
    if (p.snoozeOf) pre = 'Snoozed ' + len(p.totalMs);
    else if (p.label && p.label !== len(p.totalMs)) pre = len(p.totalMs) + ' timer';
    var s = (pre ? pre + ' · ended at ' : 'Ended at ') + at(p.endAt);
    if (p.whileOff) s += ', while Mantle was off';
    else if (p.during) s += ', while ' + p.during;
    else if (p.asleep) s += ', while the PC was asleep';
    return s;
  }

  function show(p) {
    if (!p || typeof p !== 'object') return;
    cur = p;
    var label = p.label || len(p.totalMs);
    title.textContent = 'Timer done: ' + label;
    title.title = title.textContent;
    base = subLine(p);
    actNote = '';
    drawSub();
    var ok = Array.isArray(p.snoozes) ? p.snoozes : [60000, 300000];
    snoozeBtns.forEach(function (b) { b.hidden = ok.indexOf(Number(b.getAttribute('data-snooze'))) < 0; });
    restart.title = 'Run the ' + len(p.snoozeOf || p.totalMs) + ' timer again';
    setBusy(false);
    card.hidden = false;
    T.shown = true; T.title = title.textContent;
    var ms = Number(p.closeInMs) || 0;
    if (ms > 0) {
      life.classList.remove('run');
      life.style.animationDuration = ms + 'ms';   // CSSOM: the CSP drops style="" attributes
      void life.offsetWidth;
      life.classList.add('run');
    }
    if (!chimed) { chimed = true; chime(p); }
  }

  function report(r) {
    T.sound = r.muted ? 'muted' : r.ok ? 'played' : 'failed';
    T.soundReason = r.reason || null;
    if (!r.ok) { soundNote = 'No sound: ' + r.reason; drawSub(); }
    if (mantle && typeof mantle.call === 'function') mantle.call('timer.chime', r).catch(function () { /* main is gone: nothing to tell */ });
  }

  /* Two sine notes (A5 then E5), a gentle 30 ms attack and a ~1 s exponential decay, peak gain 0.2. */
  function chime(p) {
    if (p.mute) { report({ ok: true, muted: true, reason: 'muted in --test' }); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { report({ ok: false, reason: 'this PC has no audio output Mantle can use' }); return; }
    var ac;
    try { ac = new AC(); } catch (e) { report({ ok: false, reason: String((e && e.message) || e || 'the audio could not start') }); return; }
    var settled = false;
    function play() {
      if (settled) return;
      settled = true;
      try {
        var t0 = ac.currentTime + 0.03;
        [[880, 0, 0.2], [659.25, 0.22, 0.16]].forEach(function (n) {
          var o = ac.createOscillator(), g = ac.createGain(), t = t0 + n[1];
          o.type = 'sine';
          o.frequency.value = n[0];
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(n[2], t + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
          o.connect(g); g.connect(ac.destination);
          o.start(t); o.stop(t + 1.15);
        });
        setTimeout(function () { try { ac.close(); } catch (_) { /* closed */ } }, 1800);
        report({ ok: true });
      } catch (e) {
        report({ ok: false, reason: 'the chime could not play (' + ((e && e.message) || e) + ')' });
      }
    }
    function fail(why) {
      if (settled) return;
      settled = true;
      try { ac.close(); } catch (_) { /* closed */ }
      report({ ok: false, reason: why });
    }
    if (ac.state === 'running') { play(); return; }
    var wait = setTimeout(function () { fail('the audio stayed ' + ac.state); }, 1500);
    ac.resume().then(function () {
      clearTimeout(wait);
      if (ac.state === 'running') play(); else fail('the audio stayed ' + ac.state);
    }, function (e) { clearTimeout(wait); fail('the audio could not start (' + ((e && e.message) || e) + ')'); });
  }

  var VERB = { again: 'restart', snooze: 'snooze', dismiss: 'close' };
  function act(cmd, args) {
    if (busy || !cur || !mantle || typeof mantle.call !== 'function') return;
    setBusy(true);   // pressed within the click: a second click does nothing
    var a = { endAt: cur.endAt };
    if (args) for (var k in args) a[k] = args[k];
    var failed = function (why) {
      actNote = 'Couldn’t ' + VERB[cmd] + ': ' + why; drawSub();
      setBusy(false);
    };
    mantle.call('timer.' + cmd, a).then(function (r) {
      if (r && r.ok === false) failed(r.reason || 'Mantle said no and gave no reason');
      // ok: main closes this window
    }, function (e) { failed((e && e.message) || String(e || 'Mantle did not answer')); });
  }
  snoozeBtns.forEach(function (b) {
    b.addEventListener('click', function () { act('snooze', { ms: Number(b.getAttribute('data-snooze')) }); });
  });
  restart.addEventListener('click', function () { act('again'); });
  dismiss.addEventListener('click', function () { act('dismiss'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !card.hidden) { e.preventDefault(); act('dismiss'); }
  });

  if (!mantle || typeof mantle.on !== 'function') {
    title.textContent = 'Timer done';
    base = 'This pop-up lost its link to Mantle, so its buttons can’t work. Restart Mantle from the tray to close it.';
    drawSub();
    setBusy(true);
    card.hidden = false;
    return;
  }
  mantle.on('timer.done', show);
})();
