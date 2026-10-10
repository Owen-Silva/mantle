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
    // a reason (refusal / failure) wins; else a quiet hint ("Win+Ctrl+T again to stop")
    why.textContent = p.reason || p.hint || '';
    if (!p.reason && p.hint) why.classList.add('hint'); else why.classList.remove('hint');    box.dataset.did = p.did || '';
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
    show({ text: 'Keep on top', reason: 'this pop-up could not connect to Mantle: restart Mantle to fix it', tone: 'warn' });
    return;
  }
  // dark: one picture of what is behind this pop-up per show (ui/shared/hud-backdrop.js)
  mantle.on('ontop.toast', function (p) { show(p); if (window.MantleHudBackdrop) window.MantleHudBackdrop.request('shown', { hold: true }); });
})();
