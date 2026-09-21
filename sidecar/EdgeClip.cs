// EdgeClip.cs - `edgeclip`: keep Explorer's auto-hidden taskbar DOWN so
// Mantle's bar can float as an inset island.
//
// THE MEASURED FACT THIS IS BUILT ON (live probe, 2026-09-21): an auto-hidden
// taskbar pops up when the cursor reaches the very bottom row of the screen -
// its hidden sliver lives in the last 2 px. Confine the cursor to stop 2 px
// short of that edge and the taskbar never appears, without hiding it, moving
// it, or changing a single thing Explorer owns. Compare that with what the
// sidecar used to do: ShowWindow on Shell_TrayWnd, which on 2026-09-21 left the
// taskbar stuck hidden and cost a reboot. This touches only the CURSOR - but a
// clip is NOT free of that danger either, which the next paragraph is about.
//
// WHY IT HAS TO BE RE-APPLIED. Windows drops any cursor clip on every
// foreground change, on lock, on UAC and on Ctrl+Alt+Del - deliberately, so an
// app cannot trap the pointer. So this is not "set it once": it is a
// EVENT_SYSTEM_FOREGROUND hook (on the thread that already pumps, ~150 ms after
// the change so the new window has settled) plus a 1 s backstop timer for the
// cases no event covers.
//
// A CLIP OUTLIVES ITS PROCESS (measured 2026-09-21: a child was clipped to
// 0,0,1920,1078, force-killed, and the clip stayed until another process
// released it). That is the whole reason this file recognises a clip BY ITS
// SHAPE rather than by remembering that we set it:
//
//   * a clip that is the monitor rect with only the bottom pulled in by 1..8 px
//     is a MANTLE clip - ours, or a stale one left by a Mantle that died badly.
//     We take it over instead of yielding to it, or the feature would be dead
//     until a reboot.
//   * the sidecar releases exactly that shape at startup (non-passive) and
//     says so on stderr, because finding one means a previous instance skipped
//     its safety path.
//   * the safety path releases only that shape. A game's own clip is never
//     ours to clear, however much it looks like something is stuck.
//
// WHERE IT YIELDS, and these are not optional. A cursor clip is the rudest
// thing in this whole protocol, so it gives way to anything that wants the
// pointer more than we do:
//
//   another app already confined it  a game, a remote-desktop window, a drag
//                                    operation. If the current clip is smaller
//                                    than the monitor and it is not ours, we
//                                    do not touch it.
//   a full-screen window is in front  a game does not want its pointer fenced
//                                    2 px above the edge; we release ours.
//   more than one monitor             a clip is ONE rectangle over the whole
//                                    virtual desktop, so clipping the primary
//                                    would wall the second screen off entirely.
//                                    Refused outright until it is done properly.
//
// Every yield and every resume is SAID on the wire ({"ev":"edgeclip",...}),
// once per change: a bar whose island behaviour quietly stopped working is
// exactly the silent failure this project does not allow.
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mantle {
  static class EdgeClip {
    public const int MinInset = 1;
    public const int MaxInset = 8;
    const int SettleMs = 150;     // after a foreground change, before re-applying
    const int BackstopMs = 1000;

    public const string MultiMonitorReason = "multi-monitor edge clip not supported yet";

    static bool _on;
    static int _inset = 2;
    static bool _applied;
    static string _reason = "";
    static Win32.WinEventProc _proc;   // static: the GC must never collect a live hook proc
    static IntPtr _hook = IntPtr.Zero;
    static Timer _settle, _backstop;

    public static bool On { get { return _on; } }
    public static bool Applied { get { return _applied; } }
    public static string Reason { get { return _reason; } }

    // ------------------------------------------------------- the pure maths

    /// monitor rect + inset -> the rect that would be clipped. No Win32, no
    /// state: this is the whole geometry of the feature, and `dryRun` hands it
    /// to the test suite so the arithmetic is proven without confining
    /// anybody's cursor.
    public static Win32.RECT Compute(Win32.RECT monitor, int inset, out int usedInset) {
      usedInset = inset < MinInset ? MinInset : (inset > MaxInset ? MaxInset : inset);
      Win32.RECT r = monitor;
      r.bottom = monitor.bottom - usedInset;
      return r;
    }

    /// The SHAPE this feature sets: the monitor rect with only the bottom
    /// pulled in by 1..MaxInset px. Recognising it by shape, not by a flag we
    /// set, is what lets a fresh sidecar take over (or clear) a clip left
    /// behind by a Mantle that died - a clip survives its process.
    public static bool IsMantleShaped(Win32.RECT clip, Win32.RECT mon) {
      if (clip.left != mon.left || clip.top != mon.top || clip.right != mon.right) return false;
      int inset = mon.bottom - clip.bottom;
      return inset >= MinInset && inset <= MaxInset;
    }

    /// The PRIMARY monitor's full rect (not its work area) in physical pixels,
    /// plus how many monitors this desktop has.
    public static string PrimaryRect(out Win32.RECT monitor, out int monitors) {
      monitor = new Win32.RECT();
      monitors = Win32.GetSystemMetrics(Win32.SM_CMONITORS);
      var origin = new Win32.POINT();
      IntPtr mon = Win32.MonitorFromPoint(origin, Win32.MONITOR_DEFAULTTOPRIMARY);
      if (mon == IntPtr.Zero) return "edgeclip: the primary monitor could not be identified";
      var mi = new Win32.MONITORINFO();
      mi.cbSize = (uint)Marshal.SizeOf(typeof(Win32.MONITORINFO));
      if (!Win32.GetMonitorInfoW(mon, ref mi))
        return "edgeclip: GetMonitorInfo failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
      monitor = mi.rcMonitor;
      return null;
    }

    // ------------------------------------------------------------- the verbs

    /// Turn it on and apply immediately. `applied` is the state RIGHT NOW,
    /// which may be false with a reason (a game is up, two monitors) while
    /// still being on - the hook will apply it the moment that changes.
    public static string TurnOn(int inset, out bool applied, out string reason) {
      int used;
      Compute(new Win32.RECT(), inset, out used);
      _inset = used;
      _on = true;

      if (_hook == IntPtr.Zero) {
        _proc = OnForeground;
        // ONE event, not a range: the only thing that matters here is "the
        // foreground changed, so the system just dropped our clip".
        _hook = Win32.SetWinEventHook(Win32.EVENT_SYSTEM_FOREGROUND, Win32.EVENT_SYSTEM_FOREGROUND,
                                      IntPtr.Zero, _proc, 0, 0, Win32.WINEVENT_OUTOFCONTEXT);
        if (_hook == IntPtr.Zero)
          Program.EmitLog("warn", "edgeclip: the foreground hook could not be installed, so the clip is " +
                                  "only re-applied by the 1s backstop and the taskbar may flash up briefly");
      }
      if (_backstop == null) {
        _backstop = new Timer();
        _backstop.Interval = BackstopMs;
        _backstop.Tick += OnBackstop;
      }
      _backstop.Start();

      Apply();
      applied = _applied;
      reason = _reason;
      return null;
    }

    /// Release, but ONLY our own clip: if something else has taken the cursor
    /// since, clearing it would be us breaking their app instead of the other
    /// way round.
    public static bool TurnOff(out string reason) {
      _on = false;
      StopWatchers();
      bool released = ReleaseOwnClip();
      reason = released
        ? "the cursor clip was released"
        : "no Mantle-shaped cursor clip was in place, so nothing was released (another app's clip is never cleared here)";
      Say(false, reason);
      return released;
    }

    /// The shutdown path: identical work, NO STDOUT. Called before anything is
    /// written, like every other restore step - a cursor the user cannot move
    /// to the bottom of their screen is precisely the "Windows looks broken"
    /// class of failure this sidecar exists to avoid.
    public static bool ReleaseForExit() {
      _on = false;
      StopWatchers();
      bool released = ReleaseOwnClip();
      _applied = false;
      return released;
    }

    static void StopWatchers() {
      try { if (_hook != IntPtr.Zero) Win32.UnhookWinEvent(_hook); } catch (Exception) { }
      _hook = IntPtr.Zero;
      _proc = null;
      try { if (_settle != null) { _settle.Stop(); _settle.Dispose(); } } catch (Exception) { }
      _settle = null;
      try { if (_backstop != null) { _backstop.Stop(); _backstop.Dispose(); } } catch (Exception) { }
      _backstop = null;
    }

    /// Releases the clip ONLY IF IT HAS MANTLE'S SHAPE. Never by remembering
    /// that we set one (a stale clip from a dead instance has to be clearable
    /// too), and never anything else (a game's clip is not ours to touch).
    static bool ReleaseOwnClip() {
      try {
        Win32.RECT mon;
        int monitors;
        if (PrimaryRect(out mon, out monitors) != null) return false;
        Win32.RECT cur;
        if (!Win32.GetClipCursor(out cur)) return false;
        if (!IsMantleShaped(cur, mon)) return false;
        return Win32.ClipCursorRelease(IntPtr.Zero);
      } catch (Exception) {
        return false;
      }
    }

    /// Run once at startup, in non-passive mode only. A Mantle-shaped clip
    /// already in place before this process has done anything means a previous
    /// Mantle died without its safety path, and the cursor has been fenced ever
    /// since. Returns the line to print, or null when there was nothing to do.
    public static string ClearStaleAtStartup() {
      Win32.RECT mon;
      int monitors;
      if (PrimaryRect(out mon, out monitors) != null) return null;
      Win32.RECT cur;
      if (!Win32.GetClipCursor(out cur)) return null;
      if (!IsMantleShaped(cur, mon)) return null;
      string where = cur.left + "," + cur.top + "," + cur.right + "," + cur.bottom;
      bool ok;
      try { ok = Win32.ClipCursorRelease(IntPtr.Zero); } catch (Exception) { ok = false; }
      return (ok ? "released a stale cursor clip (" : "FAILED to release a stale cursor clip (") + where +
             ") left behind by an earlier Mantle that did not run its safety path";
    }

    // ------------------------------------------------------------ the keeping

    static void OnForeground(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (!_on) return;
      // Hook procs must return in microseconds, and the new window has not
      // finished arranging itself yet, so this only arms a short timer.
      if (_settle == null) {
        _settle = new Timer();
        _settle.Interval = SettleMs;
        _settle.Tick += OnSettle;
      }
      _settle.Stop();      // restart the wait: a burst of switches settles once
      _settle.Start();
    }

    static void OnSettle(object sender, EventArgs e) {
      try { if (_settle != null) _settle.Stop(); } catch (Exception) { }
      Apply();
    }

    static void OnBackstop(object sender, EventArgs e) { Apply(); }

    /// Decide and act. Runs on the message-loop thread only.
    static void Apply() {
      if (!_on) return;

      Win32.RECT mon;
      int monitors;
      string err = PrimaryRect(out mon, out monitors);
      if (err != null) { Say(false, err); return; }
      if (monitors > 1) { ReleaseOwnClip(); Say(false, MultiMonitorReason); return; }

      Win32.RECT cur;
      if (!Win32.GetClipCursor(out cur)) {
        Say(false, "the current cursor clip could not be read (Win32 error " + Marshal.GetLastWin32Error() + ")");
        return;
      }

      // BY SHAPE, not by memory: a clip of this shape is ours or a stale one
      // from a dead Mantle, and either way we take it over rather than treating
      // it as a foreign app's confinement and yielding forever.
      bool ours = IsMantleShaped(cur, mon);

      // Someone else owns the pointer: leave it completely alone.
      if (!ours && Smaller(cur, mon)) {
        Say(false, "another app has confined the cursor, so Mantle left it alone");
        return;
      }

      // A full-screen window in front wants its own pointer behaviour.
      if (Foreground.ForegroundIsFullScreen()) {
        if (ours) ReleaseOwnClip();
        Say(false, "a full-screen window is in the foreground, so the cursor was left free");
        return;
      }

      int used;
      Win32.RECT want = Compute(mon, _inset, out used);
      if (Same(cur, want)) {   // already exactly right: no Win32 call at all
        Say(true, AppliedReason(used));
        return;
      }

      if (!Win32.ClipCursor(ref want)) {
        Say(false, "ClipCursor was refused (Win32 error " + Marshal.GetLastWin32Error() + ")");
        return;
      }
      Say(true, AppliedReason(used));
    }

    static string AppliedReason(int inset) {
      return "the cursor stops " + inset + " px above the bottom edge, so the auto-hidden taskbar stays down";
    }

    /// One line per CHANGE, never per tick: this is called from a 1 s timer.
    static void Say(bool applied, string reason) {
      if (applied == _applied && reason == _reason) return;
      _applied = applied;
      _reason = reason;
      Program.Emit(Json.Obj("ev", "edgeclip", "applied", applied, "reason", reason));
    }

    static bool Same(Win32.RECT a, Win32.RECT b) {
      return a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom;
    }

    /// Strictly inside the monitor rect on any edge - which is what "somebody
    /// has confined the cursor" looks like. With no clip at all, Windows
    /// reports the whole virtual screen, so this is false.
    static bool Smaller(Win32.RECT clip, Win32.RECT mon) {
      return clip.left > mon.left || clip.top > mon.top ||
             clip.right < mon.right || clip.bottom < mon.bottom;
    }
  }
}
