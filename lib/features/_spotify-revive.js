'use strict';
/* _spotify-revive.js - the hidden Spotify closed during a game (spotdeath lane, 2026-09-27).
 *
 * WHAT HAPPENED. In every Valorant session in the log (3 of 3) the hidden Spotify Mantle started was
 * gone within minutes of the game starting, and nothing brought it back: the card read "not running"
 * for the rest of the game and after it. The user listens to music while they game. Windows kept no crash
 * record for it (no Application Error, no WER report, Spotify's own Crashpad folder empty), so the
 * cause is not known yet; sidecar/SpotifyMem.cs now reports the exit code and time when it can.
 *
 * WHAT THIS DOES. When the watched hidden Spotify exits without Mantle asking (the card's Quit and
 * Restart stop the watch first, so they never land here):
 *   - one names-only process list (the sidecar's gamemode.scan, the one game mode makes every 5 s)
 *     says whether a known game runs (_gamemode-plan.js runningGames, the same list game mode uses);
 *   - the card says so: "Spotify closed while VALORANT was running", with the exit code when known;
 *   - while that game runs, one names-only list every POLL_MS; once no known game runs (and SETTLE_MS
 *     more, while Mantle wakes from its rest), Spotify is started again HIDDEN and NOT playing, if the
 *     card's "Restart Spotify after games" is on (the default), it was not already restarted once for
 *     this game, and no Spotify runs by then. One log line either way.
 *   - no game running when it closed: said on the card, never restarted on its own (they may have
 *     closed it themselves).
 * cancel() drops a pending restart: the user started or quit Spotify from the card meanwhile.
 *
 * CLOSED FOR THE GAME (spotgame lane, 2026-09-28). The user: "for the spotify thing i closed it myself to
 * save ram". When Mantle starts resting for a known game and the card's "Close Spotify while I game"
 * is on (setting closeForGames, default on), ./_spotify-app.js closes Mantle's own Spotify if nothing
 * is playing, and this module holds what the card says and the reopen:
 *   - session(list): once per game session (a session = the game pids; any pid seen before = the same);
 *   - closing() / closed() / closeFailed() / kept(): the card's words ("Closed for VALORANT to save
 *     memory; it comes back when the game exits" / "Kept open: music was playing when VALORANT started");
 *   - closed() arms the same wait as a death (state waiting, mine: true); after the game (+ SETTLE_MS)
 *     Spotify starts again hidden and NOT playing. Mantle closed it, so Mantle brings it back: that
 *     reopen does NOT depend on "Restart Spotify after games" (that toggle is about a Spotify that
 *     closed on its own). cancel() still drops it when the user starts or quits Spotify meanwhile.
 *   - gameOver(): game mode's wake; a pending reopen asks at once instead of at the next POLL_MS.
 *

 * step decisions are small and live in createRevive; the words are pure (words(), exitWords()) so the
 * tests pin what the card says. Every I/O is injected.
 */
const G = require('./_gamemode-plan.js');

const POLL_MS = 15 * 1000;        // while the game runs: one names-only process list
const SETTLE_MS = 8 * 1000;       // after it exits, before Spotify starts (Mantle is waking from rest)
const SETTING = 'reviveAfterGames';
const TOGGLE = 'Restart Spotify after games';
const CLOSE_SETTING = 'closeForGames';       // spotgame lane
const CLOSE_TOGGLE = 'Close Spotify while I game';

/* 100-ns ticks since 1601 (a FILETIME, as the sidecar writes it) -> ms since 1970, or null. */
function fileTimeMs(ft) {
  if (ft == null || ft === '') return null;
  const n = Number(ft);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 10000 - 11644473600000) : null;
}

/* exit = {code, at (ms)} from the sidecar, or null -> plain words, or '' when unknown. */
function exitWords(exit) {
  if (!exit || exit.code == null || !Number.isFinite(Number(exit.code))) return '';
  const c = Number(exit.code) >>> 0;
  const hex = '0x' + c.toString(16).toUpperCase().padStart(8, '0');
  if (c === 0) return 'it exited normally (exit code 0)';
  if (c >= 0xC0000000) return `it crashed (exit code ${hex})`;
  if (c === 1) return 'it was ended from outside (exit code 1, what a forced close leaves)';
  return `exit code ${c} (${hex})`;
}

