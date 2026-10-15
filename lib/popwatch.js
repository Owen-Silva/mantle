'use strict';
/*
 * lib/popwatch.js -- Mantle's pop-ups close the way macOS menus do (lane mn-pop, 2026-10-12): on a
 * click anywhere outside them, and on Esc, whichever app has the keyboard.
 *
 * WHY THIS EXISTS. The bar window is focusable:false (a click on it must never take the keyboard
 * from the app Owen is in), so it never gets a blur and never sees a key, and its page's own
 * mousedown listener only sees clicks INSIDE the bar window. Nothing closed a bar pop-up when Owen
 * clicked into an app or the desktop, Esc did nothing, and an open pop-up pins the bar up (main.js
 * hoverTick), so the bar stayed up too. The live log had 138 click-opened panels, and only one
 * stayed open past 60 s: Owen closed every one by hand. The timer's "done" card and the per-app
 * volume panel are focusable:false windows too, so their pages' Escape handlers never ran.
 *
 * THE SIGNAL: the sidecar's low-level mouse hook, armed ONLY while a pop-up is open
 * (`hotkey {op:'popwatch'}`, sidecar/Hotkey.cs). Chosen over:
 *   - the foreground-change event: the bar never takes the foreground, so a click back into the
 *     app that was already in front (the usual way out) changes nothing; and when the Wi-Fi box
 *     hands the keyboard back, the foreground moves while the panel rightly stays open;
 *   - blur + cursor-outside: there is no blur on a window that never had focus;
 *   - polling the buttons (GetAsyncKeyState): a touchpad tap is a down and an up within a few ms,
 *     far inside any poll interval, so taps would be lost. It is kept as the FALLBACK below, for a
 *     sidecar that cannot watch, and says so.
 * The hook only reports a click (never swallows one), and does not exist while nothing is open.
 * Esc rides the same watch: while a pop-up is open the sidecar keeps a bare Esc from the app in
 * front (in Helm an Esc interrupts every running agent) and reports it; with no pop-up open there
 * is no hook, so Esc is never touched. A --test run watches nothing unless --test-popwatch.
 *
 * WHO USES IT: main.js (the bar's pop-ups), lib/features/timer.js and lib/features/osd.js. Each
 * open() names its pop-up and says what Esc and an outside click do; close() when it goes. The
 * newest open pop-up gets the Esc. main.js configure()s the shared watch with the sidecar; before
 * that (and in unit tests of the features) open/close only keep the list.
 *
 * SWITCHING AWAY (lane mantle-m6, backlog M6). Alt+Tab, Win+Tab, Win+D or a window that pops up by
 * itself is no click, so an open bar pop-up stayed up over the app Owen switched to. A pop-up that
 * passes `away` also closes when ANOTHER APP'S window comes to the front: while one is open the
 * foreground is read every AWAY_MS (deps.foreground = lib/raise.js foreground(), one user32 call).
 * It closes only on a change to a window that is (1) not Mantle's own (the bar's Wi-Fi box, the
 * switcher's overlay and the launcher take the keyboard on purpose) and (2) not the window that was in
 * front when the pop-up opened, so the Wi-Fi box handing the keyboard BACK to that app keeps it open
 * (the case the foreground event was rejected for above). The one switch it cannot see: back to that
 * same app from a Mantle window. A --test run reads nothing unless --test-popwatch, like the hook.
 */

const LEASE_MS = 8000;   // the sidecar drops the watch by itself this long after the last renewal
const RENEW_MS = 2500;   // so a main that hangs or dies can never leave Esc swallowed for long
const POLL_MS = 25;      // the fallback's button poll
const AWAY_MS = 150;     // the foreground read while a pop-up that closes on a switch-away is open
const AWAY_DEDUPE_MS = 1500;   // a click outside already asked it to close: the switch that follows is the same event
const VK = { left: 0x01, right: 0x02, middle: 0x04, esc: 0x1B };

/**
 * PURE: the fallback's press detector. `prev` = which keys were down at the last read ({left,
 * right, middle, esc}: bools); `raw` = GetAsyncKeyState's shorts for the same keys. A key counts as
 * PRESSED when it is down now and was not before, or when Windows' "pressed since the last read"
 * bit is set while it was up (a tap shorter than the poll). -> {down, pressed: [names]}.
 */
