/* gamemode.js - the Game mode tile in the quick-settings panel (lane gamemode, 2026-09-25; made
 * minimal and obvious by lane sysmon-game, 2026-09-29).
 *
 * WHAT IT TALKS TO (lib/features/gamemode.js):
 *   gamemode.state            -> {on, how, game:{file,title,why}, busy, auto, liftSaver, dry, enabled, watching,
 *                                 reason, actions:[{key,label,status,text}], last, fromCrash,
 *                                 rest:{on, why, text, busy, last:{text}},     <- Mantle resting while a game runs
 *                                 leftover:{text, tries, gaveUp}}              <- what could not be put back yet
 *   gamemode.set {on}         -> the same state (turn on / off by hand)
 *   gamemode.auto {on}        -> "Turn on by itself for games"
 *   gamemode.liftSaver {on}   -> "Lift Energy saver while gaming on battery"
 *   'gamemode.state' push     -> whenever it changes (a game starts or exits)
 *
 * THE SURFACE (Owen: "minimalistic and super easy to use and obvious"):
 *   header    "Game mode" + ONE short status on the right ("On for VALORANT", "Starts with your games")
 *   line      a switch that says what a click does ("Turn on" / "Turn off", the track shows the state)
 *             and "Details" (what it changed, what it left alone, the two options)
 *   one line  under it only when something needs reading: a failure (warning ink), what could not be
 *             put back, games not being watched, the restore after a restart, a test run.
 * NO SILENT FAILURES: every action game mode took, skipped or could not take is a Details row with
 * its words; a failure is also the one line under the switch.
 *
 * Loaded as a plain <script> by the bar (window.MantleGameMode) and by require() in node
 * (ui/bar/gamemode.test.js tests the pure half, `view`; gamemode.page.test.js clicks the real tile). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleGameMode = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // info rows are notes: no badge at all
  var BADGE = { done: 'Done', same: 'No change', dry: 'Test run', blocked: 'Not done', failed: 'Failed', skipped: 'Skipped' };
  var PLAN = [
    ['Power mode', 'Best performance while you play; your own choice comes back after'],
    ['Background apps', 'Efficiency mode for your other apps. Never the game, anti-cheat, Discord, music, recording, mouse or keyboard software, or anything playing sound'],
    ['Mantle itself', 'its own windows slowed down the same way'],
    ['Wallpaper', 'paused, even for a windowed game'],
    ['Mantle resting', 'while a game runs, Mantle closes its hidden windows and hands their shortcuts back to Windows; all back when the game closes'],
  ];

  function exeName(f) { return String(f || '').replace(/\.exe$/i, '').replace(/-Win64-Shipping$/i, ''); }
  function mins(m) { return !(m >= 1) ? 'under a minute' : m === 1 ? '1 min' : m + ' min'; }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  /** PURE: the state -> what the tile shows. */
  function view(st) {
    var v = { dead: false, on: false, pending: false, label: 'Turn on', tip: '', sub: '', why: '', warn: false, rows: [], plan: null,
              last: '', crash: '', auto: true, liftSaver: false, rest: '' };
    if (!st || st.error) {
      v.dead = true; v.sub = 'Unavailable'; v.warn = true;
      v.why = "Game mode didn't answer. Close and reopen quick settings to try again";
      v.tip = 'Game mode is unavailable right now';
      return v;
    }
    v.auto = st.auto !== false; v.liftSaver = !!st.liftSaver;
    if (st.enabled === false) {
      v.dead = true; v.sub = 'Switched off';
      v.why = "Game mode is switched off in Mantle's tray menu. Turn it back on there to use it";
      v.tip = "Switched off in Mantle's tray menu";
      return v;
    }
    v.on = !!st.on; v.pending = !!st.busy;
    var game = st.game && st.game.file && st.how !== 'manual' ? exeName(st.game.file) : '';
    var rest = st.rest || {};
    if (st.busy === 'on') { v.sub = 'Turning on…'; v.label = 'Turning on…'; }
    else if (st.busy === 'off') { v.sub = 'Putting things back…'; v.label = 'Turning off…'; }
    else if (v.on) { v.sub = game ? 'On for ' + game : 'On'; v.label = 'Turn off'; }
    else if (rest.on) v.sub = 'Off · Mantle is resting';
    else if (!v.auto) v.sub = 'Off · starts only by hand';
    else if (st.watching === false) v.sub = 'Off · not watching';
    else v.sub = 'Off · starts with your games';
    v.tip = v.on ? 'Turn game mode off and put everything back' : 'Turn game mode on now, for whatever you play next';

    // Mantle resting: the full words (what closed, the memory it freed) are a Details row; the status
    // says "Mantle is resting" when game mode itself is off.
    if (rest.on) v.rest = rest.text || ('Mantle is resting while ' + rest.why);
    else if (rest.text) v.rest = rest.text;                  // "could not rest": a fault, said below

    // ONE line under the switch, the most important first; warnings in warning ink.
    var lo = st.leftover;
    if (!rest.on && rest.text) { v.why = cap(rest.text); v.warn = true; }
    else if (lo && lo.text) { v.why = cap(lo.text); v.warn = true; }
    else if (!v.on && st.watching === false && st.reason) { v.why = cap(st.reason); v.warn = true; }
    else if (st.fromCrash && st.fromCrash.text) { v.why = 'After Mantle restarted: ' + st.fromCrash.text; v.warn = st.fromCrash.ok === false; }
    else if (st.dry) v.why = 'Test run: everything is planned and shown, nothing on this PC is changed';
    if (st.fromCrash && st.fromCrash.text) v.crash = 'After Mantle restarted: ' + st.fromCrash.text;

    var acts = Array.isArray(st.actions) ? st.actions : [];
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i];
      v.rows.push({ key: a.key, label: a.label, status: a.status, badge: BADGE[a.status] || '', text: cap(a.text) });
    }
    if (v.on && st.game && st.game.why && st.how !== 'manual') v.rows.unshift({ key: 'why', label: 'Why it is on', status: 'info', badge: '', text: cap(st.game.why) });
    if (rest.on) v.rows.unshift({ key: 'rest', label: 'Mantle resting', status: 'done', badge: BADGE.done, text: cap(v.rest) });
    if (!v.on && !st.busy) v.plan = PLAN.map(function (p) { return { label: p[0], text: cap(p[1]) }; });
    if (st.last) v.last = 'Last game: ' + (st.last.game ? exeName(st.last.game) : 'turned on by hand') + ', ' + mins(st.last.minutes) + '. ' + cap(st.last.text) + '.';
    if (!rest.on && rest.last && rest.last.text) v.last = (v.last ? v.last + ' ' : '') + cap(rest.last.text) + '.';
    return v;
  }

  var S = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function attach(parent, ctx, before) {
    closed();
    var me = S = { alive: true, st: null, open: false, off: null, inflight: false, note: null };
    var row = el('div', 'gmrow');
    var head = el('div', 'qsrowhead');
    head.appendChild(el('span', null, 'Game mode'));
    var sub = el('span', 'qsval gmsub');
    head.appendChild(sub);
    var line = el('div', 'gmline');
    var sw = el('button', 'gmswitch'); sw.type = 'button'; sw.setAttribute('role', 'switch');
    var track = el('span', 'gmtrack'); track.setAttribute('aria-hidden', 'true');
    track.appendChild(el('span', 'gmknob'));
    var swText = el('span', 'gmswtext');
    sw.appendChild(track); sw.appendChild(swText);
    var more = el('button', 'gmmore'); more.type = 'button'; more.setAttribute('aria-expanded', 'false');
    var moreText = el('span', null, 'Details');
    var chev = el('span', 'gmchev'); chev.setAttribute('aria-hidden', 'true');
    more.appendChild(moreText); more.appendChild(chev);
    more.title = 'What game mode changes, and its two options';
    line.appendChild(sw); line.appendChild(more);
    var why = el('div', 'gmwhy'); why.hidden = true;
    var list = el('div', 'gmlist'); list.hidden = true;
    var opts = el('div', 'gmopts'); opts.hidden = true;   // outside the scrolling list: always in view when open
    row.appendChild(head); row.appendChild(line); row.appendChild(why); row.appendChild(list); row.appendChild(opts);
    if (before && before.parentNode === parent) parent.insertBefore(row, before); else parent.appendChild(row);

    function opt(label, key, cmd, help) {
      var l = el('label', 'gmopt');
      l.title = help;
      var box = document.createElement('input'); box.type = 'checkbox';
      box.checked = !!(me.v && me.v[key]);
      box.addEventListener('change', function () {
        var want = box.checked;
        box.disabled = true;
        Promise.resolve().then(function () { return ctx.call(cmd, { on: want }); }).then(function (st) {
          box.disabled = false; me.note = null; take(st);
        }, function (e) { box.disabled = false; box.checked = !want; note("That setting didn't change: " + plain(e)); });
      });
      l.appendChild(box); l.appendChild(el('span', null, label));
      return l;
    }
    function plain(e) {
      var m = String(e && e.message || e || '');
      return !m || /sidecar|ipc|undefined|null|timed? ?out|\bE[A-Z]{3,}\b/i.test(m) ? "Mantle didn't answer. Try again in a moment" : m;
    }
    function note(t) { me.note = t || null; paint(); }

    function paint() {
      if (!me.alive) return;
      var v = me.v = view(me.st);
      row.classList.toggle('dead', v.dead);
      row.classList.toggle('on', v.on);
      sub.textContent = v.sub; sub.title = v.sub;
      swText.textContent = v.label;
      sw.setAttribute('aria-checked', v.on ? 'true' : 'false');
      sw.setAttribute('aria-label', 'Game mode: ' + v.label);
      sw.classList.toggle('on', v.on);
      sw.classList.toggle('pending', v.pending || me.inflight);
      sw.disabled = v.dead;
      sw.title = v.tip;
      var words = me.note || v.why;
      why.hidden = !words; why.textContent = words || ''; why.title = words || '';
      why.classList.toggle('warn', !!me.note || v.warn);
      more.setAttribute('aria-expanded', me.open ? 'true' : 'false');
      moreText.textContent = me.open ? 'Hide details' : 'Details';
      more.disabled = v.dead && !(me.st && !me.st.error);
      list.hidden = !me.open; opts.hidden = !me.open;
      list.textContent = ''; opts.textContent = '';
      if (!me.open) return;
      var rows = v.rows.length ? v.rows : (v.plan || []).map(function (p) { return { label: p.label, status: 'plan', badge: '', text: p.text }; });
      if (!v.rows.length && v.plan) list.appendChild(el('div', 'gmlisthead', 'When it is on'));
      rows.forEach(function (r) {
        var a = el('div', 'gmact st-' + r.status);
        var top = el('div', 'gmacthead');
        var name = el('span', 'gmactname');
        if (r.status === 'blocked' || r.status === 'failed') { var g = el('span', 'gmwarn'); g.setAttribute('aria-hidden', 'true'); name.appendChild(g); }
        name.appendChild(document.createTextNode(r.label));
        top.appendChild(name);
        if (r.badge) top.appendChild(el('span', 'gmbadge', r.badge));
        a.appendChild(top);
        a.appendChild(el('div', 'gmacttext', r.text));
        list.appendChild(a);
      });
      if (v.last && !v.on) list.appendChild(el('div', 'gmlast', v.last));
      opts.appendChild(opt('Turn on by itself for games', 'auto', 'gamemode.auto', 'Game mode starts when a known game starts and ends when it closes'));
      opts.appendChild(opt('Lift Energy saver while gaming on battery', 'liftSaver', 'gamemode.liftSaver', 'Energy saver forces Best power efficiency; this lifts it for the game and puts it back after'));
    }
    function take(st) { if (!me.alive || !st) return; me.st = st; paint(); }

    sw.addEventListener('click', function () {
      // one click = one call: a second click while the first is on its way does nothing
      if (!me.v || me.v.dead || me.v.pending || me.inflight) return;
      var want = !me.v.on;
      me.inflight = true; me.note = null;
      sw.classList.add('pending');                        // feedback at once, before main answers
      Promise.resolve().then(function () { return ctx.call('gamemode.set', { on: want }); }).then(function (st) {
        me.inflight = false;
        me.note = st && st.ok === false && st.reason ? cap(st.reason) : null;
        if (st) take(st); else paint();
      }, function (e) { me.inflight = false; note("Game mode didn't switch: " + plain(e)); });
    });
    more.addEventListener('click', function () { me.open = !me.open; paint(); });
    // Esc inside the open details closes them (and stays in the panel); a second Esc is the panel's.
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && me.open) { me.open = false; paint(); more.focus(); e.stopPropagation(); e.preventDefault(); }
    });

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
