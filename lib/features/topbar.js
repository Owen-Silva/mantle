'use strict';
/*
 * topbar.js - the macOS-style menu bar across the top of the primary display (wave 3, 2026-09-24).
 *
 * Owen: "the thing that macbooks have at the very top of your screen": left, the Mantle menu and
 * the focused app's name and ITS menus; right, live "ram cpu gpu etc." updating "every 1 sec".
 * And: "nothing should be able to go past the topbar ... unless its like valorant or whatever".
 *
 * THE PIECES
 *   ui/topbar/*            the page (renders, keyboard, menus); mock-mantle.js + shoot.js for shots
 *   sidecar/MenuBar.cs     focus snapshots with the app's Win32 / UIA menus, invoke, window actions,
 *                          the app bar, the drag-end guard, the game verdict
 *   sidecar/TopbarStats.cs one 1 s system sample, pushed as `topbarstats`
 *   this file              the window, the event bridge, the page's commands, and the three rules:
 *
 * NOTHING GOES PAST IT
 *   maximise      the bar is a registered TOP APP BAR round(28 x scale) px tall (LIVE ONLY: a test
 *                 never reserves Owen's screen), so the work area - and every maximised or snapped
 *                 window - starts below it. Checked, not assumed: the work area's top must equal the
 *                 bar's bottom, and the answer is in `topbar.status` and the feature's health.
 *   drag / resize a window dragged or resized up into the strip is put back below it when the drag
 *                 ENDS (topbar.guard, sidecar). Never during the drag.
 *   z-order       the window is topmost (live), so no normal window is ever drawn over it.
 *   borderless full screen (browser F11, video full screen): the bar STAYS, over the window's top
 *                 28 DIP. It is not squeezed below: see NO FIT below.
 * GAMES STEP ASIDE in any full-screen mode (the sidecar's verdict: a known game exe or Windows' Game
 *   Bar list, AND the window covers its monitor or Windows reports exclusive/busy full screen). The
 *   bar hides and its stats sampler stops; it comes back when the game leaves the foreground or
 *   exits. Setting `overGames` ("Keep the top bar over full-screen games") overrides.
 * FULL-SCREEN VIDEO steps aside too (the foreground covers its monitor AND is a known player or has
 *   its own Playing media session), latched until that window leaves full screen or the foreground;
 *   the strip is kept. HIDDEN BY HAND (Win+Alt+T, "Hide top bar") wins over every rule, lets the
 *   strip go and is remembered across restarts. See FULL-SCREEN VIDEO and MANUAL HIDE below.
 *   Hidden by hand, the cursor RESTING on the top edge PEEKS at it: shown over the screen with the
 *   strip still let go, gone again when the cursor leaves; the manual setting never changes (PEEK
 *   below, lib/features/_topbar-peek.js).
 * KNOWN GAMES RUNNING (valofix, 2026-09-26). The verdict above needs the game in front AND full
 *   screen, and Valorant never got there: it came up under the reserved strip as a maximised
 *   WINDOW (style 0x15CF0000, -7,-7 1543x871 once Mantle was gone) although its own config says
 *   full screen, and no log line of that evening names it. So the process list is checked every
 *   second (_gamemode-plan.js runningGames: names only, no handle to the game). From the moment a
 *   known game STARTS - before its window exists - the bar hides, its stats stop, the drag guard
 *   goes off and the app bar is RELEASED, so the work area is the whole screen; nothing re-reserves
 *   it (display changes, re-checks) while the game runs, and an alt-tab changes nothing. When the
 *   last one exits the strip is reserved again, once, and the bar comes back. `overGames` does not
 *   apply to a known game: it keeps the bar over games found only by the verdict.
 *
 * NO FIT for borderless full-screen windows (MEASURED 2026-09-24, _topbar-selftest.js, on a window
 *   the test made - never Owen's): a frame-ful Electron window in setFullScreen (Chromium's own
 *   full-screen path, the one Chrome's F11 and video full screen take) moved 35 px down from outside
 *   with SetWindowPos(NOZORDER|NOACTIVATE) was back at 0,0 1536x864 within 1.5 s, its page never
 *   re-laid out (innerHeight 864 throughout). Fitting it would be a tug of war. And a window moved
 *   down no longer covers its monitor, which is the ONE definition of full screen the bottom bar,
 *   the wallpaper pause rules and the edge clip share (sidecar/Foreground.cs). So the bar stays
 *   OVER such a window's top 28 DIP, and `topbar.status` .cover names the app it covers.
 *
 * TEST (--test): the sidecar is passive (reads everything, writes nothing but its own fixture);
 * the window is shown inactive and sent to the back (thumbs.toBack), never focused, never topmost;
 * power / new window / Task Manager / Settings are dry runs; UI Automation actions are refused
 * outright (a UIA invoke once activated a test window and took Owen's keyboard, 2026-09-24).
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');

const BAR_DIP = 28;
const RUN_MS = 1000;   // how often the process list is checked for a known game starting or exiting
const M = require(path.join(__dirname, '..', '..', 'ui', 'topbar', 'model.js'));
const P = require('./_gamemode-plan');
const PK = require('./_topbar-peek');   // PEEK at a bar hidden by hand (lane tbpeek): the pure step + the button reader
const CZ = require('./_corners');       // HOT CORNERS (lane corners): an active corner's square is taken from the peek band
const TOOLS_HUB = require('./_tools-hub');   // THE TWO SMALL TOOLS (lane tbtools): Mantle's rest, told to the timer

/** The app bar's size in the SIDECAR's units: physical px when it is DPI-aware (see main.js placeBar). */
function reserveSize(scale, dpiAware) { return dpiAware ? Math.round(BAR_DIP * (scale || 1)) : BAR_DIP; }

/* A RESERVE ON ITS WAY IS NOT A FAILURE (lane corners, 2026-09-27). The live log said "NOT healthy:
 * maximised windows can go under the top bar: let go: hidden by hand" for the ~0.3 s between "shown
 * by hand" and the strip landing (and "not reserved yet" at start-up), then "healthy". So a reserve
 * that was ASKED FOR is `pending` and counts as healthy - for a bounded grace only: one that never
 * lands still reports, with how long ago it was asked. A reserve that ANSWERS with a failure clears
 * the pending mark and reports at once. 6 s covers the sidecar call's own 4 s timeout plus the 300 ms
 * work-area check; 20 s at start-up covers the sidecar starting (ping, watch, game check, reserve). */
const RESERVE_GRACE_MS = 6000;
const RESERVE_START_GRACE_MS = 20000;

/** Pure: why the missing strip is a failure right now, or null. o = {live, reserve: {reserved, reason,
 * pending: {since, why, grace} | null}, run, hidden, now}. */
function stripGap(o) {
  const r = (o && o.reserve) || {};
  if (!o || !o.live || r.reserved || o.run || o.hidden) return null;
  const p = r.pending;
  if (p && o.now - p.since < (p.grace || RESERVE_GRACE_MS)) return null;
  if (p) return `the strip was asked for ${Math.round((o.now - p.since) / 1000)} s ago (${p.why}) and has not landed: ${r.reason}`;
  return r.reason || 'the strip is not reserved';
}

/* THE LOCK SCREEN. mantle.log, live, 2026-09-25: "topbar: LockApp.exe is full screen; the top bar
 * stays over its top 28 DIP". Win+L puts LockApp.exe (the lock curtain) in front of the user's
 * desktop, where a topmost bar draws over it; LogonUI.exe is the sign-in / credential screen. The
 * bar steps aside for both, always: "Keep the top bar over full-screen games" does not apply. */
const LOCK_EXES = ['lockapp.exe', 'logonui.exe'];
/** Pure: the lock / sign-in screen's exe name when this focus snapshot is one of them, else null. */
function lockScreen(f) {
  if (!f || f.self) return null;
  for (const s of [f.exe, f.desc]) {
    const file = String(s || '').split(/[\\/]/).pop().toLowerCase();
    if (LOCK_EXES.includes(file)) return file === 'lockapp.exe' ? 'LockApp.exe' : 'LogonUI.exe';
  }
  return null;
}

/* FULL-SCREEN VIDEO (lane tbvideo, 2026-09-26). Owen: "make it so the topbar goes away when i start
 * watching a fullscreen video". The foreground window fills its monitor (the sidecar's one
 * definition of full screen, the same one the "stays over its top 28 DIP" rule uses) AND it is
 * watching video, which means either:
 *   a player   the app is a known video player (PLAYER_EXES, or a Movies & TV / Netflix package), or
 *   a session  that same app has a Windows media session that is PLAYING (main.js's NOW PLAYING
 *              read, handed over by ctx.host.onMedia). Windows gives a session an app id (AUMID)
 *              and no pid, so the session is tied to the window by app id, in this order:
 *                app id    the taskbar's own resolver's id for the window (jumplist.shortcut) equals
 *                          the session's: Owen's browser (a bare electron.exe whose process says
 *                          com.owensilva.quartz; its windows carry no id of their own, measured
 *                          2026-09-26) and packaged apps
 *                exe       a session named by exe ("vlc.exe", "Spotify.exe") is that exe's
 *                package   a packaged session (Name_hash!App) is an exe under WindowsApps\Name_
 *                browser   Chrome*, MSEdge*, Brave*, Opera*, Vivaldi* and Firefox's 16-hex install
 *                          hash belong to their browser's exe
 *                name      the window's exe name is a word of the session's id (Quartz.exe <-> ...quartz)
 * LATCHED: once aside for a video the bar stays aside while THAT window stays full screen and in
 * front, played or paused (no flicker on pause/play); it comes back when the window leaves full
 * screen or another window takes the foreground (Mantle's own windows do not count).
 * THE STRIP IS KEPT: the video window covers the whole monitor, strip included, so hiding the bar
 * is enough. Letting the app bar go would re-lay every maximised window behind the video (and again
 * when it ends), and the browser would come out of full screen onto a work area that moved. */
