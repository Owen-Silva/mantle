/* powermode.js - the Power mode switch in the quick-settings panel: Best power efficiency /
 * Balanced / Best performance (osd lane, wave 3, 2026-09-24).
 *
 * WHAT IT TALKS TO (lib/features/powermode.js over sidecar/PowerMode.cs):
 *   powermode.get                -> the state: {ok, mode, available, plan:{name, balanced}, source, reason}
 *   powermode.set {mode}         -> {ok, mode, state (READ BACK), reason}
 *   'powermode' push             -> the state, whenever Windows reports a change (Settings, a plan
 *                                   switch, plugging in); the panel re-reads every 3 s as a backstop
 *
 * THE PANEL'S OPTIMISTIC PATTERN (bar.js qsSet): a click moves the selection in the same frame and
 * marks it pending; the reply - the mode read back from Windows - has the last word; a refusal
 * springs back and its reason is written under the control. Only on the Balanced plan does
 * Windows apply a power mode, so on any other plan the control is drawn muted with that reason
 * (Owen's machine, 2026-09-24: "Hone Ultimate Power Plan V5", so muted is what he sees today).
 *
 * KEYBOARD: the three segments are a radiogroup - Left/Right (Up/Down) move and apply, Home/End
 * jump, Enter/Space apply the focused one.
 *
 * Loaded as a plain <script> by the bar (window.MantlePowerMode) and by require() in node
 * (ui/bar/powermode.test.js tests the pure half, `view`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantlePowerMode = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = [
    { mode: 'efficiency', label: 'Efficiency', full: 'Best power efficiency' },
    { mode: 'balanced', label: 'Balanced', full: 'Balanced' },
    { mode: 'performance', label: 'Performance', full: 'Best performance' },
  ];
  var POLL_MS = 3000;

  function fullName(mode) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].mode === mode) return MODES[i].full;
    if (mode === 'better') return 'Better performance (a Windows 10 setting)';
    return mode ? 'an unrecognised mode' : 'unknown';
  }
  function sentence(s) { s = String(s || ''); return /[.!?…]$/.test(s) ? s : s + '.'; }

  /* THE PURE HALF: what to draw from (state, the click in flight, the last refusal). */
  function view(state, pending, err) {
    var s = state || null;
    var ok = !!s && s.ok !== false;
    var live = ok && s.available !== false;
    var shown = pending || (ok ? s.mode : null);
    var sub, reason = null;
    if (!s) { sub = 'Reading…'; }
    else if (!ok) { sub = 'Unavailable'; reason = s.reason || 'the power mode could not be read, and no reason was given'; }
    else if (!live) {
      sub = 'Needs the Balanced plan';
      reason = s.reason || 'Windows applies a power mode only on the Balanced power plan';
    } else {
      sub = (s.source === 'battery' ? 'On battery' : s.source === 'ac' ? 'Plugged in' : 'Power source unknown') +
        (s.saver ? ' · Energy saver on' : '');
    }
    var segs = MODES.map(function (m) {
      return {
        mode: m.mode, label: m.label,
        on: shown === m.mode,
        pending: pending === m.mode,
        disabled: !live,
        title: live ? m.full + (shown === m.mode ? ' (current)' : '') : m.full + ' — ' + sentence(reason),
      };
    });
    var other = ok && live && !pending && MODES.every(function (m) { return m.mode !== s.mode; });
    return {
      dead: !live, sub: sub, reason: reason,
      note: err ? sentence('Power mode did not change: ' + err) : other ? sentence('Windows reports ' + fullName(s.mode) + '; pick one to replace it') : null,
      segs: segs,
      aria: live ? 'Power mode: ' + fullName(shown) : 'Power mode unavailable: ' + reason,
    };
  }

  /* THE DOM HALF, attached by bar.js buildQsPop. ctx: { call, on } (the bar's bridge helpers). */
  var S = null;

  function attach(parent, ctx, before) {
    closed();
    var row = document.createElement('div'); row.className = 'pmrow';
    var head = document.createElement('div'); head.className = 'qsrowhead';
    var name = document.createElement('span'); name.textContent = 'Power mode';
    var sub = document.createElement('span'); sub.className = 'qsval pmsub';
    head.appendChild(name); head.appendChild(sub);
    var group = document.createElement('div'); group.className = 'pmseg';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Power mode');
    var btns = MODES.map(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'pmbtn'; b.dataset.mode = m.mode;
      b.setAttribute('role', 'radio');
      b.textContent = m.label;
      group.appendChild(b);
      return b;
    });
    var why = document.createElement('div'); why.className = 'pmwhy'; why.hidden = true;
    var note = document.createElement('div'); note.className = 'pmnote'; note.hidden = true;
    row.appendChild(head); row.appendChild(group); row.appendChild(why); row.appendChild(note);
    if (before && before.parentNode === parent) parent.insertBefore(row, before); else parent.appendChild(row);

    var me = S = { row: row, state: null, pending: null, err: null, seq: 0, timer: 0, off: null, ctx: ctx, alive: true };

    function paint() {
      if (!me.alive) return;
      var v = view(me.state, me.pending, me.err);
      row.classList.toggle('dead', v.dead);
      row.title = v.dead && v.reason ? 'Power mode — ' + sentence(v.reason) : '';
      sub.textContent = v.sub;
      group.setAttribute('aria-label', v.aria);
      var focusable = null;
      v.segs.forEach(function (sg, i) {
        var b = btns[i];
        b.classList.toggle('on', sg.on);
        b.classList.toggle('pending', sg.pending);
        b.setAttribute('aria-checked', String(sg.on));
        b.setAttribute('aria-disabled', String(sg.disabled));
        b.title = sg.title;
        if (sg.on) focusable = b;
      });
      btns.forEach(function (b) { b.tabIndex = b === (focusable || btns[1]) ? 0 : -1; });
      why.textContent = v.dead && v.reason ? sentence(v.reason) : '';
      why.hidden = !(v.dead && v.reason);
      note.textContent = v.note || '';
      note.hidden = !v.note;
    }

    function take(state) {
      if (!me.alive || !state || typeof state !== 'object') return;
      if (me.pending) return;                     // the click in flight is newer than any push
      me.state = state;
      paint();
    }

    function read() {
      var seq = me.seq;
      return Promise.resolve().then(function () { return ctx.call('powermode.get'); }).then(function (r) {
        if (seq === me.seq) take(r || { ok: false, reason: 'powermode.get answered with nothing' });
      }, function (e) {
        if (seq === me.seq && !me.pending) { me.state = { ok: false, reason: 'the power mode could not be asked for: ' + (e && e.message ? e.message : String(e)) }; paint(); }
      });
    }

    function set(mode) {
      if (!me.state || me.state.ok === false || me.state.available === false) { paint(); return; }
      if (me.pending) return;
      if (me.state.mode === mode) { me.err = null; paint(); return; }
      var was = me.state;
      me.pending = mode;
      me.err = null;
      me.seq++;
      paint();
      Promise.resolve().then(function () { return ctx.call('powermode.set', { mode: mode }); }).then(function (r) {
        if (!me.alive) return;
        me.pending = null;
        r = r || { ok: false, reason: 'powermode.set answered with nothing' };
        me.state = r.state && typeof r.state === 'object' ? r.state : was;   // the read-back, or spring back
        me.err = r.ok === false ? (r.reason || 'no reason was given') : null;
        paint();
      }, function (e) {
        if (!me.alive) return;
        me.pending = null;
        me.state = was;
        me.err = e && e.message ? e.message : String(e);
        paint();
        read();
      });
    }

    btns.forEach(function (b, i) {
      b.addEventListener('click', function () { set(MODES[i].mode); });
      b.addEventListener('keydown', function (e) {
        var k = e.key, j = -1;
        if (k === 'ArrowRight' || k === 'ArrowDown') j = Math.min(btns.length - 1, i + 1);
        else if (k === 'ArrowLeft' || k === 'ArrowUp') j = Math.max(0, i - 1);
        else if (k === 'Home') j = 0;
        else if (k === 'End') j = btns.length - 1;
        if (j < 0) return;
        e.preventDefault();
        e.stopPropagation();
        btns[j].focus();
        set(MODES[j].mode);
      });
    });

    if (ctx.on) me.off = ctx.on('powermode', function (st) { take(st); }, function () { /* the 3 s re-read covers it */ });
    (function loop() {
      if (!me.alive) return;
      me.timer = setTimeout(function () { read().then(loop); }, POLL_MS);
    })();
    paint();
    read();
    return { repaint: paint, read: read };
  }

  function closed() {
    if (!S) return;
    S.alive = false;
    clearTimeout(S.timer);
    if (typeof S.off === 'function') { try { S.off(); } catch (e) { /* gone */ } }
    S = null;
  }

  return { MODES: MODES, view: view, attach: attach, closed: closed, fullName: fullName };
}));
