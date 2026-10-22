'use strict';
/* spotify.js - Spotify's "Up next" queue in the now-playing card (spotq lane, then spotapp lane,
 * 2026-09-25). The control is ui/bar/spotify.js (drawn inside the card by ui/bar/bar.js); the
 * Spotify side is ./_spotify-app.js, which drives the Spotify DESKTOP APP over the Chrome DevTools
 * Protocol on 127.0.0.1:47292 (Spotify started by Mantle with --remote-debugging-port).
 *
 * The first version used the Spotify Web API with the user's own developer Client ID; that API now needs
 * Spotify Premium (developer.spotify.com: "Upgrade to Spotify Premium to access the Web API") and they
 * have none, so that path (its sign-in, local catcher and encrypted token file) was REMOVED rather
 * than kept as an option: the desktop app does everything the Web API did, plus remove and reorder,
 * for free and Premium accounts alike, and a second sign-in flow would only be a dead end in the card.
 *
 * Commands (window.mantle.call('spotify.<verb>')): status, queue, play {uri, uid}, add {uri},
 * remove {uri, uid}, move {uri, uid, dir: up|down}, search {q}, start, restart; and (spothide lane,
 * 2026-09-26) info, library, searchAll {q}, playUri {uri}, shuffle {on}, repeat {mode}, openWindow,
 * hideWindow, quit; and (media-be lane, 2026-09-29) like {on, uri?}: the card's heart (Liked Songs),
 * with info() saying liked true | false | null. start (and a pin or launcher start, via launchBus) runs
 * Spotify HIDDEN.
 * Push: 'spotify.status' (replayed on subscribe with the last known state).
 *
 * Nothing runs on its own (no poll of the page, no port opened by Mantle) EXCEPT the memory watch
 * (sptrim lane, ./_spotify-trim.js): while the Spotify Mantle started runs hidden, its RAM is read every
 * 30 s through the sidecar (spotify.mem) and trimmed when it is over TRIM_ABOVE_MB (the setting
 * trimAboveMB overrides it), never the process playing the audio. The card asks while its "Up next"
 * list is open. start/restart are the only things that start or close the Spotify process when the user
 * clicks, with ONE exception (spotdeath lane, ./_spotify-revive.js): a hidden Spotify that closed while
 * a game ran is started again, hidden and not playing, after the game exits, once per game, unless
 * the card’s "Restart Spotify after games" is off (command revive {on}; setting reviveAfterGames).
 * And (spotgame lane, 2026-09-28) when Mantle starts resting for a known game (ctx.onRest: game mode's
 * own watch), Mantle's own Spotify is closed if nothing plays and started again hidden after the game,
 * unless the card's "Close Spotify while I game" is off (command gameclose {on}; setting closeForGames).
 *
 * --test (ctx.flags.test): start and restart are DRY RUNS (the real Spotify is never closed or
 * started), and MANTLE_SPOTIFY_APP_PORT points the bridge at a fake debugging port (ignored, with a
 * log line, in a live run).
 */
const { createSpotifyApp, launchBus, PORT } = require('./_spotify-app.js');
const { TRIM_ABOVE_MB } = require('./_spotify-trim.js');
const { SETTING: REVIVE, TOGGLE: REVIVE_LABEL, CLOSE_SETTING: GAMECLOSE, CLOSE_TOGGLE: GAMECLOSE_LABEL } = require('./_spotify-revive.js');

const OFF = 'the Spotify queue is off in Mantle’s tray menu';

/* spotgame lane: does the media session say Spotify plays? main.js's last NOW PLAYING read ->
   true | false (no Spotify session, or one not playing) | null (unknown: nothing read yet, or it failed). */
function mediaPlaying(read) {
  if (!read || read.ok === false || !Array.isArray(read.sessions)) return null;
  const sp = read.sessions.filter((s) => s && /spotify/i.test(`${s.aumid || ''} ${(s.app && s.app.name) || ''}`));
  return sp.some((s) => s.playing === true || /^playing$/i.test(String(s.status || '')));
}