/* media-be lane (2026-09-29): the CARD's words for an exit: no codes (the log keeps exitWords). */
function exitPlain(exit) {
  if (!exit || exit.code == null || !Number.isFinite(Number(exit.code))) return '';
  const c = Number(exit.code) >>> 0;
  if (c === 0) return 'it closed normally';
  if (c >= 0xC0000000) return 'it crashed';
  if (c === 1) return 'something outside Spotify ended it';
  return 'it closed with an error';
}

/* The card's words for a view (v = view()). -> {head, plan}. Pure. */
function words(v) {
  if (!v || v.state === 'idle') return { head: '', plan: '' };
  const g = v.game || 'the game';
  /* spotgame lane: Mantle's own close for a game, and the times it kept Spotify open. */
  if (v.state === 'kept') return { head: `Kept open: ${v.why}.`, plan: '' };
  if (v.state === 'closing') return { head: `Closing Spotify for ${g} to save memory…`, plan: '' };
  if (v.state === 'closefailed') return { head: `Mantle could not close Spotify for ${g}: ${v.why}.`, plan: 'It stays open.' };
  if (v.mine) {
    const dry = v.dryRun ? ' (dry run: nothing was closed)' : '';
    if (v.state === 'waiting') return { head: `Closed for ${g} to save memory; it comes back when the game exits${dry}.`, plan: 'It comes back hidden and not playing: press play then.' };
    const head = `Mantle closed Spotify for ${g} to save memory${dry}.`;
    if (v.state === 'starting') return { head, plan: `${g} exited: starting Spotify again, hidden…` };
    if (v.state === 'done') return { head, plan: `Mantle started it again, hidden, after ${g} exited. Press play to carry on.` };
    if (v.state === 'skipped') return { head, plan: `Not started again: ${v.why}.` };
    if (v.state === 'failed') return { head, plan: `Mantle could not start it again: ${v.why}.` };
  }
  const ex = exitPlain(v.exit);
  const head = v.game ? `Spotify closed while ${g} was running${ex ? `: ${ex}` : ''}.`
    : v.scanError ? `Spotify closed without being asked${ex ? `: ${ex}` : ''}. Mantle couldn’t tell whether a game was running.`
      : `Spotify closed without being asked${ex ? `: ${ex},` : ','} and no game was running.`;
  let plan = '';
  if (v.state === 'waiting') plan = v.on ? `Mantle starts it again, hidden, when ${g} exits. Press play then.` : `“${TOGGLE}” is off, so it stays closed.`;
  else if (v.state === 'starting') plan = `${g} exited: starting Spotify again, hidden…`;
  else if (v.state === 'done') plan = `Mantle started it again, hidden, after ${g} exited. Press play to carry on.`;
  else if (v.state === 'skipped') plan = `Not started again: ${v.why}.`;
  else if (v.state === 'failed') plan = `Mantle could not start it again: ${v.why}.`;
  else if (v.state === 'closed') plan = 'Mantle only starts it again on its own after a game. Start it from here.';
  return { head, plan };
}

/* opts: games() -> [{pid, file}] (throws when the list cannot be read); running() -> [pid];
   relaunch(why) -> {ok, reason, dryRun}; enabled() -> bool (the toggle); closeEnabled() -> bool
   (spotgame lane: "Close Spotify while I game"); log(line); onChange(view);
   now, setTimeout, clearTimeout, pollMs, settleMs (tests). */
