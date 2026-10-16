/* mock-screenrec.js - main, played for the recording page in a plain browser (screenrec.page.test.js and
 * the morning shots). Defines window.mantle ONLY when it is absent; under Electron the real preload wins.
 *
 *   ?state=starting | recording | stopping | done | failed | refused | idle   what main says first
 *   ?secs=<n>        recording: how long it has run (the living timer starts there)
 *   ?theme=dark      <html data-theme="dark"> (the preload does this under Electron)
 *   ?copyfail=1      the card's Copy fails (the card stays, says why)
 * window.__mock.calls lists every call; window.__mockEmit(event, payload) plays main.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  if (q.get('theme')) document.documentElement.setAttribute('data-theme', q.get('theme'));
  var listeners = {};
  var mock = window.__mock = { calls: [] };
  var secs = Number(q.get('secs')) || 0;
  var STATES = {
    starting: { phase: 'starting', secs: 0 },
    recording: { phase: 'recording', secs: secs, startedAt: Date.now() - secs * 1000, w: 1920, h: 1080, fps: 30 },
    stopping: { phase: 'stopping', secs: secs },
    done: { phase: 'done', secs: 47, w: 1920, h: 1080, bytes: 14.2 * 1024 * 1024, name: 'Recording 2026-10-15 213000.mp4',
      words: { title: 'Recording saved', detail: '0:47 · 1920 × 1080 · 14.2 MB', note: null, name: 'Recording 2026-10-15 213000.mp4' } },
    failed: { phase: 'failed', error: 'the disk is almost full (812 MB free), so the recording stopped',
      words: { title: 'Recording not saved', detail: 'the disk is almost full (812 MB free), so the recording stopped', warn: true } },
    refused: { phase: 'failed', error: 'VALORANT-Win64-Shipping.exe is in front, and Mantle never records games. Game Bar records games: press Win+Alt+R',
      words: { title: 'Not recording', detail: 'VALORANT-Win64-Shipping.exe is in front, and Mantle never records games. Game Bar records games: press Win+Alt+R', warn: true } },
  };
  window.mantle = {
    call: function (name, args) {
      mock.calls.push({ name: name, args: args });
      if (name === 'screenrec.cardCopy' && q.get('copyfail') === '1') return Promise.resolve({ ok: false, reason: 'Windows did not take it onto the clipboard (another app has it open)' });
      if (name === 'screenrec.pillStop') {
        setTimeout(function () { emit('screenrec.state', STATES.done); }, Number(q.get('savems')) || 400);
        return Promise.resolve({ ok: true, stopped: true });
      }
      if (name === 'screenrec.loaded') {
        var first = STATES[q.get('state') || 'recording'];
        if (first) setTimeout(function () { emit('screenrec.state', first); }, 0);
      }
      return Promise.resolve({ ok: true });
    },
    on: function (name, cb) { (listeners[name] = listeners[name] || []).push(cb); return function () {}; },
  };
  function emit(name, payload) { (listeners[name] || []).forEach(function (cb) { cb(payload); }); }
  window.__mockEmit = emit;
  window.__mockStates = STATES;
})();
