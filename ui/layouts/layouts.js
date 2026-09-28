/* layouts.js - the window layouts pop-up's page (lane layouts, 2026-09-27). Main pushes
 * layouts.toast {text, lines[], tone, below}; the page shows it at once, holds it longer when there
 * are reasons to read, fades, and tells main (layouts.faded) so the window hides. A missing bridge
 * is said on the page itself, never silent. */
(function () {
  'use strict';
  var HOLD_MS = 2600, PER_LINE_MS = 1400;
  var box = document.getElementById('t');
  var text = document.getElementById('text');
  var lines = document.getElementById('lines');
  var timer = null, fadeTimer = null;
  var mantle = window.mantle;

  function faded() {
    box.hidden = true;
    box.classList.remove('fading');
    if (mantle && typeof mantle.call === 'function') mantle.call('layouts.faded', {}).catch(function () {});
  }

  function show(p) {
    p = p || {};
    clearTimeout(timer); clearTimeout(fadeTimer);
    text.textContent = p.text || '';
    lines.textContent = '';
    var list = (p.lines || []).slice(0, 4);
    if ((p.lines || []).length > 4) list.push('and ' + (p.lines.length - 4) + ' more (Mantle\'s log has them all)');
    list.forEach(function (l) {
      var d = document.createElement('span');
      d.className = 'line';
      d.textContent = l;
      lines.appendChild(d);
    });
    box.dataset.tone = p.tone || '';
    if (p.below) document.body.setAttribute('data-below', ''); else document.body.removeAttribute('data-below');
    box.classList.remove('fading');
    box.hidden = false;
    timer = setTimeout(function () {
      box.classList.add('fading');
      fadeTimer = setTimeout(faded, 260);
    }, HOLD_MS + PER_LINE_MS * list.length);
  }

  if (!mantle || typeof mantle.on !== 'function') {
    show({ text: 'Window layouts', lines: ['this pop-up has no bridge to Mantle (window.mantle is missing)'], tone: 'warn' });
    return;
  }
  mantle.on('layouts.toast', show);
})();
