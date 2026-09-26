'use strict';
/* spotify.js - Spotify's "Up next" queue in the now-playing card (spotq lane, 2026-09-25).
 * The control is ui/bar/spotify.js (drawn inside the card by ui/bar/bar.js); the Spotify client is
 * ./_spotify-api.js. This file wires it to Mantle: the page's commands, the status push, the
 * encrypted token file (Electron safeStorage) and Owen's default browser for the one-time consent.
 *
 * Commands (window.mantle.call('spotify.<verb>')): status, setClient {clientId}, connect, cancel,
 * disconnect {forgetClient}, queue, add {uri}, play {uri, index}, search {q}, copyRedirect,
 * openDashboard. Push: 'spotify.status' (replayed on subscribe).
 *
 * Nothing runs on its own: no timer, no poll, no port open. The card asks for the queue while its
 * "Up next" list is open; the sign-in catcher on 127.0.0.1 listens only between Connect and the
 * browser's answer (5 minutes at most). stop() closes it and forgets the access token.
 *
 * --test (ctx.flags.test): the browser is NEVER opened and the clipboard is never written (both
 * answer dryRun with what they would have done), and MANTLE_SPOTIFY_ACCOUNTS / MANTLE_SPOTIFY_API /
 * MANTLE_SPOTIFY_PORT point it at a fake Spotify (ignored, with a log line, in a live run).
 */
const path = require('path');
const { createSpotify, fileVault, PORT } = require('./_spotify-api.js');

const OFF = 'the Spotify queue is off in Mantle’s tray menu';

function install(ctx, inject) {
  const inj = inject || {};
  const test = !!(ctx.flags && ctx.flags.test);
  const env = {};
  for (const [k, key] of [['accountsBase', 'MANTLE_SPOTIFY_ACCOUNTS'], ['apiBase', 'MANTLE_SPOTIFY_API'], ['port', 'MANTLE_SPOTIFY_PORT']]) {
    if (!process.env[key]) continue;
    if (test) env[k] = k === 'port' ? Number(process.env[key]) : process.env[key];
    else ctx.log(`${key} is ignored outside --test`);
  }

  let electron = null;
  function el() { if (!electron) electron = require('electron'); return electron; }
  const vault = inj.vault || fileVault(path.join(path.dirname(ctx.settings.file), 'spotify-token.bin'), el().safeStorage);
  const openExternal = inj.openExternal || (async (url) => {
    if (test) { ctx.log('connect: a test instance never opens the browser (dry run)'); return { dryRun: true }; }
    await el().shell.openExternal(url);
    return { dryRun: false };
  });

  const sp = createSpotify(Object.assign({
    port: PORT,
    vault,
    settings: ctx.settings,
    log: (t) => ctx.log(t),
    onStatus: (s) => ctx.broadcast('spotify.status', s),
    openExternal,
  }, env, inj.options || {}));

  ctx.replay('spotify.status', () => (ctx.enabled() ? sp.status() : { ok: true, state: 'off', reason: OFF }));

  const guard = (fn) => async (a) => (ctx.enabled() ? fn(a || {}) : { ok: false, state: 'off', reason: OFF });
  ctx.command('status', guard(async () => sp.status()));
  ctx.command('setClient', guard(async (a) => sp.setClientId(a)));
  ctx.command('connect', guard(async () => sp.connect()));
  ctx.command('cancel', guard(async () => sp.cancel()));
  ctx.command('disconnect', guard(async (a) => sp.disconnect(a)));
  ctx.command('queue', guard(async () => sp.queue()));
  ctx.command('add', guard(async (a) => sp.add(a)));
  ctx.command('play', guard(async (a) => sp.play(a)));
  ctx.command('search', guard(async (a) => sp.search(a)));
  ctx.command('copyRedirect', guard(async () => {
    if (test) return { ok: true, dryRun: true, text: sp.redirectUri, reason: 'a test instance never writes the clipboard' };
    try { el().clipboard.writeText(sp.redirectUri); } catch (e) { return { ok: false, reason: `it could not be copied (${e.message})` }; }
    return { ok: true, text: sp.redirectUri };
  }));
  ctx.command('openDashboard', guard(async () => {
    const url = 'https://developer.spotify.com/dashboard';
    if (test) return { ok: true, dryRun: true, url };
    try { await el().shell.openExternal(url); } catch (e) { return { ok: false, reason: `the browser could not be opened (${e.message})` }; }
    return { ok: true, url };
  }));

  ctx.onEnabled((on) => {
    if (!on) sp.stop();
    ctx.broadcast('spotify.status', on ? sp.status() : { ok: true, state: 'off', reason: OFF });
  });
  ctx.health(true);
  const st = sp.status();
  ctx.log(`state=${st.state} encryption=${st.encryption ? 'yes' : 'NO'} redirect=${st.redirectUri}`);

  return { stop() { sp.stop(); }, _sp: sp };
}

module.exports = {
  name: 'spotify',
  label: 'Spotify queue (now-playing card)',
  defaultOn: true,
  chords: [],
  observe: [],
  install(ctx) { return install(ctx, null); },
  _install: install,          // spotify.test.js: the same install with a fake vault and a fake Spotify
};
