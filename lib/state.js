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
 *   taskbar:  { hidden: bool, reason }
 *   workarea: { reserved: bool, reason }
 *   desktop:  { attached: bool, mode: string|null, reason }
 *   hotkey:   { winTap: bool, reason }
 *   tray:     { status: 'ok'|'unavailable', reason }
 *   shortcuts:{ killSwitch: bool, launcher: bool, reason }   <- addition, see below
 *
 * `shortcuts` is NOT in the original four-lane contract. It is here because
 * globalShortcut.register() returns false when another app already owns the
 * combination (Alt+Space especially), and a kill switch that quietly failed to
 * register is exactly the kind of silent failure the rule forbids. It has the
 * same {..., reason} shape as every other piece, so generic renderers that look
 * for `.reason` handle it without knowing what it is.
 */

const PLAIN_UNKNOWN = 'not started yet';

function initialState(mode, edge) {
  return {
    mode,
    // Which screen edge the bar is pinned to, straight from --bar-edge. The bar
    // reads it to decide which way its popovers open.
    edge: edge === 'top' ? 'top' : 'bottom',
    sidecar: { status: 'starting', reason: 'sidecar has not answered yet' },
    taskbar: { hidden: false, reason: PLAIN_UNKNOWN },
    workarea: { reserved: false, reason: PLAIN_UNKNOWN },
    desktop: { attached: false, mode: null, reason: PLAIN_UNKNOWN },
    hotkey: { winTap: false, reason: PLAIN_UNKNOWN },
    tray: { status: 'unavailable', reason: PLAIN_UNKNOWN },
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
    if (JSON.stringify(this.data[piece]) === before) return false;
    this.emit('change', this.get());
    return true;
  }

  /** Every piece that is not in its healthy state, with the reason, for the strip. */
  problems() {
    const out = [];
    const d = this.data;
    if (d.sidecar.status !== 'ok') out.push({ piece: 'sidecar', reason: d.sidecar.reason });
    if (!d.taskbar.hidden) out.push({ piece: 'taskbar', reason: d.taskbar.reason });
    if (!d.workarea.reserved) out.push({ piece: 'work area', reason: d.workarea.reason });
    if (!d.desktop.attached) out.push({ piece: 'desktop layer', reason: d.desktop.reason });
    if (!d.hotkey.winTap) out.push({ piece: 'Win key', reason: d.hotkey.reason });
    if (d.tray.status !== 'ok') out.push({ piece: 'tray', reason: d.tray.reason });
    if (!d.shortcuts.killSwitch || !d.shortcuts.launcher) {
      out.push({ piece: 'shortcuts', reason: d.shortcuts.reason });
    }
    return out;
  }
}

module.exports = { ShellState, initialState };
