/* welcome.js - the three first-start cards (lane mantle-firstrun, 2026-10-15). lib/welcome.js decides
 * whether this page is shown at all; this page shows the cards and answers welcome.done.
 *
 * Keys: Right arrow / Enter = Next, Left arrow = Back, Esc = Skip, Tab moves through every control.
 * The last card's button finishes. Every way out is recorded by main (finished or skipped); if the
 * record fails the reason shows here and the card stays.
 * Tests: <html data-ready="1" data-step="<id>"> once drawn; window.__welcome exposes the state.
 */
(function () {
  'use strict';
  var C = window.MantleWelcomeContent;
  var M = window.mantle;
  var $ = function (id) { return document.getElementById(id); };
  var el = { card: $('card'), steps: $('steps'), stage: $('stage'), back: $('back'), next: $('next'), skip: $('skip'), count: $('count'), chip: $('testchip') };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var OUT_MS = REDUCED ? 0 : 140;
  var S = { i: 0, leaving: false, corners: null, restore: 'idle', restoreWhy: '', error: '' };
  window.__welcome = S;

  function plain(e) {
    var m = e && e.message ? e.message : String(e || 'no reason came back');
    try { return window.MantlePlain && window.MantlePlain.plain ? window.MantlePlain.plain(m) : m; } catch (_) { return m; }
  }
  function call(name, args) {
    if (!M || typeof M.call !== 'function') return Promise.reject(new Error('this page is not connected to Mantle'));
    return M.call(name, args || {});
  }

  /* ---- tiny DOM helpers (no innerHTML: every word is set as text) ---- */
  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (attrs[k] == null || attrs[k] === false) continue; if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); }
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  function add(n, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(n, k); }); return; }
    n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  var NS = 'http://www.w3.org/2000/svg';
  function svg(w, hgt, parts) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + hgt); s.setAttribute('width', w); s.setAttribute('height', hgt);
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    parts.forEach(function (p) {
      var e = document.createElementNS(NS, p[0]);
      for (var k in p[1]) e.setAttribute(k, p[1][k]);
      s.appendChild(e);
    });
    return s;
  }
  function keycaps(keys) { return h('span', { class: 'keys' }, keys.map(function (k) { return h('kbd', { class: 'kc', text: k }); })); }

  /* the little screens: a display outline with the part each item is about drawn in the accent */
  var SCREEN = ['rect', { class: 'scr', x: 1.5, y: 1.5, width: 37, height: 27, rx: 4 }];
  var ICONS = {
    bar: [SCREEN, ['rect', { class: 'hot', x: 11, y: 21.5, width: 18, height: 4, rx: 2 }]],
    top: [SCREEN, ['rect', { class: 'hot', x: 4.5, y: 4.5, width: 31, height: 3, rx: 1.5 }]],
    launcher: [SCREEN, ['rect', { class: 'hot-line', x: 10.5, y: 9.5, width: 19, height: 11, rx: 3 }], ['rect', { class: 'hot', x: 13, y: 12, width: 9, height: 2, rx: 1 }]],
  };

  /* ---- the cards ---- */
  function cardChanged(c) {
    return [
      h('h1', { class: 'title', id: 'title', text: c.title }),
      h('p', { class: 'lead', id: 'lead', text: c.lead }),
      h('ul', { class: 'items' }, c.items.map(function (it) {
        return h('li', { class: 'item', 'data-k': it.icon },
          h('span', { class: 'pic' }, svg(40, 30, ICONS[it.icon] || [SCREEN])),
          h('span', { class: 'itext' }, h('span', { class: 'iname', text: it.name }), h('span', { class: 'idesc', text: it.text })));
      })),
    ];
  }

  function cornerView(k) {
    var live = S.corners && S.corners.actions ? S.corners.actions : null;
    return { actions: live || k.actions, off: !!(S.corners && S.corners.enabled === false), live: !!live };
  }
  function cornersBlock(k) {
    var v = cornerView(k);
    var on = ['tl', 'tr', 'bl', 'br'].filter(function (c) { return v.actions[c] && v.actions[c] !== 'off'; });
    var spots = { tl: [6, 6], tr: [82, 6], bl: [6, 50], br: [82, 50] };
    var parts = [['rect', { class: 'scr', x: 1.5, y: 1.5, width: 85, height: 53, rx: 6 }]];
    if (!v.off) on.forEach(function (c) { parts.push(['circle', { class: 'hot', cx: spots[c][0], cy: spots[c][1], r: 3.5 }]); });
    var lines = v.off || !on.length
      ? [h('li', { class: 'cline off', 'data-k': 'off', text: k.off })]
      : on.map(function (c) {
        return h('li', { class: 'cline', 'data-k': c }, h('span', { class: 'cname', text: k.names[c] + ':' }), h('span', { class: 'cact', text: k.labels[v.actions[c]] || v.actions[c] }));
      });
    return h('div', { class: 'corners', 'data-live': v.live ? '1' : '0' },
      h('span', { class: 'cpic' }, svg(88, 56, parts)),
      h('div', { class: 'ctext' },
        h('div', { class: 'csub', text: k.title }),
        h('ul', { class: 'clist' }, lines),
        v.off || !on.length ? null : h('div', { class: 'chow', text: k.how })));
  }
  function cardKeys(c) {
    return [
      h('h1', { class: 'title', id: 'title', text: c.title }),
      h('ul', { class: 'keylist', id: 'lead' }, c.keys.map(function (k) {
        return h('li', { class: 'krow', 'data-k': k.keys.join('+') },
          keycaps(k.keys),
          h('span', { class: 'kwhat' }, h('span', { class: 'kname', text: k.what }), k.note ? h('span', { class: 'knote', text: k.note }) : null));
      })),
      cornersBlock(c.corners),
      h('p', { class: 'fine', text: c.foot }),
    ];
  }

  function restoreCtl(c) {
    var r = c.restore;
    if (S.restore === 'done') return h('p', { class: 'status ok', role: 'status', text: r.done });
    var b = h('button', { class: 'btn small', type: 'button', 'data-act': 'restore', text: S.restore === 'busy' ? r.busy : r.label, disabled: S.restore === 'busy' ? 'disabled' : null });
    return [b, S.restore === 'failed' ? h('p', { class: 'status warn', role: 'alert', text: r.failed + S.restoreWhy }) : null];
  }
  function cardBack(c) {
    return [
      h('h1', { class: 'title', id: 'title', text: c.title }),
      h('p', { class: 'lead', id: 'lead', text: c.lead }),
      h('ol', { class: 'ways' }, c.ways.map(function (w, i) {
        return h('li', { class: 'way', 'data-k': w.action || ('way' + i) },
          h('span', { class: 'wnum', text: String(i + 1) }),
          h('div', { class: 'wbody' },
            h('div', { class: 'wname', text: w.name }),
            h('p', { class: 'wtext' }, w.text, w.keys ? [' ', keycaps(w.keys), ' ', w.after || ''] : null,
              w.code ? [' ', h('code', { class: 'code', text: w.code }), ' ', w.after || ''] : null),
            w.action === 'restore' ? h('div', { class: 'wact' }, restoreCtl(c)) : null));
      })),
    ];
  }
  var BUILD = { changed: cardChanged, keys: cardKeys, back: cardBack };

  /* ---- drawing ---- */
  function drawSteps() {
    el.steps.textContent = '';
    C.cards.forEach(function (c, i) {
      var st = i === S.i ? 'now' : i < S.i ? 'done' : 'todo';
      el.steps.appendChild(h('button', { class: 'step ' + st, type: 'button', 'data-act': 'step', 'data-i': String(i),
        'aria-label': 'Step ' + (i + 1) + ' of ' + C.cards.length + ': ' + c.step, 'aria-current': i === S.i ? 'step' : null, title: c.step },
      h('span', { class: 'tick' })));
    });
  }
  function draw(dir) {
    var c = C.cards[S.i];
    var last = S.i === C.cards.length - 1;
    var panel = h('div', { class: 'panel' + (dir ? ' in-' + dir : ''), 'data-card': c.id }, BUILD[c.id](c));
    el.stage.textContent = '';
    el.stage.appendChild(panel);
    drawSteps();
    el.count.textContent = c.step;
    el.back.style.visibility = S.i === 0 ? 'hidden' : '';
    el.back.disabled = S.i === 0;
    el.next.textContent = last ? C.buttons.finish : C.buttons.next;
    el.next.title = last ? 'Start using Mantle (Enter)' : 'Next (Right arrow or Enter)';
    el.next.classList.toggle('finish', last);
    if (S.error) el.stage.appendChild(h('p', { class: 'status warn saveerr', role: 'alert', text: S.error }));
    document.documentElement.setAttribute('data-step', c.id);
  }
  function go(i, from) {
    if (S.leaving || i < 0 || i >= C.cards.length || i === S.i) return;
    var dir = i > S.i ? 'fwd' : 'back';
    S.i = i;
    S.error = '';
    draw(REDUCED ? null : dir);
    var f = from === 'step' ? el.steps.querySelector('[data-i="' + i + '"]') : el.next;
    if (f) f.focus({ preventScroll: true });
  }

  function leave(how) {
    if (S.leaving) return;
    S.leaving = true;
    el.card.classList.add('out');
    setTimeout(function () {
      call('welcome.done', { how: how }).then(function (r) {
        if (r && r.ok === false) fail(r.reason || 'Mantle gave no reason');
        // ok: main closes the window
      }, function (e) { fail(plain(e)); });
    }, OUT_MS);
  }
  function fail(why) {
    S.leaving = false;
    el.card.classList.remove('out');
    S.error = 'That could not be saved: ' + why + '. The welcome may show again next time.';
    draw(null);
    el.next.focus({ preventScroll: true });
  }

  function restore() {
    if (S.restore === 'busy' || S.restore === 'done') return;
    S.restore = 'busy';
    draw(null);
    call('shell.restore').then(function () { S.restore = 'done'; S.restoreWhy = ''; draw(null); el.next.focus({ preventScroll: true }); },
      function (e) { S.restore = 'failed'; S.restoreWhy = plain(e); draw(null); var b = el.stage.querySelector('[data-act="restore"]'); if (b) b.focus({ preventScroll: true }); });
  }

  /* ---- input ---- */
  var ACT = {
    next: function () { if (S.i === C.cards.length - 1) leave('finished'); else go(S.i + 1, 'next'); },
    back: function () { go(S.i - 1, 'back'); },
    skip: function () { leave('skipped'); },
    step: function (t) { go(+t.getAttribute('data-i'), 'step'); },
    restore: restore,
  };
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || t.disabled || S.leaving) return;
    var f = ACT[t.getAttribute('data-act')];
    if (f) f(t);
  });
  // the focus ring waits for the keyboard: Next has focus from the start (Enter works at once), but a
  // ring on the first look at a window nobody has typed into yet is noise
  document.addEventListener('keydown', function () { document.body.classList.add('kb'); }, true);
  document.addEventListener('mousedown', function () { document.body.classList.remove('kb'); }, true);
  document.addEventListener('keydown', function (e) {
    if (S.leaving || e.altKey || e.ctrlKey || e.metaKey) return;
    var onButton = e.target && e.target.tagName === 'BUTTON';
    if (e.key === 'Escape') { e.preventDefault(); leave('skipped'); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); if (S.i < C.cards.length - 1) go(S.i + 1, 'next'); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(S.i - 1, 'back'); }
    else if (e.key === 'Enter' && !onButton) { e.preventDefault(); ACT.next(); }
  });

  /* ---- start ---- */
  draw(null);
  el.next.focus({ preventScroll: true });   // before data-ready: Enter works from the first frame
  document.documentElement.setAttribute('data-ready', '1');
  requestAnimationFrame(function () { el.card.classList.add('in'); });
  call('welcome.state').then(function (r) { if (r && r.test) el.chip.hidden = false; }, function () { /* the cards need nothing from it */ });
  // the corners this PC really has (a changed or switched-off corner shows as it is)
  call('corners.state').then(function (r) {
    if (!r || typeof r !== 'object' || !r.actions) return;
    S.corners = { actions: r.actions, enabled: r.enabled !== false };
    if (C.cards[S.i].id === 'keys') {
      var old = el.stage.querySelector('.corners');
      if (old) old.replaceWith(cornersBlock(C.cards[S.i].corners));
    }
  }, function () { /* not running yet: the defaults stand, which is what a new profile has */ });
})();
