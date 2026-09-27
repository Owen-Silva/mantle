/* topbarhide.js - the Top bar row in the quick-settings panel (lane tbvideo, 2026-09-26).
 *
 * Owen: "make a way that i can manually hide it". The top bar hides from its own Mantle menu or with
 * Win+Alt+T, and then it is gone from the screen, so THIS row is where "hidden" is said and undone:
 * "Hidden · point at the top to peek" with a Show top bar button and a line naming Win+Alt+T (lane tbpeek:
 * resting the cursor on the top edge peeks at the bar without un-hiding it; a watch that cannot work
 * gets its own warning line with the reason). While it shows, the button hides it.
 *
 * WHAT IT TALKS TO (lib/features/topbar.js):
 *   topbar.state          -> {hidden, chord, enabled, visible, stepAside, kind, signal, video:{app,how}, test,
 *                             peek:{ok, reason, watching, shown}}
 *   topbar.hidden {on}    -> the same state, after hiding / showing
 *   'topbar.state' push   -> whenever it changes (hidden, shown, a video or game taking the screen)
 * A top bar that is resting while a game runs, or switched off in the tray, answers with its reason,
 * and the row says it (No Silent Failures).
 *
 * Loaded as a plain <script> by the bar (window.MantleTopbarHide) and by require() in node (`view` is pure). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleTopbarHide = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** PURE: the state -> what the row shows. */
  function view(st) {
    var chord = (st && st.chord) || 'Win+Alt+T';
    var v = { dead: false, hidden: false, sub: '', label: 'Hide top bar', title: '', why: '', warn: false };
    // Resting while a game runs is Mantle's design, not a fault: said plainly, not as a warning.
    if (st && st.error && /resting while/i.test(st.error)) {
      v.dead = true; v.sub = 'Resting · a game runs'; v.why = st.error;
      return v;
    }
    if (!st || st.error) {
      v.warn = true;
      v.dead = true; v.sub = 'Unavailable';
      v.why = 'The top bar did not answer' + (st && st.error ? ': ' + st.error : '');
      return v;
    }
    v.hidden = !!st.hidden;
    if (st.enabled === false) {
      v.dead = !v.hidden;   // hidden and switched off: showing it is still remembered for when it is on
      v.sub = v.hidden ? 'Hidden · switched off in the tray' : 'Switched off in the tray';
      v.why = "The top bar is switched off in Mantle's tray menu"; v.warn = true;
      if (v.hidden) { v.label = 'Show top bar'; v.title = 'Show the top bar again when it is switched on'; }
      return v;
    }
    if (v.hidden) {
      v.label = 'Show top bar';
      v.title = 'Show the top bar again and give it back its strip at the top of the screen (' + chord + ')';
      // PEEK (lane tbpeek): hidden by hand, resting the cursor on the top edge brings it out for a look.
      // A watch that cannot work says so, with its reason, instead of the peek quietly never coming.
      var pk = st.peek || null;
      if (pk && pk.ok === false) {
        v.sub = 'Hidden · ' + chord + ' to show';
        v.why = 'Pointing at the top edge cannot peek at it: ' + (pk.reason || 'no reason came back');
        v.warn = true;
      } else {
        // the sub is one ellipsised line (~36 characters fit), so the way back for good gets its own line
        v.sub = 'Hidden · point at the top to peek';
        v.why = 'Resting the pointer on the top edge peeks at it; ' + chord + ' or Show top bar brings it back for good.';
      }
      return v;
    }
    v.title = 'Hide the top bar; maximised windows get the whole screen (' + chord + ' shows it again)';
    if (st.stepAside && st.kind === 'video') v.sub = 'Aside · ' + ((st.video && st.video.app) || 'a video') + ' full screen';
    else if (st.stepAside && (st.kind === 'game' || st.kind === 'run')) v.sub = 'Aside · a game';
    else if (st.stepAside && st.kind === 'lock') v.sub = 'Aside · locked';
    else v.sub = 'Shown · ' + chord + ' hides it';
    if (st.stepAside && st.signal) v.why = st.signal;
    return v;
  }

  var S = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function attach(parent, ctx, before) {
    closed();
    var me = S = { alive: true, st: null, off: null, note: null, busy: false, v: null };
    var row = el('div', 'tbrow');
    var head = el('div', 'qsrowhead');
    head.appendChild(el('span', null, 'Top bar'));
    var sub = el('span', 'qsval tbsub');
    head.appendChild(sub);
    var btn = el('button', 'tbbtn'); btn.type = 'button';
    var why = el('div', 'tbwhy'); why.hidden = true;
    row.appendChild(head); row.appendChild(btn); row.appendChild(why);
    if (before && before.parentNode === parent) parent.insertBefore(row, before); else parent.appendChild(row);

    function paint() {
      if (!me.alive) return;
      var v = me.v = view(me.st);
      row.classList.toggle('dead', v.dead);
      row.classList.toggle('hidden-by-hand', v.hidden);
      sub.textContent = v.sub; sub.title = v.sub;
      btn.textContent = me.busy ? (v.hidden ? 'Showing…' : 'Hiding…') : v.label;
      btn.title = v.title;
      btn.disabled = v.dead || me.busy;
      btn.classList.toggle('on', v.hidden);
      btn.setAttribute('aria-pressed', v.hidden ? 'true' : 'false');
      var words = [me.note, v.why].filter(Boolean).join('. ');
      why.hidden = !words; why.textContent = words; why.classList.toggle('warn', !!me.note || v.warn);
    }
    function take(st) { if (!me.alive || !st) return; me.st = st; paint(); }

    btn.addEventListener('click', function () {
      if (!me.v || me.v.dead || me.busy) return;
      var want = !me.v.hidden;
      me.busy = true; me.note = null; paint();
      Promise.resolve().then(function () { return ctx.call('topbar.hidden', { on: want, via: 'quick settings' }); }).then(function (st) {
        me.busy = false;
        me.note = st && st.ok === false ? 'The top bar could not be ' + (want ? 'hidden' : 'shown') + ': ' + (st.reason || st.error || 'no reason came back') : null;
        if (st && st.ok !== false) take(st); else paint();
      }, function (e) {
        me.busy = false;
        me.note = 'The top bar could not be ' + (want ? 'hidden' : 'shown') + ': ' + (e && e.message || e);
        paint();
      });
    });

    if (ctx.on) me.off = ctx.on('topbar.state', take, function () { /* read on open covers it */ });
    paint();
    Promise.resolve().then(function () { return ctx.call('topbar.state'); }).then(take, function (e) { take({ error: e && e.message || String(e) }); });
    return { repaint: paint };
  }

  function closed() {
    if (!S) return;
    S.alive = false;
    if (typeof S.off === 'function') { try { S.off(); } catch (e) { /* gone */ } }
    S = null;
  }

  return { view: view, attach: attach, closed: closed };
}));
