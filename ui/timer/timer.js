/* timer.js - the "Timer done" pop-up's page (lane tbtimer, 2026-09-27). Main (lib/features/timer.js)
 * pushes timer.done { label, totalMs, endAt, whileOff, during, mute, closeInMs } once, after the page
 * has loaded. The page draws the card, plays a soft two-note chime with Web Audio (unless `mute`:
 * a --test run never makes a sound) and reports it (timer.chime { ok, muted, reason }); a chime that
 * could not play is said on the card itself. Again / Dismiss go back to main, which closes the
 * window. window.__timer is for a test reading the DOM of the hidden --test window.
 */
(function () {
  'use strict';
  var C = window.TimerCore;
  var mantle = window.mantle;
  var card = document.getElementById('card');
  var title = document.getElementById('title');
  var sub = document.getElementById('sub');
  var again = document.getElementById('again');
  var dismiss = document.getElementById('dismiss');
  var life = document.getElementById('life');
  var cur = null, base = '', note = '', noteBad = false, chimed = false;
  var T = window.__timer = { shown: false, title: '', sub: '', sound: null, soundReason: null };

  function at(ms) {
    if (C && C.timeOfDay) return C.timeOfDay(ms);
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }

  function drawSub() {
    sub.textContent = base;
    if (note) {
      var s = document.createElement('span');
      if (noteBad) s.className = 'bad';
      s.textContent = ' ' + note;
      sub.appendChild(s);
    }
    sub.title = sub.textContent;
    T.sub = sub.textContent;
  }

  function show(p) {
    if (!p || typeof p !== 'object') return;
    cur = p;
    var label = p.label || (C ? C.labelFor(p.totalMs) : '');
    var end = at(p.endAt);
    title.textContent = 'Timer done: ' + label;
    title.title = title.textContent;
    base = p.whileOff ? 'Finished while Mantle was off · ended ' + end
      : p.during ? 'Ended at ' + end + ' while ' + p.during
      : 'Ended at ' + end;
    drawSub();
    again.disabled = false; dismiss.disabled = false;
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
    if (!r.ok) { note = '(no sound: ' + r.reason + ')'; noteBad = true; drawSub(); }
    if (mantle && typeof mantle.call === 'function') mantle.call('timer.chime', r).catch(function () { /* main is gone: nothing to tell */ });
  }

  /* Two sine notes (A5 then E5), a gentle 30 ms attack and a ~1 s exponential decay, peak gain 0.2. */
  function chime(p) {
    if (p.mute) { report({ ok: true, muted: true, reason: 'muted in --test' }); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { report({ ok: false, reason: 'this page has no Web Audio' }); return; }
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

  function act(verb, btn) {
    if (!mantle || typeof mantle.call !== 'function') return;
    again.disabled = true; dismiss.disabled = true;
    mantle.call('timer.' + verb, {}).then(function (r) {
      if (r && r.ok === false) {
        note = '(' + verb + ' failed: ' + r.reason + ')'; noteBad = true; drawSub();
        again.disabled = false; dismiss.disabled = false;
      }
      // ok: main closes this window
    }, function (e) {
      note = '(' + verb + ' failed: ' + ((e && e.message) || e) + ')'; noteBad = true; drawSub();
      again.disabled = false; dismiss.disabled = false;
    });
    if (btn) btn.blur();
  }
  again.addEventListener('click', function () { act('again', again); });
  dismiss.addEventListener('click', function () { act('dismiss', dismiss); });

  if (!mantle || typeof mantle.on !== 'function') {
    title.textContent = 'Timer done';
    base = 'this pop-up has no bridge to Mantle (window.mantle is missing)';
    note = ''; drawSub();
    card.hidden = false;
    return;
  }
  mantle.on('timer.done', show);
})();
