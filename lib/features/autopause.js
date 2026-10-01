'use strict';
/* autopause.js - Spotify auto-pause, inside Mantle (r5-autopause lane, 2026-09-30).
 *
 * Owen: "we need to integrate the spotify auto pause and those spotify features that are in my custom
 * browser into mantle". Spotify pauses while another app plays video or sound (LessonPlayer, a YouTube
 * video in any browser, a video player) and starts again after. This replaces the standalone
 * PowerShell bridge (~/spotify-autopause) with no PowerShell at all:
 *   - the sidecar meters every app's audio with its process tree (sidecar/AutoPause.cs,
 *     autopause.peaks): LessonPlayer' sound comes from a grandchild web view;
 *   - main's NOW PLAYING read (ctx.host.media / onMedia) says which media sessions exist and Spotify's
 *     own state; Spotify is paused and resumed through the same media session (sidecar `media`
 *     control, dryRun in --test);
 *   - the rules and constants are the bridge's, measured on Owen's machine (./_autopause-core.js), and
 *     who-is-playing is ./_autopause-attrib.js.
 *
 * COEXISTENCE (./_autopause-coexist.js): while the standalone helper is in charge (its task enabled, or
 * a bridge answering on 8787-8790) this stays off and says so. Checked every 15 s; when the helper
 * comes back, any hold Mantle holds is handed back first.
 *
 * COST: nothing runs while Spotify is not playing and nothing is held (the media watch wakes it). While
 * Spotify plays: one peaks read + one verdict every 250 ms (the bridge's pollMs; its tick measured p50
 * 6 ms). Rests while a game runs (rest: true), and every hold is handed back first.
 *
 * COMPATIBLE API (./_autopause-compat.js): while this is in charge, Mantle also answers the bridge's HTTP
 * API on the first free port of 8787-8790, so Quartz and the Opera GX extension keep working unchanged
 * with the bridge retired. Never in --test (unless MANTLE_AUTOPAUSE_PORT names a test port).
 *
 * Push: 'autopause.status' { ok, state: off|standby|idle|holding|backoff|error, words, card, apps, ... }.
 * Commands: status. Privacy: the log gets counts and states, never an app name or a title.
 */
const { createEngine } = require('./_autopause-core.js');
const attrib = require('./_autopause-attrib.js');
const coexist = require('./_autopause-coexist.js');
const { createCompat } = require('./_autopause-compat.js');

const APPS = 'apps';
const COEXIST_MS = 15000;

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
  if (s.holds.length) {
    const w = s.wePaused ? holdWords(s.holds) : holdWords(s.holds).replace(/^Paused/, 'Holding Spotify');
    return Object.assign(base, { state: 'holding', words: w, card: s.wePaused ? w : '' });
  }
  const what = mode === 'any' ? 'any other app makes a sound' : 'another app plays video or sound';
  const note = x.meterWhy ? `. App sound levels can’t be read right now (${x.meterWhy}), so Mantle goes by what apps report` : '';
  return Object.assign(base, { state: 'idle', words: `On: Spotify pauses while ${what}${note}`, card: '' });
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
  const engine = inj.engine || createEngine({
    now,
    log: (t) => ctx.log(t),
    spotify: { state: spState, pause: () => control('pause'), play: () => control('play') },
  });

  const envPort = Number(process.env.MANTLE_AUTOPAUSE_PORT);
  const compatPorts = inj.compatPorts || (test ? (Number.isInteger(envPort) && envPort > 1024 ? [envPort] : null) : null);
  const compat = createCompat({
    engine, now, log: (t) => ctx.log(t), media: readMedia, control,
    spotify: () => ({ found: spotify.found, state: spState(), aumid: spotify.aumid }),
    changed: () => { publish(); if (wanted()) schedule(0); },
    ports: compatPorts || undefined,
  });
  /* Up only while this auto-pause is in charge; in --test only on a named test port. */
  function syncCompat(why) {
    if (!stopped && !standby && ctx.enabled() && (!test || compatPorts)) compat.start().catch((e) => ctx.log(`the compatible API threw: ${(e && e.stack) || e}`));
    else compat.stop(why);
  }

  function publish() {
    const st = statusOf({ enabled: ctx.enabled(), standby, standbyWords, mode: mode(), meterWhy, snap: engine.snapshot(now()) });
    last = st;
    const j = JSON.stringify([st.state, st.words, st.card, st.mode]);
    if (j !== lastJson) { lastJson = j; ctx.broadcast('autopause.status', st); }
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
    const sp = attrib.sources({ media, peaks: null, mode: mode(), mantlePids }).spotify;
    spotify = sp;
    if (sim && !sp.found) sim = null;
    const r = await ctx.sidecar.send('autopause.peaks', {}, { timeoutMs: 1500 });
    const peaks = r && r.ok && r.result && r.result.ok !== false ? r.result : null;
    const why = peaks ? '' : ((r && r.ok && r.result && r.result.reason) || (r && r.error) || 'no answer');
    if (why !== meterWhy) { meterWhy = why; ctx.log(why ? 'app sound levels unreadable; judging by media status only' : 'app sound levels readable again'); }
    const a = attrib.sources({ media, peaks, mode: mode(), mantlePids });
    await engine.tick(now(), a.sources);
  }

  function schedule(ms) {
    if (timer || stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!wanted()) { publish(); return; }
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
      if (standby) { compat.stop('the standalone helper is in charge'); await releaseAll('the standalone helper is in charge'); }
      else onMedia(readMedia());
    }
    syncCompat(standby ? 'the standalone helper is in charge' : '');
    publish();
  }

  ctx.replay('autopause.status', () => last || publish());
  ctx.command('status', async () => Object.assign({}, publish(), { detail: engine.snapshot(now()), test }));
  const offMedia = ctx.host && typeof ctx.host.onMedia === 'function' ? ctx.host.onMedia(onMedia) : () => {};
  if (typeof ctx.onOption === 'function') ctx.onOption(APPS, () => { ctx.log(`counting: ${mode()}`); publish(); });
  ctx.onEnabled((on) => {
    if (!on) { compat.stop('auto-pause was turned off'); releaseAll('auto-pause was turned off'); } else { coexistCheck(); onMedia(readMedia()); }
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
      compat.stop('Mantle stopped auto-pause');
      return engine.releaseAll('Mantle stopped auto-pause').catch((e) => ctx.log(`handing Spotify back threw: ${(e && e.stack) || e}`));
    },
    _engine: engine, _compat: compat, _tick: tickOnce, _coexist: coexistCheck, _state: () => ({ standby, sim, spotify, meterWhy }),
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
      help: 'Like LessonPlayer or a YouTube video. "Any sound" also counts calls, games and notification sounds' },
  ],
  install(ctx) { return install(ctx, null); },
  _install: install,
  _statusOf: statusOf,
};
