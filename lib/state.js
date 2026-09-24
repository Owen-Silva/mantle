'use strict';
const { EventEmitter } = require('events');

/*
 * The one honest picture of what Mantle has and has not managed to do.
 *
 * WHY this exists as a first-class object instead of scattered booleans: Owen's
 * standing rule is that nothing may fail silently, and that a log line does not
 * count -- every helper, poller and fallback has to show its state AND its reason
 * in the UI it serves. So every piece here carries a `reason` string in plain
 * words at all times, including when it is fine ("test mode: taskbar left alone"),
 * and the whole object is pushed to every window whenever any of it changes.
 * The desktop page renders every non-ok piece; the bar can render what it likes.
 *
 * Shape (the contract the bar and launcher lanes code against):
 *   mode:     'live' | 'test'
 *   sidecar:  { status: 'ok'|'starting'|'down', reason }
 *   taskbar:  { autohide: bool, wasAutohide: bool|null, hidden: bool, reason }
 *   workarea: { reserved: bool, reason }
 *   desktop:  { attached: bool, mode: string|null, reason }
 *   hotkey:   { winTap: bool, reason }
 *   tray:     { status: 'ok'|'unavailable', reason, watch: 'on'|'off', watchReason }
 *   glass:    { material: 'acrylic-blur-behind'|'none', reason }
 *   bar:      { mode: 'hover'|'dock', shape: 'pill'|'edge', revealed: bool, reason }
 *   edgeclip: { on: bool, applied: bool, reason }
 *   backdrop: { bar|launcher|desktop: { on: bool, ok: bool, fps, ms, reason } }
 *   shortcuts:{ killSwitch: bool, launcher: bool, reason }   <- addition, see below
 *   switcher: { want, page, altTab, reason, winKeys, winKeysReason, broken }  <- lib/switcher.js
 *             sets it (absent until then); `broken` is the plain words for a switch Owen left
 *             on whose feature is Windows' own anyway, else null
 *   features: { <name>: { label, on, ok, reason, keys, keysReason, broken, stopped } }
 *             <- lib/features.js, one per lib/features/<name>.js (absent until app ready).
 *             on = its tray switch; ok/reason = its own ctx.health (or why it failed to load or
 *             install); keys = its chords are Mantle's right now; broken = the words for chords
 *             that should be Mantle's and are not, else null; stopped = after its stop() ran
 *
 * `shortcuts` is NOT in the original four-lane contract. It is here because
 * globalShortcut.register() returns false when another app already owns the
 * combination (Alt+Space especially), and a kill switch that quietly failed to
 * register is exactly the kind of silent failure the rule forbids. It has the
 * same {..., reason} shape as every other piece, so generic renderers that look
 * for `.reason` handle it without knowing what it is.
 */

/*
 * WHY `taskbar` stopped being `{hidden}` (2026-09-21, after the incident).
 *
 * Mantle's first live run hid the Shell_TrayWnd window outright with
 * ShowWindow(SW_HIDE). Owen's taskbar is set to AUTO-HIDE, and hiding the window
 * of an auto-hiding taskbar wedges explorer's own state machine: showing the
 * window again does not un-wedge it. He had to REBOOT, mid-task.
 *
 * So Mantle no longer hides a window. It flips the OS-managed auto-hide flag
 * (ABM_SETSTATE) and puts the original back. `autohide` is what Mantle asked the
 * OS for; `wasAutohide` is what the OS said it was BEFORE Mantle touched it, so
 * the restore path has something true to aim at and the reason can say which of
 * the two cases this is.
 *
 * `hidden` is kept as a MIRROR of `autohide`, never set by hand -- see set()
 * below. ui/bar/bar.js (lane C) renders a "taskbar showing" chip off
 * `taskbar.hidden === false`, and the meaning carries over exactly: false still
 * means "the Windows taskbar is sitting there in front of Owen". Dropping the key
 * would have turned that chip into a silent no-op, which is the one thing the
 * no-silent-failures rule forbids. Lane C can move to `autohide` whenever it
 * likes; until then neither key can drift from the other.
 */

const PLAIN_UNKNOWN = 'not started yet';

