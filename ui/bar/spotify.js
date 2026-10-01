/* spotify.js - the "Up next" queue inside the now-playing card (spotq lane; rebuilt on the Spotify
 * DESKTOP APP by the spotapp lane, 2026-09-25).
 *
 * Owen: "make a dropdown so i can see and adjust the queue too". Windows' media session has no
 * queue, so this reads Spotify's own. The Web API version needed Premium (he has none), so main now
 * drives the Spotify desktop app itself over a local debugging port (lib/features/_spotify-app.js):
 * Spotify has to be started BY MANTLE for that, and the card says so and offers the button.
 * It is drawn ONLY when the card is showing Spotify: one collapsed row, "Spotify", between the
 * transport buttons and the source list, which opens to:
 *   - "Next in queue" (songs he added) and "Coming up" (the playlist/album that follows), with art; a
 *     click on a row plays it (Spotify's own jump: the songs before it are used up);
 *   - per row, on hover or keyboard focus: move up / move down (queued songs only: Spotify reorders
 *     only its queue) and remove;
 *   - one search box: search Spotify, click a result to play it, a song's + queues it.
 * Every other state is said in the list's place with its reason: checking, Spotify not running
 * (Start button), running without the port (Restart button, which warns playback stops), starting,
 * the port taken by something else, Spotify's internals not found (an update), not installed, off,
 * and each action's result (verified against a re-read of the queue).
 *
 * SPOTHIDE LANE (2026-09-26): Owen: "i can just start it and play music ... without opening the app".
 * Mantle starts Spotify HIDDEN (lib/features/_spotify-app.js); tabs Up next | Library (Liked Songs,
 * playlists, artists, albums) with shuffle and repeat; one search where a tap PLAYS it.
 *
 * MEDIA-UI LANE (2026-09-29, quality pass: "minimalistic and super easy to use and obvious what to do"):
 *   - the first screen is the player: tabs, the heart / shuffle / repeat, the list and search. The
 *     window line (running hidden, memory), Open Spotify / Hide window, Quit Spotify and the two game
 *     toggles moved behind a quiet "More" at the bottom (a warn dot on it when something in there is
 *     wrong); a window that could not be hidden is still said on the first screen, with its fix.
 *   - Like: a heart beside shuffle and repeat (spotify.like / info().liked, see the media CONTRACT),
 *     flipped at once and put back, with the reason, if Spotify refuses.
 *   - nothing loaded in Spotify: the section's first line is ONE button, "Play Liked Songs".
 *   - designed empty / loading (skeleton rows, so nothing jumps) / error states; every error in plain
 *     words (plain(): Spotify's internals and codes never reach the screen; the raw text is the tip).
 *   - HOLES closed: the list was rebuilt on every 8 s read (each read has a new `at`), which dropped
 *     keyboard focus and re-decoded every image: it now redraws only when what it shows changed, and
 *     focus is put back on the same row. Arm timers (Restart / Quit) and the note timer belonged to no
 *     card and could disarm a NEWER card: they are the card's own now, freed in closed(). A double-click
 *     never runs an action twice; the two game toggles are held while their change is on its way.
 *   - keyboard: arrows move through the list (one Tab stop), Delete removes, Alt+Up/Down moves, Shift+
 *     Enter queues a song result; Left/Right switch the tabs; Esc clears the search, shuts More or
 *     disarms Quit/Restart before it closes the card.
 *
 * FITTING: the card lives in the bar's one popover, and main gives a popover at most POPOVER_MAX px
 * (main.js; the card keeps to ROOM_MAX, under it), so a card taller than that would be cut off by the WINDOW, not by CSS (the
 * top bar's dropdown shipped clipped like that on 2026-09-24). The list therefore scrolls inside
 * the card, and its height is recomputed on every paint so the whole card always fits the room.
 *
 * COST: nothing while the list is shut but one status read when the card opens. While it is open:
 * one read on opening, one on each track change (the 'media' push), one every 8 s; all stop when it
 * shuts or the card closes.
 */
