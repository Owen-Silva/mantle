'use strict';
/* autopause.js - Spotify auto-pause, inside Mantle (r5-autopause lane, 2026-09-30).
 *
 * Spotify pauses while another app plays video or sound (a lesson or video app, a YouTube video in any
 * browser, a video player) and starts again after. This replaced an earlier standalone PowerShell
 * bridge with no PowerShell at all:
 *   - the sidecar meters every app's audio with its process tree (sidecar/AutoPause.cs,
 *     autopause.peaks): a Store app's sound can come from a grandchild web view;
 *   - main's NOW PLAYING read (ctx.host.media / onMedia) says which media sessions exist and Spotify's
 *     own state; Spotify is paused and resumed through the same media session (sidecar `media`
 *     control, dryRun in --test);
 *   - the rules and constants are the bridge's, measured on a real machine (./_autopause-core.js), and
 *     who-is-playing is ./_autopause-attrib.js.
 *
 * COEXISTENCE (./_autopause-coexist.js): while the standalone helper is in charge (its task enabled, or
 * a bridge answering on 8787-8790) this stays off and says so. Checked every 15 s; when the helper
 * comes back, any hold Mantle holds is handed back first.
 *
 * COST: nothing runs while Spotify is not playing and nothing is held (the media watch wakes it). While
 * Spotify plays: one verdict every 250 ms (the bridge's pollMs), and a peaks read ONLY while another app
 * has a media session ('media' mode: Spotify alone needs no meter at all) or in 'any' mode. The read
 * itself never waits: the sidecar meters on its own low-priority thread and answers with its newest
 * reading (sidecar/AutoPause.cs). The first ticks wait START_QUIET_MS after Mantle starts, so none of
 * this lands in the start-up rush. Rests while a game runs (rest: true), and every hold is handed back
 * first. MEASURED (r6-apfix, 2026-09-30, passive private builds back to back, 30 s at 250 ms, per-thread
 * CPU): the meter work went from 2.5% of a core (6.4 ms a read, on the audio request lane) to 0.16%
 * (0.4 ms a read, on its own thread); the whole sidecar while asked from 2.7% to 0.6%; 0 with Spotify alone.
 *
 * ADOPTION (_autopause-core.js adopt()): when auto-pause takes charge ON ITS OWN (Mantle starting, the
 * standalone helper switched off), what already plays next to Spotify is left alone until it stops.
 *
 * WITH QUARTZ (./_autopause-link.js + ./_autopause-compat.js, docs/autopause-protocol.md): Quartz ships the
 * same auto-pause, and either app works alone. The first to bind 127.0.0.1:8787-8790 is the HOST, the one
 * decision maker over Spotify, and serves the old bridge's HTTP API there (so a browser extension written
 * for it keeps working). The other is a CLIENT: Mantle as a client forwards "a watched app plays" as one
 * hold (src=mantle) and its engine never sees Spotify. When the host quits or crashes, the client takes
 * over within a second and inherits its pause, so nothing double-pauses and nothing strands. Never on the
 * real ports in --test (MANTLE_AUTOPAUSE_PORT names a test port; with none, Mantle decides alone, dry run).
 *
 * Push: 'autopause.status' { ok, state: off|standby|idle|holding|backoff|error, words, card, apps, ... }.
 * Commands: status. Privacy: the log gets counts and states, never an app name or a title.
 */
const { createEngine } = require('./_autopause-core.js');
const attrib = require('./_autopause-attrib.js');
const coexist = require('./_autopause-coexist.js');
const { createCompat, PORTS } = require('./_autopause-compat.js');
const { createLink } = require('./_autopause-link.js');

const APPS = 'apps';
const COEXIST_MS = 15000;
const START_QUIET_MS = 5000;     // no meter read in Mantle's first 5 s (the start-up rush)
const WARMING_MAX = 8;           // a meter still "warming" after 8 asks (~2 s) counts as unreadable

function holdWords(holds) {
  const names = [];
  let http = false;
  for (const h of holds) {
    if (!h.native) { http = true; continue; }
    const n = h.kind === 'browser' ? `${h.label || 'your browser'} plays a video` : `${h.label || 'another app'} plays`;
    if (!names.includes(n)) names.push(n);
  }
  if (http && !names.length) names.push('a video plays in your browser');
  if (!names.length) return 'Paused while another app plays';
  if (names.length === 1) return `Paused while ${names[0]}`;
  return `Paused while ${names.length} apps play`;
}

