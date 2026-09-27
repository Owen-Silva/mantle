/* gamemode.js - the Game mode tile in the quick-settings panel (lane gamemode, 2026-09-25).
 *
 * WHAT IT TALKS TO (lib/features/gamemode.js):
 *   gamemode.state            -> {on, how, game:{file,title,why}, busy, auto, liftSaver, dry, enabled, watching,
 *                                 reason, actions:[{key,label,status,text}], last, fromCrash,
 *                                 rest:{on, why, text, busy, last:{text}}}   <- Mantle resting while a game runs
 *   gamemode.set {on}         -> the same state (turn on / off by hand)
 *   gamemode.auto {on}        -> "Turn on by itself for games"
 *   gamemode.liftSaver {on}   -> "Lift Energy saver while gaming"
 *   'gamemode.state' push     -> whenever it changes (a game starts or exits)
 *
 * NO SILENT FAILURES: every action game mode took, skipped or could not take is a row with its
 * words; "not watching" and "put back after a restart" are said under the switch.
 *
 * Loaded as a plain <script> by the bar (window.MantleGameMode) and by require() in node
 * (ui/bar/gamemode.test.js tests the pure half, `view`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleGameMode = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BADGE = { done: 'Done', same: 'Already', dry: 'Dry run', blocked: 'Not done', failed: 'Failed', info: 'Note', skipped: 'Skipped' };
  var PLAN = [
    ['Power mode', 'Best performance for the power source in use; your choice back after'],
    ['Background apps', 'Efficiency mode for your other apps. Never the game, anti-cheat, Discord, music, recording, input software or anything playing sound'],
    ['Mantle itself', 'its own processes slowed down the same way'],
    ['Wallpaper', 'held paused, even for a windowed game'],
    ['Mantle resting', "while a game runs, Mantle closes its hidden windows (launcher, Alt+Tab, Task View, clipboard, screenshot, snap, pop-ups, top bar) and gives their keys back to Windows; all back when the game exits"],
  ];

  function exeName(f) { return String(f || '').replace(/\.exe$/i, '').replace(/-Win64-Shipping$/i, ''); }
  function mins(m) { return m < 1 ? 'under a minute' : m === 1 ? '1 min' : m + ' min'; }

  /** PURE: the state -> what the tile shows. */
  function view(st) {
    var v = { dead: false, on: false, pending: false, label: 'Turn on', sub: '', why: '', rows: [], plan: null, last: '', crash: '', auto: true, liftSaver: false, rest: '' };
    if (!st || st.error) {
      v.dead = true; v.sub = 'Unavailable';
      v.why = 'Game mode did not answer' + (st && st.error ? ': ' + st.error : '');
      return v;
    }
    v.auto = st.auto !== false; v.liftSaver = !!st.liftSaver;
    if (st.enabled === false) { v.dead = true; v.sub = 'Switched off'; v.why = "Game mode is switched off in Mantle's tray menu"; return v; }
    v.on = !!st.on; v.pending = !!st.busy;
    var game = st.game && st.game.file ? exeName(st.game.file) : '';
    if (st.busy === 'on') { v.sub = 'Turning on…'; v.label = 'Turning on…'; }
    else if (st.busy === 'off') { v.sub = 'Putting things back…'; v.label = 'Turning off…'; }
    else if (v.on) { v.sub = st.how === 'manual' ? 'On (by hand)' : 'On · ' + (game || 'a game'); v.label = 'On' + (game && st.how !== 'manual' ? ' · ' + game : ''); }
    else { v.sub = v.auto ? (st.watching ? 'Off · watching for games' : 'Off') : 'Off · automatic is off'; }
    // Mantle resting while a game runs: said under the switch whether game mode is on or not (a game
    // can run behind another window with game mode off), with what was closed and the memory it freed.
    var rest = st.rest || {};
    if (rest.on && !v.on && !st.busy) v.sub = 'Off · Mantle resting';
    if (rest.on || (rest.text && !rest.on)) v.rest = rest.text || ('Mantle is resting while ' + rest.why);
    var why = [];
    if (st.dry) why.push('Test run: planned and shown, nothing on this PC is changed');
    if (!v.on && st.watching === false && st.reason) why.push(st.reason);
    if (v.on && st.game && st.game.why && st.how !== 'manual') why.push(st.game.why);
    v.why = why.join('. ');
    var acts = Array.isArray(st.actions) ? st.actions : [];
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i];
      v.rows.push({ key: a.key, label: a.label, status: a.status, badge: BADGE[a.status] || a.status, text: a.text });
    }
    if (!v.on && !st.busy) v.plan = PLAN.map(function (p) { return { label: p[0], text: p[1] }; });
    if (rest.on) v.rows.unshift({ key: 'rest', label: 'Mantle resting', status: 'done', badge: BADGE.done, text: v.rest });
    if (st.last) v.last = 'Last game: ' + (st.last.game ? exeName(st.last.game) : 'by hand') + ', ' + mins(st.last.minutes) + ' (' + st.last.why + '). ' + st.last.text;
    if (st.fromCrash) v.crash = 'After Mantle restarted: ' + st.fromCrash.text;
    if (!rest.on && rest.last && rest.last.text) v.last = (v.last ? v.last + ' ' : '') + rest.last.text + '.';
    return v;
  }

  var S = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function attach(parent, ctx, before) {
    closed();
    var me = S = { alive: true, st: null, open: false, off: null };
    var row = el('div', 'gmrow');
    var head = el('div', 'qsrowhead');
    head.appendChild(el('span', null, 'Game mode'));
    var sub = el('span', 'qsval gmsub');
    head.appendChild(sub);
    var line = el('div', 'gmline');
    var sw = el('button', 'gmswitch'); sw.type = 'button';
    var more = el('button', 'gmmore', 'Details'); more.type = 'button'; more.setAttribute('aria-expanded', 'false');
    line.appendChild(sw); line.appendChild(more);
    var why = el('div', 'gmwhy'); why.hidden = true;
    var list = el('div', 'gmlist'); list.hidden = true;
    var opts = el('div', 'gmopts'); opts.hidden = true;   // outside the scrolling list: always in view when open
    row.appendChild(head); row.appendChild(line); row.appendChild(why); row.appendChild(list); row.appendChild(opts);
    if (before && before.parentNode === parent) parent.insertBefore(row, before); else parent.appendChild(row);

    function opt(label, key, cmd) {
      var l = el('label', 'gmopt');
      var box = document.createElement('input'); box.type = 'checkbox';
      box.checked = !!(me.v && me.v[key]);
      box.addEventListener('change', function () {
        var want = box.checked;
        Promise.resolve().then(function () { return ctx.call(cmd, { on: want }); }).then(take, function (e) { box.checked = !want; note('Could not change that: ' + (e && e.message || e)); });
      });
      l.appendChild(box); l.appendChild(el('span', null, label));
      return l;
    }
    function note(t) { me.note = t || null; paint(); }

    function paint() {
      if (!me.alive) return;
      var v = me.v = view(me.st);
      row.classList.toggle('dead', v.dead);
      row.classList.toggle('on', v.on);
      sub.textContent = v.sub; sub.title = v.sub;
      sw.textContent = v.label;
      sw.setAttribute('aria-pressed', v.on ? 'true' : 'false');
      sw.classList.toggle('on', v.on);
      sw.classList.toggle('pending', v.pending);
      sw.disabled = v.dead;
      sw.title = v.on ? 'Turn game mode off and put everything back' : 'Turn game mode on now';
      var words = [me.note, v.rest, v.why, v.crash].filter(Boolean).join('. ');
      why.hidden = !words; why.textContent = words; why.classList.toggle('warn', !!me.note);
      more.setAttribute('aria-expanded', me.open ? 'true' : 'false');
      more.textContent = me.open ? 'Hide' : 'Details';
      list.hidden = !me.open; opts.hidden = !me.open;
      list.textContent = ''; opts.textContent = '';
      if (!me.open) return;
      var rows = v.rows.length ? v.rows : (v.plan || []).map(function (p) { return { label: p.label, status: 'plan', badge: '', text: p.text }; });
      rows.forEach(function (r) {
        var a = el('div', 'gmact st-' + r.status);
        var top = el('div', 'gmacthead');
        top.appendChild(el('span', 'gmactname', r.label));
        if (r.badge) top.appendChild(el('span', 'gmbadge', r.badge));
        a.appendChild(top);
        a.appendChild(el('div', 'gmacttext', r.text));
        list.appendChild(a);
      });
      if (v.last && !v.on) list.appendChild(el('div', 'gmlast', v.last));
      opts.appendChild(opt('Turn on by itself for games', 'auto', 'gamemode.auto'));
      opts.appendChild(opt('Lift Energy saver while gaming on battery', 'liftSaver', 'gamemode.liftSaver'));
    }
    function take(st) { if (!me.alive || !st) return; me.st = st; paint(); }

    sw.addEventListener('click', function () {
      if (!me.v || me.v.dead || me.v.pending) return;
      var want = !me.v.on;
      sw.classList.add('pending');
      Promise.resolve().then(function () { return ctx.call('gamemode.set', { on: want }); }).then(function (st) {
        me.note = st && st.ok === false && st.reason ? st.reason : null;
        take(st);
      }, function (e) { sw.classList.remove('pending'); note('Game mode could not be switched: ' + (e && e.message || e)); });
    });
    more.addEventListener('click', function () { me.open = !me.open; paint(); });

    if (ctx.on) me.off = ctx.on('gamemode.state', take, function () { /* read on open covers it */ });
    paint();
    Promise.resolve().then(function () { return ctx.call('gamemode.state'); }).then(take, function (e) { take({ error: e && e.message || String(e) }); });
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
