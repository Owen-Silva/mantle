/*
 * _timer-core.js - the timer and stopwatch's rules (lane tbtimer, 2026-09-27). PURE: no requires,
 * no clock of its own (every function takes `now`), no timers. UMD, so the same file runs in main
 * (lib/features/timer.js) and in the top bar's page (<script src="../../lib/features/_timer-core.js">
 * -> window.TimerCore), and the bar's "18:42" is drawn by the same arithmetic main fires by.
 *
 * STATE is a plain JSON object, saved as is (ctx.settings 'clock'):
 *   idle              { kind:'idle' }
 *   timer running     { kind:'timer', endAt, totalMs, label, startedAt }
 *   timer paused      { kind:'timer', paused:true, leftMs, totalMs, label, startedAt }
 *   stopwatch running { kind:'stopwatch', startAt }            (startAt = now - elapsed)
 *   stopwatch paused  { kind:'stopwatch', paused:true, elapsedMs }
 * A timer made by a snooze ("+1 min" / "+5 min" on the done pop-up) also has `of`: the length of
 * the timer it snoozes, so "Restart" runs that again and not the snooze (lane topbar-timer, 2026-09-29).
 * A running timer keeps its END (a wall-clock instant), never a countdown, so a sleep or a restart
 * cannot stretch it: restore() fires one that ended while Mantle was off.
 */