/** The plain words for every state. PURE (autopause.test.js). */
function statusOf(x) {
  const mode = x.mode === 'any' ? 'any' : 'media';
  const base = { ok: true, mode, apps: mode };
  if (!x.enabled) return Object.assign(base, { state: 'off', words: 'Off', card: '' });
  if (x.standby) return Object.assign(base, { state: 'standby', words: x.standbyWords, card: '' });
  const s = x.snap || { holds: [] };
  if (s.lastError && (s.holds.length || s.wePaused)) {
    return Object.assign(base, { state: 'error', words: `Spotify could not be paused: ${s.lastError}`, card: 'Couldn’t pause Spotify' });
  }
  if (s.holds.length && s.suppressed) {
    const min = Math.max(1, Math.round(s.suppressedForMs / 60000));
    return Object.assign(base, { state: 'backoff', words: `You started Spotify again, so auto-pause leaves it alone for ${min} min`, card: 'Auto-pause is leaving Spotify alone for now' });
  }
  // Another app is the host (docs/autopause-protocol.md): Mantle's holds go there and it pauses Spotify.
  const via = x.via ? String(x.via.server || '').replace(/^./, (c) => c.toUpperCase()) : '';
  if (via && s.holds.length) {
    const w = holdWords(s.holds);
    return Object.assign(base, { state: 'holding', words: `${w} (${via} pauses it)`, card: x.via.paused ? w : '' });
  }
  if (s.holds.length) {
    const w = s.wePaused ? holdWords(s.holds) : holdWords(s.holds).replace(/^Paused/, 'Holding Spotify');
    return Object.assign(base, { state: 'holding', words: w, card: s.wePaused ? w : '' });
  }
  const what = mode === 'any' ? 'any other app makes a sound' : 'another app plays video or sound';
  const note = x.meterWhy ? `. App sound levels can’t be read right now (${x.meterWhy}), so Mantle goes by what apps report` : '';
  const shared = via ? `. ${via} is also running and controls Spotify for both` : '';
  return Object.assign(base, { state: 'idle', words: `On: Spotify pauses while ${what}${note}${shared}`, card: '' });
}