function initialState(mode, edge) {
  return {
    mode,
    // Which screen edge the bar is pinned to, straight from --bar-edge. The bar
    // reads it to decide which way its popovers open.
    edge: edge === 'top' ? 'top' : 'bottom',
    sidecar: { status: 'starting', reason: 'sidecar has not answered yet' },
    taskbar: { autohide: false, wasAutohide: null, hidden: false, reason: PLAIN_UNKNOWN },
    workarea: { reserved: false, reason: PLAIN_UNKNOWN },
    desktop: { attached: false, mode: null, reason: PLAIN_UNKNOWN },
    hotkey: { winTap: false, reason: PLAIN_UNKNOWN },
    /*
     * `tray` carries two unrelated facts that happen to be about the same strip of
     * Windows, so each gets its OWN reason rather than sharing one and lying about
     * half of it:
     *   status/reason        -- can Mantle READ the notification area for the bar?
     *   watch/watchReason    -- has the sidecar been asked to re-raise Mantle's bar
     *                           above the Windows taskbar when that taskbar pops up
     *                           ('traywatch')? Without it the auto-hide Windows
     *                           taskbar, which answers the same bottom edge as
     *                           Mantle's hover bar, comes up ON TOP of ours.
     */
    tray: { status: 'unavailable', reason: PLAIN_UNKNOWN, watch: 'off', watchReason: PLAIN_UNKNOWN },
    /*
     * The bar's whole shape, in one piece:
     *   mode 'hover' (default) -- hidden until the cursor touches the bottom edge,
     *        reserves NO screen space, floats over the auto-hide Windows taskbar.
     *   mode 'dock'  (--dock)  -- the old app bar: a permanent reserved strip.
     *   revealed -- is the bar window on screen right now.
     *   reason   -- why it is where it is, including every reveal/hide refusal
     *        (a fullscreen foreground window, a sidecar that cannot be asked).
     */
    bar: { mode: 'hover', shape: 'pill', revealed: false, reason: PLAIN_UNKNOWN },
    /*
     * The 2 px cursor clip that keeps Windows' own auto-hide taskbar from popping
     * up through the island's gaps. `on` is whether Mantle ASKED for it, `applied`
     * whether it is in force right now -- the sidecar drops it by itself for a
     * fullscreen app or when another app claims the cursor, and says so. Only
     * on && !applied is worth a chip: off-and-not-applied is a setting, not a
     * fault.
     */
    edgeclip: { on: false, applied: false, reason: PLAIN_UNKNOWN },
    /*
     * The bar's own backdrop capture -- the picture of what is behind the bar
     * that the page blurs in CSS, because no DWM mode could be "a little bit more
     * translucent" (acrylic ignores its tint's alpha, blur-behind paints black).
     * `on` while the loop is running, `ok` false only when it gave up, so a chip
     * appears for a loop that is failing and never for one that is simply off
     * (the bar is hidden most of the time, and hidden is not broken).
     */
    /*
     * PER WINDOW, because the three fail independently and each has to keep its
     * own reason. The bar and the launcher run a 4 fps loop while they are on
     * screen; the desktop layer takes ONE still of the wallpaper (there is
     * nothing else behind it) and retakes it only when the display changes.
     */
    backdrop: {
      bar: { on: false, ok: true, fps: 0, ms: 0, reason: PLAIN_UNKNOWN },
      launcher: { on: false, ok: true, fps: 0, ms: 0, reason: PLAIN_UNKNOWN },
      desktop: { on: false, ok: true, fps: 0, ms: 0, reason: PLAIN_UNKNOWN },
    },
    // A real Windows blur-behind backdrop on the bar and launcher, or nothing but
    // what lane C and lane D paint in CSS. Two very different pictures, and which
    // one is on screen must never be something you have to squint to work out.
    glass: { material: 'none', reason: PLAIN_UNKNOWN },
    shortcuts: { killSwitch: false, launcher: false, reason: PLAIN_UNKNOWN },
  };
}

class ShellState extends EventEmitter {
  constructor(mode, edge) {
    super();
    this.data = initialState(mode, edge);
  }

  /** A snapshot safe to hand to IPC (structured clone would choke on getters). */
  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /**
   * Merge a patch into one piece. Emits 'change' with the whole state ONLY when
   * something actually moved -- a poller that reports the same thing every five
   * seconds must not wake three renderers every five seconds.
   */
  set(piece, patch) {
    const before = JSON.stringify(this.data[piece]);
    this.data[piece] = Object.assign({}, this.data[piece], patch);
    // The one derived key in the whole object, mirrored HERE so no caller can
    // forget it and leave lane C's chip reading a stale boolean. See the long
    // comment above for why `hidden` still exists at all.
    if (piece === 'taskbar') this.data[piece].hidden = this.data[piece].autohide === true;
    if (JSON.stringify(this.data[piece]) === before) return false;
    this.emit('change', this.get());
    return true;
  }

