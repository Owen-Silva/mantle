/* layouts.js - the window layouts pop-up's page (lane layouts, 2026-09-27). Main pushes
 * layouts.toast {text, lines[], tone, below, undo}; the page shows it at once, holds it longer when
 * there are reasons to read, fades, and tells main (layouts.faded) so the window hides. A missing
 * bridge is said on the page itself, never silent.
 * UNDO (lane windows-layouts, 2026-09-29): a restore that moved windows shows an Undo button. The
 * window lets clicks through; with the pointer on the pill the page asks main to take clicks
 * (layouts.pointer {over}) and holds the pop-up; Undo calls layouts.undo once (pressed + "Undoing…"),
 * and main answers with a new pop-up. */
(function () {
  'use strict';
  var HOLD_MS = 2600, PER_LINE_MS = 1400, UNDO_HOLD_MS = 6000;
  var box = document.getElementById('t');
  var text = document.getElementById('text');
  var lines = document.getElementById('lines');
  var undo = document.getElementById('undo');
  var timer = null, fadeTimer = null, hold = 0, over = false;
  var mantle = window.mantle;
  var call = function (name, args) {
    try { return mantle && typeof mantle.call === 'function' ? Promise.resolve(mantle.call(name, args)) : Promise.resolve(null); } catch (e) { return Promise.resolve(null); }
  };

  function faded() {
    box.hidden = true;
    box.classList.remove('fading');
    if (over) { over = false; call('layouts.pointer', { over: false }).catch(function () {}); }
    call('layouts.faded', {}).catch(function () {});
  }

  function arm() {
    clearTimeout(timer); clearTimeout(fadeTimer);
    timer = setTimeout(function () {
      box.classList.add('fading');
      fadeTimer = setTimeout(faded, 260);
    }, hold);
  }

  function show(p) {
    p = p || {};
    text.textContent = p.text || '';
    lines.textContent = '';
    var all = p.lines || [];
    var list = all.slice(0, 4);
    if (all.length > 4) list.push('and ' + (all.length - 4) + ' more');
    list.forEach(function (l) {
      var d = document.createElement('span');
      d.className = 'line';
      d.textContent = l;
      d.title = l;
      lines.appendChild(d);
    });
    box.dataset.tone = p.tone || '';
    if (p.below) document.body.setAttribute('data-below', ''); else document.body.removeAttribute('data-below');
    undo.hidden = !p.undo;
    undo.disabled = false;
    undo.textContent = 'Undo';
    box.classList.remove('fading');
    box.hidden = false;
    hold = HOLD_MS + PER_LINE_MS * list.length + (p.undo ? UNDO_HOLD_MS : 0);
    if (!over) arm();
  }

  // the pointer on the pill: take clicks (only when Undo shows) and hold the pop-up while it is there
  box.addEventListener('mouseenter', function () {
    if (undo.hidden) return;
    over = true;
    clearTimeout(timer); clearTimeout(fadeTimer);
    box.classList.remove('fading');
    call('layouts.pointer', { over: true }).catch(function () {});
  });
  box.addEventListener('mouseleave', function () {
    if (!over) return;
    over = false;
    call('layouts.pointer', { over: false }).catch(function () {});
    hold = 2000;
    arm();
  });
  undo.addEventListener('click', function () {
    if (undo.disabled) return;   // one undo per click, never two
    undo.disabled = true;
    undo.textContent = 'Undoing…';
    // main shows the outcome as a new pop-up. A refusal is said here (Undo goes: main said why it
    // cannot); no answer at all keeps Undo, so the next step is simply to press it again.
    var below = document.body.hasAttribute('data-below');
    var noAnswer = function () {
      show({ text: 'Not undone', lines: ['Mantle did not answer. Press Undo to try again.'], tone: 'warn', below: below, undo: true });
    };
    call('layouts.undo', {}).then(function (r) {
      if (!r) { noAnswer(); return; }
      if (r.ok === false) show({ text: 'Not undone', lines: [r.reason || 'Mantle did not say why'], tone: 'warn', below: below });
    }, noAnswer);
  });

  if (!mantle || typeof mantle.on !== 'function') {
    show({ text: 'Window layouts', lines: ['this pop-up could not connect to Mantle: restart Mantle to fix it'], tone: 'warn' });
    return;
  }
  // dark: one picture of what is behind this pop-up per show (ui/shared/hud-backdrop.js)
  mantle.on('layouts.toast', function (p) { show(p); if (window.MantleHudBackdrop) window.MantleHudBackdrop.request('shown', { hold: true }); });
})();
