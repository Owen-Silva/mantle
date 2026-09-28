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
 * SPOTHIDE LANE (2026-09-26): Owen: "i can just start it and play music ... without opening the app".
 * Mantle starts Spotify HIDDEN (lib/features/_spotify-app.js), so the section is now "Spotify": a line
 * saying it runs hidden and its memory, with Open Spotify / Hide window and Quit (two clicks); tabs
 * Up next | Library (Liked Songs, playlists, artists, albums) with shuffle and repeat; and one search
 * over songs, artists, albums and playlists where a tap PLAYS it (a song's + still queues it).
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

  var ROOM_MAX = 480;          // the card's own budget (DIP), under main.js POPOVER_MAX (640 since 2026-09-27, was this 480)
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
    search: '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    // spothide lane
    shuffle: '<path d="M2 4.5h2.6c1.4 0 2.2.7 3 2l1 1.6c.8 1.3 1.6 2 3 2H14M2 11.5h2.6c1.4 0 2.2-.7 3-2M9.4 6.3c.8-1.2 1.6-1.8 2.9-1.8H14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.4 2.8L14.2 4.5 12.4 6.2M12.4 9.8L14.2 11.5 12.4 13.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    repeat: '<path d="M3 7.5V6.5A2 2 0 0 1 5 4.5h8M13 8.5v1a2 2 0 0 1-2 2H3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11.3 2.8L13 4.5 11.3 6.2M4.7 9.8L3 11.5 4.7 13.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    heart: '<path d="M8 13.2S2.5 9.9 2.5 6.1A2.9 2.9 0 0 1 8 4.8a2.9 2.9 0 0 1 5.5 1.3c0 3.8-5.5 7.1-5.5 7.1z" fill="currentColor"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  };
  var KIND = { track: 'Song', episode: 'Episode', album: 'Album', artist: 'Artist', playlist: 'Playlist', show: 'Podcast' };
  var REPEAT = ['Repeat: off', 'Repeat: all', 'Repeat: this song'];
  function mbText(v) { return v == null ? '' : v >= 1000 ? (v / 1024).toFixed(1) + ' GB' : v + ' MB'; }
  function mb(m) { if (!m) return ''; return mbText(m.privateWsMB != null ? m.privateWsMB : m.wsMB); }
  function ago(at) { var sec = Math.max(0, (Date.now() - at) / 1000); return sec < 60 ? 'just now' : sec < 3600 ? Math.round(sec / 60) + ' min ago' : Math.round(sec / 3600) + ' h ago'; }
  function cap(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }
  /* sptrim lane: the memory watch, from the push or from info, whichever read is newer (a tie goes to
     the push: it carries a stop). */
  function watchView() {
    var ws = S.status && S.status.window && S.status.window.watch, wi = S.info && S.info.window && S.info.window.watch;
    return ws && wi ? ((wi.at || 0) > (ws.at || 0) ? wi : ws) : ws || wi || null;
  }
  var HINT = { checking: '', notrunning: 'Not running', noport: 'Needs restart', starting: 'Starting…', loading: 'Loading…', portbusy: 'Port busy',
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
    if (st.state === 'connected' && was !== 'connected' && expanded) { refresh(true); loadInfo(); if (S.tab === 'lib') loadLib(); }
    if (st.state !== 'connected') { S.info = null; S.quitArmed = false; }
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
      else if (r.loading) say(r.note || 'Spotify is still loading; Mantle connects once it has loaded.');
      else if (r.note) say(r.note, true);
      else say(verb === 'restart' ? 'Spotify restarted. Press play to carry on.' : 'Spotify started.');
      loadStatus();
    }, function (e) { if (S === mine) { say('Spotify was not ' + (verb === 'restart' ? 'restarted' : 'started') + ': ' + why(e), true); loadStatus(); } });
  }

  /* ------------------------------------------------------------------ spothide lane: the hidden app */

  /* Running hidden or shown, its memory, shuffle and repeat: read on opening, on connecting and after
     each window action (one PowerShell read in main; never on a timer). */
  function loadInfo() {
    if (!S || S.infoLoading) return;
    var mine = S;
    S.infoLoading = true;
    call('info').then(function (r) {
      if (S !== mine) return;
      S.infoLoading = false; S.info = r.ok ? r : null; S.infoErr = r.ok ? '' : (r.reason || 'Spotify’s state could not be read');
      render();
    }, function (e) { if (S !== mine) return; S.infoLoading = false; S.infoErr = 'Spotify’s state could not be read: ' + why(e); render(); });
  }
  function loadLib() {
    if (!S || S.libLoading) return;
    var mine = S;
    S.libLoading = true; render();
    call('library').then(function (r) {
      if (S !== mine) return;
      S.libLoading = false;
      if (r.ok) { S.lib = r; S.libErr = null; } else S.libErr = r;
      render();
    }, function (e) { if (S !== mine) return; S.libLoading = false; S.libErr = { reason: 'your library could not be read: ' + why(e) }; render(); });
  }
  function setTab(t) { S.tab = t; if (t === 'lib' && !S.lib) loadLib(); else if (t === 'queue') refresh(true); render(); }
  function player() { return (S.info && S.info.player) || null; }
  function playCtx(item) {
    act('ctx:' + item.uri, 'playUri', { uri: item.uri }, function (r) {
      if (!r.ok) say('Did not play it: ' + (r.reason || 'Spotify gave no reason'), true);
      else if (!r.verified) say(r.reason, true);
      else say('Playing ' + (item.kind === 'artist' ? item.name : '“' + item.name + '”'));
      if (r.player && S.info) S.info.player = r.player;
    });
  }
  function control(verb, args, label) {
    act(verb, verb, args, function (r) {
      if (r.player && S.info) S.info.player = r.player;
      if (!r.ok) say(label + ' did not change: ' + (r.reason || 'Spotify gave no reason'), true);
      else if (!r.verified) say(r.reason, true);
      else say(verb === 'shuffle' ? (args.on ? 'Shuffle on' : 'Shuffle off') : REPEAT[args.mode]);
    });
  }
  function windowDo(verb) {
    act(verb, verb, {}, function (r) {
      if (r.dryRun) say('Test instance: ' + r.reason);
      else if (!r.ok) say((verb === 'openWindow' ? 'Spotify did not open: ' : 'Not hidden: ') + (r.reason || 'Spotify gave no reason'), true);
      else if (!r.verified) say(r.reason, true);
      else say(verb === 'openWindow' ? 'Spotify’s window is open.' : 'Spotify is hidden again.');
      loadInfo();
    });
  }
  /* Quit stops the music, so the first click only arms it and says so (as Restart does). */
  function quitApp() {
    if (!S.quitArmed) {
      S.quitArmed = true; render();
      setTimeout(function () { if (S && S.quitArmed) { S.quitArmed = false; render(); } }, 5000);
      return;
    }
    S.quitArmed = false;
    act('quit', 'quit', {}, function (r) {
      if (r.dryRun) say('Test instance: ' + r.reason);
      else if (!r.ok) say('Spotify did not quit: ' + (r.reason || 'no reason given'), true);
      else { S.info = null; S.lib = null; say('Spotify quit.'); }
      loadStatus();
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
      call('searchAll', { q: asked }).then(function (r) {
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

  /* spotdeath lane: "Restart Spotify after games" (main's revive view: on, state, text, plan). */
  function reviveOpt(st) {
    var rv = st && st.revive, lab = mk('label', 'spq-opt');
    var cb = mk('input');
    cb.type = 'checkbox';
    cb.checked = !rv || rv.on !== false;
    cb.addEventListener('change', function () {
      var on = cb.checked, mine = S;
      call('revive', { on: on }).then(function (r) {
        if (S !== mine) return;
        if (!r.ok) { cb.checked = !on; say('Not changed: ' + (r.reason || 'no reason given'), true); return; }
        loadStatus();
      }, function (e) { if (S === mine) { cb.checked = !on; say('Not changed: ' + why(e), true); } });
    });
    lab.title = 'When the hidden Spotify closes while a game runs, Mantle starts it again, hidden and not playing, after the game exits (once per game).';
    lab.appendChild(cb);
    lab.appendChild(mk('span', '', 'Restart Spotify after games'));
    return lab;
  }
  function reviveWords(st) { var rv = st && st.revive; return rv && rv.state && rv.state !== 'idle' && rv.text ? rv : null; }

  /* The not-connected states: what is wrong, why, and the one thing that fixes it. */
  function drawApp(box, st) {
    var s = st.state, reason = st.reason || '';
    if (s === 'checking') { box.appendChild(stateLine('Checking Spotify…', 'dim')); return; }
    if (s === 'starting') { box.appendChild(stateLine(reason || 'Starting Spotify…', 'dim')); box.appendChild(mk('div', 'spq-fine', 'Waiting for Spotify to open its local debugging port (up to 30 s).')); return; }
    if (s === 'loading') {
      box.appendChild(stateLine('Spotify is still loading.', 'dim'));
      box.appendChild(mk('div', 'spq-fine spq-why', reason || 'Its page has not finished loading yet.'));
      box.appendChild(linkBtn('Try again', function () { S.qErr = null; loadStatus(); }, 'act'));
      return;
    }
    if (s === 'notrunning') {
      var rv = reviveWords(st);
      box.appendChild(stateLine(rv ? rv.text : 'Spotify isn’t running.', rv ? 'bad' : ''));
      if (rv && rv.plan) box.appendChild(mk('div', 'spq-fine', rv.plan));
      box.appendChild(actBtn(rv && rv.state === 'waiting' && rv.on ? 'Start it now instead' : 'Start Spotify hidden', function () { launch('start'); }));
      box.appendChild(mk('div', 'spq-fine', 'It runs with no window: play your library and search from here. Mantle starts it with a local debugging port (127.0.0.1:' + (st.port || 47292) + ').'));
      box.appendChild(reviveOpt(st));
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
    if (item.liked) { art.innerHTML = svg(G.heart, 14); art.classList.add('liked'); }
    // secreview-sp lane: only the data: art main fetched from Spotify's image server. Never an address:
    // a file://host/share one would be an SMB fetch (the bar's CSP allows file: images).
    else if (typeof item.image === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(item.image)) { var im = document.createElement('img'); im.alt = ''; im.src = item.image; art.appendChild(im); }
    else { art.innerHTML = svg(G.note, 12); art.title = item.imageReason || ''; }
    b.appendChild(art);
    var txt = mk('span', 'spq-txt');
    txt.appendChild(mk('span', 'spq-t', item.name));
    txt.appendChild(mk('span', 'spq-a', item.artists || (item.kind === 'episode' ? 'Podcast episode' : item.kind === 'local' ? 'Local file' : '')));
    b.appendChild(txt);
    wrap.appendChild(b);
    var caps = (S.q && S.q.caps) || {};
    if (mode === 'search' || mode === 'lib') {
      // a tap plays it (spothide lane); a song can also go to the end of the queue
      if (item.kind === 'artist') art.classList.add('round');
      b.title = 'Play ' + (item.kind === 'artist' ? item.name : '“' + item.name + '”');
      if (S.busy === 'ctx:' + item.uri) wrap.classList.add('busy');
      b.addEventListener('click', function () { playCtx(item); });
      if (item.kind === 'track') {
        var done = S.added[item.uri];
        var tl = mk('div', 'spq-tools keep');
        tl.appendChild(tool(done ? G.note : G.plus, done ? 'Added to the queue' : 'Add to the end of the queue', function () { add(item); }, !!done));
        wrap.appendChild(tl);
      }
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

  function subLine(it) {
    var who = it.sub || it.owner || '';
    if (it.kind === 'track') return who;
    return (KIND[it.kind] || 'Spotify') + (who && it.kind !== 'artist' ? ' · ' + who : '');
  }
  function drawLib(box, list) {
    var l = S.lib, err = S.libErr;
    if (err) { box.appendChild(stateLine(err.reason || 'your library could not be read', 'bad')); box.appendChild(linkBtn('Try again', function () { S.libErr = null; loadLib(); }, 'act')); return; }
    if (!l) { box.appendChild(stateLine(S.libLoading ? 'Loading your library…' : 'Not loaded yet.', 'dim')); return; }
    list.appendChild(row({ uri: l.liked.uri, kind: 'collection', name: l.liked.name, artists: 'Playlist · your liked songs', image: '', liked: true }, 0, 'lib'));
    l.items.forEach(function (it, i) { list.appendChild(row({ uri: it.uri, kind: it.kind, name: it.name, artists: subLine(it), image: it.image, imageReason: it.imageReason }, i + 1, 'lib')); });
    if (l.skipped) list.appendChild(mk('div', 'spq-fine', l.skipped + ' folder' + (l.skipped > 1 ? 's or items' : ' or item') + ' Mantle cannot play ' + (l.skipped > 1 ? 'are' : 'is') + ' not listed'));
  }
  function drawConnected(box, list) {
    if (S.query) {
      var r = S.results;
      if (S.searching && !r) box.appendChild(stateLine('Searching…', 'dim'));
      else if (r && !r.ok) box.appendChild(stateLine(r.reason || 'the search failed', 'bad'));
      else if (r) {
        var any = false;
        [['tracks', 'Songs'], ['artists', 'Artists'], ['albums', 'Albums'], ['playlists', 'Playlists']].forEach(function (g) {
          var arr = r[g[0]] || [];
          if (!arr.length) return;
          any = true;
          list.appendChild(mk('div', 'spq-sec', g[1]));
          arr.forEach(function (it, i) { list.appendChild(row({ uri: it.uri, kind: it.kind, name: it.name, artists: subLine(it), image: it.image, imageReason: it.imageReason }, i, 'search')); });
        });
        if (!any) box.appendChild(stateLine('Nothing on Spotify matches “' + S.query + '”.', 'dim'));
      }
      return;
    }
    if (S.tab === 'lib') { drawLib(box, list); return; }
    var q = S.q, err = S.qErr;
    if (err) {
      box.appendChild(stateLine(err.reason || 'the queue could not be read', 'bad'));
      box.appendChild(linkBtn('Try again', function () { S.qErr = null; refresh(true); }, 'act'));
      return;
    }
    if (!q) { box.appendChild(stateLine(S.loading ? 'Loading the queue…' : 'Not loaded yet.', 'dim')); return; }
    if (!q.current && !q.queued.length && !q.nextUp.length) { box.appendChild(stateLine('Nothing is playing: pick something from Library, or search below.', 'dim')); return; }
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

  /* The hidden app's line (running hidden · its memory, Open / Hide window, Quit, and what went wrong
     in words) and the Up next | Library tabs with shuffle and repeat. Drawn only while connected. */
  function drawAppLine(st) {
    var line = S.appLine, tabs = S.tabs;
    line.textContent = ''; tabs.textContent = '';
    line.hidden = tabs.hidden = st !== 'connected';
    if (st !== 'connected') return;
    var w = (S.status && S.status.window) || null, inf = S.info, m = inf && inf.memory;
    var shown = inf && inf.visible != null ? inf.visible : w ? w.state === 'shown' : null;
    var main = mk('div', 'spq-appmain');
    var wv = watchView(), watching = !!(wv && wv.state === 'watching');
    var memTxt = watching && wv.mb != null && wv.at && Date.now() - wv.at < 90000 ? mbText(wv.mb) : m ? mb(m) : '';
    var trimTxt = watching ? (wv.lastTrim && wv.lastTrim.ok ? ' · trimmed ' + ago(wv.lastTrim.at) : ' · not trimmed yet') : '';
    var txt = mk('span', 'spq-apptxt', (shown === false ? 'Running hidden' : shown === true ? 'Window open' : 'Running') + (memTxt ? ' · ' + memTxt : S.infoLoading ? ' · …' : '') + trimTxt);
    txt.title = (m ? 'Spotify’s ' + m.n + ' processes: ' + (m.privateWsMB != null ? m.privateWsMB + ' MB of RAM of their own (Task Manager’s Memory), ' : '') + m.wsMB + ' MB working set, ' + m.privateMB + ' MB committed'
      : (inf && inf.memoryReason) || S.infoErr || 'Reading Spotify’s memory…') + (w && w.how ? (w.adopted && w.how === 'adopted after a Mantle restart' ? '\nTaken over after a Mantle restart: an earlier Mantle started and hid it' : '\nHidden by ' + w.how) : '') + (w && w.trim ? '\n' + w.trim.text : '')
      + (watching ? '\nMemory watch: trimmed when over ' + wv.aboveMB + ' MB, checked every 30 s, at most once every ' + Math.round(wv.gapMs / 60000) + ' min; never the process playing the audio'
        : wv && wv.state === 'stopped' && wv.reason ? '\nMemory watch stopped: ' + wv.reason : '')
      + (wv && wv.lastTrim ? '\n' + wv.lastTrim.text + ' (' + ago(wv.lastTrim.at) + ')' : '') + (wv && wv.note ? '\n' + cap(wv.note) : '');
    main.appendChild(txt);
    main.appendChild(linkBtn(shown === true ? 'Hide window' : 'Open Spotify', function () { windowDo(shown === true ? 'hideWindow' : 'openWindow'); }));
    main.appendChild(linkBtn(S.quitArmed ? 'Click again to quit' : 'Quit', quitApp, S.quitArmed ? 'warn' : ''));
    line.appendChild(main);
    var watchBad = wv ? (wv.state === 'unavailable' ? wv.reason : watching ? wv.error || (wv.lastTrim && !wv.lastTrim.ok ? wv.lastTrim.text : '') : '') : '';
    var bad = (w && w.state === 'failed' && w.reason) || (w && w.trim && !w.trim.ok && !w.trim.skipped && w.trim.text) || watchBad || S.infoErr || (inf && inf.memoryReason) || '';
    if (bad) line.appendChild(mk('div', 'spq-fine spq-bad', cap(bad)));
    else if (watching && wv.note) line.appendChild(mk('div', 'spq-fine', cap(wv.note)));
    var rv = S.status && S.status.revive;
    if (rv && rv.state === 'done' && rv.at && Date.now() - rv.at < 20 * 60000 && rv.plan) line.appendChild(mk('div', 'spq-fine', rv.text + ' ' + rv.plan));
    line.appendChild(reviveOpt(S.status));

    [['queue', 'Up next'], ['lib', 'Library']].forEach(function (t) {
      var c = mk('button', 'spq-chip' + (S.tab === t[0] ? ' on' : ''), t[1]);
      c.type = 'button';
      c.setAttribute('aria-pressed', S.tab === t[0] ? 'true' : 'false');
      c.addEventListener('click', function () {
        if (S.query) { S.input.value = ''; S.query = ''; S.results = null; }
        setTab(t[0]);
      });
      tabs.appendChild(c);
    });
    tabs.appendChild(mk('span', 'spq-gap'));
    var p = player(), off = !p ? 'Spotify’s player state is not read yet' + (inf && inf.playerReason ? ' (' + inf.playerReason + ')' : '') : '';
    var sh = tool(G.shuffle, off ? 'Shuffle: ' + off : p.canShuffle === false ? 'Shuffle: Spotify does not allow it here' : p.shuffle ? 'Shuffle is on (click to turn off)' : 'Shuffle is off (click to turn on)',
      function () { control('shuffle', { on: !p.shuffle }, 'Shuffle'); }, !p || p.canShuffle === false);
    var next = p ? (p.repeat + 1) % 3 : 1;
    var rp = tool(G.repeat, off ? 'Repeat: ' + off : p.canRepeat === false ? 'Repeat: Spotify does not allow it here' : REPEAT[p.repeat] + ' (click for ' + REPEAT[next].slice(8) + ')',
      function () { control('repeat', { mode: next }, 'Repeat'); }, !p || p.canRepeat === false);
    sh.setAttribute('aria-pressed', p && p.shuffle ? 'true' : 'false');
    rp.setAttribute('aria-pressed', p && p.repeat ? 'true' : 'false');
    if (p && p.shuffle) sh.classList.add('on');
    if (p && p.repeat) rp.classList.add('on');
    if (p && p.repeat === 2) rp.classList.add('one');
    tabs.appendChild(sh); tabs.appendChild(rp);
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
    var wst = S.status && S.status.window && S.status.window.state;
    if (st === 'connected' && wst === 'hidden') hint = 'Hidden' + (hint ? ' · ' + hint : '');
    else if (st === 'connected' && wst === 'failed') hint = S.status.window.takeOverFailed ? 'Not watched' : 'Not hidden';
    S.hint.textContent = hint;
    S.hint.classList.toggle('warn', st !== 'connected' && st !== 'checking' && st !== 'starting' && st !== 'loading' || !!S.qErr);
    S.body.hidden = !expanded;
    if (!expanded) { if (!quiet) relayout(); return; }

    var box = S.state, list = S.list;
    // keep the list (and its scroll) when nothing in it changed
    var sig = [st, S.status && S.status.reason, S.query, S.searching, S.loading && !S.q, S.busy, JSON.stringify(S.added), S.restartArmed,
      S.q && S.q.at, S.qErr && S.qErr.reason, S.results && (S.results.q + JSON.stringify([S.results.tracks, S.results.artists, S.results.albums, S.results.playlists].map(function (a) { return (a || []).length; })) + (S.results.reason || '')), S.kbdWhy,
      S.tab, S.lib && S.lib.at, S.libLoading, S.libErr && S.libErr.reason, JSON.stringify(S.status && S.status.window), JSON.stringify(S.info), S.infoErr, S.quitArmed].join('\u0001');
    if (sig !== S.sig) {
      S.sig = sig;
      drawAppLine(st);
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
      var label = mk('span', 'spq-label', 'Spotify');
      var hint = mk('span', 'spq-hint');
      var chev = mk('span', 'spq-chev'); chev.innerHTML = svg(G.chev, 14);
      head.appendChild(ico); head.appendChild(label); head.appendChild(hint); head.appendChild(chev);
      root.appendChild(head);

      var body = mk('div', 'spq-body');
      var appLine = mk('div', 'spq-app'); appLine.hidden = true;
      var tabs = mk('div', 'spq-tabs'); tabs.hidden = true;
      body.appendChild(appLine); body.appendChild(tabs);
      var scroll = mk('div', 'spq-scroll');
      var state = mk('div', 'spq-state');
      var list = mk('div', 'spq-list');
      scroll.appendChild(state); scroll.appendChild(list);
      body.appendChild(scroll);

      var addRow = mk('div', 'spq-add');
      var sico = mk('span', 'spq-sico'); sico.innerHTML = svg(G.search, 13);
      var input = mk('input', 'spq-input spq-search');
      input.type = 'text'; input.placeholder = 'Search songs, artists, albums…'; input.spellcheck = false;
      input.setAttribute('aria-label', 'Search Spotify: tap a result to play it');
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
        addRow: addRow, input: input, appLine: appLine, tabs: tabs, tab: 'queue', lib: null, libErr: null, libLoading: false, info: null, infoErr: '', infoLoading: false, quitArmed: false, sqLine: sqLine, clear: clear, kbdLine: kbdLine, noteEl: noteEl,
        status: null, q: null, qErr: null, results: null, query: '', added: {}, busy: '', noteText: '', noteBad: false,
        shown: null, sig: '', trackSig: null, timer: 0, settle: 0, searchTimer: 0, kbd: '', kbdWhy: '', loading: false, restartArmed: false };

      head.addEventListener('click', function () {
        expanded = !expanded;
        arm();
        if (expanded) { refresh(true); if (S.status && S.status.state === 'connected') loadInfo(); if (S.tab === 'lib' && !S.lib) loadLib(); }
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