  /** Every piece that is not in its healthy state, with the reason, for the strip. */
  problems() {
    const out = [];
    const d = this.data;
    if (d.sidecar.status !== 'ok') out.push({ piece: 'sidecar', reason: d.sidecar.reason });
    if (!d.taskbar.autohide) out.push({ piece: 'taskbar', reason: d.taskbar.reason });
    // In hover mode NOT reserving screen space is the whole point -- the bar is
    // hidden until the cursor asks for it, and a reserved strip would be a bug.
    // Only --dock owes a reservation, so only --dock can be missing one.
    if (d.bar.mode === 'dock' && !d.workarea.reserved) out.push({ piece: 'screen space', reason: d.workarea.reason });
    if (!d.desktop.attached) out.push({ piece: 'desktop layer', reason: d.desktop.reason });
    if (!d.hotkey.winTap) out.push({ piece: 'Win key', reason: d.hotkey.reason });
    // 'unavailable' is this Windows build's XAML notification area having no
    // ToolbarWindow32 to read: a permanent platform limit, not a fault Owen can
    // act on (the bar says so quietly in its overflow menu). ui/desktop/desktop.js
    // applies the same rule to the strip.
    if (d.tray.status !== 'ok' && d.tray.status !== 'unavailable') out.push({ piece: 'tray', reason: d.tray.reason });
    // Not armed means the Windows taskbar can surface ON TOP of Mantle's bar on
    // the shared bottom edge. Visible, with its own reason, never assumed.
    if (d.tray.watch !== 'on') out.push({ piece: 'taskbar watch', reason: d.tray.watchReason });
    // Asked for and NOT in force: the Windows taskbar can pop up through the
    // island's gaps. Never asked for is a choice, so it says nothing.
    if (d.edgeclip.on && !d.edgeclip.applied) out.push({ piece: 'edge clip', reason: d.edgeclip.reason });
    // A capture loop that GAVE UP: the bar is on screen with a flat tint instead
    // of the live blur. A loop that is simply not running is the bar being hidden.
    // A capture that GAVE UP: that window is on screen with a flat tint instead
    // of the live blur. A loop that is simply not running is the window being
    // closed, which is not a fault.
    for (const who of ['bar', 'launcher', 'desktop']) {
      const b = d.backdrop[who];
      if (b && !b.ok) out.push({ piece: `${who} backdrop`, reason: b.reason });
    }
    if (d.glass.material !== 'acrylic-blur-behind') out.push({ piece: 'window glass', reason: d.glass.reason });
    if (!d.shortcuts.killSwitch || !d.shortcuts.launcher) {
      out.push({ piece: 'shortcuts', reason: d.shortcuts.reason });
    }
    // lib/notifications.js sets this piece once it has read (absent until then).
    if (d.notifications && d.notifications.status === 'down') out.push({ piece: 'notifications', reason: d.notifications.reason });
    // Alt+Tab or Win+N / Win+A switched ON in the tray and still Windows' own: a refused hook, a
    // stale sidecar exe, a switcher page that crashed. Switched off is a choice and a test run
    // never hooks, so neither says anything (lib/switcher.js stateWords decides `broken`).
    if (d.mode !== 'test' && d.switcher && d.switcher.broken) out.push({ piece: 'Alt+Tab', reason: d.switcher.broken });
    // Each feature (lib/features/*.js) switched ON and not working: its own ctx.health, or why it
    // failed to load or start -- test mode included, because a broken feature is broken there too.
    // Or healthy with a chord the hook should hold and does not (never in a test run, which never
    // hooks). Off is a choice and stopped is Windows put back, so neither says anything.
    // ui/desktop/desktop.js applies the same rule to the strip.
    for (const name of Object.keys(d.features || {})) {
      const p = d.features[name];
      if (!p || !p.on || p.stopped) continue;
      if (p.ok === false) out.push({ piece: p.label || name, reason: p.reason || 'not working, and no reason given' });
      else if (p.broken && d.mode !== 'test') out.push({ piece: p.label || name, reason: p.broken });
    }
    return out;
  }
}

module.exports = { ShellState, initialState };
