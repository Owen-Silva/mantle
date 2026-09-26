/* spotify.js - the "Up next" queue inside the now-playing card (spotq lane; rebuilt on the Spotify
 * DESKTOP APP by the spotapp lane, 2026-09-25).
 *
 * Owen: "make a dropdown so i can see and adjust the queue too". Windows' media session has no
 * queue, so this reads Spotify's own. The Web API version needed Premium (he has none), so main now
 * drives the Spotify desktop app itself over a local debugging port (lib/features/_spotify-app.js):
 * Spotify has to be started BY MANTLE for that, and the card says so and offers the button.
 * It is drawn ONLY when the card is showing Spotify: one collapsed row, "Up next", between the
 * transport buttons and the source list, which opens to:
 *   - "Queued" (songs he added) and "Next up" (the playlist/album that follows), with art; a click on
 *     a row plays it (Spotify's own jump: the songs before it are used up);
 *   - per row, on hover or keyboard focus: move up / move down (queued songs only: Spotify reorders
 *     only its queue) and remove;
 *   - "Add a song": search Spotify, click a result, it goes to the end of the queue.
 * Every other state is said in the list's place with its reason: checking, Spotify not running
 * (Start button), running without the port (Restart button, which warns playback stops), starting,
 * the port taken by something else, Spotify's internals not found (an update), not installed, off,
 * and each action's result (verified against a re-read of the queue).
 *
 * FITTING: the card lives in the bar's one popover, and main gives a popover at most ROOM_MAX px
 * (main.js POPOVER_MAX), so a card taller than that would be cut off by the WINDOW, not by CSS (the
 * top bar's dropdown shipped clipped like that on 2026-09-24). The list therefore scrolls inside
 * the card, and its height is recomputed on every paint so the whole card always fits the room.
 *
 * COST: nothing while the list is shut. While it is open: one read on opening, one on each track
 * change (the 'media' push), one every 8 s; all stop when it shuts or the card closes.
 */