function createRevive(opts) {
  const o = Object.assign({ log: () => {}, onChange: () => {}, enabled: () => true, closeEnabled: () => true, now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), pollMs: POLL_MS, settleMs: SETTLE_MS }, opts || {});
  let v = { state: 'idle' };
  let gen = 0, timer = null, lastPollErr = '';
  const doneFor = new Set();      // game sessions (their pids) Spotify was already started again for
  let lastSession = new Set();    // spotgame lane: the game pids of the session Mantle last decided about

  const on = () => { try { return o.enabled() !== false; } catch (_) { return true; } };
  const closeOn = () => { try { return o.closeEnabled() !== false; } catch (_) { return true; } };
  function view() { const x = Object.assign({ on: on(), closeOn: closeOn() }, v); const w = words(x); return Object.assign(x, { text: w.head, plan: w.plan }); }
  function sig() { const x = view(); return [x.state, x.on, x.closeOn, x.text, x.plan].join('\u0001'); }
  function set(p) { v = Object.assign({}, v, p); try { o.onChange(view()); } catch (_) { /* the card is gone */ } }
  function clearTimer() { if (timer) { o.clearTimeout(timer); timer = null; } }
  function later(ms, g, fn) {
    clearTimer();
    timer = o.setTimeout(() => { timer = null; if (g === gen) fn(g).catch((e) => o.log(`the restart after the game threw: ${(e && e.stack) || e}`)); }, ms);
    if (timer && timer.unref) timer.unref();
  }

  /* info: {pid, why, exit: {code, at} | null}. The watched hidden Spotify has exited. */
  async function died(info) {
    const g = ++gen;
    clearTimer();
    const pid = (info && info.pid) || 0;
    const exit = info && info.exit && info.exit.code != null ? info.exit : null;
    let games = null, scanError = null;
    try { games = await o.games(); } catch (e) { scanError = (e && e.message) || String(e); }
    if (g !== gen) return view();
    const list = Array.isArray(games) ? games : [];
    const game = list.length ? G.gameLabel(list.map((x) => x.file)) : '';
    const key = list.map((x) => x.pid).sort((a, b) => a - b).join(',');
    const ex = exitWords(exit);
    const exTxt = ex ? `; ${ex}` : '; no exit code was recorded';
    const atTxt = exit && exit.at ? ` at ${new Date(exit.at).toISOString()}` : '';
    if (list.length) {
      set({ state: 'waiting', pid, game, key, exit, at: o.now(), why: null, scanError: null, mine: false, dryRun: false });
      o.log(`the hidden Spotify (pid ${pid}) closed while ${game} was running${atTxt}${exTxt}; ${on() ? 'it is started again, hidden and not playing, when the game exits' : `“${TOGGLE}” is off, so it stays closed`}`);
      later(o.pollMs, g, poll);
    } else {
      set({ state: 'closed', pid, game: '', key: '', exit, at: o.now(), why: null, scanError, mine: false, dryRun: false });
      o.log(`the hidden Spotify (pid ${pid}) closed without being asked${atTxt}${exTxt}; ${scanError ? `Mantle could not tell whether a game was running (${scanError})` : 'no game was running'}, so it is not started again on its own`);
    }
    return view();
  }

  async function poll(g) {
    let games;
    try { games = await o.games(); } catch (e) {
      if (g !== gen) return;
      const msg = `could not tell whether ${v.game} still runs (${(e && e.message) || e}); asking again in ${Math.round(o.pollMs / 1000)} s`;
      if (msg !== lastPollErr) { lastPollErr = msg; o.log(msg); }
      later(o.pollMs, g, poll);
      return;
    }
    if (g !== gen) return;
    lastPollErr = '';
    if (Array.isArray(games) && games.length) { later(o.pollMs, g, poll); return; }
    later(o.settleMs, g, finish);
  }

  async function finish(g) {
    const game = v.game || 'the game';
    const mine = !!v.mine;
    const skip = (why) => { set({ state: 'skipped', why }); o.log(`Spotify was not started again after ${game} exited: ${why}`); };
    /* spotgame lane: a game back within the settle time (a launcher handing over to the game) is the
       same wait, not an exit: ask again later instead of starting Spotify into the game's load. */
    let again = null;
    try { again = await o.games(); } catch (_) { /* the poll just read "no game"; go on */ }
    if (g !== gen) return;
    if (Array.isArray(again) && again.length) { later(o.pollMs, g, poll); return; }
    if (!mine && !on()) return skip(`“${TOGGLE}” is off`);   // Mantle closed it itself: it brings it back
    if (doneFor.has(v.key)) return skip(`it was already started again once for this ${game} session`);
    let pids = null;
    try { pids = await o.running(); } catch (e) { o.log(`the process list failed after ${game}: ${(e && e.message) || e}`); return skip('Mantle couldn’t tell whether Spotify was already running'); }
    if (g !== gen) return;
    if (pids && pids.length) return skip('Spotify is already running');
    doneFor.add(v.key);
    set({ state: 'starting' });
    let r;
    try { r = await o.relaunch(`after ${game} exited`); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    if (g !== gen) return;
    if (r && r.ok) {
      set({ state: 'done', at: o.now(), why: null });
      o.log(`started the hidden Spotify again after ${game} exited (${mine ? 'Mantle closed it for the game' : 'it closed during the game'})${r.dryRun ? ' [dry run]' : ''}; it is not playing until you press play`);
    } else {
      const why = (r && r.reason) || 'no reason given';
      set({ state: 'failed', why });
      o.log(`Spotify could not be started again after ${game} exited: ${why}`);
    }
  }

  /* The user started or quit Spotify from the card (or it came back some other way): no restart pending. */
  function cancel(why) {
    gen += 1;
    clearTimer();
    if (v.state === 'waiting' || v.state === 'closed') o.log(`no restart after the game is pending any more: ${why}`);
    if (v.state !== 'idle') set({ state: 'idle', mine: false, dryRun: false });
  }

  /* ---- spotgame lane: Mantle closes an idle Spotify for a game ---------------------------------
     list: runningGames() rows. -> {first, game, key}. first: no pid of it was in the session Mantle
     last decided about (a second game joining, or rest's why changing, is the same session). */
  function session(list) {
    const rows = Array.isArray(list) ? list : [];
    const pids = rows.map((x) => x.pid);
    const first = !pids.some((p) => lastSession.has(p));
    if (first) lastSession = new Set(pids); else for (const p of pids) lastSession.add(p);
    return { first, game: G.gameLabel(rows.map((x) => x.file)), key: pids.slice().sort((a, b) => a - b).join(',') };
  }
  /* Not closed: why is the card's words after "Kept open: " (no track names, no account data). */
  function kept(game, why) {
    if (v.state === 'waiting' || v.state === 'starting') return;       // a death's reopen is pending: its words stay
    gen += 1; clearTimer();
    set({ state: 'kept', game, why, key: '', mine: false, dryRun: false, at: o.now() });
  }
  function closing(game) { gen += 1; clearTimer(); set({ state: 'closing', game, why: null, mine: false, dryRun: false, at: o.now() }); }
  function closeFailed(game, why) { gen += 1; clearTimer(); set({ state: 'closefailed', game, why, mine: false, dryRun: false, at: o.now() }); }
  /* Mantle closed its Spotify for the game: the same wait as a death, then the reopen (mine: it does
     not depend on "Restart Spotify after games"). */
  function closed(info) {
    const g = ++gen;
    clearTimer();
    set({ state: 'waiting', mine: true, pid: (info && info.pid) || 0, game: (info && info.game) || '', key: (info && info.key) || '',
      exit: null, at: o.now(), why: null, scanError: null, dryRun: !!(info && info.dryRun) });
    later(o.pollMs, g, poll);
    return view();
  }
  /* Game mode woke Mantle (the last game exited): a pending reopen asks now; stale words go. */
  function gameOver() {
    if (v.state === 'waiting') { later(0, gen, poll); return; }
    if (v.state === 'kept' || v.state === 'closefailed') set({ state: 'idle', mine: false, dryRun: false });
  }
  /* Spotify is connected again: the words about its death have done their job (a 'done' stays, so the
     card can say it was started again). */
  function seen() { if (v.state === 'closed' || v.state === 'skipped' || v.state === 'failed') set({ state: 'idle' }); }
  function stop() { gen += 1; clearTimer(); }
  /* The toggle changed: the card's words follow it at once. */
  function toggled() { set({}); }

  return { died, cancel, seen, stop, toggled, view, sig, session, kept, closing, closeFailed, closed, gameOver,
    get pending() { return v.state === 'waiting' || v.state === 'starting'; } };
}

module.exports = { createRevive, words, exitWords, exitPlain, fileTimeMs, POLL_MS, SETTLE_MS, SETTING, TOGGLE, CLOSE_SETTING, CLOSE_TOGGLE };
