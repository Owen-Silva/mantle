/* ontop.js - the "Kept on top" pop-up's page (lane ontop, 2026-09-27). Main pushes ontop.toast
 * {text, reason, tone, did, below}; the page shows it at once, fades after HOLD_MS, and tells main
 * (ontop.faded) so the window hides. A missing bridge is said on the page itself, never silent. */
(function () {
  'use strict';
  var HOLD_MS = 1800;
  var box = document.getElementById('t');
  var text = document.getElementById('text');
  var why = document.getElementById('why');
  var timer = null, fadeTimer = null;
  var mantle = window.mantle;

  function faded() {
    box.hidden = true;
    box.classList.remove('fading');
    if (mantle && typeof mantle.call === 'function') mantle.call('ontop.faded', {}).catch(function () {});
  }

  function show(p) {
    p = p || {};
    clearTimeout(timer); clearTimeout(fadeTimer);
    text.textContent = p.text || '';
    why.textContent = p.reason || '';
    box.dataset.did = p.did || '';
    box.dataset.tone = p.tone || '';
    if (p.below) document.body.setAttribute('data-below', ''); else document.body.removeAttribute('data-below');
    box.classList.remove('fading');
    box.hidden = false;
    // a refusal or failure stays up longer: it has a reason to read
    var hold = p.reason && p.tone === 'warn' ? HOLD_MS + 1600 : HOLD_MS;
    timer = setTimeout(function () {
      box.classList.add('fading');
      fadeTimer = setTimeout(faded, 260);
    }, hold);
  }

  if (!mantle || typeof mantle.on !== 'function') {
    show({ text: 'Keep on top', reason: 'this pop-up has no bridge to Mantle (window.mantle is missing)', tone: 'warn' });
    return;
  }
  mantle.on('ontop.toast', show);
})();
