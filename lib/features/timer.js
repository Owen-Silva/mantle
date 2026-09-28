'use strict';
/* timer.js - THE TOP BAR'S TIMER AND STOPWATCH (lane tbtimer, 2026-09-27).
 *
 * The top bar (lib/features/topbar.js + ui/topbar/) draws the icon, the menu (5/15/25/50, custom,
 * stopwatch, pause/resume/cancel) and the running "18:42" from the `timer.state` event. This file
 * is the ENGINE (state, persistence, firing) and the DONE POP-UP (ui/timer/). The time rules are
 * _timer-core.js, shared with the top bar's page so both count by the same arithmetic.
 *
 * NO TICKING IN MAIN: one setTimeout to the end of a running timer (capped at 2^31-1 ms and armed
 * again), none while idle, paused or on a stopwatch. The page draws the seconds from `endAt` /
 * `startAt`. A sleep can make the timeout late, so powerMonitor 'resume' checks again.
 *
 * NEVER RESTS (no `rest` flag): a timer must fire while Mantle rests for a game. But while a game
 * runs, a new renderer is the stutter Owen closed Mantle over and a topmost window can knock an
 * exclusive full-screen game to the desktop, so AT ZERO DURING A GAME: no window, no renderer, ONE
 * shell.beep(), and the pop-up waits for the game to end (_tools-hub.js onResting). The top bar is
 * what tells us a game runs (hub.known false = it never installed: the pop-up shows at once and the
 * state says resting is unknown, with the reason).
 *
 * KEPT ACROSS A RESTART: every change is saved (ctx.settings 'clock'); install() restores. A timer
 * that ended while Mantle was off fires ONCE ("Finished while Mantle was off") and the saved state
 * turns idle at that moment. A save that fails keeps the timer running and says so (health + the
 * state's `persist`), never silently.
 *
 * --test: the pop-up is made but NEVER shown (its page still runs, readable by a test), no sound
 * ever plays (the page is told `mute`, the beep is only logged and counted), and the test hooks
 * sit on require('./_tools-hub').test.timer.
 */
const core = require('./_timer-core');
const hub = require('./_tools-hub');

const DONE_MS = 120000;                       // the done pop-up closes itself after this
const MAX_DELAY = 2147483647;                 // setTimeout's ceiling (2^31-1 ms, ~24.8 days)
const CARD = { w: 320, h: 84 };               // the pop-up's card (ui/timer/timer.css --card-w/--card-h)
const PAD = { l: 12, r: 12, t: 6, b: 18 };    // ui/timer/timer.css body padding: room for the card's shadow
const BAR_H = 28, GAP = 6, EDGE = 8;          // under the 28 DIP top bar, 8 DIP in from the screen's right edge
const WIN = { w: CARD.w + PAD.l + PAD.r, h: CARD.h + PAD.t + PAD.b };
const OK_WORDS = 'the top bar\'s timer and stopwatch';
const OFF_WORDS = 'The timer is switched off in the tray';

const words = (e) => String((e && e.message) || e || 'no reason given').replace(/\s+/g, ' ').trim().slice(0, 200);

/** "resting while VALORANT.exe runs" -> "VALORANT.exe runs" (the hub may get either). */
const gameWords = (why) => String(why || '').replace(/^resting while\s+/i, '').trim() || 'a game runs';
/** -> "VALORANT.exe ran" (for "Ended at 9:14 PM while ..."). */
const pastTense = (why) => gameWords(why).replace(/\s+is running$/i, ' ran').replace(/\s+runs$/i, ' ran').replace(/\s+is on$/i, ' was on');