(function (root, f) {
  if (typeof module === 'object' && module.exports) module.exports = f();
  else root.TimerCore = f();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
  var MAX_MS = 24 * HOUR;
  var MIN_MS = SEC;
  var JUNK = 'Type minutes (12) or hours:minutes (1:30)';
  var ZERO = 'A timer needs at least 1 second';
  var LONG = 'A timer can run up to 24 hours';

  var UNITS = {
    h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
    m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
    s: SEC, sec: SEC, secs: SEC, second: SEC, seconds: SEC,
  };

  function fin(n) { return typeof n === 'number' && isFinite(n); }
  function idle() { return { kind: 'idle' }; }

  /** A whole-second duration, checked against the limits: the one exit of parseDuration. */
  function checked(ms) {
    if (!fin(ms) || ms < 0) return { ok: false, reason: JUNK };
    ms = Math.round(ms / SEC) * SEC;
    if (ms < MIN_MS) return { ok: false, reason: ZERO };
    if (ms > MAX_MS) return { ok: false, reason: LONG };
    return { ok: true, ms: ms, label: labelFor(ms) };
  }

  /**
   * "12" = 12 min, "2.5" = 2 min 30 s, "1:30" = 1 h 30 min (h:mm, minutes 0-59), and unit forms:
   * "45s", "10m", "10 min", "1h", "1h30", "1h 30m", "1 h 30 min". A bare number after hours means
   * minutes ("1h30"), after minutes means seconds ("2m30").
   */
  function parseDuration(text) {
    var s = String(text == null ? '' : text).trim().toLowerCase();
    if (!s) return { ok: false, reason: JUNK };
    var m = /^(\d{1,3}):(\d{1,2})$/.exec(s);
    if (m) {
      var mins = Number(m[2]);
      if (mins > 59) return { ok: false, reason: JUNK };
      return checked(Number(m[1]) * HOUR + mins * MIN);
    }
    if (/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return checked(Number(s) * MIN);
    var re = /(\d+(?:\.\d*)?|\.\d+)\s*([a-z]*)\s*,?\s*/g;
    var at = 0, total = 0, last = Infinity, parts = 0, r;
    while (at < s.length) {
      re.lastIndex = at;
      r = re.exec(s);
      if (!r || r.index !== at || r[0] === '') return { ok: false, reason: JUNK };
      at = re.lastIndex;
      var unit;
      if (r[2]) {
        unit = UNITS[r[2]];
        if (!unit) return { ok: false, reason: JUNK };
      } else {
        if (at < s.length) return { ok: false, reason: JUNK };   // only the LAST number may go bare
        unit = last === HOUR ? MIN : last === MIN ? SEC : 0;
        if (!unit) return { ok: false, reason: JUNK };
      }
      if (unit >= last) return { ok: false, reason: JUNK };      // biggest unit first, each once
      last = unit;
      total += Number(r[1]) * unit;
      parts++;
    }
    if (!parts) return { ok: false, reason: JUNK };
    return checked(total);
  }

  /** "25 min", "1 h 30 min", "45 s", "2 min 30 s", "1 h". */
  function labelFor(ms) {
    var t = Math.max(0, Math.round((fin(ms) ? ms : 0) / SEC));
    var h = Math.floor(t / 3600), mi = Math.floor((t % 3600) / 60), se = t % 60;
    var out = [];
    if (h) out.push(h + ' h');
    if (mi) out.push(mi + ' min');
    if (se || !out.length) out.push(se + ' s');
    return out.join(' ');
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** Countdown (up falsy): CEIL to whole seconds, so "0:00" shows only at the end. Stopwatch: FLOOR. */
  function formatClock(ms, up) {
    var v = fin(ms) && ms > 0 ? ms : 0;
    var t = up ? Math.floor(v / SEC) : Math.ceil(v / SEC);
    var h = Math.floor(t / 3600), mi = Math.floor((t % 3600) / 60), se = t % 60;
    return h ? h + ':' + pad(mi) + ':' + pad(se) : mi + ':' + pad(se);
  }

  /** "9:14 PM": the bar clock's own shape (ui/bar/bar.js clockText, without the seconds). Local time. */
  function timeOfDay(ms) {
    var d = new Date(fin(ms) ? ms : 0);
    var h = d.getHours(), mer = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + pad(d.getMinutes()) + ' ' + mer;
  }

  /**
   * A timer's label as it may be kept, drawn and saved: one line, at most 60 characters. Control
   * characters, line/paragraph separators and bidi overrides become spaces (a saved label with a
   * newline forged a line in mantle.log; an RLO would flip the words around it). '' = none.
   */
  function cleanLabel(s) {
    if (typeof s !== 'string' || !s) return '';
    return s.slice(0, 400).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  /** A usable `of` (a snoozed timer's ORIGINAL length, so Restart runs that again) or null. */
  function ofMs(v) { return fin(v) && v >= MIN_MS && v <= MAX_MS ? v : null; }
  /** Copy `of` from a to b when a has one (b is returned). Absent = the state has no `of` key at all. */
  function keepOf(a, b) { var o = a && ofMs(a.of); if (o) b.of = o; return b; }

  /** `of` (optional): this timer is a snooze of a timer that was `of` ms long ("Restart" runs `of`). */
  function startTimer(now, ms, label, of) {
    return keepOf({ of: of }, { kind: 'timer', endAt: now + ms, totalMs: ms, label: cleanLabel(label) || labelFor(ms), startedAt: now });
  }

  function startStopwatch(now) { return { kind: 'stopwatch', startAt: now }; }

  function running(st) { return !!st && (st.kind === 'timer' || st.kind === 'stopwatch') && !st.paused; }

  function leftMs(st, now) {
    if (!st || st.kind !== 'timer') return 0;
    return Math.max(0, st.paused ? st.leftMs : st.endAt - now);
  }

  function elapsedMs(st, now) {
    if (!st) return 0;
    if (st.kind === 'stopwatch') return Math.max(0, st.paused ? st.elapsedMs : now - st.startAt);
    if (st.kind === 'timer') return Math.max(0, st.totalMs - leftMs(st, now));
    return 0;
  }

  /** Paused copy; anything else (idle, already paused) comes back as it was. */
  function pause(st, now) {
    if (!running(st)) return st;
    if (st.kind === 'timer') return keepOf(st, { kind: 'timer', paused: true, leftMs: leftMs(st, now), totalMs: st.totalMs, label: st.label, startedAt: st.startedAt });
    return { kind: 'stopwatch', paused: true, elapsedMs: elapsedMs(st, now) };
  }

  function resume(st, now) {
    if (!st || !st.paused) return st;
    if (st.kind === 'timer') return keepOf(st, { kind: 'timer', endAt: now + st.leftMs, totalMs: st.totalMs, label: st.label, startedAt: st.startedAt });
    if (st.kind === 'stopwatch') return { kind: 'stopwatch', startAt: now - st.elapsedMs };
    return st;
  }

  /** +ms (or -ms) on a timer, running or paused; what is left stays within 0..24 h. A label that
   * was the automatic one follows the new length ("25 min" + 5 min = "30 min"); a custom one stays. */
  function addTime(st, now, ms) {
    if (!st || st.kind !== 'timer' || !fin(ms)) return st;
    var left = leftMs(st, now);
    var next = Math.min(MAX_MS, Math.max(0, left + ms));
    var total = Math.max(next, st.totalMs + (next - left));
    var label = st.label === labelFor(st.totalMs) ? labelFor(total) : st.label;
    if (st.paused) return keepOf(st, { kind: 'timer', paused: true, leftMs: next, totalMs: total, label: label, startedAt: st.startedAt });
    return keepOf(st, { kind: 'timer', endAt: now + next, totalMs: total, label: label, startedAt: st.startedAt });
  }

  /** ms until the shown second changes; null when nothing ticks (idle, paused, a timer at 0). */
  function nextTickMs(st, now) {
    if (!running(st)) return null;
    if (st.kind === 'timer') {
      var left = st.endAt - now;
      if (left <= 0) return null;
      return left - (Math.ceil(left / SEC) - 1) * SEC;
    }
    var e = Math.max(0, now - st.startAt);
    return SEC - (e % SEC);
  }

  /**
   * A saved state back after a restart -> { st, fired, reason }.
   *   nothing saved            idle
   *   junk / unknown           idle + reason
   *   a timer that ENDED       idle + fired { label, totalMs, endAt, whileOff:true } (the caller
   *                            saves the idle state at once, so a second restore cannot fire again)
   *   a timer still to run     running; paused stays paused; a stopwatch carries on
   */
  var STALE_MS = 7 * 24 * HOUR;         // a saved timer that ended longer ago than this is not "done" news
  var SW_MAX = 366 * 24 * HOUR;         // a stopwatch past a year is a broken clock or a hand-edit

  function restore(saved, now) {
    var bad = function (why) { return { st: idle(), fired: null, reason: 'the saved timer could not be read (' + why + ')' }; };
    if (saved === undefined || saved === null) return { st: idle(), fired: null, reason: null };
    if (typeof saved !== 'object' || Array.isArray(saved)) return bad('not a timer');
    if (saved.kind === 'idle') return { st: idle(), fired: null, reason: null };
    if (saved.kind === 'timer') {
      if (!fin(saved.totalMs) || saved.totalMs <= 0 || saved.totalMs > MAX_MS + HOUR) return bad('its length is missing');
      var label = cleanLabel(saved.label) || labelFor(saved.totalMs);
      var startedAt = fin(saved.startedAt) ? saved.startedAt : null;
      if (saved.paused) {
        if (!fin(saved.leftMs) || saved.leftMs < 0 || saved.leftMs > MAX_MS) return bad('its time left is missing');
        return { st: keepOf(saved, { kind: 'timer', paused: true, leftMs: saved.leftMs, totalMs: saved.totalMs, label: label, startedAt: startedAt }), fired: null, reason: null };
      }
      if (!fin(saved.endAt)) return bad('its end time is missing');
      // An end at 0, negative, or weeks back is a corrupt file or a clock that jumped: one "done
      // while Mantle was off" pop-up about it would be news of nothing (it said "ended 1:00 AM" for 1970).
      if (now - saved.endAt > STALE_MS) return { st: idle(), fired: null, reason: 'the saved timer ended more than 7 days ago (or its end time is wrong), so it was not shown as done' };
      if (saved.endAt <= now) return { st: idle(), fired: keepOf(saved, { label: label, totalMs: saved.totalMs, endAt: saved.endAt, whileOff: true }), reason: null };
      if (saved.endAt - now > MAX_MS + HOUR) return bad('it ends more than 24 hours from now; the clock may have changed');
      return { st: keepOf(saved, { kind: 'timer', endAt: saved.endAt, totalMs: saved.totalMs, label: label, startedAt: startedAt }), fired: null, reason: null };
    }
    if (saved.kind === 'stopwatch') {
      if (saved.paused) {
        if (!fin(saved.elapsedMs) || saved.elapsedMs < 0) return bad('its time is missing');
        if (saved.elapsedMs > SW_MAX) return bad('its time is more than a year');
        return { st: { kind: 'stopwatch', paused: true, elapsedMs: saved.elapsedMs }, fired: null, reason: null };
      }
      if (!fin(saved.startAt)) return bad('its start time is missing');
      if (now - saved.startAt > SW_MAX) return bad('it started more than a year ago; the clock may have changed');
      return { st: { kind: 'stopwatch', startAt: Math.min(saved.startAt, now) }, fired: null, reason: null };
    }
    return bad('unknown kind ' + JSON.stringify(String(saved.kind)).slice(0, 40));
  }

  return {
    MAX_MS: MAX_MS, MIN_MS: MIN_MS,
    REASONS: { junk: JUNK, zero: ZERO, long: LONG },
    parseDuration: parseDuration, checkMs: checked, labelFor: labelFor, cleanLabel: cleanLabel, formatClock: formatClock, timeOfDay: timeOfDay,
    startTimer: startTimer, startStopwatch: startStopwatch, pause: pause, resume: resume, addTime: addTime,
    leftMs: leftMs, elapsedMs: elapsedMs, nextTickMs: nextTickMs, restore: restore, running: running,
    ofMs: ofMs, STALE_MS: STALE_MS,
  };
}));