function detect(prev, raw) {
  const p = prev || {};
  const down = {};
  const pressed = [];
  for (const k of Object.keys(VK)) {
    const v = raw && Number.isFinite(raw[k]) ? raw[k] : 0;
    const isDown = (v & 0x8000) !== 0;
    const tapped = (v & 1) !== 0;
    down[k] = isDown;
    if ((isDown && !p[k]) || (tapped && !isDown && !p[k])) pressed.push(k);
  }
  return { down, pressed };
}

function words(err) { return String((err && err.message) || err || 'no reason given').split('\n')[0]; }

function create() {
  let deps = null;          // configure()'s: {call, log, toDip, cursor, keys, hwnd, test, testArm, timers}
  const entries = [];       // [{name, esc, outside, contains, at}], newest last
  let mode = null;          // null (not watching) | 'arming' | 'hook' | 'poll' | 'none'
  let esc = null;           // the sidecar's word on Esc: 'swallow' | 'observe' | null
  let reason = null;        // why the watch is not the sidecar's hook, when it is not
  let renewT = null;
  let pollT = null;
  let pollPrev = null;
  let said = null;          // the last mode line written, so each change is logged once
  let gen = 0;              // each arm's number: an answer for an older arm is ignored
  let counts = { clicks: 0, outside: 0, escs: 0, away: 0 };
  let awayT = null;         // the foreground read, only while an entry with `away` is open
  let fgLast;               // the last foreground hwnd read (undefined = none yet)

  const T = () => (deps && deps.timers) || { setInterval, clearInterval };
  const now = () => (deps && typeof deps.now === 'function' ? deps.now() : Date.now());
  const log = (line) => { if (deps && typeof deps.log === 'function') deps.log(line); };

  // ---- switching away (see the header): the foreground, read only while it matters
  function readFg() {
    try {
      const f = deps && typeof deps.foreground === 'function' ? deps.foreground() : null;
      return f && Number.isFinite(Number(f.hwnd)) ? { hwnd: Number(f.hwnd), mine: !!f.mine } : null;
    } catch (_) { return null; }
  }
  function awayWanted() {
    return !!deps && typeof deps.foreground === 'function' && !(deps.test && !deps.testArm) && entries.some((e) => e.away);
  }
  function syncAway() {
    if (awayWanted()) {
      if (!awayT) {
        const f = readFg();
        fgLast = f ? f.hwnd : undefined;
        awayT = T().setInterval(() => onForeground(readFg()), AWAY_MS);
        if (awayT && awayT.unref) awayT.unref();
      }
    } else if (awayT) {
      T().clearInterval(awayT);
      awayT = null;
      fgLast = undefined;
    }
  }
  /** One foreground reading ({hwnd, mine} or null when it cannot be read): every open pop-up with
      `away` that this is a switch away from closes. -> how many were asked to close. */
  function onForeground(f) {
    if (!f) return 0;                              // unreadable: a wrong close is worse than a missed one
    const changed = f.hwnd !== fgLast;
    fgLast = f.hwnd;
    let n = 0;
    for (const e of entries.slice()) {
      if (!e.away) continue;
      // the window in front when it opened, taken at the first reading that is another app's
      if (e.base === undefined) { if (!f.mine && f.hwnd) e.base = f.hwnd; continue; }
      if (!changed || f.mine || !f.hwnd || f.hwnd === e.base) continue;
      if (e.askedAt && now() - e.askedAt < AWAY_DEDUPE_MS) continue;
      e.askedAt = now();
      n++;
      counts.away++;
      call(e, e.away, 'another window came to the front');
    }
    return n;
  }

  function say(line) {
    if (line === said) return;
    said = line;
    log(line);
  }

  function stopTimers() {
    if (renewT) { T().clearInterval(renewT); renewT = null; }
    if (pollT) { T().clearInterval(pollT); pollT = null; }
    pollPrev = null;
  }

  function startPoll(why) {
    reason = why;
    if (!deps || typeof deps.keys !== 'function' || !deps.keys()) {
      mode = 'none';
      say(`pop-ups: a click outside them and Esc are NOT watched (${why}; the buttons cannot be read either), so they close only from inside`);
      return;
    }
    mode = 'poll';
    pollPrev = detect(null, deps.keys()).down;    // what is already held is not a press
    pollT = T().setInterval(pollOnce, POLL_MS);
    if (pollT && pollT.unref) pollT.unref();
    say(`pop-ups: clicks outside them are polled every ${POLL_MS} ms (${why}): a very short tap can be missed, and Esc also reaches the app in front`);
  }

  // While the sidecar's watch is being armed, the buttons are polled quietly, so a pop-up opened while
  // the sidecar is busy (just after start, on a loaded PC) is never left unwatched. The hook takes over
  // when its answer comes; only a FAILED arm turns this into the said fallback (startPoll).
  function startArmingPoll() {
    if (!deps || typeof deps.keys !== 'function') return;
    let raw = null;
    try { raw = deps.keys(); } catch (_) { raw = null; }
    if (!raw) return;
    pollPrev = detect(null, raw).down;
    pollT = T().setInterval(pollOnce, POLL_MS);
    if (pollT && pollT.unref) pollT.unref();
  }

  function stopPollTimer() {
    if (pollT) { T().clearInterval(pollT); pollT = null; }
    pollPrev = null;
  }

  function pollOnce() {
    if ((mode !== 'poll' && mode !== 'arming') || !deps) return;
    let raw = null;
    try { raw = deps.keys(); } catch (_) { raw = null; }
    if (!raw) return;
    const r = detect(pollPrev, raw);
    pollPrev = r.down;
    for (const k of r.pressed) {
      if (k === 'esc') onEsc('Esc');
      else outsideAt(safeCursor(), `a ${k} click`);
    }
  }

  function safeCursor() {
    try { return deps && typeof deps.cursor === 'function' ? deps.cursor() : null; } catch (_) { return null; }
  }

  function arm() {
    if (!deps) return;                   // not configured: the list is kept, nothing is watched
    if (deps.test && !deps.testArm) {
      mode = 'none';
      reason = 'a --test run never watches the real mouse and keyboard (--test-popwatch turns it on)';
      return;
    }
    const my = ++gen;
    mode = 'arming';
    startArmingPoll();
    Promise.resolve()
      .then(() => deps.call({ on: true, leaseMs: LEASE_MS, hwnd: hwndNow() }))
      .then((r) => {
        if (my !== gen) return;
        if (!entries.length) { disarm(); return; }
        stopPollTimer();
        mode = 'hook';
        reason = null;
        esc = (r && r.esc) || null;
        say(`pop-ups: a click outside them and Esc are watched by the sidecar while one is open (Esc ${esc === 'swallow' ? 'is kept from the app in front' : 'also reaches the app in front'})`);
        renewT = T().setInterval(renew, RENEW_MS);
        if (renewT && renewT.unref) renewT.unref();
      }, (err) => {
        // A timed-out arm may still land in the sidecar later: turn it off, so a watch main does not
        // know about can never keep Esc from the app in front (its lease would end it, but only after
        // LEASE_MS).
        // (Only for the newest arm: an older one's off would end the watch a newer arm asked for.)
        if (my !== gen) return;
        Promise.resolve().then(() => deps && deps.call({ on: false })).catch(() => { /* the lease ends it anyway */ });
        stopPollTimer();
        if (!entries.length) { mode = null; return; }
        startPoll(`the sidecar could not watch: ${words(err)}`);
      });
  }

  function hwndNow() {
    try { const h = deps && typeof deps.hwnd === 'function' ? deps.hwnd() : null; return h ? Number(h) : undefined; } catch (_) { return undefined; }
  }

  function renew() {
    if (mode !== 'hook' || !deps) return;
    const my = gen;
    Promise.resolve()
      .then(() => deps.call({ on: true, leaseMs: LEASE_MS, hwnd: hwndNow() }))
      .catch((err) => {
        if (my !== gen || mode !== 'hook') return;
        // The lease is still running out on the sidecar's side; one late renewal is not a failure.
        log(`pop-ups: the sidecar's watch was not renewed (${words(err)}); it ends by itself within ${LEASE_MS / 1000} s if this goes on`);
      });
  }

  function disarm() {
    gen++;
    const was = mode;
    stopTimers();
    mode = null;
    esc = null;
    if (was === 'hook' || was === 'arming') {
      Promise.resolve().then(() => deps && deps.call({ on: false })).catch(() => { /* the lease ends it anyway */ });
    }
  }

  function sync() {
    if (entries.length && mode === null) arm();
    else if (!entries.length && mode !== null) disarm();
    syncAway();
  }

  /** A pop-up opened. h: {esc?(how), outside?(how), contains?(ptDip) -> bool, away?(how)}. Opening
      the same name again moves it to the top (the newest gets the Esc) and keeps the window that was
      in front when it FIRST opened. */
  function open(name, h) {
    const n = String(name || 'unnamed');
    const i = entries.findIndex((e) => e.name === n);
    const was = i !== -1 ? entries[i] : null;
    if (i !== -1) entries.splice(i, 1);
    const o = h || {};
    let base;
    if (o.away) {
      if (was && was.away) base = was.base;
      else { const f = readFg(); base = f && !f.mine && f.hwnd ? f.hwnd : undefined; }
    }
    entries.push({ name: n, esc: o.esc || null, outside: o.outside || null, contains: o.contains || null, away: o.away || null, base, askedAt: 0 });
    sync();
  }

  function close(name) {
    const i = entries.findIndex((e) => e.name === String(name || 'unnamed'));
    if (i === -1) return false;
    entries.splice(i, 1);
    sync();
    return true;
  }

  function call(e, fn, how) {
    try { fn(how); } catch (err) { log(`pop-ups: closing the ${e.name} pop-up threw: ${words(err)}`); }
  }

  /** A press at `pt` (DIP, or null when it could not be read): every open pop-up it is outside of
      closes. A point that cannot be read closes nothing: a wrong close is worse than a missed one. */
  function outsideAt(pt, how) {
    counts.clicks++;
    if (!pt) return 0;
    let n = 0;
    for (const e of entries.slice()) {
      if (!e.outside) continue;
      let inside = false;
      try { inside = !!(e.contains && e.contains(pt)); } catch (_) { inside = true; }
      if (inside) continue;
      n++;
      counts.outside++;
      e.askedAt = now();
      call(e, e.outside, `${how} outside it`);
    }
    return n;
  }

  function onEsc(how) {
    counts.escs++;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e.esc) continue;
      call(e, e.esc, how);
      return e.name;
    }
    return null;
  }

  /** The sidecar's {ev:'popwatch'} events (and the test hook's made-up ones). */
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (ev.op === 'click') {
      let pt = null;
      const x = Number(ev.x), y = Number(ev.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        try { pt = deps && typeof deps.toDip === 'function' ? deps.toDip({ x, y }) : { x, y }; } catch (_) { pt = null; }
      }
      if (!pt) pt = safeCursor();
      return outsideAt(pt, `a ${ev.button || 'mouse'} click`);
    }
    if (ev.op === 'esc') return onEsc('Esc');
    if (ev.op === 'off') {
      if (ev.why === 'asked' || mode !== 'hook') return null;
      // The lease ran out (a renewal was late) or a hook failed: watch again if anything is open.
      stopTimers();
      mode = null;
      if (entries.length) {
        log(`pop-ups: the sidecar's watch ended (${String(ev.why || 'no reason given').slice(0, 120)}) with a pop-up still open; watching again`);
        arm();
      }
      return null;
    }
    return null;
  }

  function configure(d) {
    deps = d || null;
    stopTimers();
    mode = null;
    sync();
  }

  function state() {
    return { mode, esc, reason, open: entries.map((e) => e.name), clicks: counts.clicks, outside: counts.outside, escs: counts.escs,
      away: counts.away, watchingAway: !!awayT };
  }

  /** The Mantle window that holds the keyboard changed (main.js: app 'browser-window-focus'): tell
      the sidecar now, not at the next renewal, so an Esc meant for that window (the launcher, say)
      is left to it rather than taken for the bar's pop-up. */
  function refresh() { if (mode === 'hook') renew(); }

  return { configure, open, close, refresh, isOpen: (name) => entries.some((e) => e.name === name), onEvent, outsideAt, onForeground, state,
    stop: () => { entries.length = 0; disarm(); syncAway(); } };
}

const shared = create();

module.exports = Object.assign(shared, { create, detect, LEASE_MS, RENEW_MS, POLL_MS, AWAY_MS, VK });
