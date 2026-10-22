'use strict';
/*
 * start-wake.js - the start-up and wake decisions main.js asks (lane mn-wake, 2026-10-12).
 *
 * The user's bar: "as reliable as macOS" -- a logon shows the finished desktop, and waking never repaints
 * the wallpaper. Each rule below is a pure function so lib/start-wake.test.js can prove it without
 * Electron, a console, a sidecar or a sleep.
 *
 *   countdownVerdict       the 3 s "Ctrl+C now" pause before a live start: only for a person at a console
 *   pingVerdict            a first ping that got no answer is asked again, never read as "old exe"
 *   desktopReshootVerdict  the desktop layer's wallpaper picture is taken again only when it changed
 */

/*
 * THE COUNTDOWN. The crash-safe redesign (0f66ec4, after the 2026-09-21 incident) prints the way out
 * (the recovery command and where the original shell state is recorded) and then pauses 3 s "so the user
 * can read the recovery line and change his mind". That pause is for a PERSON looking at a console.
 * Every live start the user actually gets -- the logon task, the `mantle` terminal command and every
 * go-live -- goes through Task Scheduler, where Electron has no console at all: nobody can read the
 * line or press Ctrl+C, the lines go to the --log file only, and the pause was 3 s of Windows' own
 * taskbar on every logon. A manual `electron . --live` in a console window still gets it.
 * The recovery lines themselves are printed either way, before anything touches the shell.
 */
const COUNTDOWN_MS = 3000;

/**
 * o = {live, tty}. tty: process.stdout.isTTY === true (a console window someone can type into).
 * -> {pause: ms (0 = none), line: the sentence to print after "mantle: ", or null (not live)}
 */
function countdownVerdict(o) {
  if (!o || !o.live) return { pause: 0, line: null };
  if (o.tty === true) {
    return { pause: COUNTDOWN_MS, line: 'starting in 3 seconds. Ctrl+C now if that was not what you meant.' };
  }
  return {
    pause: 0,
    line: 'starting now: there is no console to press Ctrl+C in (the logon task or another program started Mantle), so there is no 3 s pause; the lines above are in the log',
  };
}

/*
 * THE FIRST PING (the shell-unset item). applyLive asks the sidecar how old it is before it touches
 * the shell. lib/sidecar.js protocolAge() says current:false both for an exe that ANSWERED without the
 * current protocol (really old: rebuild it) and for a ping that got NO answer in 4 s (a loaded logon).
 * The second used to be read as the first, and the taskbar, the Win key and the desktop layer stayed
 * Windows' for the whole session. Only an answer that is too old is final; no answer is asked again
 * at 2, 5 and 15 s, and only then given up on, with the reason.
 */
const PING_RETRY_MS = [2000, 5000, 15000];

/**
 * age: protocolAge()'s {current, dpiAware, reason[, answered]}; n: how many asks came before this one.
 * -> {next: 'go' | 'old' | 'retry' | 'give-up', waitMs, reason}
 */
function pingVerdict(age, n) {
  const a = age || {};
  if (a.current) return { next: 'go', waitMs: 0, reason: a.reason || 'the sidecar speaks the current protocol' };
  // An exe that answered: its answer is the verdict. (answered is honoured if protocolAge ever says
  // it; today the old-exe sentence is the only not-current reply that came from an answer.)
  const answered = a.answered === true || (a.answered !== false && /older than the protocol/.test(String(a.reason || '')));
  if (answered) return { next: 'old', waitMs: 0, reason: a.reason || 'the sidecar exe is older than the protocol' };
  const tries = PING_RETRY_MS.length + 1;
  const why = a.reason || 'the sidecar did not answer ping';
  if (n < PING_RETRY_MS.length) {
    const ms = PING_RETRY_MS[n];
    return {
      next: 'retry',
      waitMs: ms,
      reason: `the sidecar did not answer its first ping in time, so Windows is untouched for now; asking again in ${ms / 1000} s (ask ${n + 2} of ${tries}): ${why}`,
    };
  }
  return { next: 'give-up', waitMs: 0, reason: `${why} (asked ${tries} times over ${PING_RETRY_MS.reduce((s, x) => s + x, 0) / 1000} s)` };
}

/*
 * THE DESKTOP LAYER'S WALLPAPER PICTURE (audit #9). The light panes frost a 1/8-scale screen shot of
 * what is behind the layer. Once the layer is inside Explorer's desktop it is a CHILD window, and
 * Windows will not leave a child window out of a screen capture: SetWindowDisplayAffinity fails with
 * error 87 (invalid parameter) on one, while the same call on a top-level window works (checked on
 * this machine, 2026-10-12). So the only way to photograph what is behind the attached layer is to
 * hide it, and every re-shoot is a frame with no wallpaper and no widgets. It used to run on every
 * wake and every display or work-area change, about 17 times a day.
 *
 * What it photographs only changes with the main display's PHYSICAL size (or a different main
 * display). A wake, a work-area change (a bar reserving its strip) and a scale change leave Windows'
 * wallpaper the same picture pixel for pixel, so those keep the picture and never blink.
 */
function validSize(s) {
  return !!s && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0;
}

/**
 * o = {last: {id, w, h} | null (the main display at the last GOOD picture), now: {id, w, h} | null}
 * -> {reshoot, reason}
 */
function desktopReshootVerdict(o) {
  const now = o && o.now;
  const last = o && o.last;
  if (!validSize(now)) return { reshoot: false, reason: 'the main display reported no size, so the picture it has is kept' };
  if (!validSize(last)) return { reshoot: true, reason: `there is no good picture of this display yet (${now.w}x${now.h})` };
  if (last.id != null && now.id != null && last.id !== now.id) {
    return { reshoot: true, reason: `a different display is the main one now (${now.w}x${now.h})` };
  }
  if (now.w === last.w && now.h === last.h) {
    return { reshoot: false, reason: `the main display is still ${now.w}x${now.h} physical pixels, so Windows' wallpaper is the same picture; kept, with no blink` };
  }
  return { reshoot: true, reason: `the main display went from ${last.w}x${last.h} to ${now.w}x${now.h} physical pixels` };
}

module.exports = { countdownVerdict, pingVerdict, desktopReshootVerdict, COUNTDOWN_MS, PING_RETRY_MS };
