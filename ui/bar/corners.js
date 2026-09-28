/* corners.js - the Hot corners row in the quick-settings panel (lane corners, 2026-09-27).
 *
 * Push the pointer into a screen corner and an action runs (lib/features/corners.js). This row shows
 * the four corners laid out like the screen; clicking one opens its choices below (Off, Task view,
 * Show desktop, Launcher, Quick settings, Lock screen) and a click on a choice saves it at once.
 * A corner whose last push FAILED says why under the grid (and stays so until it next works); a watch
 * that cannot read the cursor or the buttons says that too. No Silent Failures.
 *
 * WHAT IT TALKS TO (lib/features/corners.js):
 *   corners.state            -> {enabled, test, actions:{tl,tr,bl,br}, corners, names, choices:[{id,label}],
 *                                watching, watch:{ok,reason}, last:{corner,action,at,ok,blocked,dryRun,said},
 *                                fails:{<corner>:{at,action,said}}, zone, dwell}
 *   corners.set {corner, action, via} -> {ok, reason?} + the same state
 *   'corners.state' push     -> whenever it changes
 * A feature resting while a game runs, or switched off in the tray, answers with its reason.
 *
 * Loaded as a plain <script> by the bar (window.MantleCorners) and by require() in node (`view` is pure). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleCorners = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ORDER = ['tl', 'tr', 'bl', 'br'];
  var LABEL = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' };
  var CHOICES = [{ id: 'off', label: 'Off' }, { id: 'taskview', label: 'Task view' }, { id: 'desktop', label: 'Show desktop' },
    { id: 'launcher', label: 'Launcher' }, { id: 'qs', label: 'Quick settings' }, { id: 'lock', label: 'Lock screen' }];

  function nameOf(choices, id) {
    for (var i = 0; i < choices.length; i++) if (choices[i].id === id) return choices[i].label;
    return id || 'Off';
  }

  /** PURE: the state -> what the row shows. */
  function view(st) {
    var v = { dead: false, sub: '', cells: [], choices: CHOICES, lines: [], warn: false };
    if (st && st.error && /resting while/i.test(st.error)) {
      v.dead = true; v.sub = 'Resting · a game runs';
      v.lines.push({ text: st.error, warn: false });
      return v;
    }
    if (!st || st.error) {
      v.dead = true; v.warn = true; v.sub = 'Unavailable';
      v.lines.push({ text: 'Hot corners did not answer' + (st && st.error ? ': ' + st.error : ''), warn: true });
      return v;
    }
    var choices = st.choices && st.choices.length ? st.choices : CHOICES;
    v.choices = choices;
    var acts = st.actions || {};
    var fails = st.fails || {};
    var n = 0;
    for (var i = 0; i < ORDER.length; i++) {
      var c = ORDER[i];
      var a = acts[c] || 'off';
      if (a !== 'off') n++;
      v.cells.push({ corner: c, label: LABEL[c], action: a, actionLabel: nameOf(choices, a), off: a === 'off', failed: !!fails[c] });
    }
    v.sub = st.enabled === false ? 'Switched off in the tray' : n ? n + ' on · push the pointer in' : 'All off';
    if (st.enabled === false) v.lines.push({ text: "Hot corners are switched off in Mantle's tray menu; choices are kept for when they are on.", warn: true });
    if (st.watch && st.watch.ok === false) v.lines.push({ text: 'The corners cannot fire: ' + (st.watch.reason || 'no reason came back'), warn: true });
    for (var j = 0; j < ORDER.length; j++) {
      var f = fails[ORDER[j]];
      if (f) v.lines.push({ text: LABEL[ORDER[j]] + ' (' + nameOf(choices, f.action) + '): ' + (f.said || 'failed, no reason came back'), warn: true });
    }
    var l = st.last;
    if (l && l.blocked) v.lines.push({ text: 'Last push, ' + (LABEL[l.corner] || l.corner).toLowerCase() + ': did nothing, ' + (l.said || 'no reason came back'), warn: false });
    if (st.test) v.lines.push({ text: 'Test instance: every corner is a dry run.', warn: false });
    v.warn = v.lines.some(function (x) { return x.warn; });
    return v;
  }

  var S = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function attach(parent, ctx, before) {
    closed();
    var me = S = { alive: true, st: null, off: null, open: null, busy: null, note: null, v: null, h: 0 };
    var row = el('div', 'hcrow');
    var head = el('div', 'qsrowhead');
    head.appendChild(el('span', null, 'Hot corners'));
    var sub = el('span', 'qsval hcsub');
    head.appendChild(sub);
    var grid = el('div', 'hcgrid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Hot corners: pick what each screen corner does');
    var cellEls = {};
    ORDER.forEach(function (c) {
      var b = el('button', 'hccell hc-' + c); b.type = 'button';
      var cap = el('span', 'hccap', LABEL[c]);
      var act = el('span', 'hcact');
      b.appendChild(cap); b.appendChild(act);
      b.addEventListener('click', function () {
        if (!me.v || me.v.dead) return;
        me.open = me.open === c ? null : c; me.note = null; paint();
      });
      grid.appendChild(b);
      cellEls[c] = { b: b, act: act };
    });
    var pick = el('div', 'hcpick'); pick.hidden = true;
    var why = el('div', 'hcwhy'); why.hidden = true;
    row.appendChild(head); row.appendChild(grid); row.appendChild(pick); row.appendChild(why);
    if (before && before.parentNode === parent) parent.insertBefore(row, before); else parent.appendChild(row);

    function choose(c, id) {
      if (!me.v || me.v.dead || me.busy) return;
      me.busy = c; me.note = null; paint();
      Promise.resolve().then(function () { return ctx.call('corners.set', { corner: c, action: id, via: 'quick settings' }); }).then(function (st) {
        me.busy = null;
        if (st && st.ok === false) me.note = LABEL[c] + ' could not be set: ' + (st.reason || st.error || 'no reason came back');
        else me.open = null;
        if (st && st.actions) take(st); else paint();
      }, function (e) {
        me.busy = null;
        me.note = LABEL[c] + ' could not be set: ' + (e && e.message || e);
        paint();
      });
    }

    function paint() {
      if (!me.alive) return;
      var v = me.v = view(me.st);
      row.classList.toggle('dead', v.dead);
      sub.textContent = v.sub; sub.title = v.sub;
      v.cells.forEach(function (cell) {
        var ce = cellEls[cell.corner];
        ce.act.textContent = me.busy === cell.corner ? 'Saving…' : cell.actionLabel;
        ce.b.classList.toggle('off', cell.off);
        ce.b.classList.toggle('failed', cell.failed);
        ce.b.classList.toggle('open', me.open === cell.corner);
        ce.b.disabled = v.dead;
        ce.b.setAttribute('aria-expanded', me.open === cell.corner ? 'true' : 'false');
        ce.b.title = cell.label + ' corner: ' + cell.actionLabel + (cell.failed ? ' (its last push failed; the reason is below)' : '') + '. Click to change.';
      });
      if (v.dead) { ORDER.forEach(function (c) { cellEls[c].act.textContent = '—'; }); me.open = null; }
      // the choices for the open corner
      pick.textContent = '';
      var cur = null;
      for (var i = 0; i < v.cells.length; i++) if (v.cells[i].corner === me.open) cur = v.cells[i];
      pick.hidden = !cur;
      if (cur) {
        v.choices.forEach(function (ch) {
          var b = el('button', 'hcchip', ch.label); b.type = 'button';
          var on = ch.id === cur.action;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.disabled = !!me.busy;
          b.title = on ? cur.label + ' corner: ' + ch.label + ' (now)' : 'Make the ' + cur.label.toLowerCase() + ' corner ' + ch.label.toLowerCase();
          b.addEventListener('click', function () { if (on) { me.open = null; paint(); } else choose(cur.corner, ch.id); });
          pick.appendChild(b);
        });
      }
      why.textContent = '';
      var lines = (me.note ? [{ text: me.note, warn: true }] : []).concat(v.lines);
      why.hidden = !lines.length;
      lines.forEach(function (l) { why.appendChild(el('div', l.warn ? 'hcline warn' : 'hcline', l.text)); });
      // the panel was measured when it opened: ask for room again when this row grew or shrank
      var h = row.offsetHeight;
      if (me.h && h !== me.h && typeof ctx.resize === 'function') { try { ctx.resize(); } catch (e) { /* the panel says it may be clipped */ } }
      me.h = h;
    }
    function take(st) { if (!me.alive || !st) return; me.st = st; paint(); }

    if (ctx.on) me.off = ctx.on('corners.state', take, function () { /* read on open covers it */ });
    paint();
    Promise.resolve().then(function () { return ctx.call('corners.state'); }).then(take, function (e) { take({ error: e && e.message || String(e) }); });
    return { repaint: paint };
  }

  function closed() {
    if (!S) return;
    S.alive = false;
    if (typeof S.off === 'function') { try { S.off(); } catch (e) { /* gone */ } }
    S = null;
  }

  return { view: view, attach: attach, closed: closed, ORDER: ORDER, LABEL: LABEL, CHOICES: CHOICES };
}));
