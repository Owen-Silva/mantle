/* card-mock.js - main, played for the card page in a plain browser (ui/screenshot/shoot.js). Defines
 * window.mantle ONLY when it is absent; under Electron the real preload wins.
 *
 *   ?state=ok | nosave | nocopy | neither     what happened to the capture
 *          text | notext | textfail            what happened to a Copy text capture
 *   ?life=0                                   never time out (for a still screenshot)
 *   ?openfail=1                               opening the file fails (the card must stay and say why)
 */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  var listeners = {};
  var mock = window.__mock = { calls: [] };
  window.mantle = {
    call: function (name, args) {
      mock.calls.push({ name: name, args: args });
      // ?openfail=1: main could not open the file (main sends the reason in plain words)
      if (name === 'screenshot.cardOpen' && q.get('openfail') === '1') return Promise.resolve({ ok: false, reason: 'Windows has no app set to open PNG pictures' });
      return Promise.resolve({ ok: true });
    },
    on: function (name, cb) { (listeners[name] = listeners[name] || []).push(cb); return function () {}; },
    pathForFile: function () { return ''; },
  };
  function thumb() {
    var c = document.createElement('canvas');
    c.width = 480; c.height = 300;
    var g = c.getContext('2d');
    var bg = g.createLinearGradient(0, 0, 480, 300);
    bg.addColorStop(0, '#9CC3E6'); bg.addColorStop(1, '#F1D6C4');
    g.fillStyle = bg; g.fillRect(0, 0, 480, 300);
    g.fillStyle = '#fff'; g.fillRect(60, 40, 300, 200);
    g.fillStyle = '#ECEEF3'; g.fillRect(60, 40, 300, 26);
    g.fillStyle = 'rgba(51,58,78,.28)';
    for (var y = 84; y < 230; y += 16) g.fillRect(76, y, 120 + (y * 7) % 140, 6);
    return c.toDataURL('image/png');
  }
  window.addEventListener('load', function () {
    var st = q.get('state') || 'ok';
    var info = {
      seq: 3, name: 'Screenshot 2026-09-24 143005.png', folderName: 'Screenshots', w: 1280, h: 720,
      path: 'C:\\Users\\user\\Pictures\\Screenshots\\Screenshot 2026-09-24 143005.png',
      url: thumb(), copied: st === 'ok' || st === 'nosave', lifeMs: q.get('life') === '0' ? 1e9 : 5000,
      saveError: st === 'nosave' || st === 'neither' ? 'Windows did not let Mantle save there: pick another folder in Mantle Settings > Screenshots' : null,
      copyError: st === 'nocopy' || st === 'neither' ? 'another app was using the clipboard: take it again' : null,
    };
    if (info.saveError) info.path = null;
    // The Copy text card (states text | notext | textfail). The preview is made-up sample text.
    if (st === 'text') info = { seq: 3, kind: 'text', copied: true, lifeMs: info.lifeMs, text: { lines: 3, chars: 146, headline: 'Copied 3 lines', preview: 'Question 7: A train leaves the station at…' } };
    if (st === 'notext') info = { seq: 3, kind: 'text', copied: false, lifeMs: info.lifeMs, text: { lines: 0, chars: 0 } };
    if (st === 'textfail') info = { seq: 3, kind: 'text', copied: false, lifeMs: info.lifeMs, textError: 'Windows has no text recognition installed: add a language in Windows Settings > Time & language > Language & region' };
    (listeners['screenshot.card'] || []).forEach(function (cb) { cb(info); });
  });
  // shoot.js: push another card into the same page (one card window serves every capture).
  window.__cardEmit = function (name, payload) { (listeners[name] || []).forEach(function (cb) { cb(payload); }); };
}());