(function () {
  'use strict';

  /* r3-media lane: 600 (was 480, main's old cap). main gives up to POPOVER_MAX = 640 since 2026-09-27; at 480 the
     list showed two and a half songs, and with More open the card was 525 px, over its own budget. */
  var ROOM_MAX = 600;          // the card's own budget (DIP), under main.js POPOVER_MAX (640)
  var LIST_PREF = 244;         // the list's own cap when there is room: about five rows
  var LIST_MIN = 72;
  var LIST_WANT = 150;         // under this (about four rows), the card's source list folds away while Up next is open
  var REFRESH_MS = 8000;
  var TRACK_SETTLE_MS = 700;   // Spotify's queue lags the media session by a moment on a track change
  var ARM_MS = 5000;           // Quit / Restart: the second click must come within this
  var NOTE_MS = 6000;          // a good-news note clears itself; a warning stays until the next action
  var LIKED_URI = 'spotify:collection:tracks';
  var LIKE_URI_RE = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;

  var expanded = false;        // remembered across opens of the card, for this session
  var moreOpen = false;        // the "More" part, remembered the same way
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
  /* One icon family: a 16 grid, 1.3 stroke, round caps (the card's transport glyphs). */
  var G = {
    queue: '<path d="M2.5 4h8M2.5 8h8M2.5 12h5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11.5 10.2v3.6l3-1.8z" fill="currentColor"/>',
    chev: '<path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    up: '<path d="M4.5 9.5L8 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    down: '<path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    note: '<path d="M6 11.6V3.9l6.4-1.4v7.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="4.6" cy="11.8" r="1.6" fill="currentColor"/><circle cx="11" cy="10.2" r="1.6" fill="currentColor"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    search: '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    shuffle: '<path d="M2 4.5h2.6c1.4 0 2.2.7 3 2l1 1.6c.8 1.3 1.6 2 3 2H14M2 11.5h2.6c1.4 0 2.2-.7 3-2M9.4 6.3c.8-1.2 1.6-1.8 2.9-1.8H14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.4 2.8L14.2 4.5 12.4 6.2M12.4 9.8L14.2 11.5 12.4 13.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    repeat: '<path d="M3 7.5V6.5A2 2 0 0 1 5 4.5h8M13 8.5v1a2 2 0 0 1-2 2H3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11.3 2.8L13 4.5 11.3 6.2M4.7 9.8L3 11.5 4.7 13.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    heart: '<path d="M8 13.2S2.5 9.9 2.5 6.1A2.9 2.9 0 0 1 8 4.8a2.9 2.9 0 0 1 5.5 1.3c0 3.8-5.5 7.1-5.5 7.1z" fill="currentColor"/>',
    heartOff: '<path d="M8 13.2S2.5 9.9 2.5 6.1A2.9 2.9 0 0 1 8 4.8a2.9 2.9 0 0 1 5.5 1.3c0 3.8-5.5 7.1-5.5 7.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    check: '<path d="M3.5 8.4l2.9 2.9 6.1-6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    play: '<path d="M5.2 3.4v9.2L12.6 8z" fill="currentColor"/>',
    warn: '<path d="M8 2.6l5.9 10.4H2.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.6v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.3" r=".8" fill="currentColor"/>',
    off: '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.2 11.8l7.6-7.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  };
  var KIND = { track: 'Song', episode: 'Episode', album: 'Album', artist: 'Artist', playlist: 'Playlist', show: 'Podcast' };
  var REPEAT = ['Repeat: off', 'Repeat: all', 'Repeat: this song'];
  function mbText(v) { return v == null ? '' : v >= 1000 ? (v / 1024).toFixed(1) + ' GB' : v + ' MB'; }
  function mb(m) { if (!m) return ''; return mbText(m.privateWsMB != null ? m.privateWsMB : m.wsMB); }
  function ago(at) { var sec = Math.max(0, (Date.now() - at) / 1000); return sec < 60 ? 'just now' : sec < 3600 ? Math.round(sec / 60) + ' min ago' : Math.round(sec / 3600) + ' h ago'; }
  function cap(t) { t = String(t == null ? '' : t); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }
  /* sptrim lane: the memory watch, from the push or from info, whichever read is newer (a tie goes to
     the push: it carries a stop). */
  function watchView() {
    var ws = S.status && S.status.window && S.status.window.watch, wi = S.info && S.info.window && S.info.window.watch;
    return ws && wi ? ((wi.at || 0) > (ws.at || 0) ? wi : ws) : ws || wi || null;
  }
  /* The head's word per state: short, plain, and only when it tells something. */
  var HINT = { checking: '', notrunning: 'Not running', noport: 'Needs a restart', starting: 'Starting…', loading: 'Loading…', portbusy: 'Can’t connect',
    internals: 'Can’t connect', noinstall: 'Not installed', error: 'Can’t connect', off: 'Off', missing: 'Off' };

  /* media-ui lane: Spotify's and Mantle's own words for a failure are for Owen's logs, not the card.
     A reason that names Spotify's internals (function names, the page, the debugging port, socket
     codes) is said in plain words; anything else passes through with its first letter capitalised.
     The raw text stays on the line's tooltip, so nothing is lost. Exported for node tests. */
  var PLAIN = [
    [/unknown (command|verb)|no such command|not a (known )?command|no handler/i, 'This Mantle can’t do that yet: it needs an update'],
    [/page threw|TypeError|ReferenceError|is not a function|Cannot read propert/i, 'Spotify ran into a problem. Try again in a moment'],
    [/gave no answer|did not answer|didn’t answer|timed? ?out|hung\b|no answer/i, 'Spotify didn’t answer in time. Try again in a moment'],
    [/ECONN[A-Z]*|EPIPE|socket|websocket|connection (was )?(closed|reset|refused|lost)/i, 'Mantle lost its connection to Spotify. Try again in a moment'],
    [/skipTo failed/i, 'Spotify couldn’t jump to that song'],
    [/has no \w+\(\)|LibraryAPI|PlayerAPI|functions were not found|queue functions/i, 'This version of Spotify doesn’t allow that from Mantle'],
    [/\bdebugging port\b|127\.0\.0\.1:\d+|--remote-debugging/i, null]
  ];
  function plain(reason, fallback) {
    var t = String(reason == null ? '' : reason).trim();
    if (!t || t === 'undefined' || t === 'null' || t === '[object Object]') return fallback || 'Spotify gave no reason';
    for (var i = 0; i < PLAIN.length; i++) {
      if (!PLAIN[i][0].test(t)) continue;
      if (PLAIN[i][1]) return PLAIN[i][1];
      t = t.replace(/\s*\(?127\.0\.0\.1:\d+\)?/g, '').replace(/(its |the |a )?local debugging port/gi, 'Mantle’s connection').replace(/(its |the |a )?debugging port/gi, 'Mantle’s connection').replace(/\s*--remote-debugging[\w=-]*/g, '');
    }
    t = t.replace(/\s*\((E[A-Z]{3,}|0x[0-9a-f]{6,})[^)]*\)/gi, '').replace(/\b(E[A-Z]{4,}|0x[0-9a-f]{6,})\b:?\s*/g, '').replace(/\bpid \d+\b/gi, 'its process').replace(/\s+/g, ' ').trim();
    return cap(t) || fallback || 'Spotify gave no reason';
  }

  /* spotfix lane (2026-09-28): ONE source for the window's words. The header's word and the app line
     both come from here, so "Not hidden" next to "Running hidden" (seen live: the header read the
     window record, the line a later memory read) cannot happen again. w: the newest window record
     (the push or info, whichever came last; main keeps it true to its own reads); visible: the last
     read, used only for a Spotify whose window Mantle holds nothing about (or could not take over).
     -> { key, hint (header, '' = none), line (app line), bad (orange line, '' = none), act: the
     window link ({ text, verb }), mem: whether the memory follows the line } */
  function look(w, visible, now) {
    var st = w && w.state, byRead = visible === false ? 'Running hidden' : visible === true ? 'Window open' : 'Running';
    var openOrHide = visible === true ? { text: 'Hide window', verb: 'hideWindow' } : { text: 'Open Spotify', verb: 'openWindow' };
    if (st === 'hiding') {
      var n = w.trying || !w.retryAt ? 0 : Math.max(1, Math.ceil((w.retryAt - now) / 1000));
      return { key: 'hiding', hint: 'Hiding…', bad: '', mem: false, act: { text: 'Hide now', verb: 'hideWindow' },
        line: 'Hiding Spotify’s window… (' + (w.retryWhy || 'Spotify is slow to answer') + '; ' + (n ? 'trying again in ' + n + ' s' : 'trying again now') + ')' };
    }
    if (st === 'hidden') return { key: 'hidden', hint: 'Hidden', line: 'Running hidden', bad: '', mem: true, act: { text: 'Open Spotify', verb: 'openWindow' } };
    if (st === 'shown') return { key: 'shown', hint: '', line: 'Window open', bad: '', mem: true, act: { text: 'Hide window', verb: 'hideWindow' } };
    if (st === 'failed' && w.takeOverFailed) return { key: 'unwatched', hint: 'Not watched', line: byRead, bad: w.reason || '', mem: true, act: openOrHide };
    if (st === 'failed') {
      return { key: 'failed', hint: 'Not hidden', line: visible === true ? 'Window open' : 'Running', bad: w.reason || 'Spotify’s window could not be hidden', mem: true,
        act: w.own ? { text: 'Hide now', verb: 'hideWindow' } : openOrHide };
    }
    return { key: 'none', hint: '', line: byRead, bad: '', mem: true, act: openOrHide };
  }
  function lookNow() { return look(S.win || null, S.info && S.info.visible != null ? S.info.visible : null, Date.now()); }

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
    if (Object.prototype.hasOwnProperty.call(st, 'window')) S.win = st.window;   // look(): the newest window record
    if (st.state !== 'connected') { S.q = null; S.qErr = null; }
    if (st.state === 'connected' && was !== 'connected' && expanded) { refresh(true); loadInfo(); if (S.tab === 'lib') loadLib(); }
    if (st.state !== 'connected') { S.info = null; S.liked = null; S.quitArmed = false; }
    if (st.state !== 'noport') S.restartArmed = false;
    arm();
    render();
  }

  function loadStatus() {
    var mine = S;
    call('status').then(function (st) { if (S === mine) setStatus(st); }, function (e) {
      if (S !== mine) return;
      setStatus({ state: 'missing', reason: 'Spotify controls are not loaded in Mantle (' + why(e) + ')' });
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
      S.qErr = { state: 'error', reason: why(e) };
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

  /* The result line under the search box. Good news clears itself after NOTE_MS; a warning stays
     until the next action. `raw` (Mantle's own words) is its tooltip. */
  function say(text, bad, raw) {
    if (!S) return;
    if (S.noteTimer) { clearTimeout(S.noteTimer); S.noteTimer = 0; }
    S.noteText = text || ''; S.noteBad = !!bad; S.noteRaw = raw && raw !== text ? String(raw) : '';
    if (text && !bad) {
      var mine = S;
      S.noteTimer = setTimeout(function () { if (S === mine) { S.noteTimer = 0; S.noteText = ''; render(); } }, NOTE_MS);
    }
    render();
  }
  function fail(prefix, r) { say(prefix + plain(r && r.reason), true, r && r.reason); }

  /* Quit and Restart stop the music, so the first click only arms them; the second must come
     within ARM_MS. The timer is the card's own (a newer card is never disarmed by an older one). */
  function armOnce(flag) {
    var mine = S;
    S[flag] = true;
    if (S.armTimer) clearTimeout(S.armTimer);
    S.armTimer = setTimeout(function () { if (S === mine) { S.armTimer = 0; S[flag] = false; render(); } }, ARM_MS);
    render();
  }
  function disarm() {
    if (!S) return false;
    var was = S.quitArmed || S.restartArmed;
    S.quitArmed = S.restartArmed = false;
    if (S.armTimer) { clearTimeout(S.armTimer); S.armTimer = 0; }
    return was;
  }

  /* ------------------------------------------------------------------ actions */

  /* One action at a time (they each re-read the queue to verify); the result is always said. The
     same action asked again while it runs (a double-click) is simply the same action: not repeated,
     not scolded. */
  function act(key, verb, args, done) {
    if (S.busy) { if (S.busy !== key) say('Still working on the last change…'); return false; }
    var mine = S;
    S.busy = key;
    say('');
    call(verb, args).then(function (r) {
      if (S !== mine) return;
      S.busy = '';
      if (!r.ok && r.state && r.state !== 'error' && r.state !== 'moved' && r.state !== 'busy' && r.state !== 'connected') setStatus({ state: r.state, reason: r.reason });
      done(r);
      refresh(false);
      render();
    }, function (e) {
      if (S !== mine) return;
      S.busy = '';
      done({ ok: false, reason: why(e) });
      render();
    });
    render();
    return true;
  }
  function play(item) {
    act('play:' + item.uid + item.uri, 'play', { uri: item.uri, uid: item.uid }, function (r) {
      if (!r.ok) fail('Didn’t play it: ', r);
      else if (!r.verified) say(plain(r.reason), true, r.reason);
      else say('Playing “' + item.name + '”' + (r.note ? ' (' + r.note + ')' : ''));
    });
  }
  function remove(item) {
    act('rm:' + item.uid + item.uri, 'remove', { uri: item.uri, uid: item.uid }, function (r) {
      if (!r.ok) fail('Not removed: ', r);
      else if (!r.verified) say(plain(r.reason), true, r.reason);
      else say('Removed “' + item.name + '” from the queue');
    });
  }
  function move(item, dir) {
    act('mv:' + item.uid + item.uri, 'move', { uri: item.uri, uid: item.uid, dir: dir }, function (r) {
      if (!r.ok) fail('Not moved: ', r);
      else if (!r.verified) say(plain(r.reason), true, r.reason);
      else say('Moved “' + item.name + '” ' + dir);
    });
  }
  function add(item) {
    act('add:' + item.uri, 'add', { uri: item.uri }, function (r) {
      if (r.ok) { S.added[item.uri] = true; if (r.verified) say('Added “' + item.name + '” to the queue'); else say(plain(r.reason), true, r.reason); }
      else fail('Not added: ', r);
    });
  }

  /* Start (Spotify not running) or Restart (running without the port). Restart stops playback, so
     the first click only arms it and says so; the second does it. */
  function launch(verb) {
    if (verb === 'restart' && !S.restartArmed) { armOnce('restartArmed'); return; }
    if (S.launching) return;                                  // a double-click on Start
    disarm();
    var mine = S;
    S.launching = true;
    setStatus({ state: 'starting', reason: verb === 'restart' ? 'Closing Spotify…' : 'Starting Spotify…' });
    call(verb).then(function (r) {
      if (S !== mine) return;
      S.launching = false;
      if (r.dryRun) say('Test instance: ' + r.reason);
      else if (!r.ok) fail(verb === 'restart' ? 'Not restarted: ' : 'Not started: ', r);
      else if (r.loading) say(r.note ? plain(r.note) : 'Spotify is still loading; it connects once it has loaded.', !!r.forced, r.note);
      else if (r.note) say(plain(r.note), true, r.note);
      else if (r.hidden === false && r.reason) say('Spotify started. ' + plain(r.reason), !r.hiding, r.reason);   // spotfix lane: its window is not hidden (yet)
      else say(verb === 'restart' ? 'Spotify restarted. Press play to carry on.' : 'Spotify started.');
      loadStatus();
    }, function (e) { if (S === mine) { S.launching = false; say('Spotify was not ' + (verb === 'restart' ? 'restarted' : 'started') + ': ' + plain(why(e)), true, why(e)); loadStatus(); } });
  }

  /* ------------------------------------------------------------------ spothide lane: the hidden app */

  /* Running hidden or shown, its memory, shuffle, repeat and (media-ui) whether the song is liked:
     read on opening, on connecting, on a track change and after each window action (one PowerShell
     read in main; never on a timer). */
  function loadInfo() {
    if (!S || S.infoLoading) return;
    var mine = S;
    S.infoLoading = true;
    call('info').then(function (r) {
      if (S !== mine) return;
      S.infoLoading = false; S.info = r.ok ? r : null; S.infoErr = r.ok ? '' : (r.reason || 'Spotify’s state could not be read');
      if (r.ok && Object.prototype.hasOwnProperty.call(r, 'window')) S.win = r.window;
      if (S.busy !== 'like') S.liked = r.ok && typeof r.liked === 'boolean' ? r.liked : null;
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
    }, function (e) { if (S !== mine) return; S.libLoading = false; S.libErr = { reason: why(e) }; render(); });
  }
  function setTab(t) {
    if (S.query) { S.input.value = ''; S.query = ''; S.results = null; S.searching = false; if (S.searchTimer) { clearTimeout(S.searchTimer); S.searchTimer = 0; } }
    S.tab = t;
    if (t === 'lib' && !S.lib) loadLib(); else if (t === 'queue') refresh(true);
    render();
  }
  function player() { return (S.info && S.info.player) || null; }
  function playCtx(item) {
    act('ctx:' + item.uri, 'playUri', { uri: item.uri }, function (r) {
      if (!r.ok) fail('Didn’t play it: ', r);
      else if (!r.verified) say(plain(r.reason), true, r.reason);
      else say('Playing ' + (item.kind === 'artist' ? item.name : '“' + item.name + '”'));
      if (r.player && S.info) S.info.player = r.player;
      else if (r.ok && r.player) S.info = { ok: true, player: r.player };
    });
  }
  function control(verb, args, label) {
    act(verb, verb, args, function (r) {
      if (r.player && S.info) S.info.player = r.player;
      if (!r.ok) fail(label + ' didn’t change: ', r);
      else if (!r.verified) say(plain(r.reason), true, r.reason);
      else say(verb === 'shuffle' ? (args.on ? 'Shuffle on' : 'Shuffle off') : REPEAT[args.mode]);
    });
  }
  /* media-ui lane: the heart. Flipped at once (within the click), put back with the reason if Spotify
     refuses; clicking it again is the undo. The song is named by its address when Spotify gave one, so
     a track change between the read and the click never likes the wrong song. */
  function like() {
    var p = player(), was = S.liked === true, on = !was;
    var args = { on: on };
    if (p && LIKE_URI_RE.test(String(p.item || ''))) args.uri = p.item;
    var ok = act('like', 'like', args, function (r) {
      if (!r.ok) { S.liked = was; fail(on ? 'Not saved to Liked Songs: ' : 'Not removed from Liked Songs: ', r); return; }
      if (r.dryRun) { S.liked = was; say('Test instance: ' + r.reason); return; }   // r3-media: a test run never claims it saved
      S.liked = typeof r.liked === 'boolean' ? r.liked : on;
      if (S.liked !== on) say(on ? 'Spotify took it, but the song is not in Liked Songs' : 'Spotify took it, but the song is still in Liked Songs', true, r.reason);
      else say(on ? 'Saved to Liked Songs' : 'Removed from Liked Songs');
    });
    if (ok) { S.liked = on; render(); }
  }
  function windowDo(verb) {
    act(verb, verb, {}, function (r) {
      if (r && Object.prototype.hasOwnProperty.call(r, 'window')) S.win = r.window;
      if (r.dryRun) say('Test instance: ' + r.reason);
      else if (r.hiding) say(plain(r.reason || 'Spotify is slow to answer; Mantle keeps trying to hide its window.'));   // spotfix lane: tried again, said above
      else if (!r.ok) fail(verb === 'openWindow' ? 'Spotify didn’t open: ' : 'Not hidden: ', r);
      else if (!r.verified) say(plain(r.reason), true, r.reason);
      else say(verb === 'openWindow' ? 'Spotify’s window is open.' : 'Spotify is hidden again.');
      loadInfo();
    });
  }
  /* Quit stops the music, so the first click only arms it and says so (as Restart does). */
  function quitApp() {
    if (!S.quitArmed) { armOnce('quitArmed'); return; }
    disarm();
    act('quit', 'quit', {}, function (r) {
      if (r.dryRun) say('Test instance: ' + r.reason);
      else if (!r.ok) fail('Spotify didn’t quit: ', r);
      /* spotpid lane: a close it ignored was forced (by its main pid only); the card says so */
      else { S.info = null; S.lib = null; S.liked = null; say(r.note ? plain(r.note) : 'Spotify quit.', !!r.forced, r.note); }
      loadStatus();
    });
  }

  function searchSoon(now) {
    if (S.searchTimer) clearTimeout(S.searchTimer);
    S.searchTimer = 0;
    var q = S.input.value.trim();
    if (q === S.query && S.results && now !== true) { render(); return; }   // nothing new to ask
    S.query = q;
    if (!q) { S.results = null; S.searching = false; render(); return; }
    function go() {
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
        S.results = { ok: false, reason: why(e) };
        render();
      });
    }
    if (now === true) go(); else { S.searching = true; S.searchTimer = setTimeout(go, 380); render(); }
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
      S.kbdWhy = r && r.ok ? '' : 'Typing may not reach this box: ' + plain((r && r.reason) || 'the bar was not given the keyboard');
      render();
    }, function (e) {
      if (S !== mine) return;
      S.kbd = 'no';
      S.kbdWhy = 'Typing may not reach this box: ' + plain(why(e));
      render();
    });
  }

  /* ------------------------------------------------------------------ drawing */

  /* A click that is the second half of a double-click is not a second click. */
  function once(fn) { return function (ev) { if (ev && ev.detail > 1) return; fn(ev); }; }
  function btn(cls, text, fn, title) {
    var b = mk('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', once(fn));
    return b;
  }
  function primary(text, fn, cls, glyph) {
    var b = btn('spq-btn' + (cls ? ' ' + cls : ''), null, fn);
    if (glyph) { var g = mk('span', 'spq-bico'); g.innerHTML = svg(glyph, 12); b.appendChild(g); }
    b.appendChild(mk('span', '', text));
    return b;
  }
  function tool(glyph, label, fn, off, size) {
    var b = btn('spq-tool', null, function (ev) { if (ev) ev.stopPropagation(); fn(); });
    b.innerHTML = svg(glyph, size || 12);
    b.title = label;
    b.setAttribute('aria-label', label.replace(/\s*\([^)]*\)$/, ''));
    if (off) b.disabled = true;
    return b;
  }
  function keyed(n, k) { n.setAttribute('data-k', k); return n; }

  /* The designed states of the list's place: a glyph, one line in ink, one quiet line, one action. */
  function block(box, o) {
    var b = mk('div', 'spq-empty' + (o.bad ? ' bad' : ''));
    if (o.glyph) { var g = mk('span', 'spq-eico'); g.innerHTML = svg(o.glyph, 16); b.appendChild(g); }
    var h = mk('div', 'spq-ehead', o.head);
    if (o.raw) h.title = o.raw;
    b.appendChild(h);
    if (o.line) { var l = mk('div', 'spq-eline', o.line); if (o.raw) l.title = o.raw; b.appendChild(l); }
    if (o.action) b.appendChild(o.action);
    if (o.fine) b.appendChild(mk('div', 'spq-fine', o.fine));
    box.appendChild(b);
    return b;
  }
  function skeleton(list, n) {
    for (var i = 0; i < n; i++) {
      var r = mk('div', 'spq-skel');
      r.setAttribute('aria-hidden', 'true');
      r.appendChild(mk('span', 'spq-art'));
      var t = mk('span', 'spq-txt');
      t.appendChild(mk('span', 'spq-sk1')); t.appendChild(mk('span', 'spq-sk2'));
      r.appendChild(t);
      list.appendChild(r);
    }
  }

  /* spotdeath lane: "Restart Spotify after games"; spotgame lane: "Close Spotify while I game"
     (main's revive view: on / closeOn). Held while the change is on its way; put back on a refusal. */
  function opt(st, verb, field, text, tip) {
    var rv = st && st.revive, lab = mk('label', 'spq-opt');
    var cb = mk('input');
    cb.type = 'checkbox';
    var pend = S.optPending[verb];
    cb.checked = pend != null ? pend : !rv || rv[field] !== false;
    cb.disabled = pend != null;
    cb.addEventListener('change', function () {
      var on = cb.checked, mine = S;
      S.optPending[verb] = on; cb.disabled = true;
      call(verb, { on: on }).then(function (r) {
        if (S !== mine) return;
        delete S.optPending[verb];
        if (!r.ok) { cb.checked = !on; cb.disabled = false; fail('Not changed: ', r); return; }
        cb.disabled = false;
        say(text + (on ? ': on' : ': off'));
        loadStatus();
      }, function (e) { if (S === mine) { delete S.optPending[verb]; cb.checked = !on; cb.disabled = false; say('Not changed: ' + plain(why(e)), true, why(e)); } });
    });
    lab.title = tip;
    lab.appendChild(cb);
    lab.appendChild(mk('span', '', text));
    return lab;
  }
  function gameOpts(st) {
    var box = mk('div', 'spq-opts');
    box.appendChild(opt(st, 'gameclose', 'closeOn', 'Close Spotify while I game',
      'When a game starts, Mantle closes Spotify to free memory (only if no music is playing), and starts it again in the background after the game.'));
    box.appendChild(opt(st, 'revive', 'on', 'Restart Spotify after games',
      'If Spotify closes while a game runs, Mantle starts it again in the background after the game, not playing.'));
    return box;
  }
  function reviveWords(st) { var rv = st && st.revive; return rv && rv.state && rv.state !== 'idle' && rv.text ? rv : null; }

  /* The not-connected states: what is wrong, in plain words, and the one thing that fixes it. */
  function drawApp(box, st) {
    var s = st.state, reason = st.reason || '';
    var again = function () { return keyed(btn('spq-link act', 'Try again', function () { S.qErr = null; loadStatus(); }), 'state:again'); };
    if (s === 'checking') { block(box, { head: 'Checking Spotify…', line: '' }).classList.add('dim'); return; }
    if (s === 'starting') { block(box, { head: /clos/i.test(reason) ? 'Restarting Spotify…' : 'Starting Spotify…', line: 'This can take up to 30 seconds.' }).classList.add('dim'); return; }
    if (s === 'loading') { block(box, { head: 'Spotify is still loading', line: 'It works from here once it has loaded.', raw: reason, action: again() }); return; }
    if (s === 'notrunning') {
      var rv = reviveWords(st);
      block(box, { glyph: G.note, head: rv ? plain(rv.text) : 'Spotify isn’t running', bad: rv && !rv.mine,
        line: rv && rv.plan ? plain(rv.plan) : 'It starts in the background, with no window: play and search right here.',
        action: keyed(primary(rv && rv.state === 'waiting' && (rv.on || rv.mine) ? 'Start it now' : 'Start Spotify', function () { launch('start'); }, 'wide'), 'state:start') });
      return;
    }
    if (s === 'noport') {
      block(box, { glyph: G.note, head: 'Spotify was opened outside Mantle', raw: reason,
        line: S.restartArmed ? 'Restarting stops the music; press play again after.' : 'To play and search from here, Mantle has to restart it.',
        action: keyed(primary(S.restartArmed ? 'Click again to restart' : 'Restart Spotify', function () { launch('restart'); }, 'wide' + (S.restartArmed ? ' armed' : '')), 'state:restart') });
      return;
    }
    if (s === 'portbusy') { block(box, { glyph: G.warn, bad: true, head: 'Another app is using Spotify’s connection', raw: reason, line: 'Close the other app that uses it, then try again.', action: again() }); return; }
    if (s === 'internals') { block(box, { glyph: G.warn, bad: true, head: 'Spotify updated, and Mantle can’t read it yet', raw: reason, line: 'Play from the Spotify app until Mantle is updated.', action: again() }); return; }
    if (s === 'noinstall') { block(box, { glyph: G.warn, bad: true, head: 'Spotify isn’t installed', raw: reason, line: 'Install the Spotify app from spotify.com (the Microsoft Store version can’t be played from here), then try again.', action: again() }); return; }
    if (s === 'off') { block(box, { glyph: G.off, head: 'Spotify controls are off', raw: reason, line: 'Turn them on in Mantle’s tray menu.' }); return; }
    if (s === 'missing') { block(box, { glyph: G.off, head: 'Spotify controls aren’t available', raw: reason, line: plain(reason) }); return; }
    block(box, { glyph: G.warn, bad: true, head: 'Mantle can’t reach Spotify', raw: reason, line: plain(reason, 'Something went wrong, with no reason given.'), action: again() });
  }

  function artOf(item, art) {
    // secreview-sp lane: only the data: art main fetched from Spotify's image server. Never an address:
    // a file://host/share one would be an SMB fetch (the bar's CSP allows file: images).
    if (item.liked) { art.innerHTML = svg(G.heart, 14); art.classList.add('liked'); }
    else if (typeof item.image === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(item.image)) { var im = document.createElement('img'); im.alt = ''; im.src = item.image; art.appendChild(im); }
    else { art.innerHTML = svg(G.note, 14); if (item.imageReason) art.title = 'No picture: ' + plain(item.imageReason); }
  }

  function row(item, index, mode, n) {
    var wrap = keyed(mk('div', 'spq-item'), mode + ':' + (item.uid || '') + item.uri);
    var b = mk('button', 'spq-row');
    b.type = 'button';
    b.tabIndex = -1;
    var art = mk('span', 'spq-art');
    artOf(item, art);
    b.appendChild(art);
    var txt = mk('span', 'spq-txt');
    txt.appendChild(mk('span', 'spq-t', item.name));
    var sub = item.artists || (item.kind === 'episode' ? 'Podcast episode' : item.kind === 'local' ? 'Local file' : '');
    if (sub) txt.appendChild(mk('span', 'spq-a', sub));
    b.appendChild(txt);
    wrap.appendChild(b);
    var full = item.name + (sub ? ' · ' + sub : '');
    var caps = (S.q && S.q.caps) || {};
    if (mode === 'search' || mode === 'lib') {
      // a tap plays it (spothide lane); a song can also go to the end of the queue
      if (item.kind === 'artist') art.classList.add('round');
      var p = player();
      if (mode === 'lib' && p && p.context && p.context === item.uri) { wrap.classList.add('cur'); b.setAttribute('aria-current', 'true'); }
      b.title = (wrap.classList.contains('cur') ? 'Playing now: ' : 'Play ') + full;
      b.setAttribute('aria-label', 'Play ' + full);
      if (S.busy === 'ctx:' + item.uri) wrap.classList.add('busy');
      b.addEventListener('click', once(function () { playCtx(item); }));
      if (item.kind === 'track') {
        var done = S.added[item.uri];
        var tl = mk('div', 'spq-tools keep');
        var t = tool(done ? G.check : G.plus, done ? 'Added to the queue' : 'Add to queue (Shift+Enter)', function () { add(item); }, !!done);
        t.tabIndex = -1;
        tl.appendChild(t);
        wrap.appendChild(tl);
        wrap._add = function () { if (!done) add(item); };
      }
      return wrap;
    }
    b.title = 'Play ' + full + (index ? ' now (the ' + (index === 1 ? 'song' : index + ' songs') + ' before it are skipped)' : ' now');
    b.setAttribute('aria-label', 'Play ' + full);
    if (S.busy && S.busy.slice(S.busy.indexOf(':') + 1) === item.uid + item.uri) wrap.classList.add('busy');
    b.addEventListener('click', once(function () { play(item); }));
    var tools = mk('div', 'spq-tools');
    if (mode === 'queued' && caps.move !== false) {
      tools.appendChild(tool(G.up, 'Move up (Alt+Up)', function () { move(item, 'up'); }, index === 0));
      tools.appendChild(tool(G.down, 'Move down (Alt+Down)', function () { move(item, 'down'); }, index === n - 1));
      wrap._move = function (dir) { if (dir === 'up' ? index > 0 : index < n - 1) move(item, dir); };
    }
    if (caps.remove !== false) { tools.appendChild(tool(G.x, 'Remove from queue (Delete)', function () { remove(item); })); wrap._remove = function () { remove(item); }; }
    Array.prototype.forEach.call(tools.children, function (x) { x.tabIndex = -1; });
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
    if (err) {
      block(box, { glyph: G.warn, bad: true, head: 'Your library didn’t load', raw: err.reason, line: plain(err.reason),
        action: btn('spq-link act', 'Try again', function () { S.libErr = null; loadLib(); }) });
      return;
    }
    if (!l) { skeleton(list, 4); return; }
    list.appendChild(row({ uri: l.liked.uri, kind: 'collection', name: l.liked.name, artists: 'Playlist · your saved songs', image: '', liked: true }, 0, 'lib'));
    l.items.forEach(function (it, i) { list.appendChild(row({ uri: it.uri, kind: it.kind, name: it.name, artists: subLine(it), image: it.image, imageReason: it.imageReason }, i + 1, 'lib')); });
    if (!l.items.length) list.appendChild(mk('div', 'spq-fine spq-pad', 'No playlists, artists or albums saved yet.'));
    if (l.skipped) list.appendChild(mk('div', 'spq-fine spq-pad', l.skipped + ' folder' + (l.skipped > 1 ? 's or items' : ' or item') + ' that can’t be played from here ' + (l.skipped > 1 ? 'are' : 'is') + ' not listed'));
  }
  function drawConnected(box, list) {
    if (S.query) {
      var r = S.results;
      if (r && r.q != null && r.q !== S.query && S.searching) r = null;
      if (!r) { skeleton(list, 3); return; }
      if (!r.ok) {
        block(box, { glyph: G.warn, bad: true, head: 'Search didn’t work', raw: r.reason, line: plain(r.reason),
          action: btn('spq-link act', 'Try again', function () { searchSoon(true); }) });
        return;
      }
      var any = false;
      [['tracks', 'Songs'], ['artists', 'Artists'], ['albums', 'Albums'], ['playlists', 'Playlists']].forEach(function (g) {
        var arr = r[g[0]] || [];
        if (!arr.length) return;
        any = true;
        list.appendChild(mk('div', 'spq-sec', g[1]));
        arr.forEach(function (it, i) { list.appendChild(row({ uri: it.uri, kind: it.kind, name: it.name, artists: subLine(it), image: it.image, imageReason: it.imageReason }, i, 'search')); });
      });
      if (!any) block(box, { glyph: G.search, head: 'No results for “' + S.query + '”', line: 'Check the spelling, or try fewer words.' }).classList.add('dim');
      return;
    }
    if (S.tab === 'lib') { drawLib(box, list); return; }
    var q = S.q, err = S.qErr;
    if (err) {
      block(box, { glyph: G.warn, bad: true, head: 'Up next didn’t load', raw: err.reason, line: plain(err.reason),
        action: btn('spq-link act', 'Try again', function () { S.qErr = null; refresh(true); }) });
      return;
    }
    if (!q) { skeleton(list, 4); return; }
    if (!q.queued.length && !q.nextUp.length) {
      var idle = nothingLoaded();
      block(box, { glyph: G.queue, head: idle ? 'Nothing is playing' : 'Nothing is queued after this song',
        line: idle ? 'Pick something from Library, or search below.' : 'Search below and press + to add a song.' }).classList.add('dim');
      return;
    }
    var at = 0;
    if (q.queued.length) {
      list.appendChild(mk('div', 'spq-sec', 'Next in queue'));
      q.queued.forEach(function (it, i) { list.appendChild(row(it, at++, 'queued', q.queued.length)); });
      if (q.totalQueued > q.queued.length) list.appendChild(mk('div', 'spq-fine spq-pad', '+' + (q.totalQueued - q.queued.length) + ' more in the queue in Spotify'));
    }
    if (q.nextUp.length) {
      list.appendChild(mk('div', 'spq-sec', 'Coming up'));
      q.nextUp.forEach(function (it) { list.appendChild(row(it, at++, 'next', q.nextUp.length)); });
    }
  }

  /* media-ui lane (CONTRACT feature 2): Spotify runs but nothing is loaded. The media session's own
     title says so for free (no read); a read (info or the queue) says it when the section is open. */
  function nothingLoaded() {
    if (!S || !S.status || S.status.state !== 'connected') return false;
    var s = S.shown;
    if (s && s.title) return false;
    var p = player();
    if (p) return p.hasItem === false;
    if (S.q) return !S.q.current;
    return !!s && !s.title;
  }

  /* The player's row: Up next | Library, and the heart, shuffle and repeat. */
  function drawBar() {
    var bar = S.bar;
    bar.textContent = '';
    var tabs = mk('div', 'spq-seg');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Spotify lists');
    [['queue', 'Up next', 'What plays next: jump to a song, move or remove it'], ['lib', 'Library', 'Liked Songs, your playlists, artists and albums']].forEach(function (t) {
      var on = !S.query && S.tab === t[0];
      var c = keyed(btn('spq-tab' + (on ? ' on' : ''), t[1], function () { setTab(t[0]); }, t[2]), 'tab:' + t[0]);
      c.setAttribute('role', 'tab');
      c.setAttribute('aria-selected', on ? 'true' : 'false');
      c.tabIndex = on || (S.query && t[0] === 'queue') ? 0 : -1;
      tabs.appendChild(c);
    });
    bar.appendChild(tabs);
    bar.appendChild(mk('span', 'spq-gap'));
    var inf = S.info, p = player();
    var notYet = !inf ? (S.infoLoading ? 'Reading Spotify…' : S.infoErr ? plain(S.infoErr) : 'Reading Spotify…') : !p ? plain(inf.playerReason, 'Spotify’s player has not answered yet') : '';
    // the heart: the contract's words, filled with the accent when liked
    var hasItem = !!(p && p.hasItem !== false && (p.item || p.hasItem));
    var liked = S.liked === true;
    var hTip = notYet ? 'Liked Songs: ' + notYet : !hasItem ? 'Nothing is playing to save' : /^spotify:local:/.test(String(p.item || '')) ? 'Local files can’t be saved to Liked Songs'
      : liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
    var h = keyed(tool(liked ? G.heart : G.heartOff, hTip, like, !!notYet || !hasItem || /^spotify:local:/.test(String(p && p.item || '')), 14), 'tool:like');
    h.setAttribute('aria-pressed', liked ? 'true' : 'false');
    h.classList.add('big', 'heart');
    if (liked) h.classList.add('on');
    if (S.busy === 'like') h.classList.add('busy');
    var sh = keyed(tool(G.shuffle, notYet ? 'Shuffle: ' + notYet : p.canShuffle === false ? 'Shuffle isn’t allowed for what’s playing' : p.shuffle ? 'Turn shuffle off' : 'Turn shuffle on',
      function () { control('shuffle', { on: !p.shuffle }, 'Shuffle'); }, !!notYet || p.canShuffle === false, 14), 'tool:shuffle');
    var next = p ? (p.repeat + 1) % 3 : 1;
    var rp = keyed(tool(G.repeat, notYet ? 'Repeat: ' + notYet : p.canRepeat === false ? 'Repeat isn’t allowed for what’s playing' : REPEAT[p.repeat] + ' (click: ' + REPEAT[next].slice(8) + ')',
      function () { control('repeat', { mode: next }, 'Repeat'); }, !!notYet || p.canRepeat === false, 14), 'tool:repeat');
    sh.setAttribute('aria-pressed', p && p.shuffle ? 'true' : 'false');
    rp.setAttribute('aria-pressed', p && p.repeat ? 'true' : 'false');
    [sh, rp].forEach(function (x) { x.classList.add('big'); });
    if (p && p.shuffle) sh.classList.add('on');
    if (p && p.repeat) rp.classList.add('on');
    if (p && p.repeat === 2) rp.classList.add('one');
    /* the heart shows only while Spotify has said whether this song is liked (info().liked is a
       boolean): a Mantle whose main has no Like yet, or no song to like, shows no dead heart */
    if (typeof S.liked === 'boolean') bar.appendChild(h);
    bar.appendChild(sh); bar.appendChild(rp);
  }

  /* A window that could not be hidden is said on the first screen, with its fix. */
  function drawWarn(st) {
    var w = S.warn;
    w.textContent = '';
    var L = st === 'connected' ? lookNow() : null;
    var bad = L && (L.key === 'failed' || L.key === 'unwatched') ? L.bad : '';
    w.hidden = !bad;
    if (!bad) return;
    var g = mk('span', 'spq-wico'); g.innerHTML = svg(G.warn, 12);
    var t = mk('span', 'spq-wtxt', plain(bad));
    t.title = bad;
    w.appendChild(g); w.appendChild(t);
    if (L.act && L.act.verb === 'hideWindow') w.appendChild(btn('spq-link', L.act.text, function () { windowDo(L.act.verb); }));
  }

  /* "More": the window line (running hidden · memory), Open Spotify / Hide window, Quit Spotify, the
     game toggles and what the game rules did. Returns the problem to flag on the More row, or ''. */
  function moreProblem(st) {
    if (st !== 'connected') return '';
    var w = S.win || null, inf = S.info, wv = watchView(), watching = !!(wv && wv.state === 'watching');
    var watchBad = wv ? (wv.state === 'unavailable' ? wv.reason : watching ? wv.error || (wv.lastTrim && !wv.lastTrim.ok ? wv.lastTrim.text : '') : '') : '';
    var rv = S.status && S.status.revive;
    return (w && w.trim && !w.trim.ok && !w.trim.skipped && w.trim.text) || watchBad || S.infoErr || (inf && inf.memoryReason) || (rv && rv.state === 'closefailed' && rv.text) || '';
  }
  function drawMore(st) {
    var box = S.more;
    box.textContent = '';
    var rv = S.status && S.status.revive;
    if (st === 'connected') {
      var w = S.win || null, inf = S.info, m = inf && inf.memory, L = lookNow();
      var wv = watchView(), watching = !!(wv && wv.state === 'watching');
      var memTxt = watching && wv.mb != null && wv.at && Date.now() - wv.at < 90000 ? mbText(wv.mb) : m ? mb(m) : '';
      var trimTxt = watching ? (wv.lastTrim && wv.lastTrim.ok ? ' · trimmed ' + ago(wv.lastTrim.at) : '') : '';
      S.appTail = L.mem ? (memTxt ? ' · ' + memTxt : S.infoLoading ? ' · …' : '') + trimTxt : '';
      var line = mk('div', 'spq-mline');
      var txt = mk('span', 'spq-apptxt', L.line + S.appTail);
      S.appTxt = txt;
      var pre = L.key === 'hiding' && w.lastReason ? 'The last try: ' + w.lastReason + (w.tries ? ' (' + w.tries + ' tr' + (w.tries === 1 ? 'y' : 'ies') + ' so far)' : '') + '\n' : '';
      txt.title = pre + (m ? 'Spotify’s memory: ' + (m.privateWsMB != null ? m.privateWsMB + ' MB of its own (Task Manager’s Memory column), ' : '') + m.wsMB + ' MB in use in all, over ' + m.n + ' processes'
        : plain((inf && inf.memoryReason) || S.infoErr, 'Reading Spotify’s memory…')) + (w && w.how && L.key === 'hidden' ? (w.adopted && w.how === 'adopted after a Mantle restart' ? '\nTaken over after a Mantle restart: an earlier Mantle started and hid it' : '\nHidden by ' + w.how) : '') + (w && w.trim ? '\n' + w.trim.text : '')
        + (watching ? '\nMemory: trimmed when over ' + wv.aboveMB + ' MB, checked every 30 s, at most once every ' + Math.round(wv.gapMs / 60000) + ' min; never the part playing the music'
          : wv && wv.state === 'stopped' && wv.reason ? '\nMemory watch stopped: ' + wv.reason : '')
        + (wv && wv.lastTrim ? '\n' + wv.lastTrim.text + ' (' + ago(wv.lastTrim.at) + ')' : '') + (wv && wv.note ? '\n' + cap(wv.note) : '');
      line.appendChild(txt);
      box.appendChild(line);
      var acts = mk('div', 'spq-macts');
      acts.appendChild(keyed(btn('spq-sbtn', L.act.text, function () { windowDo(L.act.verb); }, L.act.verb === 'openWindow' ? 'Show Spotify’s own window' : 'Hide Spotify’s window again; it keeps playing'), 'more:win'));
      var q = keyed(btn('spq-sbtn' + (S.quitArmed ? ' armed' : ''), S.quitArmed ? 'Click again to quit' : 'Quit Spotify', quitApp, 'Close Spotify; the music stops'), 'more:quit');
      acts.appendChild(q);
      box.appendChild(acts);
      var bad = moreProblem(st);
      if (bad) { var bl = mk('div', 'spq-fine spq-bad', plain(bad)); bl.title = bad; box.appendChild(bl); }
      else if (watching && wv.note) box.appendChild(mk('div', 'spq-fine', cap(wv.note)));
    }
    if (rv && rv.state === 'done' && rv.at && Date.now() - rv.at < 20 * 60000 && rv.plan) box.appendChild(mk('div', 'spq-fine', rv.text + ' ' + rv.plan));
    // spotgame lane: kept open for a game (music was playing), closing, or a close that failed (said, why)
    else if (rv && (rv.state === 'kept' || rv.state === 'closing' || (rv.state === 'closefailed' && st !== 'connected')) && rv.text) {
      box.appendChild(mk('div', 'spq-fine' + (rv.state === 'closefailed' ? ' spq-bad' : ''), rv.text + (rv.plan ? ' ' + rv.plan : '')));
    }
    box.appendChild(gameOpts(S.status));
  }

  /* spotfix lane: while main tries the hide again, the app line counts down to the next try (its text
     only, once a second, while the list is open; nothing is read or asked). */
  function hideTick(on) {
    if (!S) return;
    on = !!(on && S.shown && expanded && moreOpen);
    if (on && !S.hideTimer) {
      S.hideTimer = setInterval(function () {
        if (!S) return;
        var L = lookNow();
        if (L.key !== 'hiding' || !S.shown || !expanded || !moreOpen) { hideTick(false); return; }
        if (S.appTxt) S.appTxt.textContent = L.line + (S.appTail || '');
      }, 1000);
    }
    if (!on && S.hideTimer) { clearInterval(S.hideTimer); S.hideTimer = 0; }
  }

  /* Redraw one part only when what it shows changed; keyboard focus inside it goes back to the same
     control (by its data-k), so an 8 s read never throws the focus away. */
  function redraw(part, sig, draw) {
    if (S.sigs[part] === sig) return;
    S.sigs[part] = sig;
    var host = S[part === 'list' ? 'scroll' : part], ae = document.activeElement;
    var had = ae && host.contains(ae) ? (ae.closest('[data-k]') || ae) : null, k = had && had.getAttribute('data-k'), wasRow = !!(ae && ae.classList && ae.classList.contains('spq-row'));
    var idx = had && part === 'list' ? Array.prototype.indexOf.call(S.list.querySelectorAll('.spq-row'), ae) : -1;
    draw();
    if (!had) return;
    var back = k ? host.querySelector('[data-k="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"]') : null;
    if (back && (wasRow || back.classList.contains('spq-item'))) back = back.querySelector('.spq-row');
    if (!back && part === 'list') { var rows = S.list.querySelectorAll('.spq-row'); back = rows[Math.min(Math.max(idx, 0), rows.length - 1)] || null; }
    if (back && back.focus) { if (part === 'list') rove(back); back.focus(); }
  }
  /* The list is one Tab stop: the row that was last focused (or the first) takes it. */
  function rove(r) {
    var rows = S.list.querySelectorAll('.spq-row');
    Array.prototype.forEach.call(rows, function (x) { x.tabIndex = x === r ? 0 : -1; });
  }

  function qSig(q) {
    if (!q) return '';
    var f = function (x) { return x.uid + x.uri + '|' + x.name + '|' + x.artists + '|' + (x.image ? x.image.length : 0); };
    return q.queued.map(f).join(',') + '/' + q.nextUp.map(f).join(',') + '/' + q.totalQueued + '/' + (q.current ? q.current.uri : '') + JSON.stringify(q.caps || {});
  }
  function rSig(r) {
    if (!r) return '';
    if (!r.ok) return 'x' + r.reason;
    return r.q + ':' + ['tracks', 'artists', 'albums', 'playlists'].map(function (k) { return (r[k] || []).map(function (x) { return x.uri + (x.image ? 'i' : ''); }).join(','); }).join('/');
  }

  /* quiet: called from inside bar.js's own repaint, which measures the card itself afterwards */
  /* r5-autopause lane: the line under the head while auto-pause acts, and its whole state under More. */
  function renderAp() {
    if (!S || !S.apLine) return;
    var a = S.ap || null;
    var line = a && a.card ? String(a.card) : '';
    S.apLine.textContent = line;
    S.apLine.title = a && a.words ? String(a.words) : '';
    S.apLine.hidden = !line;
    S.apLine.classList.toggle('bad', !!a && a.state === 'error');
    var full = a && a.words && a.state !== 'off' ? 'Auto-pause: ' + String(a.words) : '';
    S.apMore.textContent = full;
    S.apMore.hidden = !moreOpen || !full || !!line;   // never the same words twice
  }

  function render(quiet) {
    if (!S) return;
    var st = S.status ? S.status.state : 'checking';
    var show = !!S.shown;
    S.root.hidden = !show;
    if (!show) { if (!quiet) relayout(); return; }

    // the head: its word says what is in there, or what is wrong, in two or three words
    S.head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    S.head.title = expanded ? 'Hide Up next, Library and search' : 'Show Up next, Library and search';
    S.root.classList.toggle('open', expanded);
    var L = st === 'connected' ? lookNow() : null;
    var hint = st === 'connected' ? (S.q && S.q.queued.length ? S.q.queued.length + ' in queue' : '') : (HINT[st] != null ? HINT[st] : '');
    if (L && (L.key === 'failed' || L.key === 'hiding')) hint = L.hint;
    S.hint.textContent = hint;
    S.hint.classList.toggle('warn', st !== 'connected' && st !== 'checking' && st !== 'starting' && st !== 'loading' || !!(L && L.key === 'failed'));
    hideTick(L && L.key === 'hiding');

    // CONTRACT feature 2: nothing loaded -> one obvious next step, open or shut
    var idle = nothingLoaded() && !S.query;
    S.idle.hidden = !idle;
    if (idle && !S.idle.firstChild) S.idle.appendChild(keyed(primary('Play Liked Songs', function () { playCtx({ uri: LIKED_URI, kind: 'collection', name: 'Liked Songs' }); }, 'wide', G.play), 'idle:play'));
    if (idle) { var pb = S.idle.firstChild; pb.classList.toggle('busy', S.busy === 'ctx:' + LIKED_URI); pb.setAttribute('aria-busy', S.busy === 'ctx:' + LIKED_URI ? 'true' : 'false'); }

    /* the result line lives under the search box; while the section is shut it sits under the head
       (Play Liked Songs is the one action there), so no result is ever said inside a hidden part */
    if (expanded && S.noteEl.parentNode !== S.body) S.body.insertBefore(S.noteEl, S.sqLine);
    else if (!expanded && S.noteEl.parentNode !== S.root) S.root.insertBefore(S.noteEl, S.body);
    S.noteEl.textContent = S.noteText || '';
    S.noteEl.title = S.noteRaw || '';
    S.noteEl.hidden = !S.noteText;
    S.noteEl.classList.toggle('bad', !!S.noteBad);

    S.body.hidden = !expanded;
    if (!expanded) { if (!quiet) relayout(); return; }

    var WL = st === 'connected' ? lookNow() : null;
    redraw('warn', WL ? [WL.key, WL.bad, WL.act && WL.act.verb].join('\u0001') : '', function () { drawWarn(st); });
    S.bar.hidden = st !== 'connected';
    if (st === 'connected') {
      var p = player();
      redraw('bar', [S.tab, !!S.query, JSON.stringify(p), S.liked, S.busy === 'like', !!S.info, S.infoLoading && !S.info, S.infoErr].join('\u0001'), drawBar);
    }

    var box = S.state, list = S.list;
    var lsig = [st, S.status && S.status.reason, st === 'notrunning' || st === 'noport' ? JSON.stringify(S.status.revive || null) : '', S.restartArmed,
      S.query, S.searching && !S.results, rSig(S.results), S.busy, Object.keys(S.added).join(','),
      qSig(S.q), S.qErr && S.qErr.reason, S.tab, S.lib ? S.lib.items.map(function (x) { return x.uri + (x.image ? 'i' : ''); }).join(',') + S.lib.skipped : '',
      S.libErr && S.libErr.reason, S.tab === 'lib' && player() ? player().context : '', S.q && !S.q.queued.length && !S.q.nextUp.length ? nothingLoaded() : ''].join('\u0001');
    redraw('list', lsig, function () {
      var keepTop = S.scroll.scrollTop;
      box.textContent = '';
      list.textContent = '';
      if (st === 'connected') drawConnected(box, list);
      else drawApp(box, S.status || { state: 'checking' });
      S.scroll.scrollTop = keepTop;
      var first = list.querySelector('.spq-row');
      if (first) rove(list.querySelector('.spq-row[tabindex="0"]') || first);
    });
    box.hidden = !box.firstChild;
    list.hidden = !list.firstChild;
    list.setAttribute('aria-busy', list.querySelector('.spq-skel') ? 'true' : 'false');

    S.addRow.hidden = st !== 'connected';
    S.clear.hidden = !S.input.value;
    S.kbdLine.textContent = st === 'connected' ? (S.kbdWhy || '') : '';
    S.kbdLine.hidden = !S.kbdLine.textContent;

    // More: shut by default; a warn dot on its row when something in there is wrong
    var prob = moreProblem(st);
    S.moreBtn.setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
    S.moreBtn.classList.toggle('flag', !!prob && !moreOpen);
    S.moreBtn.title = (moreOpen ? 'Hide' : 'Show') + ' window, quit and game options' + (prob && !moreOpen ? ' (something needs a look)' : '');
    S.more.hidden = !moreOpen;
    renderAp();
    if (moreOpen) {
      redraw('more', [st, JSON.stringify(S.win), JSON.stringify(S.info && { m: S.info.memory, r: S.info.memoryReason, v: S.info.visible, w: S.info.window }), S.infoErr, S.infoLoading,
        JSON.stringify(S.status && S.status.revive), JSON.stringify(S.status && S.status.window), S.quitArmed, JSON.stringify(S.optPending)].join('\u0001'), function () { drawMore(st); });
    }
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
    if (over > 0) sc.style.maxHeight = rowEdge(sc, Math.max(LIST_MIN, Math.min(LIST_PREF, sc.offsetHeight) - over)) + 'px';
  }
  /* r3-media lane: a squeezed list (More open, two sources) used to end a few pixels into the next row
     or section head, which read as a glitch (a sliver of art under the last row). A cut that shows at
     least PEEK of the next row is kept (it says there is more to scroll to); a smaller one ends the list
     at the bottom of the last whole row instead, when that keeps most of the room. No rows (a state):
     left as is. Measured from the list's top, not its scroll, so the height never changes on a scroll. */
  var PEEK = 0.35;
  function rowEdge(sc, h) {
    var top = sc.getBoundingClientRect().top - sc.scrollTop, last = 0, cut = null;
    Array.prototype.forEach.call(sc.querySelectorAll('.spq-item, .spq-skel, .spq-sec'), function (r) {
      var rc = r.getBoundingClientRect(), t = rc.top - top, b = rc.bottom - top;
      if (b <= h + 0.5) { if (b > last && !r.classList.contains('spq-sec')) last = b; }
      else if (!cut && t < h - 0.5) cut = { t: t, h: b - t };
    });
    if (!cut || h - cut.t >= cut.h * PEEK) return h;
    return last >= h * 0.6 ? Math.ceil(last) : h;
  }

  /* ------------------------------------------------------------------ keyboard */

  function onListKey(ev) {
    var r = ev.target.closest && ev.target.closest('.spq-row');
    if (!r) return;
    var rows = Array.prototype.slice.call(S.list.querySelectorAll('.spq-row')), i = rows.indexOf(r), item = r.parentNode, to = null;
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { if (item._move) item._move(ev.key === 'ArrowUp' ? 'up' : 'down'); ev.preventDefault(); return; }
    if (ev.key === 'ArrowDown') to = rows[i + 1];
    else if (ev.key === 'ArrowUp') { to = rows[i - 1]; if (!to && S.query) { ev.preventDefault(); S.input.focus(); return; } }
    else if (ev.key === 'Home') to = rows[0];
    else if (ev.key === 'End') to = rows[rows.length - 1];
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { if (item._remove) { item._remove(); ev.preventDefault(); } return; }
    else if (ev.key === 'Enter' && ev.shiftKey) { if (item._add) { item._add(); ev.preventDefault(); } return; }
    else return;
    ev.preventDefault();
    if (to) { rove(to); to.focus(); to.scrollIntoView({ block: 'nearest' }); }
  }
  function onBarKey(ev) {
    var t = ev.target.closest && ev.target.closest('.spq-tab');
    if (!t || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
    ev.preventDefault();
    setTab(t.getAttribute('data-k') === 'tab:queue' ? 'lib' : 'queue');
    var on = S.bar.querySelector('.spq-tab.on');
    if (on) on.focus();
  }
  /* Esc undoes the nearest thing first (the search text, an armed Quit/Restart, More) and only then
     reaches bar.js, which closes the card. */
  function onRootKey(ev) {
    if (ev.key !== 'Escape' || !S) return;
    if (ev.target === S.input && S.input.value) { S.input.value = ''; searchSoon(); ev.stopPropagation(); ev.preventDefault(); return; }
    if (disarm()) { render(); ev.stopPropagation(); ev.preventDefault(); return; }
    if (moreOpen && S.more.contains(ev.target)) { moreOpen = false; render(); S.moreBtn.focus(); ev.stopPropagation(); ev.preventDefault(); }
  }

  /* ------------------------------------------------------------------ bar.js hooks */

  var API = {
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
      /* r5-autopause lane: what Spotify auto-pause is doing, only while it acts ("Paused while LessonPlayer
         plays"); lib/features/autopause.js pushes autopause.status. Otherwise its state sits under More. */
      var apLine = mk('div', 'spq-ap'); apLine.hidden = true; apLine.setAttribute('role', 'status');
      root.appendChild(apLine);
      var idle = mk('div', 'spq-idle'); idle.hidden = true;
      root.appendChild(idle);

      var body = mk('div', 'spq-body');
      var warn = mk('div', 'spq-warn'); warn.hidden = true;
      warn.setAttribute('role', 'status');
      var bar = mk('div', 'spq-bar'); bar.hidden = true;
      body.appendChild(warn); body.appendChild(bar);
      var scroll = mk('div', 'spq-scroll');
      var state = mk('div', 'spq-state');
      var list = mk('div', 'spq-list');
      list.setAttribute('role', 'list');
      scroll.appendChild(state); scroll.appendChild(list);
      body.appendChild(scroll);

      var addRow = mk('div', 'spq-add');
      var sico = mk('span', 'spq-sico'); sico.innerHTML = svg(G.search, 13);
      var input = mk('input', 'spq-input spq-search');
      input.type = 'text'; input.placeholder = 'Search songs, artists, albums…'; input.spellcheck = false;
      input.setAttribute('aria-label', 'Search Spotify: click a result to play it');
      input.maxLength = 100;
      var clear = mk('button', 'spq-clear'); clear.type = 'button'; clear.innerHTML = svg(G.x, 12); clear.title = 'Clear the search (Esc)';
      clear.setAttribute('aria-label', 'Clear the search');
      addRow.appendChild(sico); addRow.appendChild(input); addRow.appendChild(clear);
      body.appendChild(addRow);
      var kbdLine = mk('div', 'spq-msg bad');
      body.appendChild(kbdLine);
      var noteEl = mk('div', 'spq-note');
      noteEl.setAttribute('role', 'status');
      noteEl.setAttribute('aria-live', 'polite');
      body.appendChild(noteEl);
      var sqLine = mk('div', 'spq-fine spq-pad', 'The source list is hidden while this is open.');
      sqLine.hidden = true;
      sqLine.title = 'The card has room for this list or the source switcher, not both: close Spotify’s section to switch source';
      body.appendChild(sqLine);
      var moreBtn = mk('button', 'spq-more-btn');
      moreBtn.type = 'button';
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.appendChild(mk('span', '', 'More'));
      var mchev = mk('span', 'spq-chev'); mchev.innerHTML = svg(G.chev, 12);
      moreBtn.appendChild(mchev);
      body.appendChild(moreBtn);
      var more = mk('div', 'spq-more'); more.hidden = true;
      body.appendChild(more);
      var apMore = mk('div', 'spq-ap-more'); apMore.hidden = true;
      body.appendChild(apMore);
      root.appendChild(body);
      pop.insertBefore(root, before || null);

      S = { api: api, root: root, apLine: apLine, apMore: apMore, ap: null, head: head, hint: hint, idle: idle, body: body, warn: warn, bar: bar, scroll: scroll, state: state, list: list,
        addRow: addRow, input: input, tab: 'queue', lib: null, libErr: null, libLoading: false, info: null, infoErr: '', infoLoading: false, quitArmed: false,
        sqLine: sqLine, clear: clear, kbdLine: kbdLine, noteEl: noteEl, moreBtn: moreBtn, more: more, liked: null, optPending: {}, sigs: {},
        status: null, q: null, qErr: null, results: null, query: '', added: {}, busy: '', noteText: '', noteBad: false, noteRaw: '', noteTimer: 0, armTimer: 0,
        shown: null, trackSig: null, timer: 0, settle: 0, searchTimer: 0, win: null, hideTimer: 0, kbd: '', kbdWhy: '', loading: false, restartArmed: false, launching: false };

      head.addEventListener('click', once(function () {
        expanded = !expanded;
        arm();
        if (expanded) { refresh(true); if (S.status && S.status.state === 'connected') loadInfo(); if (S.tab === 'lib' && !S.lib) loadLib(); }
        render();
      }));
      moreBtn.addEventListener('click', once(function () { moreOpen = !moreOpen; if (moreOpen && S.status && S.status.state === 'connected' && !S.info) loadInfo(); render(); }));
      input.addEventListener('mousedown', wantKeyboard);
      input.addEventListener('focus', wantKeyboard);
      input.addEventListener('input', searchSoon);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); searchSoon(true); }
        else if (ev.key === 'ArrowDown') { var r = S.list.querySelector('.spq-row'); if (r) { ev.preventDefault(); rove(r); r.focus(); } }
      });
      clear.addEventListener('click', function () { input.value = ''; searchSoon(); input.focus(); });
      list.addEventListener('keydown', onListKey);
      list.addEventListener('focusin', function (ev) { if (ev.target.classList && ev.target.classList.contains('spq-row')) rove(ev.target); });
      bar.addEventListener('keydown', onBarKey);
      root.addEventListener('keydown', onRootKey);

      /* A dead subscription is SAID (no silent failures): without the push, a Start or Restart
         finishing elsewhere would not show until the next 8 s read. */
      var mine = S;
      S.unsub = api.on ? api.on('spotify.status', function (st) { if (S === mine) setStatus(st); }, function (reason) {
        if (S === mine) say('Live updates from Spotify are off (' + plain(reason) + '), so this list refreshes every 8 s instead', true, reason);
      }) : null;
      S.apUnsub = api.on ? api.on('autopause.status', function (st) { if (S === mine) { S.ap = st; renderAp(); relayout(); } }, function () { /* no line: the card works without it */ }) : null;
      loadStatus();
      return root;
    },

    /* From bar.js's card repaint (every 'media' push and every re-measure). Cheap when nothing
       changed; a new track (title/artist) re-reads the queue once Spotify has caught up. */
    paint: function (s, pop) {
      if (!S) return;
      var spot = isSpotify(s) ? s : null;
      var was = !!S.shown, wasTitle = S.shown ? !!S.shown.title : null;
      S.shown = spot;
      if (!!spot !== was || (spot && !!spot.title !== wasTitle)) {
        arm();
        // switched back to Spotify with the list open: read it now, not in 8 s. refresh(false) never
        // renders itself (this is inside bar.js's repaint); render(true) below draws "Loading…".
        if (spot && expanded && !!spot !== was) refresh(false);
        render(true);
      }
      if (spot) {
        var t = [spot.aumid, spot.title, spot.artist].join('|');
        if (S.trackSig !== null && t !== S.trackSig && expanded) {
          if (S.settle) clearTimeout(S.settle);
          // media-ui lane: the heart is re-read with the queue (CONTRACT: "re-read on a track change")
          S.settle = setTimeout(function () { if (S) { S.settle = 0; refresh(false); if (S.status && S.status.state === 'connected') loadInfo(); } }, TRACK_SETTLE_MS);
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
      if (S.hideTimer) clearInterval(S.hideTimer);
      if (S.armTimer) clearTimeout(S.armTimer);
      if (S.noteTimer) clearTimeout(S.noteTimer);
      if (S.unsub) { try { S.unsub(); } catch (e) { /* gone */ } }
      if (S.apUnsub) { try { S.apUnsub(); } catch (e) { /* gone */ } }
      if (S.kbd === 'yes') S.api.call('qs.keyboard', { on: false }).catch(function () {});
      S = null;
    }
  };
  // spotfix lane: look() is also loaded by require() in node (lib/features/spotify.test.js), where there is no window
  if (typeof window !== 'undefined') window.MantleSpotify = API;
  if (typeof module === 'object' && module.exports) module.exports = { look: look, plain: plain };
})();