function install(ctx, inject) {
  const inj = inject || {};
  const test = !!(ctx.flags && ctx.flags.test);
  const now = inj.now || Date.now;
  const mantlePids = new Set([process.pid].concat(inj.mantlePids || []));
  const mode = () => (ctx.settings && ctx.settings.get(APPS, 'media') === 'any' ? 'any' : 'media');
  let spotify = { found: false, aumid: null, state: 'none' };
  let sim = null;                 // dryRun: what Spotify WOULD be after our command (the real one never moves)
  let pending = null;             // live: { state, until } after a command, until the media session catches up
  let standby = true, standbyWords = '', meterWhy = '', stopped = false, timer = null, coexistTimer = null, ticking = false;
  let last = null, lastJson = '';
  const installedAt = now();
  const startQuietMs = typeof inj.startQuietMs === 'number' ? inj.startQuietMs : (test ? 0 : START_QUIET_MS);
  let warming = 0;

  function spState() {
    if (sim) return sim;
    if (pending && now() < pending.until && spotify.state !== pending.state) return pending.state;
    pending = null;
    return spotify.found ? spotify.state : 'none';
  }
  async function control(action) {
    if (!spotify.aumid) return { ok: false, reason: 'Spotify is not open' };
    const r = await ctx.sidecar.send('media', { op: 'control', action, aumid: spotify.aumid, dryRun: test }, { timeoutMs: 3000 });
    const res = r && r.ok ? r.result : null;
    if (!res || res.ok === false) return { ok: false, reason: (res && res.reason) || (r && r.error) || 'Windows did not answer' };
    const want = action === 'pause' ? 'paused' : action === 'play' ? 'playing' : null;
    if (test) { if (want) sim = want; ctx.log(`test: would ${action} Spotify (nothing sent)`); } else if (want) pending = { state: want, until: now() + 2000 };
    return { ok: true };
  }
  let link = null;
  const engine = inj.engine || createEngine({
    now,
    log: (t) => ctx.log(t),
    // Only the HOST decides: as a client (another app hosts) Mantle's engine sees no Spotify at all.
    spotify: { state: () => (link && link.role() === 'host' ? spState() : 'none'), pause: () => control('pause'), play: () => control('play') },
  });

  const envPort = Number(process.env.MANTLE_AUTOPAUSE_PORT);
  const compatPorts = inj.compatPorts || (test ? (Number.isInteger(envPort) && envPort > 1024 ? [envPort] : null) : null);
  // --test never reaches the real ports: no port named = decide alone (dry run), never a client of the live host.
  const linkPorts = compatPorts || (test ? [] : PORTS);
  const compat = createCompat({
    engine, now, log: (t) => ctx.log(t), media: readMedia, control, name: 'mantle',
    spotify: () => ({ found: spotify.found, state: spState(), aumid: spotify.aumid }),
    changed: () => { publish(); if (wanted()) schedule(0); },
    ports: linkPorts,
  });
  /* WHO DECIDES (./_autopause-link.js, docs/autopause-protocol.md): the first app to bind 8787-8790 is the
   * host and the only one that touches Spotify; the other sends its holds there. Mantle's holds are its
   * engine's own (watched apps), so as a client it forwards "something plays" and its engine sees no Spotify. */
  link = (inj.createLink || createLink)({
    name: 'mantle', ports: linkPorts, log: (t) => ctx.log(t), get: inj.linkGet,
    canHost: () => !stopped && !standby && ctx.enabled(),
    host: { start: () => (linkPorts.length ? compat.start() : Promise.resolve(null)), stop: (why) => compat.stop(why), port: () => compat.port() },
    localHold: async () => {},
    onHost: async (x) => {
      const prev = x && x.last;
      if (prev) await engine.inherit({ paused: !!(prev.wePaused || prev.heldByUs), suppressedForMs: prev.repauseSuppressed ? Number(prev.repauseSuppressedForMs) || 0 : 0 });
      publish();
      if (wanted()) schedule(0);
    },
    retire: async (why) => {
      if (compat.successorWatching()) { const r = engine.handOff(); ctx.log(`handed Spotify over to the other app (${r.action})`); }
      else { await engine.releaseAll(why); compat.notify(); }
      sim = null;
    },
    onChange: () => publish(),
  });
  /* Taking part only while this auto-pause is on and the standalone helper is not in charge. */
  function syncLink(why) {
    const want = !stopped && !standby && ctx.enabled();
    const p = want ? (link.role() === 'off' ? link.start() : link.sync()) : link.stop(why);
    return Promise.resolve(p).catch((e) => ctx.log(`the auto-pause link threw: ${(e && e.stack) || e}`));
  }
  function forward() {
    const h = engine.snapshot(now()).holds.some((x) => x.native);
    if (h !== link.held()) link.setHeld(h).catch((e) => ctx.log(`forwarding a hold threw: ${(e && e.stack) || e}`));
  }

  function publish() {
    const role = link ? link.role() : 'off';
    const hs = role === 'client' ? link.hostStatus() : null;
    const st = statusOf({ enabled: ctx.enabled(), standby, standbyWords, mode: mode(), meterWhy, snap: engine.snapshot(now()),
      via: hs ? { server: String(hs.server || 'the auto-pause helper'), paused: !!hs.heldByUs } : null });
    st.role = role;
    last = st;
    const j = JSON.stringify([st.state, st.words, st.card, st.mode, role]);
    if (j !== lastJson) { lastJson = j; ctx.broadcast('autopause.status', st); }
    if (link && role !== 'off') forward();
    compat.notify();
    return st;
  }

  function readMedia() {
    const m = ctx.host && typeof ctx.host.media === 'function' ? ctx.host.media() : null;
    return m && m.ok !== false ? m : null;
  }

  function wanted() {
    if (stopped || standby || !ctx.enabled()) return false;
    const s = engine.snapshot(now());
    return s.holds.length > 0 || s.wePaused || spState() === 'playing';
  }

  async function tickOnce() {
    const media = readMedia();
    const a0 = attrib.sources({ media, peaks: null, mode: mode(), mantlePids });
    const sp = a0.spotify;
    spotify = sp;
    if (sim && !sp.found) sim = null;
    // Spotify is the only media session ('media' mode): no app can take a hold, so no meter read at all.
    if (mode() === 'media' && a0.counts.media === 0) { warming = 0; await engine.tick(now(), []); return; }
    const r = await ctx.sidecar.send('autopause.peaks', { everyMs: engine.config.pollMs }, { timeoutMs: 1500 });
    const res = r && r.ok && r.result ? r.result : null;
    // The meter's first reading after a rest is still being taken: judge nothing on half the picture.
    if (res && res.ok !== false && res.warming && ++warming <= WARMING_MAX) return;
    warming = 0;
    const peaks = res && res.ok !== false && !res.warming ? res : null;
    const why = peaks ? '' : ((res && res.warming && 'the sound meter did not start') || (res && res.reason) || (r && r.error) || 'no answer');
    if (why !== meterWhy) { meterWhy = why; ctx.log(why ? 'app sound levels unreadable; judging by media status only' : 'app sound levels readable again'); }
    const a = attrib.sources({ media, peaks, mode: mode(), mantlePids });
    await engine.tick(now(), a.sources);
  }

  function schedule(ms) {
    if (timer || stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!wanted()) { publish(); return; }
      const quiet = installedAt + startQuietMs - now();
      if (quiet > 0) { schedule(quiet); return; }
      if (ticking) { schedule(engine.config.pollMs); return; }
      ticking = true;
      try { await tickOnce(); } catch (e) { ctx.log(`a tick threw: ${(e && e.stack) || e}`); }
      ticking = false;
      publish();
      if (wanted()) schedule(engine.config.pollMs);
    }, ms);
    if (timer && timer.unref) timer.unref();
  }

  function onMedia(m) {
    if (stopped) return;
    spotify = attrib.sources({ media: m && m.ok !== false ? m : null, peaks: null, mode: mode(), mantlePids }).spotify;
    if (!spotify.found) sim = null;
    if (wanted()) schedule(0);
  }

  async function releaseAll(why) {
    try { await engine.releaseAll(why); } catch (e) { ctx.log(`handing Spotify back threw: ${(e && e.stack) || e}`); }
    sim = null;
    publish();
  }

  async function coexistCheck() {
    if (stopped) return;
    let c;
    try { c = await (inj.coexist || coexist.check)(); } catch (e) { c = { inCharge: true, words: 'Mantle could not tell whether the separate auto-pause helper runs, so it stays off to be safe' }; }
    if (stopped) return;
    const was = standby;
    standby = !!c.inCharge;
    standbyWords = c.words || '';
    if (standby !== was) {
      ctx.log(standby ? `standing by: the standalone helper is in charge (task ${c.task || '?'}, bridge ${c.bridge ? 'answering' : 'silent'})` : 'in charge: the standalone helper is off');
      if (standby) { await syncLink('the standalone helper is in charge'); await releaseAll('the standalone helper is in charge'); }
      else { engine.adopt(); onMedia(readMedia()); }
    }
    await syncLink(standby ? 'the standalone helper is in charge' : '');
    publish();
  }

  ctx.replay('autopause.status', () => last || publish());
  ctx.command('status', async () => Object.assign({}, publish(), { detail: engine.snapshot(now()), test }));
  /* The Spotify card's switch (r6-apfix): the SAME
   * on/off as Settings and the tray (features.json, so it holds across a restart), applied at once; off
   * hands a held Spotify back before answering. {on} -> {ok, on, reason, ...status}. */
  ctx.command('switch', async (args) => {
    const on = args ? args.on : undefined;
    if (typeof on !== 'boolean') return { ok: false, on: ctx.enabled(), reason: 'on must be true or false' };
    const fx = ctx.host && ctx.host.features;
    if (!fx || typeof fx.setEnabled !== 'function') return { ok: false, on: ctx.enabled(), reason: 'this Mantle can only switch it in Settings (Win+I)' };
    let r;
    try { r = await fx.setEnabled('autopause', on); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    if (!r || r.ok === false) return { ok: false, on: ctx.enabled(), reason: (r && r.reason) || 'the switch did not move' };
    await engine.idle();           // off: the hand-back has gone out before the card hears "done"
    return Object.assign({}, publish(), { ok: true, on: ctx.enabled() });
  });
  const offMedia = ctx.host && typeof ctx.host.onMedia === 'function' ? ctx.host.onMedia(onMedia) : () => {};
  if (typeof ctx.onOption === 'function') ctx.onOption(APPS, () => { ctx.log(`counting: ${mode()}`); publish(); });
  ctx.onEnabled((on) => {
    if (!on) { syncLink('auto-pause was turned off').then(() => releaseAll('auto-pause was turned off')); } else { engine.adopt(false); coexistCheck(); onMedia(readMedia()); }
    publish();
  });
  coexistTimer = setInterval(coexistCheck, inj.coexistMs || COEXIST_MS);
  if (coexistTimer.unref) coexistTimer.unref();
  coexistCheck();
  ctx.health(true);
  ctx.log(`installed${test ? ' (test: Spotify is never paused or played, only said)' : ''}`);
  publish();
  return {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (coexistTimer) { clearInterval(coexistTimer); coexistTimer = null; }
      offMedia();
      return link.stop('Mantle stopped auto-pause')
        .then(() => engine.releaseAll('Mantle stopped auto-pause'))
        .catch((e) => ctx.log(`handing Spotify back threw: ${(e && e.stack) || e}`));
    },
    _engine: engine, _compat: compat, _link: link, _tick: tickOnce, _coexist: coexistCheck, _state: () => ({ standby, sim, spotify, meterWhy }),
  };
}

module.exports = {
  name: 'autopause',
  label: 'Spotify auto-pause',
  defaultOn: true,
  rest: true,
  chords: [],
  observe: [],
  options: [
    { key: APPS, label: 'Pause Spotify while', type: 'choice', default: 'media',
      choices: [{ value: 'media', label: 'Another app plays video or sound' }, { value: 'any', label: 'Any other app makes a sound' }],
      help: 'Like a lesson or video app, or a YouTube video. "Any sound" also counts calls, games and notification sounds' },
  ],
  install(ctx) { return install(ctx, null); },
  _install: install,
  _statusOf: statusOf,
};