module.exports = {
  name: 'timer',
  label: 'Timer and stopwatch (top bar)',
  defaultOn: true,
  chords: [],
  observe: [],
  /* no `rest`: see the header */

  /** Unit tests only (lib/features/timer.test.js): { electron, setTimeout, clearTimeout, now }. */
  _inject: null,

  install(ctx) {
    const inj = module.exports._inject || {};
    const setT = inj.setTimeout || setTimeout;
    const clearT = inj.clearTimeout || clearTimeout;
    const test = !!(ctx.flags && ctx.flags.test);
    const electron = () => {
      if (inj.electron) return inj.electron;
      try { const e = require('electron'); return e && typeof e === 'object' && e.BrowserWindow ? e : null; } catch (_) { return null; }
    };

    let fakeNow = null;
    const realNow = inj.now || Date.now;
    const now = () => (fakeNow ? fakeNow() : realNow());

    let st = { kind: 'idle' };
    let lastMs = null;            // the last started duration ("Again")
    let done = null;              // the done notice: see view()
    let held = false;             // a done pop-up waiting for a game to end
    let persist = { ok: true, reason: null };
    let restoreError = null;      // the saved timer could not be read at start (shown, not swallowed)
    let timeout = null;
    let popup = null;             // the done pop-up's BrowserWindow (made per finish, never kept)
    let popupKill = null;
    let beeps = 0;
    let stopped = false;
    let unpower = null;

    ctx.health(true, OK_WORDS);

    /* ---- view, save, events ---- */
    function view() {
      const t = now();
      const timer = st.kind === 'timer', sw = st.kind === 'stopwatch';
      return {
        kind: st.kind,
        paused: !!st.paused,
        endAt: timer && !st.paused ? st.endAt : null,
        leftMs: timer ? core.leftMs(st, t) : null,
        totalMs: timer ? st.totalMs : null,
        label: timer ? st.label : null,
        startAt: sw && !st.paused ? st.startAt : null,
        elapsedMs: sw ? core.elapsedMs(st, t) : null,
        lastMs,
        done: done ? Object.assign({}, done) : null,
        held,
        resting: hub.known ? hub.resting : 'unknown',
        restingReason: hub.known ? null : 'the top bar has not started, so Mantle cannot tell whether a game runs; a done pop-up shows at once',
        persist: Object.assign({}, persist),
        restoreError,
        on: ctx.enabled(),
        test,
        now: t,
      };
    }
    const emit = () => { if (!stopped) ctx.broadcast('timer.state', view()); };
    ctx.replay('timer.state', view);

    function save() {
      try {
        ctx.settings.set('clock', st);
        ctx.settings.set('last', lastMs);
        if (!persist.ok) {
          persist = { ok: true, reason: null };
          ctx.health(true, OK_WORDS);
          ctx.log('the timer can be kept across a restart again');
        }
      } catch (e) {
        const reason = words(e);
        if (persist.ok || persist.reason !== reason) ctx.log(`could not save the timer (${reason}); it keeps running but will not survive a restart`);
        persist = { ok: false, reason };
        ctx.health(false, `the timer cannot be kept across a restart: ${reason}`);
      }
    }

    function describe(s, t) {
      // The LENGTH names it in the log, never s.label: a label can be free text (timer.start {label}),
      // and the log gets no typed words (security review 2).
      if (s.kind === 'timer') return `${core.labelFor(s.totalMs)} timer (${core.formatClock(core.leftMs(s, t))} left${s.paused ? ', paused' : ''})`;
      if (s.kind === 'stopwatch') return `stopwatch (${core.formatClock(core.elapsedMs(s, t), true)}${s.paused ? ', paused' : ''})`;
      return 'nothing';
    }

    /* ---- the one timeout ---- */
    function disarm() { if (timeout) { clearT(timeout); timeout = null; } }
    function arm() {
      disarm();
      if (stopped || st.kind !== 'timer' || st.paused) return;
      const delay = Math.min(MAX_DELAY, Math.max(0, st.endAt - now()));
      timeout = setT(check, delay);
      if (timeout && timeout.unref) timeout.unref();
    }
    function check() {
      disarm();   // called by the timeout itself, or by a wake from sleep while it is still pending
      if (stopped || st.kind !== 'timer' || st.paused) return;
      if (now() >= st.endAt) finish({ label: st.label, totalMs: st.totalMs, endAt: st.endAt, whileOff: false });
      else arm();   // early (a capped delay, or the clock moved): wait for the rest
    }

    /* ---- sound of last resort ---- */
    function beep(why) {
      beeps++;
      if (test) { ctx.log(`would beep (muted in --test): ${why}`); return; }
      const el = electron();
      try {
        if (!el || !el.shell || typeof el.shell.beep !== 'function') throw new Error('there is no shell.beep here');
        el.shell.beep();
      } catch (e) { ctx.log(`the beep failed (${words(e)})`); }
    }

    /* ---- at zero ---- */
    function finish(f) {
      disarm();
      if (st.kind === 'timer' && !f.whileOff) st = { kind: 'idle' };
      save();
      closePopup();
      held = false;
      done = { label: f.label, totalMs: f.totalMs, endAt: f.endAt, whileOff: !!f.whileOff, during: null,
        popup: null, reason: null, sound: null, soundReason: null };
      ctx.log(`done (${core.labelFor(f.totalMs)})${f.whileOff ? ', while Mantle was off' : ''}`);
      if (hub.known && hub.resting) {
        held = true;
        done.popup = 'held';
        done.reason = `the pop-up waits for the game to end (${gameWords(hub.resting)})`;
        beep('the timer ended during a game');
        ctx.log(`done during a game (${gameWords(hub.resting)}): beeped once; the pop-up waits for the game to end`);
        emit();
        return;
      }
      showPopup();
    }

    function payload() {
      return { label: done.label, totalMs: done.totalMs, endAt: done.endAt, whileOff: done.whileOff, during: done.during, mute: test, closeInMs: DONE_MS };
    }

    function showPopup() {
      if (!done || stopped) return;
      closePopup();
      done.popup = 'shown'; done.reason = null; done.sound = test ? 'muted' : 'pending'; done.soundReason = test ? 'muted in --test' : null;
      popupKill = setT(() => {
        popupKill = null;
        ctx.log(`the done pop-up closed itself after ${Math.round(DONE_MS / 60000)} min (not dismissed)`);
        closePopup(); done = null; held = false; emit();
      }, DONE_MS);
      if (popupKill && popupKill.unref) popupKill.unref();
      const el = electron();
      if (!el) { popupFailed(null, 'there is no Electron here'); return; }
      let win;
      try {
        const b = el.screen.getPrimaryDisplay().bounds;
        win = new el.BrowserWindow({
          show: false, frame: false, transparent: true, skipTaskbar: true, focusable: false, hasShadow: false,
          resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
          alwaysOnTop: !test, title: 'Mantle timer done',
          x: Math.round(b.x + b.width - EDGE - CARD.w - PAD.r), y: Math.round(b.y + BAR_H + GAP - PAD.t), width: WIN.w, height: WIN.h,
          webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
            autoplayPolicy: 'no-user-gesture-required' },
        });
        popup = win;
        if (!test) win.setAlwaysOnTop(true, 'screen-saver');
        const wc = win.webContents;
        wc.on('will-navigate', (e) => e.preventDefault());
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        wc.on('render-process-gone', (_e, d) => popupFailed(win, `its page crashed (${(d && d.reason) || 'no reason given'})`));
        wc.on('did-fail-load', (_e, code, desc) => popupFailed(win, `its page did not load (${desc || code})`));
        wc.once('did-finish-load', () => {
          if (popup !== win || win.isDestroyed()) return;
          if (!ctx.push(win, 'timer.done', payload())) { popupFailed(win, 'its page could not be told'); return; }
          if (!test) win.showInactive();   // never focus(): it must not take the keyboard
        });
        const p = win.loadFile(ctx.page('index.html'));
        if (p && typeof p.catch === 'function') p.catch((e) => popupFailed(win, `its page did not load (${words(e)})`));
      } catch (e) {
        popupFailed(win || null, `it could not be made (${words(e)})`);
        return;
      }
      emit();
    }

    function popupFailed(win, why) {
      if (win && popup !== win) return;   // an old window, already replaced or closed
      if (popup) { const w = popup; popup = null; try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ } }
      if (done) {
        done.popup = 'failed'; done.reason = `the pop-up ${why}`;
        done.sound = 'failed'; done.soundReason = test ? 'the pop-up did not show (muted in --test)' : 'the pop-up did not show, so a plain beep played instead';
      }
      ctx.log(`the done pop-up failed: ${why}; the top bar says "Timer done" instead`);
      beep('the done pop-up failed');
      emit();
    }

    /** soon: the call came FROM the pop-up (Again / Dismiss): hide it now, destroy it on the next turn,
     * so the reply to its own mantle.call is not sent to a disposed frame. */
    function closePopup(soon) {
      if (popupKill) { clearT(popupKill); popupKill = null; }
      if (!popup) return;
      const w = popup; popup = null;
      const kill = () => { try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ } };
      if (!soon) { kill(); return; }
      try { if (!w.isDestroyed()) w.hide(); } catch (_) { /* gone */ }
      setImmediate(kill);
    }

    /* ---- a game starts / ends (the top bar reports it) ---- */
    const unhub = hub.onResting((resting, was) => {
      if (stopped) return;
      if (!resting && held && done) {
        held = false;
        done.during = pastTense(was);
        ctx.log(`the game ended (${gameWords(was)}); showing the done pop-up that waited`);
        showPopup();
        return;
      }
      emit();
    });

    /* ---- a sleep can make the timeout late ---- */
    try {
      const el = electron();
      if (el && el.powerMonitor && typeof el.powerMonitor.on === 'function') {
        const onWake = () => { if (!stopped && st.kind === 'timer' && !st.paused) check(); };
        el.powerMonitor.on('resume', onWake);
        unpower = () => { try { el.powerMonitor.removeListener('resume', onWake); } catch (_) { /* gone */ } };
      }
    } catch (e) { ctx.log(`cannot hear the PC wake up (${words(e)}); a timer that ends during sleep fires a little late`); }

    /* ---- restore ---- */
    function runRestore(saved) {
      const t = now();
      const r = core.restore(saved, t);
      st = r.st;
      restoreError = r.reason || null;
      if (r.reason) ctx.log(`${r.reason}; starting with no timer`);
      if (!ctx.enabled() && st.kind !== 'idle') {
        ctx.log(`switched off in the tray: the saved ${describe(st, t)} was cancelled`);
        st = { kind: 'idle' };
      }
      save();           // at once: a timer that fired below is idle on disk before it shows
      arm();
      if (r.fired) {
        if (ctx.enabled()) finish(r.fired);
        else ctx.log(`a ${core.labelFor(r.fired.totalMs)} timer ended while Mantle was off, but the timer is switched off in the tray: not shown`);
      } else if (st.kind !== 'idle') ctx.log(`picked up the ${describe(st, t)}`);
      emit();
    }
    let saved;
    try { saved = ctx.settings.get('clock', null); const l = ctx.settings.get('last', null); const lc = typeof l === 'number' ? core.checkMs(l) : null; lastMs = lc && lc.ok ? lc.ms : null; }
    catch (e) { saved = null; restoreError = `the saved timer could not be read (${words(e)})`; ctx.log(restoreError); }
    runRestore(saved);

    /* ---- commands ---- */
    const reply = (extra) => Object.assign({ ok: true }, view(), extra || {});
    const no = (reason) => ({ ok: false, reason });

    function begin(next, what) {
      const t = now();
      if (st.kind !== 'idle' && (st.kind !== next.kind || st.kind === 'timer')) ctx.log(`${what} replaces the ${describe(st, t)}`);
      else if (st.kind === 'stopwatch') ctx.log(`${what} restarts the ${describe(st, t)}`);
      else ctx.log(`${what} started`);
      closePopup(true); done = null; held = false; restoreError = null;
      st = next;
      save(); arm(); emit();
      return reply();
    }

    ctx.command('state', async () => reply());

    ctx.command('start', async (a) => {
      if (!ctx.enabled()) return no(OFF_WORDS);
      a = a || {};
      let r;
      if (typeof a.text === 'string') r = core.parseDuration(a.text);
      else if (typeof a.ms === 'number') r = core.checkMs(a.ms);
      else r = { ok: false, reason: core.REASONS.junk };
      if (!r.ok) return no(r.reason);
      const label = core.cleanLabel(a.label) || r.label;   // one line, 60 chars, no control or bidi characters
      lastMs = r.ms;
      return begin(core.startTimer(now(), r.ms, label), `a ${r.label} timer`);
    });

    ctx.command('stopwatch', async () => {
      if (!ctx.enabled()) return no(OFF_WORDS);
      return begin(core.startStopwatch(now()), 'a stopwatch');
    });

    ctx.command('pause', async () => {
      if (st.kind === 'idle') return no('No timer or stopwatch is running');
      if (st.paused) return no(`The ${st.kind} is already paused`);
      st = core.pause(st, now());
      ctx.log(`paused the ${describe(st, now())}`);
      save(); arm(); emit();
      return reply();
    });

    ctx.command('resume', async () => {
      if (!ctx.enabled()) return no(OFF_WORDS);
      if (st.kind === 'idle') return no('No timer or stopwatch is running');
      if (!st.paused) return no(`The ${st.kind} is not paused`);
      st = core.resume(st, now());
      ctx.log(`resumed the ${describe(st, now())}`);
      save(); arm(); emit();
      return reply();
    });

    ctx.command('cancel', async () => {
      if (st.kind === 'idle') return no('No timer or stopwatch is running');
      ctx.log(`cancelled the ${describe(st, now())}`);
      st = { kind: 'idle' };
      save(); arm(); emit();
      return reply();
    });

    ctx.command('add', async (a) => {
      if (!ctx.enabled()) return no(OFF_WORDS);
      const ms = a && a.ms;
      if (typeof ms !== 'number' || !isFinite(ms) || !ms) return no('Say how much time to add (ms)');
      if (st.kind !== 'timer') return no('Only a running or paused timer can take more time');
      const before = core.leftMs(st, now());
      st = core.addTime(st, now(), ms);
      const after = core.leftMs(st, now());
      ctx.log(`${ms > 0 ? 'added' : 'took off'} ${core.labelFor(Math.abs(after - before))}: ${describe(st, now())}`);
      save(); arm(); emit();
      return reply();
    });

    ctx.command('dismiss', async () => {
      const had = !!done;
      closePopup(true); done = null; held = false;
      if (had) ctx.log('the done pop-up was dismissed');
      emit();
      return reply({ dismissed: had });
    });

    ctx.command('again', async () => {
      if (!ctx.enabled()) return no(OFF_WORDS);
      const ms = (done && done.totalMs) || lastMs;
      if (!ms) return no('There is no finished timer to run again');
      const label = done && done.label ? done.label : core.labelFor(ms);
      lastMs = ms;
      return begin(core.startTimer(now(), ms, label), `again: a ${core.labelFor(ms)} timer`);
    });

    ctx.command('chime', async (a) => {
      a = a || {};
      if (!done) return no('There is no done pop-up');
      if (a.muted) { done.sound = 'muted'; done.soundReason = String(a.reason || 'muted'); }
      else if (a.ok) { done.sound = 'played'; done.soundReason = null; }
      else {
        done.sound = 'failed'; done.soundReason = words(a.reason);
        ctx.log(`the chime did not play (${done.soundReason})`);
        beep('the chime did not play');
      }
      emit();
      return reply();
    });

    ctx.onEnabled((on) => {
      if (!on) {
        if (st.kind !== 'idle') ctx.log(`switched off in the tray: cancelled the ${describe(st, now())}`);
        st = { kind: 'idle' };
        closePopup(); done = null; held = false;
        save(); arm();
      }
      emit();
    });

    /* ---- test hooks (--test only) ---- */
    const hooks = test ? {
      now(fn) { fakeNow = typeof fn === 'function' ? fn : null; arm(); return view(); },
      fire() {
        if (st.kind !== 'timer' || st.paused) return no('No running timer to end');
        finish({ label: st.label, totalMs: st.totalMs, endAt: now(), whileOff: false });
        return view();
      },
      view,
      popup() { return popup && !popup.isDestroyed() ? popup : null; },
      restore(s) { closePopup(); done = null; held = false; runRestore(s); return view(); },
      beeps() { return beeps; },
      setResting(why) { hub.setResting(why); return view(); },
    } : null;
    if (hooks) hub.test.timer = hooks;

    return {
      stop() {
        stopped = true;
        disarm();
        closePopup();
        try { unhub(); } catch (_) { /* gone */ }
        if (unpower) unpower();
        if (hooks && hub.test.timer === hooks) delete hub.test.timer;
      },
    };
  },
};
