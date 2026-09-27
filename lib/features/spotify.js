'use strict';
/* spotify.js - Spotify's "Up next" queue in the now-playing card (spotq lane, then spotapp lane,
 * 2026-09-25). The control is ui/bar/spotify.js (drawn inside the card by ui/bar/bar.js); the
 * Spotify side is ./_spotify-app.js, which drives the Spotify DESKTOP APP over the Chrome DevTools
 * Protocol on 127.0.0.1:47292 (Spotify started by Mantle with --remote-debugging-port).
 *
 * The first version used the Spotify Web API with Owen's own developer Client ID; that API now needs
 * Spotify Premium (developer.spotify.com: "Upgrade to Spotify Premium to access the Web API") and he
 * has none, so that path (its sign-in, local catcher and encrypted token file) was REMOVED rather
 * than kept as an option: the desktop app does everything the Web API did, plus remove and reorder,
 * for free and Premium accounts alike, and a second sign-in flow would only be a dead end in the card.
 *
 * Commands (window.mantle.call('spotify.<verb>')): status, queue, play {uri, uid}, add {uri},
 * remove {uri, uid}, move {uri, uid, dir: up|down}, search {q}, start, restart; and (spothide lane,
 * 2026-09-26) info, library, searchAll {q}, playUri {uri}, shuffle {on}, repeat {mode}, openWindow,
 * hideWindow, quit. start (and a pin or launcher start, via launchBus) runs Spotify HIDDEN.
 * Push: 'spotify.status' (replayed on subscribe with the last known state).
 *
 * Nothing runs on its own: no timer, no poll, no port opened by Mantle. The card asks while its
 * "Up next" list is open. start/restart are the only things that touch the Spotify process, and only
 * when Owen clicks them.
 *
 * --test (ctx.flags.test): start and restart are DRY RUNS (the real Spotify is never closed or
 * started), and MANTLE_SPOTIFY_APP_PORT points the bridge at a fake debugging port (ignored, with a
 * log line, in a live run).
 */
const { createSpotifyApp, launchBus, PORT } = require('./_spotify-app.js');

const OFF = 'the Spotify queue is off in Mantle’s tray menu';

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
    onStatus: (s) => { if (ctx.enabled()) ctx.broadcast('spotify.status', s); },
  }, env, inj.options || {}));

  ctx.replay('spotify.status', () => (ctx.enabled() ? sp.last() : { ok: true, state: 'off', reason: OFF }));

  /* Every command answers { ok, reason } even when the bridge throws: nothing fails silently. */
  const guard = (verb, fn) => async (a) => {
    if (!ctx.enabled()) return { ok: false, state: 'off', reason: OFF };
    try { return await fn(a || {}); } catch (e) {
      ctx.log(`${verb} threw: ${(e && e.stack) || e}`);
      return { ok: false, state: 'error', reason: `${verb} failed inside Mantle: ${(e && e.message) || e}` };
    }
  };
  for (const verb of ['status', 'queue', 'play', 'add', 'remove', 'move', 'search', 'start', 'restart']) {
    ctx.command(verb, guard(verb, (a) => sp[verb](a)));
  }

  /* spothide lane (2026-09-26): Spotify runs HIDDEN and is played from the card. */
  for (const verb of ['info', 'library', 'searchAll', 'playUri', 'shuffle', 'repeat', 'openWindow', 'hideWindow', 'quit']) {
    ctx.command(verb, guard(verb, (a) => sp[verb](a)));
  }
  /* A pin or launcher row started Spotify (lib/spotify-launch.js): hide it the way the card's Start
     does. Only while the feature is on; the launch itself only happens then too. */
  const bus = inj.bus || launchBus();
  const onLaunched = (e) => {
    if (!ctx.enabled()) { ctx.log(`a Spotify started from ${(e && e.source) || 'Mantle'} was not hidden: the Spotify queue is off`); return; }
    sp.adopt(e).catch((err) => ctx.log(`hiding a launched Spotify threw: ${(err && err.stack) || err}`));
  };
  bus.on('launched', onLaunched);

  ctx.onEnabled((on) => {
    if (!on) sp.stop();
    ctx.broadcast('spotify.status', on ? sp.last() : { ok: true, state: 'off', reason: OFF });
  });
  ctx.health(true);
  ctx.log(`desktop-app bridge on 127.0.0.1:${sp.port}${test ? ' (test: start/restart are dry runs)' : ''}`);

  return { stop() { bus.removeListener('launched', onLaunched); sp.stop(); }, _sp: sp };
}

module.exports = {
  name: 'spotify',
  label: 'Spotify queue (now-playing card)',
  defaultOn: true,
  chords: [],
  observe: [],
  install(ctx) { return install(ctx, null); },
  _install: install,          // spotify.test.js: the same install against a fake Spotify page
};
