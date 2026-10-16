/* qs-tiles.js - quick settings' new tiles: Airplane mode, Do not disturb, Focus, Project, Cast (lane
 * qstiles, 2026-10-15; plan notes/mantle-replace-windows.md P8).
 *
 * WHAT IT TALKS TO: lib/features/qstiles.js (qstiles.state / .refresh / .set) and lib/features/project.js
 * (project.state / .refresh / .open / .cast). The words are _qstiles-core.js and _project-core.js, the
 * same files main uses.
 *
 * INSTANT, FROM A CACHE (P8's budget: pagePaint p95 <= 80 ms, no sidecar call before the paint): listen()
 * subscribes once when the bar loads, and main replays the last state on subscribe and pushes every
 * change, so when the panel opens attach() draws the tiles from what the bar already holds, in the
 * same frame as the rest of the panel. Only AFTER that frame does it ask main to read again.
 * A click changes the tile at once (pending), and main's reply - the state read back - decides.
 *
 * MOTION (ui/bar/qs-tiles.css): a press sinks the tile, a switch that lands springs it back past rest
 * and settles. Transitions, not keyframes, so a second click mid-motion simply retargets.
 *
 * Loaded as a plain <script> by the bar (window.MantleQsTiles) and by require() in node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleQsTiles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var C = (typeof self !== 'undefined' && self.MantleQsTilesCore) || null;
  var P = (typeof self !== 'undefined' && self.MantleProjectCore) || null;
  if (typeof module === 'object' && module.exports) {
    try { C = C || require('../../lib/features/_qstiles-core.js'); P = P || require('../../lib/features/_project-core.js'); } catch (e) { /* the page */ }
  }

  function svg(body) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  var S = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
  var GLYPH = {
    airplane: svg('<path d="M8 1.8c.6 0 1 .5 1 1.2v3.6l4.6 2.6v1.4L9 9.3v2.6l1.6 1.2v1.1L8 13.5l-2.6.7v-1.1L7 11.9V9.3l-4.6 1.3V9.2L7 6.6V3c0-.7.4-1.2 1-1.2z" ' + S + '/>'),
    dnd: svg('<path d="M4.3 11.2V7.4a3.7 3.7 0 0 1 6.2-2.7M11.7 7.4v3.8l1 1.1H5.2M6.6 13.6a1.5 1.5 0 0 0 2.8 0M2.6 2.6l10.8 10.8" ' + S + '/>'),
    focus: svg('<circle cx="8" cy="8" r="5.9" ' + S + '/><circle cx="8" cy="8" r="3" ' + S + '/><circle cx="8" cy="8" r=".9" fill="currentColor"/>'),
    project: svg('<rect x="1.5" y="3" width="8" height="6" rx="1.2" ' + S + '/><rect x="6.5" y="6.5" width="8" height="6" rx="1.2" ' + S + '/>'),
    cast: svg('<path d="M1.8 5.5V4.2c0-.8.6-1.4 1.4-1.4h9.6c.8 0 1.4.6 1.4 1.4v7.6c0 .8-.6 1.4-1.4 1.4H9.6M1.8 8.4a4.8 4.8 0 0 1 4.8 4.8M1.8 10.8a2.4 2.4 0 0 1 2.4 2.4" ' + S + '/><circle cx="2" cy="13.1" r=".7" fill="currentColor"/>'),
  };
  var NAMES = { airplane: 'Airplane mode', dnd: 'Do not disturb', focus: 'Focus', project: 'Project', cast: 'Cast' };
  var ORDER = ['airplane', 'dnd', 'focus', 'project', 'cast'];

  var held = { q: null, p: null, offs: [] };
  var live = null;                         // the open panel's tiles, or null

  /** Once, when the bar loads: keep the last state of both features (main replays it on subscribe). */
  function listen(ctx) {
    if (held.offs.length || !ctx || typeof ctx.on !== 'function') return;
    held.offs.push(ctx.on('qstiles.state', function (s) { if (s && typeof s === 'object') { held.q = s; if (live) live.paint(); } }, function () {}));
    held.offs.push(ctx.on('project.state', function (s) { if (s && typeof s === 'object') { held.p = s; if (live) live.paint(); } }, function () {}));
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function msg(e) { return String((e && e.message) || e || 'no reason given'); }
  function plain(e) {
    var m = msg(e);
    return (/sidecar|ipc|undefined|\bnull\b|timed? ?out/i.test(m) || /\bE[A-Z]{3,}\b/.test(m)) ? 'Mantle didn’t answer. Try again in a moment' : m;
  }

  /** Builds the five tiles into the panel's grid, drawn from the held state at once. -> { paint } */
  function attach(pop, grid, ctx) {
    if (!grid || !C || !P) return null;
    var me = { tiles: {}, notes: el('div', 'qsnotes qsx-notes'), note: {}, guess: null, busy: {}, alive: true, timer: null, was: {} };
    ORDER.forEach(function (k) {
      var b = el('button', 'qstile qsx'); b.type = 'button'; b.dataset.tile = k;
      var ico = el('span', 'qsico'); ico.innerHTML = GLYPH[k];
      var lbl = el('span', 'qslbl', NAMES[k]);
      var sub = el('span', 'qssub');
      b.appendChild(ico); b.appendChild(lbl); b.appendChild(sub);
      grid.appendChild(b);
      me.tiles[k] = { b: b, sub: sub };
      b.addEventListener('click', function () { click(k); });
    });
    if (grid.parentNode) grid.parentNode.insertBefore(me.notes, grid.nextSibling);
    live = me;

    function q() { return me.guess || held.q; }
    function view(k) {
      if (k === 'dnd') return C.dnd(q());
      if (k === 'airplane') return C.airplane(q());
      if (k === 'focus') return C.focus(q(), Date.now());
      if (k === 'cast') return C.cast();
      var p = held.p;
      if (p && p.on === false) return { dead: true, on: false, sub: 'Switched off', tip: 'Project: Mantle’s pop-up is switched off in the tray menu. Windows’ own is Win+P' };
      return P.tile(p);
    }

    /* A switch that lands: spring past rest and settle (a transition, so it can be interrupted). */
    function settle(b) {
      if (!b.animate || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
      b.classList.add('qsx-lift');
      requestAnimationFrame(function () { requestAnimationFrame(function () { b.classList.remove('qsx-lift'); }); });
    }

    function paint() {
      if (!me.alive) return;
      if (!document.contains(grid)) { closed(); return; }
      var qs = q() || {}, busy = {};
      (qs.busy || []).forEach(function (k) { busy[k] = true; });
      ORDER.forEach(function (k) {
        var t = me.tiles[k], v = view(k);
        t.sub.textContent = v.sub || '';
        var on = !!v.on && !v.dead;
        if (me.was[k] !== undefined && me.was[k] !== on) settle(t.b);
        me.was[k] = on;
        t.b.classList.toggle('on', on);
        t.b.classList.toggle('dead', !!v.dead);
        t.b.classList.toggle('pending', !!(me.busy[k] || busy[k]));
        t.b.title = v.tip || '';
        t.b.setAttribute('aria-pressed', String(on));
        if (v.dead) t.b.setAttribute('aria-disabled', 'true'); else t.b.removeAttribute('aria-disabled');
      });
      // one line per refusal, until that tile is clicked again; never a dead tile with no words
      me.notes.textContent = '';
      Object.keys(me.note).forEach(function (k) { me.notes.appendChild(el('div', 'note', me.note[k])); });
      me.notes.hidden = !me.notes.firstChild;
    }

    function click(k) {
      var v = view(k);
      delete me.note[k];
      if (k === 'project' || k === 'cast') {
        if (v.dead) { me.note[k] = v.tip.split('\n')[0]; paint(); return; }
        Promise.resolve().then(function () { return ctx.call(k === 'project' ? 'project.open' : 'project.cast', { via: 'tile' }); }).then(function (r) {
          if (r && r.ok === false) { me.note[k] = NAMES[k] + ': ' + (r.reason || 'it did not open'); paint(); return; }
          if (ctx.close) ctx.close();
        }, function (e) { me.note[k] = NAMES[k] + ' did not open: ' + plain(e); paint(); });
        return;
      }
      if (v.dead) { me.note[k] = v.tip.replace(/\n.*/g, ''); paint(); return; }
      if (v.reading) { me.note[k] = NAMES[k] + ' is still being read, so it cannot be switched yet'; paint(); return; }
      if (me.busy[k]) return;
      var want = !v.on;
      me.busy[k] = true;
      me.guess = C.guess(held.q, k, want);         // the tile moves in this frame; the reply decides
      paint();
      Promise.resolve().then(function () { return ctx.call('qstiles.set', { tile: k, on: want }); }).then(function (r) {
        me.busy[k] = false; me.guess = null;
        if (r && r.state) held.q = r.state;
        if (r && r.ok === false) me.note[k] = r.reason || NAMES[k] + ' did not change, and Mantle gave no reason';
        else if (r && r.reason) me.note[k] = r.reason.charAt(0).toUpperCase() + r.reason.slice(1);
        paint();
      }, function (e) {
        me.busy[k] = false; me.guess = null;
        me.note[k] = NAMES[k] + ' did not change: ' + plain(e);
        paint();
      });
    }

    function closed() {
      me.alive = false;
      if (me.timer) { clearInterval(me.timer); me.timer = null; }
      if (live === me) live = null;
    }

    paint();                                         // from the held state, in the panel's own frame
    // AFTER the paint: fresh reads (never before it), and Focus's minutes while the panel is up
    requestAnimationFrame(function () {
      setTimeout(function () {
        if (!me.alive) return;
        Promise.resolve().then(function () { return ctx.call('qstiles.refresh'); }).then(function (s) { if (s && s.dnd !== undefined) { held.q = s; paint(); } }, function () {});
        Promise.resolve().then(function () { return ctx.call('project.refresh'); }).then(function (s) { if (s && s.phase !== undefined) { held.p = s; paint(); } }, function () {});
      }, 0);
    });
    me.timer = setInterval(function () { if (q() && q().focus) paint(); else if (!document.contains(grid)) closed(); }, 20000);
    return { paint: paint, closed: closed };
  }

  return { listen: listen, attach: attach, ORDER: ORDER, NAMES: NAMES, _held: held };
}));