const PLAYER_EXES = ['vlc.exe', 'mpv.exe', 'mpvnet.exe', 'potplayer.exe', 'potplayer64.exe', 'potplayermini.exe', 'potplayermini64.exe',
  'mpc-hc.exe', 'mpc-hc64.exe', 'mpc-be.exe', 'mpc-be64.exe', 'video.ui.exe', 'netflix.exe', 'wmplayer.exe'];
const PLAYER_PACKAGES = [['microsoft.zunevideo', 'Movies & TV'], ['4df9e0f8.netflix', 'Netflix']];
const BROWSER_IDS = [['chrome.exe', /^chrome/i], ['msedge.exe', /^msedge/i], ['brave.exe', /^brave/i], ['opera.exe', /^opera/i],
  ['vivaldi.exe', /^vivaldi/i], ['firefox.exe', /^[0-9a-f]{16}$/i], ['librewolf.exe', /^[0-9a-f]{16}$/i], ['floorp.exe', /^[0-9a-f]{16}$/i],
  ['waterfox.exe', /^[0-9a-f]{16}$/i]];
// words too common to tie a session to a window by name
const GENERIC = new Set(['com', 'app', 'apps', 'exe', 'www', 'microsoft', 'windows', 'google', 'mozilla', 'desktop', 'player', 'media', 'electron', 'client', 'main']);

const fileOf = (s) => String(s || '').split(/[\\/]/).pop().toLowerCase();
const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/** Pure: "VLC media player" / "Movies & TV" when the window is a known video player, else null. */
function knownPlayer(f) {
  if (!f) return null;
  const file = fileOf(f.exe);
  const exe = String(f.exe || '').toLowerCase();
  for (const [pkg, name] of PLAYER_PACKAGES) {
    if (exe.includes(`\\windowsapps\\${pkg}_`) || String(f.appid || '').toLowerCase().startsWith(`${pkg}_`)) return name;
  }
  return PLAYER_EXES.includes(file) ? (M.appName(f) || file) : null;
}

/** Pure: how a media session belongs to the window f ('app id' | 'exe' | 'package' | 'browser' | 'name'), or null. */
function sessionMatch(f, s) {
  const id = String((s && s.aumid) || '').trim();
  if (!f || !id) return null;
  const file = fileOf(f.exe);
  if (same(f.appid, id)) return 'app id';
  if (/\.exe$/i.test(id)) return file && fileOf(id) === file ? 'exe' : null;
  const pkg = id.includes('!') || /_[a-z0-9]{13}$/i.test(id.split('!')[0]) ? id.split('!')[0].split('_')[0].toLowerCase() : null;
  if (pkg && String(f.exe || '').toLowerCase().includes(`\\windowsapps\\${pkg}_`)) return 'package';
  if (BROWSER_IDS.some(([exe, re]) => exe === file && re.test(id))) return 'browser';
  const stem = file.replace(/\.exe$/, '');
  if (stem.length >= 3 && !GENERIC.has(stem) && id.toLowerCase().split(/[^a-z0-9]+/).includes(stem)) return 'name';
  return null;
}

const playing = (s) => !!s && (s.playing === true || s.status === 'playing');

/**
 * Pure: is the foreground window f watching video full screen? `held` is the video the bar is
 * already aside for (it stays while that window is full screen and in front, paused or not).
 * Returns {hwnd, app, how, aumid, why} or null.
 */
function videoFor(f, sessions, held) {
  if (!f || f.self || f.shell || !f.fullscreen || lockScreen(f)) return null;
  if (held && held.hwnd === f.hwnd) return held;
  const app = M.appName(f);
  const player = knownPlayer(f);
  if (player) return { hwnd: f.hwnd, app, how: 'player', aumid: null, why: `${player} is a video player` };
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!playing(s)) continue;
    const how = sessionMatch(f, s);
    if (how) return { hwnd: f.hwnd, app, how, aumid: s.aumid, why: `its media session (${s.aumid}) is playing, matched by ${how}` };
  }
  return null;
}

/* MANUAL HIDE (lane tbvideo, 2026-09-26). Owen: "make a way that i can manually hide it". HIDE_CHORD,
 * "Hide top bar" in the bar's Mantle menu, or the Top bar row in the bottom bar's quick settings.
 * Hidden by hand = the app bar is LET GO (maximised windows get the whole screen), the stats and
 * the drag guard stop, the window hides; quick settings says "Hidden · Win+Alt+T to show". It is
 * kept in the feature's settings (`hidden`), so it outlives a Mantle restart, and it WINS: no rule
 * shows the bar while it is hidden by hand. Showing takes the strip back once.
 * Win+Alt+T: Windows' only use of it is Xbox Game Bar's "show/hide recording timer" (a no-op unless
 * Game Bar is recording); while a game runs Mantle rests and the key is Windows' again anyway. */
const HIDE_CHORD = 'Win+Alt+T';

/** Pure: why the bar is not showing: 'hidden' (by hand) | 'lock' | 'run' | 'video' | 'game', or null. */
function asideKind(o) {
  if (o.hidden) return 'hidden';
  if (o.lock) return 'lock';
  if (o.run) return 'run';
  if (o.video) return 'video';
  if (o.game && o.game.stepAside && !o.overGames) return 'game';
  return null;
}

/** Pure: should the bar step aside? Always for the lock screen and while a known game RUNS (run =
 * S.run, in front or not); for the sidecar's full-screen game verdict unless overGames; for a
 * video playing full screen; and whenever it is hidden by hand. */
function stepAsideFor(game, overGames, lock, run, video, hidden) { return !!asideKind({ game, overGames, lock, run, video, hidden }); }

/** Pure: "VALORANT.exe, VALORANT-Win64-Shipping.exe" - the distinct names in a runningGames() list. */
function runNames(list) { return [...new Set((list || []).map((g) => g.file))].join(', ') || 'the game'; }

/** Pure: is the work area's top where the bar's bottom is (DIP, 1 px of rounding allowed)? */
function workAreaCheck(display) {
  const want = display.bounds.y + BAR_DIP;
  const got = display.workArea.y;
  return { ok: Math.abs(got - want) <= 1, want, got };
}

/* THE BAR WINDOW CANNOT BE RESIZED BY HAND (lane tbdrift, 2026-09-27). Owen's log had bursts of
 * "drifted to 0,0 1477x38 ... 1443 ... 1359 ... 673" (left edge fixed at 0) and "140,0 1396 ...
 * 191,0 1345 ... 519,0 1017" (right edge fixed at 1536), one even 1538 wide: the shape of a mouse
 * DRAG on the window's right end, then its left end. The window was resizable:true + thickFrame:false,
 * on the belief that no WS_THICKFRAME meant no drag handles. It does not: Electron's frameless view
 * answers WM_NCHITTEST itself, and for any RESIZABLE frameless window it returns HTTOPLEFT /
 * HTTOPRIGHT on the 5 DIP at each end (the 16 DIP corner zones cover the whole 28 DIP bar) and HTTOP
 * along the top edge (probe, 2026-09-27: resizable:true answered TOPLEFT / TOPRIGHT / TOP there,
 * resizable:false answered CLIENT everywhere). So a click thrown into a top corner of the screen
 * started a Windows sizing drag instead of reaching the page, and the put-back fought the drag.
 * resizable:false has no such bands. Electron's own setBounds still resizes it (it pins min = max to
 * each size it sets), the menu still grows 28 -> 300 -> 28 (the same 38 DIP floor as before, see
 * place()), and a FOREIGN SetWindowPos can no longer change its size at all (min = max). */