function install(ctx, inject) {
  const inj = inject || {};
  const test = !!(ctx.flags && ctx.flags.test);
  const env = {};
  if (process.env.MANTLE_SPOTIFY_APP_PORT) {
    if (test) env.port = Number(process.env.MANTLE_SPOTIFY_APP_PORT);
    else ctx.log('MANTLE_SPOTIFY_APP_PORT is ignored outside --test');
  }

  const sp = createSpotifyApp(Object.assign({
    port: PORT,
    dryRun: test,
    log: (t) => ctx.log(t),
    /* sptrim lane: the memory watch reads and trims through the sidecar (sidecar/SpotifyMem.cs). */
    sidecar: (cmd, args, ms) => ctx.sidecar.send(cmd, args, { timeoutMs: ms }),
    trimAboveMB: () => { const n = Number(ctx.settings && ctx.settings.get('trimAboveMB', TRIM_ABOVE_MB)); return Number.isFinite(n) && n >= 50 ? n : TRIM_ABOVE_MB; },
    onStatus: (s) => { if (ctx.enabled()) ctx.broadcast('spotify.status', s); },
    /* spotdeath lane: the card's "Restart Spotify after games" (on unless the user turns it off). */
    reviveOn: () => !(ctx.settings && ctx.settings.get(REVIVE, true) === false),
    /* spotgame lane: the card's "Close Spotify while I game" (on unless the user turns it off). */
    closeForGames: () => !(ctx.settings && ctx.settings.get(GAMECLOSE, true) === false),
    mediaPlaying: () => mediaPlaying(ctx.host && typeof ctx.host.media === 'function' ? ctx.host.media() : null),
  }, env, inj.options || {}));

  ctx.replay('spotify.status', () => (ctx.enabled() ? sp.last() : { ok: true, state: 'off', reason: OFF }));

  /* Every command answers { ok, reason } even when the bridge throws: nothing fails silently. The
     card gets plain words (media-be lane, 2026-09-29: it used to show "searchAll failed inside Mantle:
     <the error>"); the log gets the stack. A renderer sending a non-object gets an empty one. */
  const guard = (verb, fn) => async (a) => {
    if (!ctx.enabled()) return { ok: false, state: 'off', reason: OFF };
    try { return await fn(a && typeof a === 'object' && !Array.isArray(a) ? a : {}); } catch (e) {
      ctx.log(`${verb} threw: ${(e && e.stack) || e}`);
      return { ok: false, state: 'error', reason: 'Something went wrong inside Mantle, so that didn’t happen. Try again' };
    }
  };
  for (const verb of ['status', 'queue', 'play', 'add', 'remove', 'move', 'search', 'start', 'restart']) {
    ctx.command(verb, guard(verb, (a) => sp[verb](a)));
  }

  /* spothide lane (2026-09-26): Spotify runs HIDDEN and is played from the card. */
  for (const verb of ['info', 'library', 'searchAll', 'playUri', 'shuffle', 'repeat', 'openWindow', 'hideWindow', 'quit']) {
    ctx.command(verb, guard(verb, (a) => sp[verb](a)));
  }
  /* media-be lane (2026-09-29): the card's heart, like {on: bool, uri?} (the current song when no uri). */
  ctx.command('like', guard('like', (a) => sp.like(a)));
  /* spotdeath lane: the card's toggle. Saved with the feature's settings; the card's words follow at once. */
  ctx.command('revive', guard('revive', async (a) => {
    const on = a.on !== false;
    ctx.settings.set(REVIVE, on);
    ctx.log(`${REVIVE_LABEL}: ${on ? 'on' : 'off'} (from the card)`);
    sp.reviveToggled();
    return { ok: true, on };
  }));
  /* spotgame lane: "Close Spotify while I game". */
  ctx.command('gameclose', guard('gameclose', async (a) => {
    const on = a.on !== false;
    ctx.settings.set(GAMECLOSE, on);
    ctx.log(`${GAMECLOSE_LABEL}: ${on ? 'on' : 'off'} (from the card)`);
    sp.closeToggled();
    return { ok: true, on };
  }));
  /* Mantle Settings (lane settings, 2026-09-28) writes the same keys in the same store (options below,
     lib/features.js OPTIONS): the card's words follow at once, as from its own toggles. trimAboveMB is
     read at every check, so it needs no word. */
  if (typeof ctx.onOption === 'function') {
    ctx.onOption(REVIVE, () => sp.reviveToggled());
    ctx.onOption(GAMECLOSE, () => sp.closeToggled());
  }
  /* spotgame lane: Mantle starts resting for a game (on) or wakes after it (off). */
  const offRest = typeof ctx.onRest === 'function' ? ctx.onRest((e) => {
    if (!ctx.enabled()) return;
    sp.gameRest(e).catch((err) => ctx.log(`closing Spotify for a game threw: ${(err && err.stack) || err}`));
  }) : () => {};

  /* A pin or launcher row started Spotify (lib/spotify-launch.js): hide it the way the card's Start
     does. Only while the feature is on; the launch itself only happens then too. */
  const bus = inj.bus || launchBus();
  const onLaunched = (e) => {
    if (!ctx.enabled()) { ctx.log(`a Spotify started from ${(e && e.source) || 'Mantle'} was not hidden: the Spotify queue is off`); return; }
    sp.adopt(e).catch((err) => ctx.log(`hiding a launched Spotify threw: ${(err && err.stack) || err}`));
  };
  bus.on('launched', onLaunched);
  /* spotfix lane: a pin or launcher row brought the RUNNING Spotify forward: the user wants it seen, so a
     hide still being tried stops, and it is not hidden again. */
  const onOpening = (e) => { if (ctx.enabled()) sp.opening(e); };
  bus.on('opening', onOpening);

  ctx.onEnabled((on) => {
    if (!on) sp.stop('the Spotify queue was turned off'); else sp.resume();
    ctx.broadcast('spotify.status', on ? sp.last() : { ok: true, state: 'off', reason: OFF });
  });
  ctx.health(true);
  ctx.log(`desktop-app bridge on 127.0.0.1:${sp.port}${test ? ' (test: start/restart are dry runs)' : ''}`);
  /* spadopt lane: a Spotify an EARLIER Mantle started hidden (go-live, Restart Mantle, logon) is taken
     over: its window state, memory watch, Open / Hide / Quit. Reads only; --test says, never takes. */
  if (ctx.enabled()) sp.takeOver('Mantle started').catch((e) => ctx.log(`the Spotify takeover threw: ${(e && e.stack) || e}`));

  return { stop() { bus.removeListener('launched', onLaunched); bus.removeListener('opening', onOpening); offRest(); sp.stop(); }, _sp: sp };
}

module.exports = {
  name: 'spotify',
  label: 'Spotify queue (now-playing card)',
  defaultOn: true,
  chords: [],
  observe: [],
  // Mantle Settings > Mantle (lane settings, 2026-09-28): the card's two toggles and the trim line.
  options: [
    { key: GAMECLOSE, label: GAMECLOSE_LABEL, help: 'Only when no music is playing; it comes back hidden when the game exits', type: 'bool', default: true },
    { key: REVIVE, label: REVIVE_LABEL, help: 'A Spotify that closed while a game ran is started again, hidden, after it', type: 'bool', default: true },
    { key: 'trimAboveMB', label: 'Trim the hidden Spotify above', help: 'Its memory is handed back to Windows when the whole Spotify tree passes this', type: 'number', min: 50, max: 4000, step: 50, unit: 'MB', default: TRIM_ABOVE_MB },
  ],
  install(ctx) { return install(ctx, null); },
  _install: install,          // spotify.test.js: the same install against a fake Spotify page
  _mediaPlaying: mediaPlaying,
};
