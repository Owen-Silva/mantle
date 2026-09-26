/* spotify.js - the "Up next" queue inside the now-playing card (spotq lane, 2026-09-25).
 *
 * Owen: "make a dropdown so i can see and adjust the queue too". Windows' media session has no
 * queue, so this reads Spotify's own (the Web API, through lib/features/spotify.js) and is drawn
 * ONLY when the card is showing Spotify. bar.js builds the card; this adds one collapsed row,
 * "Up next", between the transport buttons and the source list, which opens to:
 *   - the next songs (art, title, artist); a click plays that one. Spotify's API has no "play from
 *     queue", so main skips forward to it (N x next), which is what Spotify's own queue does with
 *     the songs before it: they are used up;
 *   - "Add a song": search, click a result, it goes to the END of the queue;
 *   - one line saying Spotify's API cannot remove or reorder, so there are no fake handles.
 * Every other state is said in the list's place: not set up (the steps + Client ID + Connect),
 * waiting for the browser, loading, empty, no active player, Premium required, signed out, and
 * any other failure with Spotify's own words.
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
  var TRACK_SETTLE_MS = 700;   // Spotify's API lags the media session by a moment on a track change

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
    note: '<path d="M6 11.6V3.9l6.4-1.4v7.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="4.6" cy="11.8" r="1.6" fill="currentColor"/><circle cx="11" cy="10.2" r="1.6" fill="currentColor"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    search: '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  };

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
    if (st.state !== 'connected') { S.q = null; S.qErr = null; S.results = null; }
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

  /* One read at a time; a result that lands after the card closed (or re-opened) is dropped. */
  function refresh(first) {
    // not while the card shows another source (LessonPlayer): paint() reads it once Spotify is shown again
    if (!S || !expanded || !S.shown || !S.status || S.status.state !== 'connected' || S.loading) return;
    var mine = S;
    S.loading = true;
    if (first && !S.q) render();
    call('queue').then(function (r) {
      if (S !== mine) return;
      S.loading = false;
      if (r.ok) { S.q = r; S.qErr = null; }
      else {
        S.qErr = r;
        if (r.state === 'expired' || r.state === 'setup') { loadStatus(); return; }
      }
      render();
    }, function (e) {
      if (S !== mine) return;
      S.loading = false;
      S.qErr = { state: 'error', reason: 'the queue could not be read: ' + why(e) };
      render();
    });
  }

  /* The 8 s refresh runs only while the list is open, the card is up and Spotify is connected. */
  function arm() {
    if (!S) return;
    var want = expanded && S.shown && S.status && S.status.state === 'connected';
    if (want && !S.timer) S.timer = setInterval(function () { refresh(false); }, REFRESH_MS);
    if (!want && S.timer) { clearInterval(S.timer); S.timer = 0; }
  }

  function say(text, bad) { if (!S) return; S.noteText = text || ''; S.noteBad = !!bad; render(); }

  /* ------------------------------------------------------------------ actions */

  function play(item, index) {
    if (S.busy) { say('still skipping to the last song you picked'); return; }
    var mine = S;
    S.busy = 'play:' + index;
    say('');
    call('play', { uri: item.uri, index: index }).then(function (r) {
      if (S !== mine) return;
      S.busy = '';
      if (!r.ok) {
        say((r.state === 'premium' ? '' : 'Did not play it: ') + (r.reason || 'Spotify refused and gave no reason'), true);
        if (r.state === 'expired') loadStatus();
      } else if (!r.verified) say(r.reason, true);
      else say('Playing “' + item.name + '”' + (r.skipped > 1 ? ' (skipped ' + (r.skipped - 1) + ' before it)' : ''));
      refresh(false);
    }, function (e) {
      if (S !== mine) return;
      S.busy = '';
      say('Did not play it: ' + why(e), true);
    });
    render();
  }

  function add(item) {
    if (S.busy) return;
    var mine = S;
    S.busy = 'add:' + item.uri;
    render();
    call('add', { uri: item.uri }).then(function (r) {
      if (S !== mine) return;
      S.busy = '';
      if (r.ok) { S.added[item.uri] = true; say('Added “' + item.name + '” to the end of the queue'); refresh(false); }
      else { say('Not added: ' + (r.reason || 'Spotify refused and gave no reason'), true); if (r.state === 'expired') loadStatus(); }
    }, function (e) {
      if (S !== mine) return;
      S.busy = '';
      say('Not added: ' + why(e), true);
    });
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

  function connect() {
    var mine = S;
    var id = S.idInput ? S.idInput.value.trim() : '';
    var first = id && (!S.status || id.toLowerCase() !== String(S.status.clientId || '').toLowerCase())
      ? call('setClient', { clientId: id }) : Promise.resolve({ ok: true });
    say('');
    first.then(function (r) {
      if (S !== mine) return null;
      if (r && r.ok === false) { say(r.reason, true); return null; }
      if (r && r.state) setStatus(r);
      return call('connect');
    }).then(function (r) {
      if (!r || S !== mine) return;
      if (!r.ok) say('Not connected: ' + (r.reason || 'no reason given'), true);
      else if (r.dryRun) say('Test instance: the browser was not opened (dry run)');
      loadStatus();
    }, function (e) { if (S === mine) say('Not connected: ' + why(e), true); });
  }

  /* ------------------------------------------------------------------ drawing */

  function stateLine(text, cls) {
    var d = mk('div', 'spq-msg' + (cls ? ' ' + cls : ''), text);
    return d;
  }
  function linkBtn(text, fn, cls) {
    var b = mk('button', 'spq-link' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function drawSetup(box) {
    var st = S.status || {};
    if (st.reason) box.appendChild(stateLine(st.reason, 'bad'));
    var ol = mk('ol', 'spq-steps');
    var li1 = mk('li');
    li1.appendChild(document.createTextNode('Open '));
    li1.appendChild(linkBtn('developer.spotify.com/dashboard', function () {
      call('openDashboard').then(function (r) { if (!r.ok) say(r.reason, true); else if (r.dryRun) say('Test instance: the browser was not opened (dry run)'); },
        function (e) { say('The browser did not open: ' + why(e), true); });
    }));
    li1.appendChild(document.createTextNode(' and choose Create app.'));
    ol.appendChild(li1);
    ol.appendChild(mk('li', null, 'Under “Which API/SDKs”, tick Web API.'));
    var li3 = mk('li');
    var uriHead = mk('div', 'spq-urihead');
    uriHead.appendChild(mk('span', null, 'Add this Redirect URI, exactly:'));
    var copy = mk('button', 'spq-chip', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      call('copyRedirect').then(function (r) {
        if (!r.ok) say('Not copied: ' + r.reason, true);
        else say(r.dryRun ? 'Test instance: the clipboard was not touched (dry run)' : 'Redirect URI copied');
      }, function (e) { say('Not copied: ' + why(e), true); });
    });
    uriHead.appendChild(copy);
    li3.appendChild(uriHead);
    li3.appendChild(mk('code', 'spq-uri', st.redirectUri || 'http://127.0.0.1:47291/callback'));
    ol.appendChild(li3);
    ol.appendChild(mk('li', null, 'Save, then paste the app’s Client ID:'));
    box.appendChild(ol);

    var row = mk('div', 'spq-idrow');
    var inp = S.idInput || mk('input', 'spq-input');
    inp.type = 'text'; inp.spellcheck = false; inp.placeholder = 'Client ID';
    inp.setAttribute('aria-label', 'Spotify Client ID');
    if (!S.idInput) {
      if (st.clientId) inp.value = st.clientId;
      inp.addEventListener('mousedown', wantKeyboard);
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); connect(); } });
      S.idInput = inp;
    }
    row.appendChild(inp);
    var go = mk('button', 'spq-btn', 'Connect');
    go.type = 'button';
    go.addEventListener('click', connect);
    row.appendChild(go);
    box.appendChild(row);
    if (S.kbdWhy) box.appendChild(stateLine(S.kbdWhy, 'bad'));
    box.appendChild(mk('div', 'spq-fine', st.encryption === false
      ? 'Windows encryption is not available, so Mantle cannot save a sign-in (it is never saved unencrypted).'
      : 'Needs Spotify Premium. The sign-in is saved encrypted on this PC.'));
  }

  function row(item, index, mode) {
    var b = mk('button', 'spq-row');
    b.type = 'button';
    var art = mk('span', 'spq-art');
    if (item.image) { var im = document.createElement('img'); im.alt = ''; im.src = item.image; art.appendChild(im); }
    else { art.innerHTML = svg(G.note, 12); art.title = item.imageReason || ''; }
    b.appendChild(art);
    var txt = mk('span', 'spq-txt');
    txt.appendChild(mk('span', 'spq-t', item.name));
    txt.appendChild(mk('span', 'spq-a', item.artists || (item.kind === 'episode' ? 'Podcast episode' : '')));
    b.appendChild(txt);
    if (mode === 'queue') {
      b.title = 'Play now: skips the current song' + (index ? ' and the ' + index + ' queued before it' : '') + ', which is what Spotify’s own queue does';
      if (S.busy === 'play:' + index) b.classList.add('busy');
      b.addEventListener('click', function () { play(item, index); });
    } else {
      var done = S.added[item.uri];
      var tag = mk('span', 'spq-tag', done ? 'Added' : (S.busy === 'add:' + item.uri ? 'Adding…' : 'Add'));
      b.appendChild(tag);
      b.title = 'Add “' + item.name + '” to the end of the queue';
      if (done) b.classList.add('done');
      b.addEventListener('click', function () { add(item); });
    }
    return b;
  }

  function drawConnected(box, list) {
    var searching = !!S.query;
    if (searching) {
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
      if (err.state === 'offline' || err.state === 'http' || err.state === 'error' || err.state === 'nodevice')
        box.appendChild(linkBtn('Try again', function () { S.qErr = null; refresh(true); }, 'act'));
      return;
    }
    if (!q) { box.appendChild(stateLine(S.loading ? 'Loading the queue…' : 'Not loaded yet.', 'dim')); return; }
    if (q.noPlayer) { box.appendChild(stateLine('Spotify has no active player right now: start something in Spotify first.', 'dim')); return; }
    if (!q.items.length) { box.appendChild(stateLine('Nothing is queued after this song.', 'dim')); return; }
    q.items.forEach(function (it, i) { list.appendChild(row(it, i, 'queue')); });
  }

  /* quiet: called from inside bar.js's own repaint, which measures the card itself afterwards */
  function render(quiet) {
    if (!S) return;
    var st = S.status ? S.status.state : 'loading';
    var show = !!S.shown;
    S.root.hidden = !show;
    if (!show) { if (!quiet) relayout(); return; }

    // the collapsed row: what is in there, in two or three words
    S.head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    S.root.classList.toggle('open', expanded);
    var hint = st === 'setup' ? 'Set up' : st === 'connecting' ? 'Waiting for browser' : st === 'expired' ? 'Signed out'
      : st === 'off' || st === 'missing' ? 'Off'
      : st === 'connected' && S.qErr ? ({ premium: 'Premium needed', offline: 'Offline', nodevice: 'No player', forbidden: 'Refused' }[S.qErr.state] || 'Error')
      : st === 'connected' && S.q && !S.q.noPlayer ? (S.q.items.length ? S.q.items.length + ' queued' : 'Empty')
      : '';
    S.hint.textContent = hint;
    S.hint.classList.toggle('warn', st === 'expired' || !!(st === 'connected' && S.qErr));
    S.body.hidden = !expanded;
    if (!expanded) { if (!quiet) relayout(); return; }

    var box = S.state, list = S.list;
    // keep the list (and its scroll) when nothing in it changed
    var sig = [st, S.query, S.searching, S.loading && !S.q, S.busy, JSON.stringify(S.added),
      S.q && S.q.at, S.qErr && S.qErr.reason, S.results && (S.results.q + (S.results.items || []).length + (S.results.reason || '')),
      S.kbdWhy, S.status && S.status.reason, S.status && S.status.clientId].join('\u0001');
    if (sig !== S.sig) {
      S.sig = sig;
      box.textContent = '';
      var keepTop = list.scrollTop;
      list.textContent = '';
      if (st === 'loading') box.appendChild(stateLine('Checking the Spotify connection…', 'dim'));
      else if (st === 'missing' || st === 'off') box.appendChild(stateLine(S.status.reason || 'the Spotify queue is off', 'bad'));
      else if (st === 'setup') drawSetup(box);
      else if (st === 'connecting') {
        box.appendChild(stateLine('Waiting for you to approve Mantle in your browser…', 'dim'));
        box.appendChild(mk('div', 'spq-fine', 'Mantle listens on ' + String((S.status.redirectUri || '').replace(/^http:\/\//, '').replace(/\/callback$/, '')) + ' for Spotify’s answer, for up to 5 minutes.'));
        box.appendChild(linkBtn('Cancel', function () { call('cancel').then(setStatus, function (e) { say('Not cancelled: ' + why(e), true); }); }, 'act'));
      } else if (st === 'expired') {
        box.appendChild(stateLine(S.status.reason || 'Spotify signed Mantle out', 'bad'));
        box.appendChild(linkBtn('Connect again', connect, 'act'));
      } else if (st === 'connected') drawConnected(box, list);
      list.scrollTop = keepTop;
    }
    box.hidden = !box.firstChild;
    list.hidden = !list.firstChild;
    S.addRow.hidden = st !== 'connected';
    S.clear.hidden = !S.input.value;
    S.limit.hidden = st !== 'connected';
    S.kbdLine.textContent = st === 'connected' ? (S.kbdWhy || '') : '';
    S.kbdLine.hidden = !S.kbdLine.textContent;
    S.noteEl.textContent = S.noteText || '';
    S.noteEl.hidden = !S.noteText;
    S.noteEl.classList.toggle('bad', !!S.noteBad);
    S.foot.hidden = st !== 'connected' && st !== 'expired';
    S.disc.textContent = S.discArmed ? 'Click again to disconnect' : 'Disconnect Spotify';
    S.disc.classList.toggle('armed', !!S.discArmed);
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
      var limit = mk('div', 'spq-fine spq-limit', 'Spotify’s API can’t remove or reorder songs.');
      limit.title = 'Spotify’s Web API can only read the queue and add to its end, so removing or moving a song stays in the Spotify app';
      body.appendChild(limit);
      var sqLine = mk('div', 'spq-fine', 'Sources are hidden while Up next is open.');
      sqLine.hidden = true;
      sqLine.title = 'The card has room for the queue or the source switcher, not both: close Up next to switch source';
      body.appendChild(sqLine);
      var foot = mk('div', 'spq-foot');
      var disc = linkBtn('Disconnect Spotify', function () {
        if (!S.discArmed) { S.discArmed = true; render(); setTimeout(function () { if (S && S.discArmed) { S.discArmed = false; render(); } }, 3500); return; }
        S.discArmed = false;
        call('disconnect').then(function (r) { if (r.ok === false) say(r.reason, true); else { say('Disconnected. The Client ID is kept, so Connect is one click.'); setStatus(r); } },
          function (e) { say('Not disconnected: ' + why(e), true); });
      }, 'spq-disc');
      foot.appendChild(disc);
      body.appendChild(foot);
      root.appendChild(body);
      pop.insertBefore(root, before || null);

      S = { api: api, root: root, head: head, hint: hint, body: body, scroll: scroll, state: state, list: list,
        addRow: addRow, input: input, sqLine: sqLine, clear: clear, kbdLine: kbdLine, noteEl: noteEl, limit: limit, foot: foot, disc: disc,
        status: null, q: null, qErr: null, results: null, query: '', added: {}, busy: '', noteText: '', noteBad: false,
        shown: null, sig: '', trackSig: null, timer: 0, settle: 0, searchTimer: 0, kbd: '', kbdWhy: '', idInput: null, loading: false };

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

      /* A dead subscription is SAID (no silent failures): without the push, "Waiting for browser"
         never turns into the queue on its own, so the card says why and how to get past it. */
      var mine = S;
      S.unsub = api.on ? api.on('spotify.status', function (st) { if (S === mine) setStatus(st); }, function (reason) {
        if (S === mine) say('Spotify’s live status is off (' + reason + '): close and reopen this card to see a new sign-in', true);
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