function barWindowOptions(r, o) {
  return {
    x: r.x, y: r.y, width: r.width, height: r.height, show: false, frame: false, transparent: true,
    resizable: false, thickFrame: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, focusable: true, alwaysOnTop: !!o.live, title: o.title,
    backgroundColor: '#00000000',
    webPreferences: { preload: o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  };
}

/* PUT BACK, NEVER GIVE UP (lane tbdrift). Things outside Mantle still MOVE the window: Chromium
 * moves a normal window into the work area whenever the work area changes (HWNDMessageHandler's
 * AdjustToFit), which is the "drifted to 0,28" right after every app bar reservation in the log.
 * The first DRIFT_FREE put-backs in DRIFT_WINDOW_MS are immediate; past that the window is put back
 * on a backoff (1, 2, 4, 8, 16, then every 30 s) until a re-check finds it in place, instead of
 * being left wrong. The fight is a health state with the reason while it lasts.
 * Pure: d = the running record (null = none), o = { off: a description of where the window is when
 * it is NOT in place (null = in place), to: where it goes back to, now, retry: true when this is the
 * queued re-check }.
 * Returns { d, fix, retryMs, log, settled }. */
const DRIFT_WINDOW_MS = 10000;
const DRIFT_FREE = 3;
const DRIFT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
function driftStep(d, o) {
  const now = o.now;
  const off = o.off || null;
  if (d && d.stuck) {
    // a re-check is queued: events in between wait for it (that is the backoff)
    if (!o.retry) return { d: { ...d, last: off || d.last }, fix: false, retryMs: 0, log: null };
    if (!off) {
      return { d: null, fix: false, retryMs: 0, settled: true,
        log: `the window is back in place and stayed there, after ${d.fixes} put-backs in ${Math.round((now - d.since) / 1000)} s` };
    }
    const tries = d.tries + 1;
    const retryMs = DRIFT_BACKOFF_MS[Math.min(tries, DRIFT_BACKOFF_MS.length - 1)];
    // one line per step of the backoff; at the 30 s cap the health state carries it (no line every 30 s)
    return { d: { ...d, last: off, fixes: d.fixes + 1, tries, retryMs, nextAt: now + retryMs }, fix: true, retryMs,
      log: retryMs !== d.retryMs ? `the window was out of place again (${off}); put back to ${o.to} (put-back ${d.fixes + 1}), next check in ${retryMs / 1000} s` : null };
  }
  if (!off) return { d, fix: false, retryMs: 0, log: null };
  if (!d || now - d.since > DRIFT_WINDOW_MS) d = { n: 0, fixes: 0, since: now, last: null, stuck: false, tries: 0, retryMs: 0, nextAt: null };
  const n = d.n + 1;
  if (n <= DRIFT_FREE) return { d: { ...d, n, last: off, fixes: d.fixes + 1 }, fix: true, retryMs: 0, log: `the window drifted to ${off}; put back to ${o.to}` };
  const retryMs = DRIFT_BACKOFF_MS[0];
  return { d: { ...d, n, last: off, fixes: d.fixes + 1, stuck: true, stuckSince: now, tries: 0, retryMs, nextAt: now + retryMs }, fix: true, retryMs,
    log: `the window keeps leaving its place (${off}) after ${DRIFT_FREE} put-backs in ${DRIFT_WINDOW_MS / 1000} s; put back to ${o.to} again, then checked after ` +
      `${DRIFT_BACKOFF_MS.map((ms) => ms / 1000).join(', ')} s until it stays` };
}
/** Pure: the health reason while the window is being fought over (null = no fight, or the bar is not showing). */
function driftReason(d, visible) {
  if (!d || !d.stuck || !visible) return null;
  return `something keeps moving or resizing the top bar's window (last seen at ${d.last}); Mantle put it back ${d.fixes} times since ` +
    `${new Date(d.since).toLocaleTimeString()} and tries again every ${Math.round(d.retryMs / 1000)} s until it stays`;
}

module.exports = {
  name: 'topbar',
  label: 'Top menu bar',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: [HIDE_CHORD],
  observe: [],
  _test: { reserveSize, stepAsideFor, asideKind, videoFor, sessionMatch, knownPlayer, runNames, lockScreen, workAreaCheck, stripGap, RESERVE_GRACE_MS, RESERVE_START_GRACE_MS, BAR_DIP, HIDE_CHORD,
    barWindowOptions, driftStep, driftReason, DRIFT_FREE, DRIFT_WINDOW_MS, DRIFT_BACKOFF_MS },

  install(ctx) {
    const { BrowserWindow, screen, shell } = require('electron');
    const { hwndOf } = require('../windows');
    const thumbs = require('../thumbs');
    const test = !!ctx.flags.test;
    const live = !!ctx.flags.live && !test;
    // The top bar's two small tools (lane tbtools): the timer never rests, so it learns that Mantle
    // rests for a game from THIS feature's install / stop(why, {rest}) (lib/features/_tools-hub.js).
    TOOLS_HUB.setResting(null);

    const S = {
      win: null, hwnd: null, pageOk: false, pageReason: 'the page has not loaded yet',
      focus: null, lastApp: null, stats: null, note: null, dpiAware: null,
      overGames: !!ctx.settings.get('overGames', false),
      stepAside: false, stepSignal: null, stepSince: null,
      watch: { ok: null, reason: 'starting' },   // null = not asked yet (not a failure: no strip row)
      stats_: { on: false, reason: 'not started' },
      guard: { ok: false, reason: 'not started', last: null },
      reserve: { reserved: false, reason: live ? 'not reserved yet' : 'a --test instance never reserves space on the screen',
        pending: live ? { since: Date.now(), why: 'starting', grace: RESERVE_START_GRACE_MS } : null },
      graceT: null,   // one health() re-check when a pending reserve's grace runs out
      menu: { open: false, height: BAR_DIP },
      cover: null, stopped: false, timers: new Set(),
      // a known game running (in front or not): {pid, file, all, since, released}; see KNOWN GAMES RUNNING
      run: null, runSeen: new Map(), runT: null, runBusy: false, runWatch: { ok: null, reason: 'starting' },
      // hidden by hand (persisted); the full-screen video the bar is aside for {hwnd, app, how, aumid, why, since}
      hidden: !!ctx.settings.get('hidden', false),
      video: null, videoEnd: null, sessions: [], media: { ok: null, reason: 'no media sessions read yet' },
      appids: new Map(), appidAsk: null, holdReal: false,
      // PEEK while hidden by hand (see PEEK below): the cursor / button sources (the self-test swaps in
      // fakes), the step state, the poll, and the watch's own {ok, reason} for quick settings
      peek: { src: null, st: PK.initial(), t: null, watching: false, shown: false, since: null, ok: null, reason: null, blocked: null, last: null, n: 0 },
    };
    S.peek.src = { cursor: () => screen.getCursorScreenPoint(), buttons: PK.nativeButtons(), fake: false };
    // TEST ONLY: MANTLE_TOPBAR_TEST_GAME=<exe name>[,<exe name>] counts as a known game in a --test
    // instance (the self-test runs a stand-in exe of that name; no game ever runs for a test).
    const TEST_GAMES = test && process.env.MANTLE_TOPBAR_TEST_GAME
      ? String(process.env.MANTLE_TOPBAR_TEST_GAME).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const later = (ms, fn) => { const t = setTimeout(() => { S.timers.delete(t); fn(); }, ms); S.timers.add(t); return t; };
    const push = (ev, payload) => { if (S.win && !S.win.isDestroyed()) ctx.push(S.win, ev, payload); };
    const sc = async (cmd, args, ms) => {
      const r = await ctx.sidecar.send(cmd, args || {}, { timeoutMs: ms || 4000 });
      return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: r.error };
    };
    const primary = () => screen.getPrimaryDisplay();
    const barDip = (h) => { const b = primary().bounds; return { x: b.x, y: b.y, width: b.width, height: h || BAR_DIP }; };

    /** A reserve was asked for (shown by hand, a game exited, switched on): not a failure until it
     * lands, fails, or its grace runs out (see stripGap). reserve() / release() replace S.reserve. */
    function asked(why, grace) {
      if (!live || S.reserve.reserved) return;
      S.reserve = Object.assign({}, S.reserve, { pending: { since: Date.now(), why, grace: grace || RESERVE_GRACE_MS } });
    }
    function health() {
      const gap = !S.pageOk || S.watch.ok === false ? null
        : stripGap({ live, reserve: S.reserve, run: S.run, hidden: S.hidden, now: Date.now() });
      const p = S.reserve.pending;
      const left = p ? p.since + (p.grace || RESERVE_GRACE_MS) - Date.now() : 0;
      if (live && p && left > 0 && !S.reserve.reserved && !S.graceT) {   // re-judged once the grace is over, so one that never lands reports
        S.graceT = later(left + 50, () => { S.graceT = null; health(); });
      }
      const drift = driftReason(S.drift, !!S.win && !S.win.isDestroyed() && S.win.isVisible());
      const why = !S.pageOk ? S.pageReason
        : drift ? drift
        : S.watch.ok === false ? `the top bar cannot follow the focused app: ${S.watch.reason}`
        : gap ? `maximised windows can go under the top bar: ${gap}`
        : S.runWatch.ok === false ? `a game starting is not noticed, so the top bar can sit over it until it goes full screen: ${S.runWatch.reason}`
        : (S.hidden && S.peek.ok === false) ? `the top bar is hidden by hand and cannot peek at the top edge: ${S.peek.reason}`
        : null;
      ctx.health(!why, why);
    }

    /* ---- the window ------------------------------------------------------------------------- */
    function toBackIfTest() { if (test && S.hwnd) { try { thumbs.toBack(S.hwnd); } catch (_) { /* shown inactive anyway */ } } }
    function show() {
      if (!S.win || S.win.isDestroyed() || !ctx.enabled() || S.stepAside || S.hidden) return;
      // moved while hidden, or a put-back fight paused while hidden: put back BEFORE it shows
      if (!S.win.isVisible()) { driftRun(!!(S.drift && S.drift.stuck), true); S.win.showInactive(); }
      if (live) { S.win.setAlwaysOnTop(true, 'screen-saver'); S.win.moveTop(); }
      toBackIfTest();
    }
    function hide() { if (S.win && !S.win.isDestroyed() && S.win.isVisible()) S.win.hide(); }
    // the peek's own show: show() refuses while hidden by hand, this one is only called by the peek
    function showOver() {
      if (!S.win || S.win.isDestroyed()) return;
      if (!S.win.isVisible()) { driftRun(!!(S.drift && S.drift.stuck), true); S.win.showInactive(); }
      if (live) { S.win.setAlwaysOnTop(true, 'screen-saver'); S.win.moveTop(); }
      toBackIfTest();
    }
    function place(height) {
      if (!S.win || S.win.isDestroyed()) return;
      const r = barDip(height);
      S.win.setBounds(r);
      // Windows will not make this window shorter than ~38-40 DIP: 28 came out 40 at creation and
      // 300 -> 28 came out 38, whatever resizable / thickFrame / minHeight / setMinimumSize / type /
      // transparent / useContentSize said (hidden probe windows, 2026-09-24). So the window may be
      // taller than the bar, and a SHAPE crops it to exactly the bar (or the open menu): outside it
      // nothing draws and clicks go straight through (lib/bar-shape.js does the same for the bar).
      const got = S.win.getBounds();
      pinZoom();
      S.shape = { window: got.height, shown: r.height, ok: true, reason: null };
      try { S.win.setShape(got.height > r.height ? [{ x: 0, y: 0, width: got.width, height: r.height }] : []); } catch (e) {
        S.shape.ok = false;
        S.shape.reason = `the window is ${got.height} DIP tall and could not be cropped to ${r.height} (${e.message}), so its bottom ${got.height - r.height} DIP swallow clicks`;
        ctx.log(S.shape.reason);
      }
      toBackIfTest();
    }

    /* DRIFT (2026-09-25). Owen's bar showed "CPU 82%" at the screen's right edge with RAM / GPU / NET
     * past it: the look of a bar WINDOW wider than its display (headless, a 1920 CSS px page on a
     * 1536 px screen reproduces the shot exactly; an Electron probe window resized to 1920 DIP while
     * hidden laid out 1920 CSS px). 1920 is the panel's PHYSICAL width, so a size in the wrong units
     * or a DPI change resizing the window after place() ran (Windows scales the old rect in
     * WM_DPICHANGED) are the suspects. place() only runs on menus and display events, so nothing
     * put such a window back. Now any resize / move that leaves the window off the display's
     * top-left + width is put back (at most 3 times in 10 s) and logged with the numbers, so the
     * next occurrence names its size. The page also sizes itself to its screen (ui/topbar/topbar.js
     * visibleWidth), so the stats stay on screen even while the window is wrong. */
    // The page sizes its strip to the screen assuming page zoom 1 (screen.* is DIP, innerWidth CSS px).
    // Chromium keeps zoom per ORIGIN, so a Ctrl+- in any file:// Mantle page (Electron's default
    // menu accelerators are live: main.js sets no application menu) would zoom this bar too.
    function pinZoom() {
      try {
        const wc = S.win && !S.win.isDestroyed() && S.win.webContents;
        if (wc && wc.getZoomFactor() !== 1) { ctx.log(`the page was zoomed to ${wc.getZoomFactor()}; set back to 1`); wc.setZoomFactor(1); }
      } catch (e) { ctx.log(`could not check the page zoom: ${e.message}`); }
    }

    // 2026-09-27 (lane tbdrift): the cause of the width bursts was a resize DRAG on the window's own
    // handles (see barWindowOptions, now resizable:false); the put-back no longer gives up after 3
    // (driftStep's backoff), pauses while the bar is hidden (by hand, a game, full-screen video: it
    // never fights those) and resumes when show() / showOver() bring it back.
    function driftCheck() {
      if (S.stopped) return;
      // in a fight the queued re-check owns it (that IS the backoff): events in between, including
      // place()'s own move / resize, never shorten it. A fight paused while hidden resumes in show().
      if (S.drift && S.drift.stuck) {
        if (!S.driftRetryT && S.win && !S.win.isDestroyed() && S.win.isVisible()) driftRetry(S.drift.retryMs || DRIFT_BACKOFF_MS[0]);
        return;
      }
      if (S.driftT) return;
      S.driftT = later(250, () => { S.driftT = null; driftRun(false); });
    }
    function driftRun(retry, beforeShow) {
      if (!S.win || S.win.isDestroyed() || S.stopped) return;
      // HIDDEN (by hand, a game, full-screen video): nothing is put back and a fight pauses (health()
      // drops it while hidden); show() / showOver() run this with beforeShow just before it shows again
      if (!beforeShow && !S.win.isVisible()) { if (S.drift && S.drift.stuck) health(); return; }
      const want = barDip(S.menu.open ? S.menu.height : BAR_DIP);
      const got = S.win.getBounds();
      // the height is not compared: Windows' 38-40 DIP floor is expected, and the shape crops it
      const off = got.x === want.x && got.y === want.y && got.width === want.width ? null
        : `${got.x},${got.y} ${got.width}x${got.height} DIP on a ${want.width} DIP wide display at ${primary().scaleFactor}x`;
      const was = !!(S.drift && S.drift.stuck);
      const step = driftStep(S.drift || null, { off, to: `${want.x},${want.y} ${want.width} wide`, now: Date.now(), retry });
      S.drift = step.d;
      if (step.log) ctx.log(step.log);
      // the next re-check is queued BEFORE place(): its setBounds fires move / resize synchronously,
      // and driftCheck must find the re-check already there (a 250 ms one replaced the backoff once)
      if (step.retryMs) driftRetry(step.retryMs);
      else if (step.settled) driftRetry(0);
      if (step.fix) place(S.menu.open ? S.menu.height : BAR_DIP);
      if (was !== !!(S.drift && S.drift.stuck)) health();
    }
    /** (Re)queue the fight's one re-check in ms; 0 = none. */
    function driftRetry(ms) {
      if (S.driftRetryT) { clearTimeout(S.driftRetryT); S.timers.delete(S.driftRetryT); S.driftRetryT = null; }
      if (ms > 0) S.driftRetryT = later(ms, () => { S.driftRetryT = null; driftRun(true); });
    }

    function createWindow() {
      const r = barDip();
      // resizable:FALSE (2026-09-27, lane tbdrift): a resizable frameless window has resize bands at
      // its ends and top edge whatever thickFrame says (barWindowOptions). The 38 DIP floor the old
      // comment blamed on resizable:false is there either way (see place(); probe 2026-09-27).
      const win = new BrowserWindow(barWindowOptions(r, { live, title: M.TITLE || 'Mantle top bar', preload: ctx.preload }));
      S.win = win;
      S.hwnd = hwndOf(win);
      // The sidecar's stale-app-bar check only ever touches a window titled exactly this.
      win.on('page-title-updated', (e) => e.preventDefault());
      win.setTitle('Mantle top bar');
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('render-process-gone', (_e, d) => {
        S.pageOk = false; S.pageReason = `the top bar's page crashed (${d && d.reason}); reloading it`; health();
        later(1000, () => { if (!win.isDestroyed()) win.webContents.reload(); });
      });
      win.webContents.on('did-fail-load', (_e, code, desc) => { S.pageOk = false; S.pageReason = `the top bar's page did not load (${code} ${desc})`; health(); });
      win.on('unresponsive', () => { S.pageOk = false; S.pageReason = 'the top bar\'s page stopped responding'; health(); });
      win.on('responsive', () => { S.pageOk = true; health(); });
      win.on('resize', driftCheck);
      win.on('move', driftCheck);
      win.webContents.on('did-finish-load', () => { S.pageOk = true; S.pageReason = null; health(); pinZoom(); });
      win.once('ready-to-show', () => { if (ctx.enabled()) show(); });
      win.loadFile(ctx.page('index.html'));
    }

    /* ---- games step aside -------------------------------------------------------------------- */
    async function decide(game, from) {
      const lock = lockScreen(S.focus);
      const run = S.run;
      const video = S.video;
      const kind = asideKind({ game, overGames: S.overGames, lock, run, video, hidden: S.hidden });
      const want = !!kind;
      const signal = !want ? null
        : kind === 'hidden' ? `hidden by hand: ${HIDE_CHORD} or "Show top bar" in quick settings brings it back`
        : kind === 'lock' ? `${lock} is in front (the ${lock === 'LockApp.exe' ? 'lock' : 'sign-in'} screen): the bar never draws over it`
        : kind === 'run' ? `${runNames(run.all)} is running (a known game): the bar stays aside with its strip let go until it exits` +
          (S.overGames ? ' ("keep the top bar over full-screen games" does not apply to a known game)' : '')
        : kind === 'video' ? `${video.app} is playing video full screen; the top bar stepped aside until it leaves full screen`
        : (game.signal || 'the sidecar said so');
      const wasKind = S.stepKind || null;
      if (want === S.stepAside) {
        if (want && signal !== S.stepSignal) {
          S.stepSignal = signal; S.stepKind = kind;
          ctx.log(`still stepped aside (${from}): ${signal}`);
          await strip(kind, wasKind);
          publish();
        }
        return;
      }
      S.stepAside = want;
      S.stepSignal = signal;
      S.stepKind = kind;
      S.stepSince = Date.now();
      if (want) {
        ctx.log(kind === 'video' ? `${signal} (${video.why})` : `stepped aside (${from}): ${S.stepSignal}`);
        push('topbar.close', {});   // an open menu goes too, so nothing of it comes back later
        hide();
        publish();
        await statsOn(false, kind === 'lock' ? 'the screen is locked' : kind === 'hidden' ? 'the top bar is hidden by hand'
          : kind === 'video' ? `a video has the screen: ${video.app}` : `a game has the screen: ${S.stepSignal}`);
        await strip(kind, wasKind);
      } else {
        ctx.log(`back (${from}): ${wasKind === 'lock' ? 'the lock screen closed' : wasKind === 'run' ? 'the game exited'
          : wasKind === 'hidden' ? 'shown by hand' : wasKind === 'video' ? `the video ${S.videoEnd || 'left full screen'}`
          : 'the game left the foreground or full screen'}`);
        await strip(kind, wasKind);   // shown by hand: the strip is taken back BEFORE the bar shows
        show();
        publish();
        await statsOn(true);
      }
    }

    /* The strip for a change of reason: hidden by hand lets it go (and the drag guard), shown by hand
     * takes it back once. Every other reason keeps it (a known game running lets it go itself). */
    async function strip(kind, wasKind) {
      if (kind === 'hidden' && wasKind !== 'hidden') {
        await sc('topbar.guard', { on: false }, 1500);
        S.guard.ok = false; S.guard.reason = `off while the top bar is hidden by hand (${HIDE_CHORD} shows it)`;
        if (S.run) return;   // a known game already let it go
        const rel = await release(`hidden by hand; ${HIDE_CHORD} takes it back`);
        ctx.log(rel.dryRun ? 'hidden by hand: a --test instance holds no strip, so there was none to let go'
          : rel.ok ? `hidden by hand: let go of the top ${BAR_DIP} DIP, so maximised windows get the whole screen`
          : `hidden by hand, but could NOT let go of the top ${BAR_DIP} DIP (${rel.reason}), so maximised windows still start below it`);
        health();
      } else if (wasKind === 'hidden' && kind !== 'hidden') {
        await guardOn();   // not while a known game runs
        if (live) await reserve('shown by hand');
        else ctx.log('app bar shown by hand: a --test instance never reserves space on the screen, so there was nothing to take back');
        health();
      }
    }

    /* ---- full-screen video (see FULL-SCREEN VIDEO) ---------------------------------------------- */
    /** Latch or drop the video for the focused window; true when that changed. */
    function videoCheck() {
      const f = S.focus;
      const was = S.video;
      const now = videoFor(f, S.sessions, was);
      if (now === was) return false;
      if (was && !now) S.videoEnd = !f || f.hwnd !== was.hwnd ? 'lost the foreground' : 'left full screen';
      S.video = now ? Object.assign({ since: Date.now() }, now) : null;
      return true;
    }

    /** The taskbar resolver's app id for a full-screen window (once per window), then decide again. */
    function appidFor(f) {
      if (!f || !f.fullscreen || f.self || f.shell || 'appid' in f || lockScreen(f)) return false;
      if (S.appids.has(f.hwnd)) { f.appid = S.appids.get(f.hwnd); return false; }
      if (S.appidAsk === f.hwnd) return true;
      S.appidAsk = f.hwnd;
      sc('jumplist.shortcut', { hwnd: f.hwnd }, 3000).then((r) => {
        const id = r.ok && r.appid ? String(r.appid) : null;
        if (!r.ok) ctx.log(`could not ask Windows which app the full-screen window ${f.hwnd} is (${r.reason}); its video is matched by exe name only`);
        if (S.appids.size > 50) S.appids.clear();
        S.appids.set(f.hwnd, id);
        if (S.appidAsk === f.hwnd) S.appidAsk = null;
        if (S.focus && S.focus.hwnd === f.hwnd) { S.focus.appid = id; refresh('app id'); }
      });
      return true;
    }

    /** Re-judge the focused window: its video, then the rules, then the "stays over" note. */
    function refresh(from) {
      const f = S.focus;
      const asking = appidFor(f);
      videoCheck();
      const p = decide(f && f.game, from);
      // the cover note waits for the app id of a full-screen window while something is playing
      if (!(asking && !S.video && S.sessions.some(playing))) coverNote(f);
      return p;
    }

    /** main.js's media read (ctx.host.onMedia): the sessions, for the video rule. */
    function onMedia(payload, fake) {
      if (S.holdReal && !fake) return;
      const ok = !!(payload && payload.ok !== false);
      const why = ok ? null : (payload && payload.reason) || 'the media sessions could not be read';
      if (!ok && S.media.reason !== why) ctx.log(`media sessions unavailable (${why}); full-screen video is recognised by known players only`);
      S.media = { ok, reason: why, at: Date.now() };
      S.sessions = ok && Array.isArray(payload.sessions) ? payload.sessions : [];
      if (S.focus && S.focus.fullscreen && !S.video) refresh('media');
    }

    /* ---- the state the bottom bar's quick settings shows (topbar.state) ------------------------ */
    function view() {
      return {
        hidden: S.hidden, chord: HIDE_CHORD, enabled: ctx.enabled(), visible: !!(S.win && !S.win.isDestroyed() && S.win.isVisible()),
        stepAside: S.stepAside, kind: S.stepKind || null, signal: S.stepSignal,
        video: S.video ? { app: S.video.app, how: S.video.how } : null, test,
        // the peek at the top edge while hidden by hand: ok false + reason = it cannot watch (said in the row)
        peek: { ok: S.peek.ok, reason: S.peek.reason, watching: S.peek.watching, shown: S.peek.shown },
      };
    }
    function publish() { ctx.broadcast('topbar.state', view()); }
    ctx.replay('topbar.state', view);

    async function setHidden(on, via) {
      on = !!on;
      if (on !== S.hidden) {
        S.hidden = on;
        ctx.settings.set('hidden', on);
        ctx.log(on ? `hidden by hand (${via}); ${HIDE_CHORD} or "Show top bar" in quick settings shows it again, also after a restart`
          : `shown by hand (${via})` + (S.peek.shown ? ' while it was peeking: it stays, now for good' : ''));
        // shown by hand: decide() takes the strip back below; until it lands that is not a failure
        if (!on && ctx.enabled() && !S.stopped && !S.run) asked('shown by hand');
        if (!on) peekSync(via);   // shown by hand ends a peek WITHOUT hiding it: decide() below keeps it up for good
        if (ctx.enabled() && !S.stopped) await decide(S.focus && S.focus.game, via);
        else ctx.log(`the top bar is switched off in the tray, so it is only remembered: ${on ? 'hidden' : 'shown'} when it is switched on`);
        if (on) peekSync(via);    // hidden by hand: the edge is watched from now on
      }
      publish();
      return Object.assign({ ok: true }, view());
    }

    /* ---- PEEK while hidden by hand (lane tbpeek, 2026-09-27; lib/features/_topbar-peek.js) -------
     * Owen: "make it so that i can bring the topbar back after i manually hide it by putting my mouse
     * to the top of the screen". Rest the cursor on the top edge (PEEK_DWELL_MS) and the bar shows
     * OVER the screen - the strip stays let go, no maximised window moves, the drag guard stays off,
     * only the stats sampler runs while it is out - and PEEK_GRACE_MS after the cursor leaves it (no
     * menu of it open) it hides again. S.hidden and the saved setting are never touched by a peek.
     * The poll runs ONLY while hidden by hand (not while a known game runs, the bar rests or is off):
     * one GetCursorPos every PEEK_POLL_MS; the buttons are read only while the cursor is on the edge. */
    const peekWanted = () => S.hidden && ctx.enabled() && !S.stopped && !S.run && !!S.win && !S.win.isDestroyed();
    const peekStopWhy = () => S.stopped ? 'the top bar stopped' : !ctx.enabled() ? 'the top bar was switched off in the tray'
      : S.run ? `${runNames(S.run.all)} started (a known game)` : !S.hidden ? 'shown by hand' : 'the window is gone';

    /** Everything that forbids a peek besides the buttons (PK.blocker), from the feature's own state. */
    function peekGuard() {
      const f = S.focus;
      return PK.blocker({
        hidden: S.hidden, enabled: ctx.enabled(), stopped: S.stopped, run: S.run ? runNames(S.run.all) : null,
        lock: lockScreen(f),
        game: f && f.game && f.game.stepAside ? (f.game.signal || M.appName(f)) : null,
        // the sidecar's full-screen verdict for the focused window (the same one the video rule reads)
        fullscreen: f && !f.self && !f.shell && f.fullscreen ? M.appName(f) : null,
      });
    }

    /** The watch's own health: null = it works. Logged and published on a change only. */
    function peekWatch(why) {
      const ok = !why;
      if (S.peek.ok === ok && S.peek.reason === (why || null)) return;
      if (!ok) ctx.log(`peek: cannot peek at the top edge: ${why}`);
      else if (S.peek.ok === false) ctx.log('peek: the top edge is watched again');
      S.peek.ok = ok; S.peek.reason = why || null;
      publish();
      health();
    }

    /** Read both sources once when the watch starts, so a reader that cannot work is said now. */
    function peekProbe() {
      let why = null;
      try {
        const p = S.peek.src.cursor();
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) why = 'the cursor position could not be read (nothing came back)';
      } catch (e) { why = `the cursor position could not be read (${e.message})`; }
      if (!why) {
        let b;
        try { b = S.peek.src.buttons(); } catch (e) { b = { ok: false, reason: `the reader threw: ${e.message}` }; }
        if (!b || !b.ok) why = `the mouse buttons cannot be read (${(b && b.reason) || 'no reason'}), so a peek could land in the middle of a drag`;
      }
      S.peek.curWhy = null; S.peek.btnWhy = null;
      peekWatch(why);
    }

    function peekSync(why) {
      if (peekWanted()) {
        if (S.peek.watching) return;
        S.peek.watching = true;
        // DISARMED to start: Win+Alt+T pressed with the cursor resting on the edge must not peek the
        // bar straight back; the cursor leaving the edge arms it (a cursor elsewhere: armed next poll)
        S.peek.st = PK.startState();
        const b = primary().bounds;
        ctx.log(`peek: watching the top edge (y ${b.y}..${b.y + PK.PEEK_BAND_DIP - 1}, x ${b.x}..${b.x + b.width - 1} DIP) every ${PK.PEEK_POLL_MS} ms while hidden by hand: ` +
          `${PK.PEEK_DWELL_MS} ms there peeks, ${PK.PEEK_GRACE_MS} ms away hides it again` + (S.peek.src.fake ? ' (the self-test\'s FAKE cursor)' : ''));
        peekProbe();
        peekSchedule();
        return;
      }
      if (!S.peek.watching && !S.peek.shown) return;
      const stopWhy = peekStopWhy();
      S.peek.watching = false;
      if (S.peek.t) { clearTimeout(S.peek.t); S.timers.delete(S.peek.t); S.peek.t = null; }
      S.peek.st = PK.initial();
      if (S.peek.shown && S.hidden) peekHide(stopWhy);   // a game / the tray / a stop: the peek goes with the watch
      else if (S.peek.shown) {                           // shown by hand: it stays, now for good
        S.peek.shown = false;
        S.peek.last = { at: Date.now(), act: 'kept', why: `${why || stopWhy}: shown for good` };
        push('topbar.peek', { on: false });
      }
      if (stopWhy !== 'shown by hand') ctx.log(`peek: stopped watching the top edge: ${stopWhy}`);
      publish();
      health();
    }

    function peekSchedule() {
      if (S.peek.t || !S.peek.watching || S.stopped) return;
      S.peek.t = later(PK.PEEK_POLL_MS, () => {
        S.peek.t = null;
        try { peekTick(); } catch (e) { peekWatch(`the peek poll threw: ${e.message}`); }
        peekSchedule();
      });
    }

    function peekTick() {
      if (!peekWanted()) { peekSync(); return; }
      let pt = null;
      let cursorWhy = null;
      try {
        pt = S.peek.src.cursor();
        if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) { pt = null; cursorWhy = 'nothing came back'; }
      } catch (e) { cursorWhy = e.message; }
      let btn;   // undefined = not read this tick (the cursor was not on the edge)
      const bounds = primary().bounds;
      const r = PK.step(S.peek.st, {
        now: Date.now(), pt, cursorWhy, bounds, bar: barDip(S.menu.open ? S.menu.height : BAR_DIP),
        menuOpen: S.menu.open, guard: peekGuard(),
        claimed: !!(pt && CZ.claims(pt, bounds)),   // an active hot corner's square is not the edge's (lane corners)
        buttons: () => { try { btn = S.peek.src.buttons(); } catch (e) { btn = { ok: false, reason: `the reader threw: ${e.message}` }; } return btn; },
      });
      S.peek.st = r.st;
      if (r.blocked) S.peek.blocked = { at: Date.now(), why: r.blocked };
      S.peek.curWhy = pt ? null : `the cursor position could not be read (${cursorWhy})`;
      if (btn !== undefined) S.peek.btnWhy = btn && btn.ok ? null : `the mouse buttons cannot be read (${(btn && btn.reason) || 'no reason'}), so a peek could land in the middle of a drag`;
      peekWatch(S.peek.curWhy || S.peek.btnWhy || null);
      if (r.act === 'show') peekShow(r.why);
      else if (r.act === 'hide') peekHide(r.why);
    }

    function peekShow(why) {
      if (!S.win || S.win.isDestroyed()) return;
      S.peek.shown = true; S.peek.since = Date.now(); S.peek.n++;
      S.peek.last = { at: S.peek.since, act: 'shown', why };
      showOver();
      push('topbar.peek', { on: true });
      ctx.log(`peek shown: ${why}; over the screen, the strip stays let go and it is still hidden by hand`);
      publish();
      statsOn(true).catch((e) => ctx.log(`peek: the stats did not start: ${e.message}`));
    }

    function peekHide(why) {
      const secs = S.peek.since ? ((Date.now() - S.peek.since) / 1000).toFixed(1) : '?';
      S.peek.shown = false;
      S.peek.last = { at: Date.now(), act: 'hidden', why };
      push('topbar.close', {});   // a menu the peek left open goes with it
      push('topbar.peek', { on: false });
      hide();
      ctx.log(`peek hidden after ${secs} s: ${why}`);
      publish();
      statsOn(false, 'the top bar is hidden by hand').catch((e) => ctx.log(`peek: the stats did not stop: ${e.message}`));
    }

    function coverNote(f) {
      // A non-game window that covers the monitor: the bar stays over its top strip. Said, not hidden.
      if (f && f.fullscreen && !S.stepAside && !f.self) {
        const note = `${M.appName(f)} is full screen; the top bar stays over its top ${BAR_DIP} DIP (it is not a game, so the bar does not step aside)`;
        if (!S.cover || S.cover.hwnd !== f.hwnd) ctx.log(note);
        S.cover = { hwnd: f.hwnd, app: M.appName(f), coveredDip: BAR_DIP, note };
      } else if (f && !f.self) S.cover = null;
    }

    /* ---- the sidecar ------------------------------------------------------------------------ */
    function onTopbar(ev) {
      const payload = Object.assign({}, ev);
      delete payload.ev;
      if (ev.kind === 'focus') {
        if (!ev.self) { S.focus = payload; S.lastApp = ev.hwnd; refresh('focus'); }
        push('topbar.focus', payload);
      } else if (ev.kind === 'title') {
        if (S.focus && S.focus.hwnd === ev.hwnd) S.focus.title = ev.title;
        push('topbar.title', payload);
      } else if (ev.kind === 'geometry') {
        if (S.focus && S.focus.hwnd === ev.hwnd) {
          S.focus.fullscreen = ev.fullscreen; S.focus.zoomed = ev.zoomed;
          if (ev.game) S.focus.game = ev.game;
          refresh('geometry');
        }
        push('topbar.geometry', payload);
      } else if (ev.kind === 'guard') {
        S.guard.last = { at: Date.now(), cls: ev.cls, how: ev.how, dy: ev.dy, dryRun: ev.dryRun, ok: ev.ok, reason: ev.reason };
        ctx.log(`${ev.dryRun ? 'would have put' : ev.ok ? 'put' : 'could not put'} a ${ev.cls} window back below the bar (${ev.how})${ev.reason ? ': ' + ev.reason : ''}`);
      }
    }
    function onStats(ev) {
      const payload = Object.assign({}, ev);
      delete payload.ev;
      if (S.stepAside && !S.peek.shown && !payload.paused) return;   // a peek shows live stats
      if (!payload.paused) S.stats = payload;
      push('topbar.stats', payload);
    }

    async function statsOn(on, why) {
      const r = await sc('topbar.stats', { on });
      S.stats_ = { on: on && r.ok, reason: r.ok ? (on ? null : why || 'off') : r.reason };
      if (!on) push('topbar.stats', { paused: true, reason: why || 'the top bar is off' });
      else if (!r.ok) push('topbar.note', { text: `System stats are unavailable: ${r.reason}` });
    }

    async function guardOn() {
      if (S.run || S.hidden) return;   // off while a known game runs or the bar is hidden by hand: there is no strip to keep windows out of
      const d = primary();
      const phys = screen.dipToScreenRect(null, barDip());
      const r = await sc('topbar.guard', { on: true, bar: [phys.x, phys.y, phys.x + phys.width, phys.y + phys.height] });
      S.guard.ok = r.ok;
      S.guard.reason = r.ok ? (r.passive ? 'passive: drags into the strip are measured and logged, nothing is moved' : null) : r.reason;
      S.guard.bar = r.ok ? r.bar : null;
      S.guard.scale = d.scaleFactor;
      if (!r.ok) push('topbar.note', { text: `A window dragged into the top bar will not be put back: ${r.reason}` });
    }

    async function reserve(why) {
      if (!live || !S.hwnd || S.stopped || !ctx.enabled()) return;
      if (S.run) {   // never while a known game runs (a game's mode switch is a display change too)
        ctx.log(`app bar ${why}: not taken back: ${runNames(S.run.all)} is running; the strip comes back when it exits`);
        return;
      }
      if (S.hidden) {   // hidden by hand: the strip is let go until it is shown again
        ctx.log(`app bar ${why}: not taken: the top bar is hidden by hand (${HIDE_CHORD} shows it)`);
        return;
      }
      asked(why);   // on its way: healthy until it lands, fails, or RESERVE_GRACE_MS runs out
      const d = primary();
      const size = reserveSize(d.scaleFactor, S.dpiAware !== false);
      const r = await sc('topbar.reserve', { hwnd: S.hwnd, size });
      if (S.run) {   // a game started while that was on its way: give the strip straight back
        ctx.log(`app bar ${why}: ${runNames(S.run.all)} started meanwhile, so the strip was let go again`);
        await release(`${runNames(S.run.all)} is running`);
        return;
      }
      if (S.hidden) {   // hidden by hand while that was on its way
        ctx.log(`app bar ${why}: the top bar was hidden by hand meanwhile, so the strip was let go again`);
        await release(`hidden by hand; ${HIDE_CHORD} takes it back`);
        return;
      }
      if (!r.ok) {
        S.reserve = { reserved: false, size, reason: `the strip could not be reserved (${r.reason}), so maximised windows go under the bar` };
        health();
        return;
      }
      place(S.menu.open ? S.menu.height : BAR_DIP);
      const check = () => {
        const w = workAreaCheck(primary());
        S.reserve = {
          reserved: w.ok, size, rect: r.rect, workTop: w.got, barBottom: w.want, checked: why, at: Date.now(),
          reason: w.ok ? `reserved ${size}px (${BAR_DIP} DIP at ${d.scaleFactor}x); the work area starts at the bar's bottom (${w.got})`
            : `reserved ${size}px, but the work area starts at ${w.got} DIP instead of the bar's bottom ${w.want} DIP`,
        };
        ctx.log(`app bar ${why}: ${S.reserve.reason}`);
        health();
      };
      later(300, check);
    }

    async function release(why) {
      if (!live || !S.hwnd) return { ok: true, dryRun: true };
      const r = await sc('topbar.release', { hwnd: S.hwnd }, 2000);
      S.reserve = { reserved: false, reason: r.ok ? (why ? `let go: ${why}` : 'released') : `release failed: ${r.reason}` };
      return r;
    }

    /* ---- known games running (see KNOWN GAMES RUNNING) ------------------------------------------ */
    async function gameCheck() {
      if (S.stopped || !ctx.enabled() || S.runBusy) return;
      S.runBusy = true;
      try {
        // procs without detail = the Toolhelp list only: names and pids, no handle to any process
        const r = await sc('gamemode.scan', { procs: true }, 3000);
        if (!r.ok || !Array.isArray(r.procs) || r.procsReason) {
          const why = !r.ok ? r.reason : r.procsReason || 'the sidecar sent no process list (an old sidecar: npm run build:sidecar)';
          if (S.runWatch.ok !== false || S.runWatch.reason !== why) {
            ctx.log(`cannot check for games starting: ${why}` + (S.run ? `; stays stepped aside for ${runNames(S.run.all)} until the check works again` : ''));
          }
          S.runWatch = { ok: false, reason: why };   // a failed check changes nothing: never takes the strip back mid-game
          health();
          return;
        }
        if (S.runWatch.ok !== true) {
          if (S.runWatch.ok === false) ctx.log('checking for games starting again');
          S.runWatch = { ok: true, reason: null };
          health();
        }
        await runChanged(P.runningGames(r, { seen: S.runSeen, extra: TEST_GAMES }));
      } finally { S.runBusy = false; }
    }

    async function runChanged(list) {
      const was = S.run;
      if (list.length && was) { was.all = list; return; }   // still running: an alt-tab or a second game changes nothing
      if (!list.length && !was) return;
      if (list.length) {
        S.run = { pid: list[0].pid, file: list[0].file, all: list, since: Date.now(), released: null };
        await decide(S.focus && S.focus.game, 'game started');   // hides, closes a menu, stops the stats
        peekSync('game started');   // a peek goes with the watch while a known game runs
        await sc('topbar.guard', { on: false }, 1500);
        S.guard.ok = false; S.guard.reason = `off while ${runNames(list)} runs`;
        const rel = await release(`${runNames(list)} is running; taken back when it exits`);
        S.run.released = rel.ok ? (rel.dryRun ? 'dry run' : 'released') : `failed: ${rel.reason}`;
        ctx.log(`${runNames(list)} is running (a known game); the top bar ` +
          (rel.dryRun ? `stepped aside until it exits (a --test instance holds no strip, so there was none to let go)`
            : rel.ok ? `let go of the top ${BAR_DIP} DIP and stepped aside until it exits`
            : `stepped aside until it exits, but could NOT let go of the top ${BAR_DIP} DIP (${rel.reason}), so maximised windows still start below it`));
        health();
      } else {
        S.run = null;
        ctx.log(`${runNames(was.all)} exited after ${Math.round((Date.now() - was.since) / 1000)} s; the top bar takes back the top ${BAR_DIP} DIP and comes back`);
        if (!S.hidden) asked('game exited');
        await decide(S.focus && S.focus.game, 'game exited');   // shows it and restarts the stats, unless something else still wants it aside
        peekSync('game exited');    // hidden by hand: the edge is watched again
        await guardOn();
        if (live) await reserve('game exited');
        else ctx.log('app bar game exited: a --test instance never reserves space on the screen, so there was nothing to take back');
        health();
      }
    }

    function runLoop() {
      if (S.runT || S.stopped || !ctx.enabled()) return;
      S.runT = later(RUN_MS, async () => {
        S.runT = null;
        try { await gameCheck(); } catch (e) { ctx.log(`the game check threw: ${e.message}`); }
        runLoop();
      });
    }
    function runLoopStop() { if (S.runT) { clearTimeout(S.runT); S.timers.delete(S.runT); S.runT = null; } }

    async function apply(why) {
      if (S.stopped) return;
      if (!ctx.enabled()) { await off('the top bar is switched off in the tray'); return; }
      asked(why, RESERVE_START_GRACE_MS);   // the reserve at the end of this; the steps before it can each wait on the sidecar
      const p = await sc('ping');
      S.dpiAware = p.ok ? p.dpiAware === true : null;
      const w = await sc('topbar.watch', { on: true });
      S.watch = w.ok ? { ok: true, reason: null } : { ok: false, reason: w.reason };
      if (w.ok && w.focus) onTopbar(Object.assign({ kind: 'focus' }, w.focus));
      await gameCheck();   // a game already running (Mantle restarted mid-game): the strip is not taken at all
      await decide(S.focus && S.focus.game, why);   // hidden by hand (kept from the last run) applies even with no focus read
      await guardOn();
      if (!S.stepAside) await statsOn(true);
      await reserve(why);
      // Asked again once things settle, as main.js does for the bottom bar: right after a Mantle
      // restart Explorer can still hold the previous bar's slot and stack this one below it
      // (seen live for the bottom bar, 2026-09-21). Re-reserving the same window is free.
      if (live) for (const ms of [1500, 6000]) later(ms, () => reserve(`${ms / 1000} s re-check`));
      show();
      runLoop();
      peekSync(why);
      health();
    }

    async function off(why) {
      runLoopStop();
      peekSync(why);   // off or stopped: the watch stops and a peek hides
      hide();
      await Promise.all([
        sc('topbar.watch', { on: false }, 1500), sc('topbar.guard', { on: false }, 1500),
        sc('topbar.stats', { on: false }, 1500), release(),
      ]);
      S.watch = { ok: false, reason: why };
      S.stats_ = { on: false, reason: why };
    }

    /* ---- the page's calls ------------------------------------------------------------------- */
    const refuseInTest = (what) => ({ ok: true, dryRun: true, reason: `dry run (--test): would have ${what}` });
    ctx.command('hello', async () => ({ focus: S.focus, stats: S.stats, note: S.note, stepAside: S.stepAside, overGames: S.overGames, hidden: S.hidden, chord: HIDE_CHORD, peek: S.peek.shown }));
    // "Hide top bar" (the bar's Mantle menu, quick settings) and "Show top bar" (quick settings); the chord toggles
    ctx.command('hidden', async (a) => setHidden(!!(a && a.on), (a && a.via) || 'the menu'));
    ctx.command('state', async () => view());
    ctx.command('status', async () => ({
      test, live, dpiAware: S.dpiAware, page: { ok: S.pageOk, reason: S.pageReason },
      bounds: S.win && !S.win.isDestroyed() ? S.win.getBounds() : null, visible: !!(S.win && !S.win.isDestroyed() && S.win.isVisible()),
      watch: S.watch, stats: S.stats_, guard: S.guard, reserve: S.reserve, menu: S.menu, shape: S.shape, drift: S.drift || null,
      stepAside: S.stepAside, stepSignal: S.stepSignal, stepKind: S.stepKind || null, overGames: S.overGames, cover: S.cover,
      run: S.run ? { file: S.run.file, all: S.run.all.map((g) => g.file), since: S.run.since, released: S.run.released } : null,
      runWatch: S.runWatch, hidden: S.hidden, chord: HIDE_CHORD, video: S.video, videoEnd: S.videoEnd, media: S.media,
      peek: { watching: S.peek.watching, shown: S.peek.shown, since: S.peek.since, ok: S.peek.ok, reason: S.peek.reason, phase: S.peek.st.phase, blocked: S.peek.blocked, last: S.peek.last, n: S.peek.n, fake: !!S.peek.src.fake,
        bandDip: PK.PEEK_BAND_DIP, dwellMs: PK.PEEK_DWELL_MS, graceMs: PK.PEEK_GRACE_MS, pollMs: PK.PEEK_POLL_MS },
      playing: S.sessions.filter(playing).map((s) => s.aumid),
      focus: S.focus ? { hwnd: S.focus.hwnd, app: M.appName(S.focus), fullscreen: S.focus.fullscreen, game: S.focus.game, appid: S.focus.appid } : null,
    }));
    // The page asks for its dropdowns' FULL layout height (capped by the screen, never by this
    // window: a cap from the window's own 38 DIP made every dropdown a 12 px strip, 2026-09-25,
    // ui/topbar/topbar.css .dd) and keeps them hidden until the window has grown to it.
    ctx.command('menuState', async (a) => {
      const open = !!(a && a.open);
      const d = primary();
      const h = open ? Math.max(BAR_DIP, Math.min(Math.ceil(Number(a.height) || BAR_DIP), d.bounds.height)) : BAR_DIP;
      S.menu = { open, height: h };
      place(h);
      if (!open && a && a.refocus && S.lastApp && live) {
        const r = await sc('focus', { hwnd: S.lastApp });
        if (!r.ok) return { ok: false, reason: `the app could not be given the keyboard back: ${r.reason}` };
      }
      return { ok: true, height: h, refocused: !open && !!(a && a.refocus) && live };
    });
    ctx.command('menus', async (a) => sc('topbar.menus', { hwnd: a && a.hwnd, init: a && a.init }));
    ctx.command('uia', async (a) => sc('topbar.uia', { hwnd: a && a.hwnd }, 15000));
    ctx.command('invoke', async (a) => sc('topbar.invoke', { hwnd: a && a.hwnd, item: a && a.item, focus: live }));
    ctx.command('uiaInvoke', async (a) => {
      if (test) return { ok: false, reason: 'a --test instance never runs a UI Automation action (one activated a test window and took the keyboard, 2026-09-24)' };
      return sc('topbar.uiaInvoke', { hwnd: a && a.hwnd, path: a && a.path, names: a && a.names, expand: !!(a && a.expand) }, 15000);
    });
    ctx.command('window', async (a) => sc('topbar.window', { hwnd: a && a.hwnd, action: a && a.action, on: a && a.on, dryRun: test }));
    ctx.command('newWindow', async (a) => {
      const exe = String((a && a.exe) || '');
      const want = M.newWindowArgs(exe);
      const args = Array.isArray(a && a.args) ? a.args.map(String) : [];
      if (!want || JSON.stringify(want) !== JSON.stringify(args)) return { ok: false, reason: `Mantle does not know how to open a new ${path.basename(exe) || 'app'} window` };
      if (!path.isAbsolute(exe) || !fs.existsSync(exe)) return { ok: false, reason: `${exe || 'the app'} is not on disk any more` };
      if (test) return refuseInTest(`run ${exe} ${args.join(' ')}`.trim());
      try {
        const child = cp.spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', (e) => push('topbar.note', { text: `New window: ${e.message}` }));
        child.unref();
        return { ok: true };
      } catch (e) { return { ok: false, reason: e.message }; }
    });
    ctx.command('power', async (a) => {
      const LI = require('../launcher-index');
      const sidecar = async (cmd, args, ms) => {
        const r = await ctx.sidecar.send(cmd, args, { timeoutMs: ms || 4000 });
        if (!r.ok) throw new Error(r.error);
        return r.result;
      };
      return LI.power({ action: a && a.action, confirmed: !!(a && a.confirmed) }, { sidecar, dryRun: test });
    });
    ctx.command('about', async () => {
      let version = '?';
      try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version; } catch (_) { /* shown as ? */ }
      const cpu = (os.cpus()[0] || {}).model || 'unknown CPU';
      const text = `Mantle ${version} · Windows ${os.release()} · ${cpu.replace(/\s+/g, ' ').trim()} · ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM`;
      S.note = text;
      push('topbar.note', { text });
      later(8000, () => { if (S.note === text) S.note = null; });
      return { ok: true, text };
    });
    ctx.command('settings', async () => {
      if (test) return refuseInTest('opened Windows Settings (ms-settings:)');
      try { await shell.openExternal('ms-settings:'); return { ok: true }; } catch (e) { return { ok: false, reason: `Windows Settings did not open: ${e.message}` }; }
    });
    ctx.command('taskmgr', async () => {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Taskmgr.exe');
      if (test) return refuseInTest(`run ${exe}`);
      try { cp.spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ctx.command('statsDetail', async (a) => {
      if (S.stepAside && !S.peek.shown) return { ok: false, reason: S.stepKind === 'hidden' ? 'the stats are paused while the top bar is hidden by hand' : 'the stats are paused while a game has the screen' };
      return sc('topbar.stats', { on: true, detail: String((a && a.kind) || '') });
    });
    ctx.command('overGames', async (a) => {
      S.overGames = !!(a && a.on);
      ctx.settings.set('overGames', S.overGames);
      ctx.log(`keep the top bar over full-screen games: ${S.overGames}`);
      await decide(S.focus && S.focus.game, 'setting');
      return { ok: true, overGames: S.overGames, stepAside: S.stepAside };
    });

    /* ---- wiring ----------------------------------------------------------------------------- */
    // S.holdReal: the self-test is driving FAKE focus snapshots and sessions; Owen's real ones wait
    ctx.sidecar.on('topbar', (ev) => { if (!S.holdReal || (ev && ev.kind === 'guard')) onTopbar(ev); });
    ctx.sidecar.on('topbarstats', onStats);
    ctx.onChord(HIDE_CHORD, () => { setHidden(!S.hidden, HIDE_CHORD).catch((e) => ctx.log(`${HIDE_CHORD} failed: ${e.message}`)); });
    // the NOW PLAYING read (main.js), for the video rule; without it only known players count, and status says why
    let mediaOff = null;
    if (ctx.host.onMedia) {
      mediaOff = ctx.host.onMedia((p) => onMedia(p));
      const first = ctx.host.media && ctx.host.media();
      if (first) onMedia(first);
    } else S.media = { ok: false, reason: 'this Mantle hands features no media sessions (ctx.host.onMedia)' };
    createWindow();
    place(BAR_DIP);
    ctx.sidecar.onReady(() => { apply('sidecar ready').catch((e) => ctx.log(`start failed: ${e.message}`)); });
    ctx.onEnabled((on) => { (on ? apply('switched on') : off('the top bar is switched off in the tray')).catch((e) => ctx.log(e.message)); });
    const onDisplay = () => {
      if (S.stopped) return;
      place(S.menu.open ? S.menu.height : BAR_DIP);
      // not while a known game runs: its own mode switch fires these, and re-reserving then would
      // move the work area under the game (reserve() and guardOn() both check S.run as well)
      if (ctx.enabled() && !S.run) { reserve('display changed'); guardOn(); }
    };
    screen.on('display-metrics-changed', onDisplay);
    screen.on('display-added', onDisplay);
    screen.on('display-removed', onDisplay);

    let selftest = null;
    if (test && process.env.MANTLE_TOPBAR_SELFTEST === '1') {
      selftest = require('./_topbar-selftest.js');
      // TEST ONLY: peekSource({cursor, buttons}) swaps in the self-test's FAKE cursor and buttons for the
      // peek (Owen's real cursor never drives a test instance's peek); peekSource(null) puts the real ones back
      const real = S.peek.src;
      const peekSource = (src) => {
        S.peek.src = src ? { cursor: src.cursor, buttons: src.buttons, fake: true } : real;
        S.peek.st = PK.startState();
        if (S.peek.watching) peekProbe();
      };
      selftest.start({ ctx, S, screen, BrowserWindow, hwndOf, thumbs, onTopbar, decide, BAR_DIP, onMedia: (p) => onMedia(p, true), HIDE_CHORD, peekSource });
    }

    return {
      async stop(why, how) {
        S.stopped = true;
        // resting for a game: the timer holds a finished timer's pop-up until install() runs again
        if (how && how.rest) TOOLS_HUB.setResting(String(why || 'a game runs').replace(/^resting while /, ''));
        if (selftest) selftest.stop();
        if (mediaOff) { try { mediaOff(); } catch (_) { /* host gone */ } }
        for (const t of S.timers) clearTimeout(t);
        screen.removeListener('display-metrics-changed', onDisplay);
        screen.removeListener('display-added', onDisplay);
        screen.removeListener('display-removed', onDisplay);
        await off('Mantle is putting Windows back');
        if (S.win && !S.win.isDestroyed()) S.win.destroy();
      },
    };
  },
};
