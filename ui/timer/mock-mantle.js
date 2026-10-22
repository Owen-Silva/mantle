/* mock-mantle.js - plays main for the "Timer done" page when it is opened over file:// without
 * Electron (headless shots and ui/timer/timer.test.js). The real preload.js defines window.mantle
 * first, so under Electron this file does nothing. Nothing here is from the user's machine.
 *
 * Query: mock=done (default) | off (finished while Mantle was off) | game (shown after a game)
 *        | asleep (fired late after a sleep) | snooze (a 5 min snooze of a 25 min timer ended)
 *        | nosound (the chime fails: Web Audio is replaced by one that cannot start)
 *        | none (no window.mantle at all: the page's "lost its link" state)
 *        label=<text>   dark=1 (a dark desktop behind it)   fail=1 (every action answers ok:false)
 *        sound=fail (any mode, with the `nosound` chime failure: the longest sub lines)
 *        snoozes=60000 (the snooze lengths main offers, comma-separated; default 60000,300000)
 * No sound is ever made: every mock but `nosound` sends mute:true, and `nosound` has no working audio.
 * window.__mockCalls records what the page asked main for ([name, args]).
 */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  var mode = q.get('mock') || 'done';
  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('mock');
    if (q.get('dark') === '1') document.body.classList.add('dark');
  });
  if (mode === 'none') return;
  var end = new Date(); end.setHours(21, 14, 0, 0);
  var snooze = mode === 'snooze';
  var payload = { label: q.get('label') || '25 min', totalMs: (snooze ? 5 : 25) * 60000, endAt: end.getTime(), whileOff: mode === 'off',
    asleep: mode === 'asleep', during: mode === 'game' ? 'VALORANT.exe ran' : null, snoozeOf: snooze ? 25 * 60000 : null,
    snoozes: (q.get('snoozes') || '60000,300000').split(',').map(Number), mute: mode !== 'nosound', closeInMs: 120000 };
  if (q.get('sound') === 'fail') payload.mute = false;   // any mode + a chime that fails
  if (mode === 'nosound' || q.get('sound') === 'fail') {
    window.AudioContext = function () { throw new Error('no audio output device was found'); };
    window.webkitAudioContext = undefined;
  }
  var calls = window.__mockCalls = [];
  var subs = {};
  window.mantle = {
    call: function (name, args) {
      calls.push([name, args]);
      if (q.get('fail') === '1' && name !== 'timer.chime') return Promise.resolve({ ok: false, reason: 'the mock said no' });
      return Promise.resolve({ ok: true });
    },
    on: function (ev, cb) {
      (subs[ev] = subs[ev] || []).push(cb);
      // main pushes timer.done after did-finish-load: after this script and the page's have run
      if (ev === 'timer.done') setTimeout(function () { cb(payload); }, 0);
      return function () { subs[ev] = (subs[ev] || []).filter(function (f) { return f !== cb; }); };
    },
  };
})();
