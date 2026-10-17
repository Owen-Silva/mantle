/* card-mock.js - main, played for the card page in a plain browser (ui/screenshot/shoot.js). Defines
 * window.mantle ONLY when it is absent; under Electron the real preload wins.
 *
 *   ?state=copied | auto | nosave | nocopy | neither   what happened to the capture
 *          (copied: the default since lane shot-save - copied, NOT saved, Save offered;
 *           auto: "Also save every screenshot automatically" on, saved and copied;
 *           nosave: saving automatically failed; nocopy: the clipboard refused, Save offered;
 *           neither: both failed)
 *          text | notext | textfail            what happened to a Copy text capture
 *   ?life=0                                   never time out (for a still screenshot)
 *   ?openfail=1                               opening the file fails (the card must stay and say why)
 *   ?savefail=1                               the card's Save fails (the card must stay, say why, offer it again)
 *   ?saveslow=<ms>                            the card's Save takes this long (the "Saving..." state)
 */
(function () {
  'use strict';
  if (window.mantle) return;
  var q = new URLSearchParams(location.search);
  var listeners = {};
  var mock = window.__mock = { calls: [] };
  var SAVED = { name: 'Screenshot 2026-09-24 143005.png', folderName: 'Screenshots', w: 1280, h: 720,
    path: 'C:\\Users\\user\\Pictures\\Screenshots\\Screenshot 2026-09-24 143005.png' };
  window.mantle = {
    call: function (name, args) {
      mock.calls.push({ name: name, args: args });
      // hud.backdrop (dark): main.js hudBackdrop answers { ok: true } only AFTER it has sent the picture as
      // <key>.backdrop; with no picture it answers { ok: false, reason }. The mock takes no picture, so it says
      // that. (A bare { ok: true } with no picture after it kept hud-backdrop.js's one request "in flight" for
      // good: its timeout is cleared on the answer, so every later request, the glide's reshoot too, was folded
      // into it and never reached main: card.page.test.js 48/1, lane mantle-corner-follow2.)
      if (name === 'hud.backdrop') return Promise.resolve({ ok: false, reason: 'the card mock takes no picture' });
      // ?openfail=1: main could not open the file (main sends the reason in plain words)
      if (name === 'screenshot.cardOpen' && q.get('openfail') === '1') return Promise.resolve({ ok: false, reason: 'Windows has no app set to open PNG pictures' });
      if (name === 'screenshot.cardSave') {
        var r = q.get('savefail') === '1'
          ? { ok: false, reason: 'Windows did not let Mantle save there: pick another folder in Mantle Settings > Screenshots' }
          : Object.assign({ ok: true, url: thumb() }, SAVED);
        var ms = Number(q.get('saveslow')) || 0;
        return new Promise(function (res) { setTimeout(function () { res(r); }, ms); });
      }
      return Promise.resolve({ ok: true });
    },
    on: function (name, cb) { (listeners[name] = listeners[name] || []).push(cb); return function () {}; },
    pathForFile: function () { return ''; },
  };
  var cached = null;
  function thumb() {
    if (cached) return cached;
    var c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    var g = c.getContext('2d');
    var bg = g.createLinearGradient(0, 0, 1280, 720);
    bg.addColorStop(0, '#9CC3E6'); bg.addColorStop(1, '#F1D6C4');
    g.fillStyle = bg; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#fff'; g.fillRect(160, 100, 800, 520);
    g.fillStyle = '#ECEEF3'; g.fillRect(160, 100, 800, 64);
    g.fillStyle = 'rgba(51,58,78,.28)';
    for (var y = 210; y < 590; y += 40) g.fillRect(200, y, 320 + (y * 7) % 360, 16);
    cached = c.toDataURL('image/png');
    return cached;
  }
  /** The frame's pieces main would send (thumbPieces): here one "monitor" picture, cut whole. */
  function pieces() { return { w: 1280, h: 720, pieces: [{ url: thumb(), sx: 0, sy: 0, sw: 1280, sh: 720, dx: 0, dy: 0 }] }; }
  window.addEventListener('load', function () {
    var st = q.get('state') || 'copied';
    var life = q.get('life') === '0' ? 1e9 : 7000;
    var saved = st === 'auto';
    var info = {
      seq: 3, w: 1280, h: 720, thumb: pieces(), lifeMs: life,
      copied: st === 'copied' || st === 'auto' || st === 'nosave',
      canSave: !saved,
      saveError: st === 'nosave' || st === 'neither' ? 'Windows did not let Mantle save there: pick another folder in Mantle Settings > Screenshots' : null,
      copyError: st === 'nocopy' || st === 'neither' ? 'another app was using the clipboard: take it again' : null,
    };
    if (saved) Object.assign(info, SAVED, { url: thumb() });
    // The Copy text card (states text | notext | textfail). The preview is made-up sample text.
    if (st === 'text') info = { seq: 3, kind: 'text', copied: true, lifeMs: life, text: { lines: 3, chars: 146, headline: 'Copied 3 lines', preview: 'Question 7: A train leaves the station at…' } };
    if (st === 'notext') info = { seq: 3, kind: 'text', copied: false, lifeMs: life, text: { lines: 0, chars: 0 } };
    if (st === 'textfail') info = { seq: 3, kind: 'text', copied: false, lifeMs: life, textError: 'Windows has no text recognition installed: add a language in Windows Settings > Time & language > Language & region' };
    (listeners['screenshot.card'] || []).forEach(function (cb) { cb(info); });
  });
  // shoot.js: push another card into the same page (one card window serves every capture).
  window.__cardEmit = function (name, payload) { (listeners[name] || []).forEach(function (cb) { cb(payload); }); };
  window.__mockPieces = pieces;
}());