(function () {
  'use strict';

  var ROOM_MAX = 480;          // main.js POPOVER_MAX: the most room a popover is ever given (DIP)
  var LIST_PREF = 244;         // the list's own cap when there is room: about five rows
  var LIST_MIN = 72;
  var LIST_WANT = 150;         // under this (about four rows), the card's source list folds away while Up next is open
  var REFRESH_MS = 8000;
  var TRACK_SETTLE_MS = 700;   // Spotify's queue lags the media session by a moment on a track change

  var expanded = false;        // remembered across opens of the card, for this session
  var S = null;                // the open card's state, or null

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(inner, size) {
    return '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" aria-hidden="true">' + inner + '</svg>';
  }
  var G = {
    queue: '<path d="M2.5 4h8M2.5 8h8M2.5 12h5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11.5 10.2v3.6l3-1.8z" fill="currentColor"/>',
    chev: '<path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    up: '<path d="M4.5 9.5L8 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    down: '<path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    note: '<path d="M6 11.6V3.9l6.4-1.4v7.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="4.6" cy="11.8" r="1.6" fill="currentColor"/><circle cx="11" cy="10.2" r="1.6" fill="currentColor"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    search: '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  };
  var HINT = { checking: '', notrunning: 'Not running', noport: 'Needs restart', starting: 'Starting…', portbusy: 'Port busy',
    internals: 'Spotify changed', noinstall: 'Not found', error: 'Error', off: 'Off', missing: 'Off' };

  function isSpotify(s) {
    return !!s && (/spotify/i.test(String(s.aumid || '')) || /spotify/i.test(String((s.app && s.app.name) || '')));
  }
  function why(e) { return (S && S.api.msg) ? S.api.msg(e) : String((e && e.message) || e); }

  /* ------------------------------------------------------------------ talking to main */

  function call(verb, args) {
    return S.api.call('spotify.' + verb, args || {}).then(function (r) { return r || {}; });
  }
  function relayout() { if (S && S.api.repaint) S.api.repaint(); }

  function setStatus(st) {
    if (!S || !st) return;
    var was = S.status && S.status.state;
    S.status = st;
    if (st.state !== 'connected') { S.q = null; S.qErr = null; }
    if (st.state === 'connected' && was !== 'connected' && expanded) refresh(true);
    arm();
    render();
  }

  function loadStatus() {
    var mine = S;
    call('status').then(function (st) { if (S === mine) setStatus(st); }, function (e) {
      if (S !== mine) return;
      setStatus({ state: 'missing', reason: 'the Spotify queue is not loaded in Mantle (' + why(e) + ')' });
    });
  }

  /* One read at a time; a result that lands after the card closed (or re-opened) is dropped. A read
     also notices Spotify quitting or restarting: its answer then carries the new state. */
  function refresh(first) {
    // not while the card shows another source (LessonPlayer): paint() reads it once Spotify is shown again
    if (!S || !expanded || !S.shown || !S.status || S.loading) return;
    var st = S.status.state;
    if (st === 'off' || st === 'missing' || st === 'starting') return;
    if (st !== 'connected') { loadStatus(); return; }
    var mine = S;
    S.loading = true;
    if (first && !S.q) render();
    call('queue').then(function (r) {
      if (S !== mine) return;
      S.loading = false;
      if (r.ok) { S.q = r; S.qErr = null; }
      else if (r.state && r.state !== 'error' && r.state !== 'connected') { setStatus({ state: r.state, reason: r.reason }); return; }
      else S.qErr = r;
      render();
    }, function (e) {
      if (S !== mine) return;
      S.loading = false;
      S.qErr = { state: 'error', reason: 'the queue could not be read: ' + why(e) };
      render();
    });
  }

  /* The 8 s refresh runs only while the list is open and the card is up (it also notices Spotify
     being started or quit, so the Start/Restart state never goes stale). */
  function arm() {
    if (!S) return;
    var st = S.status && S.status.state;
    var want = expanded && S.shown && st && st !== 'off' && st !== 'missing';
    if (want && !S.timer) S.timer = setInterval(function () { refresh(false); }, REFRESH_MS);
    if (!want && S.timer) { clearInterval(S.timer); S.timer = 0; }
  }

  function say(text, bad) { if (!S) return; S.noteText = text || ''; S.noteBad = !!bad; render(); }

  /* ------------------------------------------------------------------ actions */

  /* One action at a time (they each re-read the queue to verify); the result is always said. */
  function act(key, verb, args, done) {
    if (S.busy) { say('Still working on the last change…'); return; }
    var mine = S;
    S.busy = key;
    say('');
    call(verb, args).then(function (r) {
      if (S !== mine) return;
      S.busy = '';
      if (!r.ok && r.state && r.state !== 'error' && r.state !== 'moved' && r.state !== 'busy' && r.state !== 'connected') setStatus({ state: r.state, reason: r.reason });
      done(r);
      refresh(false);
    }, function (e) {
      if (S !== mine) return;
      S.busy = '';
      done({ ok: false, reason: why(e) });
    });
    render();
  }
  function play(item) {
    act('play:' + item.uid + item.uri, 'play', { uri: item.uri, uid: item.uid }, function (r) {
      if (!r.ok) say('Did not play it: ' + (r.reason || 'Spotify gave no reason'), true);
      else if (!r.verified) say(r.reason, true);
      else say('Playing “' + item.name + '”' + (r.note ? ' (' + r.note + ')' : ''));
    });
  }
  function remove(item) {
    act('rm:' + item.uid + item.uri, 'remove', { uri: item.uri, uid: item.uid }, function (r) {
      if (!r.ok) say('Not removed: ' + (r.reason || 'Spotify gave no reason'), true);
      else if (!r.verified) say(r.reason, true);
      else say('Removed “' + item.name + '”');
    });
  }
  function move(item, dir) {
    act('mv:' + item.uid + item.uri, 'move', { uri: item.uri, uid: item.uid, dir: dir }, function (r) {
      if (!r.ok) say('Not moved: ' + (r.reason || 'Spotify gave no reason'), true);
      else if (!r.verified) say(r.reason, true);
      else say('Moved “' + item.name + '” ' + dir);
    });
  }
  function add(item) {
    act('add:' + item.uri, 'add', { uri: item.uri }, function (r) {
      if (r.ok) { S.added[item.uri] = true; say(r.verified ? 'Added “' + item.name + '” to the end of the queue' : r.reason, !r.verified); }
      else say('Not added: ' + (r.reason || 'Spotify gave no reason'), true);
    });
  }

  /* Start (Spotify not running) or Restart (running without the port). Restart stops playback, so
     the first click only arms it and says so; the second does it. */
  function launch(verb) {
    if (verb === 'restart' && !S.restartArmed) {
      S.restartArmed = true; render();
      setTimeout(function () { if (S && S.restartArmed) { S.restartArmed = false; render(); } }, 5000);
      return;
    }
    S.restartArmed = false;
    var mine = S;
    setStatus({ state: 'starting', reason: verb === 'restart' ? 'Closing Spotify…' : 'Starting Spotify with Up next’s port…' });
    call(verb).then(function (r) {
      if (S !== mine) return;
      if (r.dryRun) say('Test instance: ' + r.reason);
      else if (!r.ok) say((verb === 'restart' ? 'Not restarted: ' : 'Not started: ') + (r.reason || 'no reason given'), true);
      else if (r.note) say(r.note, true);
      else say(verb === 'restart' ? 'Spotify restarted. Press play to carry on.' : 'Spotify started.');
      loadStatus();
    }, function (e) { if (S === mine) { say('Spotify was not ' + (verb === 'restart' ? 'restarted' : 'started') + ': ' + why(e), true); loadStatus(); } });
  }

  function searchSoon() {
    if (S.searchTimer) clearTimeout(S.searchTimer);
    var q = S.input.value.trim();
    S.query = q;
    if (!q) { S.results = null; S.searching = false; render(); return; }
    S.searchTimer = setTimeout(function () {
      S.searchTimer = 0;
      var mine = S, asked = q;
      S.searching = true;
      render();
      call('search', { q: asked }).then(function (r) {
        if (S !== mine || S.query !== asked) return;
        S.searching = false;
        S.results = r;
        render();
      }, function (e) {
        if (S !== mine || S.query !== asked) return;
        S.searching = false;
        S.results = { ok: false, reason: 'the search failed: ' + why(e) };
        render();
      });
    }, 380);
  }

  /* The bar window is not focusable until it is given the keyboard (main's qs.keyboard, as the
     Wi-Fi password field does). A refusal is said under the box, never a dead field. */
  function wantKeyboard() {
    if (!S || S.kbd) return;
    S.kbd = 'asking';
    var mine = S;
    S.api.call('qs.keyboard', { on: true }).then(function (r) {
      if (S !== mine) { if (r && r.ok) S.api.call('qs.keyboard', { on: false }).catch(function () {}); return; }
      S.kbd = r && r.ok ? 'yes' : 'no';
      S.kbdWhy = r && r.ok ? '' : 'Typing may not reach this box: ' + ((r && r.reason) || 'the bar was not given the keyboard');
      render();
    }, function (e) {
      if (S !== mine) return;
      S.kbd = 'no';
      S.kbdWhy = 'Typing may not reach this box: ' + why(e);
      render();
    });
  }

  /* ------------------------------------------------------------------ drawing */

  function stateLine(text, cls) { return mk('div', 'spq-msg' + (cls ? ' ' + cls : ''), text); }
  function actBtn(text, fn, cls) {
    var b = mk('button', 'spq-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function linkBtn(text, fn, cls) {
    var b = mk('button', 'spq-link' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function tool(glyph, label, fn, off) {
    var b = mk('button', 'spq-tool');
    b.type = 'button';
    b.innerHTML = svg(glyph, 12);
    b.title = label;
    b.setAttribute('aria-label', label);
    if (off) b.disabled = true;
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
    return b;
  }

  /* The not-connected states: what is wrong, why, and the one thing that fixes it. */
  function drawApp(box, st) {
    var s = st.state, reason = st.reason || '';
    if (s === 'checking') { box.appendChild(stateLine('Checking Spotify…', 'dim')); return; }
    if (s === 'starting') { box.appendChild(stateLine(reason || 'Starting Spotify…', 'dim')); box.appendChild(mk('div', 'spq-fine', 'Waiting for Spotify to open its local debugging port (up to 30 s).')); return; }
    if (s === 'notrunning') {
      box.appendChild(stateLine('Spotify isn’t running.'));
      box.appendChild(actBtn('Start Spotify for Up next', function () { launch('start'); }));
      box.appendChild(mk('div', 'spq-fine', 'Mantle starts it with a local debugging port (127.0.0.1:' + (st.port || 47292) + ') so it can read and edit the queue.'));
      return;
    }
    if (s === 'noport') {
      box.appendChild(stateLine('Up next needs Spotify started by Mantle.'));
      box.appendChild(mk('div', 'spq-fine spq-why', reason || 'Spotify is running without the debugging port, so Mantle cannot reach it.'));
      box.appendChild(actBtn(S.restartArmed ? 'Click again: playback will stop' : 'Restart Spotify for Up next', function () { launch('restart'); }, S.restartArmed ? 'armed' : ''));
      box.appendChild(mk('div', 'spq-fine', 'Spotify closes and reopens with the port, so what is playing stops; press play again after.'));
      return;
    }
    var head = { portbusy: 'Up next can’t use its port.', internals: 'Spotify changed, so Up next can’t read it.', noinstall: 'Spotify wasn’t found.',
      off: null, missing: null }[s];
    if (head) box.appendChild(stateLine(head));
    box.appendChild(stateLine(reason || 'Something went wrong with no reason given', 'bad'));
    if (s !== 'off' && s !== 'missing') box.appendChild(linkBtn('Try again', function () { S.qErr = null; loadStatus(); }, 'act'));
  }

  function row(item, index, mode, n) {
    var wrap = mk('div', 'spq-item');
    var b = mk('button', 'spq-row');
    b.type = 'button';
    var art = mk('span', 'spq-art');
    if (item.image) { var im = document.createElement('img'); im.alt = ''; im.src = item.image; art.appendChild(im); }
    else { art.innerHTML = svg(G.note, 12); art.title = item.imageReason || ''; }
    b.appendChild(art);
    var txt = mk('span', 'spq-txt');
    txt.appendChild(mk('span', 'spq-t', item.name));
    txt.appendChild(mk('span', 'spq-a', item.artists || (item.kind === 'episode' ? 'Podcast episode' : item.kind === 'local' ? 'Local file' : '')));
    b.appendChild(txt);
    wrap.appendChild(b);
    var caps = (S.q && S.q.caps) || {};
    if (mode === 'search') {
      var done = S.added[item.uri];
      b.appendChild(mk('span', 'spq-tag', done ? 'Added' : (S.busy === 'add:' + item.uri ? 'Adding…' : 'Add')));
      b.title = 'Add “' + item.name + '” to the end of the queue';
      if (done) b.classList.add('done');
      b.addEventListener('click', function () { add(item); });
      return wrap;
    }
    b.title = 'Play “' + item.name + '” now' + (index ? ': the ' + (index === 1 ? 'song' : index + ' songs') + ' before it are used up, as in Spotify' : '');
    if (S.busy && S.busy.slice(S.busy.indexOf(':') + 1) === item.uid + item.uri) wrap.classList.add('busy');
    b.addEventListener('click', function () { play(item); });
    var tools = mk('div', 'spq-tools');
    if (mode === 'queued' && caps.move !== false) {
      tools.appendChild(tool(G.up, 'Move up', function () { move(item, 'up'); }, index === 0));
      tools.appendChild(tool(G.down, 'Move down', function () { move(item, 'down'); }, index === n - 1));
    }
    if (caps.remove !== false) tools.appendChild(tool(G.x, 'Remove from the queue', function () { remove(item); }));
    if (tools.firstChild) wrap.appendChild(tools);
    return wrap;
  }

  function drawConnected(box, list) {
    if (S.query) {
      var r = S.results;
      if (S.searching && !r) box.appendChild(stateLine('Searching…', 'dim'));
      else if (r && !r.ok) box.appendChild(stateLine(r.reason || 'the search failed', 'bad'));
      else if (r && !r.items.length) box.appendChild(stateLine('No songs match “' + S.query + '”.', 'dim'));
      else if (r) r.items.forEach(function (it, i) { list.appendChild(row(it, i, 'search')); });
      return;
    }
    var q = S.q, err = S.qErr;
    if (err) {
      box.appendChild(stateLine(err.reason || 'the queue could not be read', 'bad'));
      box.appendChild(linkBtn('Try again', function () { S.qErr = null; refresh(true); }, 'act'));
      return;
    }
    if (!q) { box.appendChild(stateLine(S.loading ? 'Loading the queue…' : 'Not loaded yet.', 'dim')); return; }
    if (!q.current && !q.queued.length && !q.nextUp.length) { box.appendChild(stateLine('Spotify has nothing playing: start something in Spotify first.', 'dim')); return; }
    if (!q.queued.length && !q.nextUp.length) { box.appendChild(stateLine('Nothing is queued after this song.', 'dim')); return; }
    var at = 0;
    if (q.queued.length) {
      list.appendChild(mk('div', 'spq-sec', 'Queued'));
      q.queued.forEach(function (it, i) { list.appendChild(row(it, at++, 'queued', q.queued.length)); });
      if (q.totalQueued > q.queued.length) list.appendChild(mk('div', 'spq-fine', '+' + (q.totalQueued - q.queued.length) + ' more queued in Spotify'));
    }
    if (q.nextUp.length) {
      list.appendChild(mk('div', 'spq-sec', 'Next up'));
      q.nextUp.forEach(function (it) { list.appendChild(row(it, at++, 'next', q.nextUp.length)); });
    }
  }

  /* quiet: called from inside bar.js's own repaint, which measures the card itself afterwards */
  function render(quiet) {
    if (!S) return;
    var st = S.status ? S.status.state : 'checking';
    var show = !!S.shown;
    S.root.hidden = !show;
    if (!show) { if (!quiet) relayout(); return; }

    // the collapsed row: what is in there, in two or three words
    S.head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    S.root.classList.toggle('open', expanded);
    var n = S.q ? S.q.queued.length + S.q.nextUp.length : 0;
    var hint = st === 'connected' ? (S.qErr ? 'Error' : S.q ? (S.q.queued.length ? S.q.queued.length + ' queued' : n ? n + ' next' : 'Empty') : '')
      : (HINT[st] != null ? HINT[st] : '');
    S.hint.textContent = hint;
    S.hint.classList.toggle('warn', st !== 'connected' && st !== 'checking' && st !== 'starting' || !!S.qErr);
    S.body.hidden = !expanded;
    if (!expanded) { if (!quiet) relayout(); return; }

    var box = S.state, list = S.list;
    // keep the list (and its scroll) when nothing in it changed
    var sig = [st, S.status && S.status.reason, S.query, S.searching, S.loading && !S.q, S.busy, JSON.stringify(S.added), S.restartArmed,
      S.q && S.q.at, S.qErr && S.qErr.reason, S.results && (S.results.q + (S.results.items || []).length + (S.results.reason || '')), S.kbdWhy].join('\u0001');
    if (sig !== S.sig) {
      S.sig = sig;
      box.textContent = '';
      var keepTop = list.scrollTop;
      list.textContent = '';
      if (st === 'connected') drawConnected(box, list);
      else drawApp(box, S.status || { state: 'checking' });
      list.scrollTop = keepTop;
    }
    box.hidden = !box.firstChild;
    list.hidden = !list.firstChild;
    S.addRow.hidden = st !== 'connected';
    S.clear.hidden = !S.input.value;
    S.kbdLine.textContent = st === 'connected' ? (S.kbdWhy || '') : '';
    S.kbdLine.hidden = !S.kbdLine.textContent;
    S.noteEl.textContent = S.noteText || '';
    S.noteEl.hidden = !S.noteText;
    S.noteEl.classList.toggle('bad', !!S.noteBad);
    if (!quiet) relayout();
  }

  /* Called by bar.js from its card repaint, BEFORE it measures the card for bar.popover: size the
     scrolling part so the whole card fits main's room. */
  function fit(pop) {
    if (!S) return;
    pop.classList.remove('spq-squeeze');
    S.sqLine.hidden = true;
    if (!expanded || S.root.hidden) return;
    var sc = S.scroll;
    sc.style.maxHeight = LIST_PREF + 'px';
    var over = pop.offsetHeight + 16 - ROOM_MAX;
    var have = Math.min(LIST_PREF, sc.offsetHeight);
    /* Two sources (Spotify + an LessonPlayer lesson) add the switcher's rows: with the queue open there
       is then no room for a useful list, so the switcher folds away, SAID in the card, until Up next
       is closed again. */
    var src = pop.querySelector('.mc-src');
    if (over > 0 && src && !src.hidden && have - over < Math.min(have, LIST_WANT)) {
      pop.classList.add('spq-squeeze');
      S.sqLine.hidden = false;
      over = pop.offsetHeight + 16 - ROOM_MAX;
    }
    if (over > 0) sc.style.maxHeight = Math.max(LIST_MIN, Math.min(LIST_PREF, sc.offsetHeight) - over) + 'px';
  }

  /* ------------------------------------------------------------------ bar.js hooks */

  window.MantleSpotify = {
    isSpotify: isSpotify,

    /* api: { call, on, msg, repaint } from bar.js. Returns the section (already in the card). */
    attach: function (pop, before, api) {
      if (S) this.closed();
      var root = mk('div', 'spq');
      var head = mk('button', 'spq-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false');
      var ico = mk('span', 'spq-ico'); ico.innerHTML = svg(G.queue, 14);
      var label = mk('span', 'spq-label', 'Up next');
      var hint = mk('span', 'spq-hint');
      var chev = mk('span', 'spq-chev'); chev.innerHTML = svg(G.chev, 14);
      head.appendChild(ico); head.appendChild(label); head.appendChild(hint); head.appendChild(chev);
      root.appendChild(head);

      var body = mk('div', 'spq-body');
      var scroll = mk('div', 'spq-scroll');
      var state = mk('div', 'spq-state');
      var list = mk('div', 'spq-list');
      scroll.appendChild(state); scroll.appendChild(list);
      body.appendChild(scroll);

      var addRow = mk('div', 'spq-add');
      var sico = mk('span', 'spq-sico'); sico.innerHTML = svg(G.search, 13);
      var input = mk('input', 'spq-input spq-search');
      input.type = 'text'; input.placeholder = 'Add a song…'; input.spellcheck = false;
      input.setAttribute('aria-label', 'Search Spotify for a song to add to the queue');
      var clear = mk('button', 'spq-clear'); clear.type = 'button'; clear.innerHTML = svg(G.x, 12); clear.title = 'Clear the search';
      addRow.appendChild(sico); addRow.appendChild(input); addRow.appendChild(clear);
      body.appendChild(addRow);
      var kbdLine = mk('div', 'spq-msg bad');
      body.appendChild(kbdLine);
      var noteEl = mk('div', 'spq-note');
      body.appendChild(noteEl);
      var sqLine = mk('div', 'spq-fine', 'Sources are hidden while Up next is open.');
      sqLine.hidden = true;
      sqLine.title = 'The card has room for the queue or the source switcher, not both: close Up next to switch source';
      body.appendChild(sqLine);
      root.appendChild(body);
      pop.insertBefore(root, before || null);

      S = { api: api, root: root, head: head, hint: hint, body: body, scroll: scroll, state: state, list: list,
        addRow: addRow, input: input, sqLine: sqLine, clear: clear, kbdLine: kbdLine, noteEl: noteEl,
        status: null, q: null, qErr: null, results: null, query: '', added: {}, busy: '', noteText: '', noteBad: false,
        shown: null, sig: '', trackSig: null, timer: 0, settle: 0, searchTimer: 0, kbd: '', kbdWhy: '', loading: false, restartArmed: false };

      head.addEventListener('click', function () {
        expanded = !expanded;
        arm();
        if (expanded) refresh(true);
        render();
      });
      input.addEventListener('mousedown', wantKeyboard);
      input.addEventListener('input', searchSoon);
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); searchSoon(); } });
      clear.addEventListener('click', function () { input.value = ''; searchSoon(); });

      /* A dead subscription is SAID (no silent failures): without the push, a Start or Restart
         finishing elsewhere would not show until the next 8 s read. */
      var mine = S;
      S.unsub = api.on ? api.on('spotify.status', function (st) { if (S === mine) setStatus(st); }, function (reason) {
        if (S === mine) say('Spotify’s live status is off (' + reason + '): the list still refreshes every 8 s while open', true);
      }) : null;
      loadStatus();
      return root;
    },

    /* From bar.js's card repaint (every 'media' push and every re-measure). Cheap when nothing
       changed; a new track (title/artist) re-reads the queue once Spotify has caught up. */
    paint: function (s, pop) {
      if (!S) return;
      var spot = isSpotify(s) ? s : null;
      var was = !!S.shown;
      S.shown = spot;
      if (!!spot !== was) {
        arm();
        // switched back to Spotify with the list open: read it now, not in 8 s. refresh(false) never
        // renders itself (this is inside bar.js's repaint); render(true) below draws "Loading…".
        if (spot && expanded) refresh(false);
        render(true);
      }
      if (spot) {
        var t = [spot.aumid, spot.title, spot.artist].join('|');
        if (S.trackSig !== null && t !== S.trackSig && expanded) {
          if (S.settle) clearTimeout(S.settle);
          S.settle = setTimeout(function () { if (S) { S.settle = 0; refresh(false); } }, TRACK_SETTLE_MS);
        }
        S.trackSig = t;
      }
      if (pop) fit(pop);
    },

    closed: function () {
      if (!S) return;
      if (S.timer) clearInterval(S.timer);
      if (S.settle) clearTimeout(S.settle);
      if (S.searchTimer) clearTimeout(S.searchTimer);
      if (S.unsub) { try { S.unsub(); } catch (e) { /* gone */ } }
      if (S.kbd === 'yes') S.api.call('qs.keyboard', { on: false }).catch(function () {});
      S = null;
    }
  };
})();
