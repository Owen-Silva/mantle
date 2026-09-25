/* powermode.js - the Power mode switch in the quick-settings panel: Best power efficiency /
 * Balanced / Best performance (osd lane, wave 3, 2026-09-24).
 *
 * WHAT IT TALKS TO (lib/features/powermode.js over sidecar/PowerMode.cs):
 *   powermode.get                -> the state: {ok, mode, inForce, available, settable, configured:{ac, battery},
 *                                   plan:{name, balanced}, source, saver, reason}. `mode` is the choice for
 *                                   the CURRENT power source, as Settings shows it; `inForce` what Windows
 *                                   runs (Energy saver pins efficiency and makes settable false).
 *   powermode.set {mode}         -> {ok, mode, state (READ BACK), reason}
 *   powermode.plan {plan}        -> {ok, plan, same, state (READ BACK), reason}: switch the power PLAN
 *                                   (the state carries plans:[{guid, name, active, balanced}])
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

  /* THE PURE HALF: what to draw from (state, the click in flight, the last refusal, and the plan
     half's ui: {plan: the plan click in flight, planErr, plansOpen}). */
  function view(state, pending, err, ui) {
    ui = ui || {};
    var s = state || null;
    var ok = !!s && s.ok !== false;
    var live = ok && s.available !== false;
    // On Balanced but Windows will not take a mode now (2026-09-25: Energy saver, which pins Best
    // power efficiency - Settings says "Power mode cannot be set when energy saver is on"). The
    // choice for this power source stays lit, muted, with the sidecar's reason under it.
    var locked = live && s.settable === false;
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
      if (locked) reason = s.reason || 'Windows will not take a power mode right now, and gave no reason';
    }
    // The mode Windows is actually running, when it differs from the choice and nothing above says why.
    var inForce = ok && !locked && s.inForce && s.inForce !== s.mode ? '; Windows reports ' + fullName(s.inForce) + ' in effect right now' : '';
    var segs = MODES.map(function (m) {
      return {
        mode: m.mode, label: m.label,
        on: shown === m.mode,
        pending: pending === m.mode,
        disabled: !live || locked,
        title: live && !locked ? m.full + (shown === m.mode ? ' (current' + inForce + ')' : '') : m.full + ' — ' + sentence(reason),
      };
    });
    var other = ok && live && !pending && MODES.every(function (m) { return m.mode !== s.mode; });
    // THE PLANS (2026-09-24): off Balanced, Windows applies no mode, so the installed plans ARE the
    // control (Owen's machine: "Hone Ultimate Power Plan V5"); on Balanced they sit behind a small
    // "Plan: Balanced" toggle so the way back is one click. A sidecar without `plans` keeps the
    // muted mode switch with its reason, exactly as before.
    var plans = ok && Array.isArray(s.plans) ? s.plans : [];
    var activePlan = null;
    plans.forEach(function (p) { if (p.active) activePlan = p; });
    var pickPlan = ok && !live && plans.length > 0;
    var planShown = ui.plan || (activePlan ? activePlan.guid : null);
    var planRows = plans.map(function (p) {
      return {
        guid: p.guid, name: p.name || p.guid, balanced: !!p.balanced,
        on: planShown === p.guid, pending: ui.plan === p.guid,
        title: (p.name || p.guid) + (p.active ? ' (current)' : '') + (p.balanced ? ' — power modes work on this plan' : ''),
      };
    });
    var v = {
      dead: !live || locked, sub: sub, reason: reason, head: 'Power mode',
      note: err ? sentence('Power mode did not change: ' + err) : other ? sentence('Windows reports ' + fullName(s.mode) + '; pick one to replace it') : null,
      segs: segs,
      aria: locked ? 'Power mode: ' + fullName(shown) + ', locked: ' + reason
        : live ? 'Power mode: ' + fullName(shown) : 'Power mode unavailable: ' + reason,
      pickPlan: pickPlan, plans: planRows,
      plansOpen: pickPlan || (live && !!ui.plansOpen && plans.length > 1),
      planToggle: live && plans.length > 1 ? (ui.plansOpen ? 'Hide power plans' : 'Plan: ' + ((activePlan && activePlan.name) || 'Balanced')) : null,
      hint: null,
      planNote: ui.planErr ? sentence('Power plan did not change: ' + ui.planErr) : null,
    };
    if (pickPlan) {
      v.dead = false;
      v.head = 'Power plan';
      v.sub = activePlan ? activePlan.name : 'Unknown plan';
      v.hint = 'Power modes (Efficiency, Balanced, Performance) work only on the Balanced plan. Choose Balanced to use them.';
      v.aria = 'Power plan: ' + v.sub;
    }
    return v;
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
    // The plans: a radio list (rebuilt only when the set of plans changes) and, on Balanced, the
    // small toggle that opens it. Arrows move between plans; Enter/Space/click switches (a plan
    // switch is heavier than a mode, so moving the focus alone never switches one).
    var toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'pmplantoggle'; toggle.hidden = true;
    var plist = document.createElement('div'); plist.className = 'pmplans'; plist.hidden = true;
    plist.setAttribute('role', 'radiogroup'); plist.setAttribute('aria-label', 'Power plan');
    var pnote = document.createElement('div'); pnote.className = 'pmnote'; pnote.hidden = true;
    row.appendChild(head); row.appendChild(group); row.appendChild(plist); row.appendChild(why);
    row.appendChild(toggle); row.appendChild(note); row.appendChild(pnote);
    if (before && before.parentNode === parent) parent.insertBefore(row, before); else parent.appendChild(row);

    var me = S = { row: row, state: null, pending: null, err: null, seq: 0, timer: 0, off: null, ctx: ctx, alive: true,
      plan: null, planErr: null, plansOpen: false, planKey: '', planBtns: [] };

    function planButtons(v) {
      var key = v.plans.map(function (p) { return p.guid + '=' + p.name; }).join('|');
      if (key === me.planKey) return;
      me.planKey = key;
      plist.textContent = '';
      me.planBtns = v.plans.map(function (p, i) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'pmplan'; b.dataset.plan = p.guid;
        b.setAttribute('role', 'radio');
        b.textContent = p.name;
        b.addEventListener('click', function () { setPlan(p.guid); });
        b.addEventListener('keydown', function (e) {
          var k = e.key, j = -1, n = me.planBtns.length;
          if (k === 'ArrowDown' || k === 'ArrowRight') j = Math.min(n - 1, i + 1);
          else if (k === 'ArrowUp' || k === 'ArrowLeft') j = Math.max(0, i - 1);
          else if (k === 'Home') j = 0;
          else if (k === 'End') j = n - 1;
          if (j < 0) return;
          e.preventDefault();
          e.stopPropagation();
          me.planBtns[j].focus();
        });
        plist.appendChild(b);
        return b;
      });
    }

    function paint() {
      if (!me.alive) return;
      var v = view(me.state, me.pending, me.err, { plan: me.plan, planErr: me.planErr, plansOpen: me.plansOpen });
      var hadFocus = plist.contains(document.activeElement) || toggle === document.activeElement;
      name.textContent = v.head;
      group.hidden = v.pickPlan;
      planButtons(v);
      plist.hidden = !v.plansOpen;
      var tabbable = null;
      v.plans.forEach(function (p, i) {
        var b = me.planBtns[i];
        if (!b) return;
        b.classList.toggle('on', p.on);
        b.classList.toggle('pending', p.pending);
        b.setAttribute('aria-checked', String(p.on));
        b.title = p.title;
        if (p.on) tabbable = b;
      });
      me.planBtns.forEach(function (b, i) { b.tabIndex = b === (tabbable || me.planBtns[0]) ? 0 : -1; });
      toggle.hidden = !v.planToggle;
      toggle.textContent = v.planToggle || '';
      toggle.setAttribute('aria-expanded', String(!!v.plansOpen));
      pnote.textContent = v.planNote || '';
      pnote.hidden = !v.planNote;
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
      why.textContent = v.hint || (v.dead && v.reason ? sentence(v.reason) : '');
      why.hidden = !(v.hint || (v.dead && v.reason));
      note.textContent = v.note || '';
      note.hidden = !v.note || v.pickPlan;
      // A switch that hid the focused plan list (Hone -> Balanced) hands the focus to the modes.
      if (hadFocus && !row.contains(document.activeElement)) {
        var t = v.plansOpen ? (tabbable || me.planBtns[0]) : v.planToggle ? toggle : focusable || btns[1];
        if (t && t.focus) t.focus();
      }
    }

    function setPlan(guid) {
      var st = me.state;
      if (!st || st.ok === false || me.plan || me.pending) return;
      var cur = null;
      (st.plans || []).forEach(function (p) { if (p.active) cur = p.guid; });
      if (cur === guid) { me.planErr = null; paint(); return; }
      me.plan = guid;
      me.planErr = null;
      me.seq++;
      paint();
      Promise.resolve().then(function () { return ctx.call('powermode.plan', { plan: guid }); }).then(function (r) {
        if (!me.alive) return;
        me.plan = null;
        r = r || { ok: false, reason: 'powermode.plan answered with nothing' };
        if (r.state && typeof r.state === 'object') me.state = r.state;   // the read-back, or spring back
        me.planErr = r.ok === false ? (r.reason || 'no reason was given') : null;
        if (r.ok !== false) me.plansOpen = false;
        paint();
      }, function (e) {
        if (!me.alive) return;
        me.plan = null;
        me.planErr = e && e.message ? e.message : String(e);
        paint();
        read();
      });
    }

    toggle.addEventListener('click', function () { me.plansOpen = !me.plansOpen; me.planErr = null; paint(); });

    function take(state) {
      if (!me.alive || !state || typeof state !== 'object') return;
      if (me.pending || me.plan) return;          // the click in flight is newer than any push
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
      if (!me.state || me.state.ok === false || me.state.available === false || me.state.settable === false) { paint(); return; }
      if (me.pending || me.plan) return;
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
