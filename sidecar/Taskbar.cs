// Taskbar.cs - getting the Windows taskbar out of the way, and reserving screen
// space for ours, in ways that SURVIVE OUR OWN DEATH.
//
// ============================ READ THIS FIRST ==============================
//
// THE INCIDENT (2026-09-21, the first live run). This file used to do
// ShowWindow(Shell_TrayWnd, SW_HIDE), with a 1 s watcher that re-hid the bar
// whenever explorer showed it again, and ShowWindow(SW_SHOW) on the way out.
// Owen's taskbar is set to AUTO-HIDE. Mantle was killed - so the SW_SHOW never
// ran - and even when it did, SW_SHOW is meaningless to an auto-hide taskbar:
// explorer's auto-hide state machine had been left mid-flight and stayed stuck
// hidden. Hovering the screen edge did nothing. He had to REBOOT, in the middle
// of his work. His words: "dont ever let that happen again."
//
// THE RULE that came out of it, and it is absolute:
//
//   NEVER call ShowWindow or SetWindowPos on Shell_TrayWnd or
//   Shell_SecondaryTrayWnd. Not to hide it, not to show it, not to "fix" it.
//
// More generally: MANTLE MAY NOT HOLD ANY SHELL STATE THAT NEEDS A LIVING
// PROCESS TO UNDO. A killed Mantle - killed any way, at any moment - must leave
// Windows exactly as usable as it found it. So both jobs below are done through
// the OS's own app bar protocol:
//
//   Taskbar   SHAppBarMessage(ABM_SETSTATE, ABS_AUTOHIDE). This is the same
//             switch as Settings > Personalisation > Taskbar > "Automatically
//             hide the taskbar". If Mantle dies holding it, the user has an
//             auto-hide taskbar: a completely normal Windows that reveals its
//             bar on a hover at the screen edge. Nothing is stuck, nothing
//             needs us. The original state is read FIRST and written to the
//             state file (State.cs) so a recovery script - or Owen by hand -
//             can put it back without Mantle running at all.
//
//   AppBars   SHAppBarMessage(ABM_NEW/ABM_QUERYPOS/ABM_SETPOS) registers OUR
//             bar window as a real app bar. Explorer then keeps maximised
//             windows clear of it, and - the part that matters - EXPLORER DROPS
//             THE RESERVATION ITSELF THE MOMENT THE WINDOW DIES. That is why
//             this replaced SPI_SETWORKAREA, which is a global setting that
//             survives the process that set it and left the desktop wrong.
//
// WorkArea below is now a read-only capture plus a reset, kept purely as belt
// and braces for a machine that an older build already shrank.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Mantle {

  /// The Windows taskbar's auto-hide state. Nothing here touches a window
  /// handle: every call goes through Explorer's own app bar protocol.
  static class Taskbar {
    /// True once WE have set ABS_AUTOHIDE on a taskbar that did not have it.
    /// The restore path only undoes what we actually did - if Owen's taskbar
    /// was already auto-hide (it is), Mantle must not "restore" it to visible.
    public static bool ChangedByUs { get; private set; }

    /// The state we found at startup, captured before anything was touched.
    public static int OriginalState { get; private set; }
    static bool _captured;

    /// ABM_GETSTATE is passive-safe: it reads, it never writes. Runs at startup
    /// in every mode, including --passive.
    public static int GetState() {
      var abd = new Win32.APPBARDATA();
      abd.cbSize = (uint)Marshal.SizeOf(typeof(Win32.APPBARDATA));
      // ABM_GETSTATE returns the state bits as its RESULT. Zero is a valid
      // answer (a normal always-visible taskbar), not a failure code.
      return (int)Win32.SHAppBarMessage(Win32.ABM_GETSTATE, ref abd).ToInt64();
    }

    public static bool IsAutohide(int state) { return (state & Win32.ABS_AUTOHIDE) != 0; }

    /// Read the original once, at startup, before anything changes it.
    public static void CaptureOriginal() {
      if (_captured) return;
      OriginalState = GetState();
      _captured = true;
    }

    /// The handle ABM_SETSTATE is conventionally given. It is NOT touched - no
    /// ShowWindow, no SetWindowPos, ever (see the incident above); Explorer
    /// only wants to know which app bar is asking, and the taskbar is its own.
    static IntPtr TrayHandle() {
      return Win32.FindWindowW("Shell_TrayWnd", null);
    }

    static bool SetState(int state) {
      var abd = new Win32.APPBARDATA();
      abd.cbSize = (uint)Marshal.SizeOf(typeof(Win32.APPBARDATA));
      abd.hWnd = TrayHandle();
      abd.lParam = new IntPtr(state);   // ABM_SETSTATE takes the bits in lParam
      Win32.SHAppBarMessage(Win32.ABM_SETSTATE, ref abd);
      // SHAppBarMessage's return for ABM_SETSTATE is not documented as a
      // success flag, so we never trust it: the caller reads the state back.
      return true;
    }

    /// Put the taskbar into auto-hide. Returns null on success, or plain words.
    /// Sets `wasAutohide` (it already was, so we changed nothing) and
    /// `verified` (we read the bit back and it is really there).
    public static string SetAutohide(out bool wasAutohide, out bool verified, out string reason) {
      CaptureOriginal();
      int before = GetState();
      wasAutohide = IsAutohide(before);
      verified = false;
      reason = null;

      if (wasAutohide) {
        // Nothing to do, and nothing to undo later. This is Owen's machine:
        // his taskbar is already auto-hide, so the live path below never runs
        // for him and Mantle holds no taskbar state at all.
        verified = true;
        reason = "was already auto-hide";
        Program.Emit(Json.Obj("ev", "taskbar", "autohide", true, "reason", reason));
        return null;
      }

      // Keep every other bit (ABS_ALWAYSONTOP in particular) exactly as found:
      // ABM_SETSTATE replaces the whole state, so an OR is the only safe form.
      SetState(before | Win32.ABS_AUTOHIDE);

      int after = GetState();
      verified = IsAutohide(after);
      if (!verified) {
        // Change nothing else, claim nothing. The caller reports ok:false and
        // the UI says the taskbar is still there, which is the truth.
        return "Windows did not take the auto-hide setting (ABM_SETSTATE ran, " +
               "but ABM_GETSTATE still reports state " + after + "). The taskbar " +
               "is unchanged; nothing was hidden.";
      }

      ChangedByUs = true;
      ShellState.SetAutohideChanged(true);
      reason = "set by Mantle";
      Program.Emit(Json.Obj("ev", "taskbar", "autohide", true, "reason", reason));
      return null;
    }

    /// Put the taskbar back the way we found it - ONLY if we changed it.
    public static string Restore(out bool restored, out bool changedByUs, out int state, out bool verified) {
      changedByUs = ChangedByUs;
      restored = false;
      verified = false;

      if (!ChangedByUs) {
        // The honest answer: there is nothing to restore, and pretending to
        // restore would mean turning OFF an auto-hide taskbar the user chose.
        state = GetState();
        verified = true;
        Program.Emit(Json.Obj("ev", "taskbar", "autohide", IsAutohide(state),
          "reason", "restore: Mantle never changed the taskbar, so it was left alone"));
        return null;
      }

      SetState(OriginalState);
      state = GetState();
      verified = state == OriginalState;
      restored = verified;
      if (verified) ChangedByUs = false;
      ShellState.SetAutohideChanged(ChangedByUs);
      Program.Emit(Json.Obj("ev", "taskbar", "autohide", IsAutohide(state),
        "reason", verified
          ? "restore: put back the state Mantle found (" + OriginalState + ")"
          : "restore FAILED: asked for state " + OriginalState + ", Windows reports " + state));
      if (!verified)
        return "the taskbar state did not go back (asked for " + OriginalState +
               ", Windows reports " + state + "). It is an auto-hide taskbar, " +
               "which still works - hover the screen edge, or turn auto-hide off " +
               "in Settings > Personalisation > Taskbar.";
      return null;
    }

    /// Exit path. Must work from any thread, must never throw, must never
    /// depend on a message loop. Returns plain words for the restore event.
    public static string RestoreForExit() {
      try {
        if (!ChangedByUs) return "taskbar: untouched by Mantle, left alone";
        bool restored, changed, verified;
        int state;
        string err = Restore(out restored, out changed, out state, out verified);
        if (err != null) return "taskbar: " + err;
        return "taskbar: auto-hide removed, back to state " + state;
      } catch (Exception ex) {
        return "taskbar: restore threw (" + ex.Message + "); it is an auto-hide taskbar, which still works";
      }
    }
  }

  /// Screen space for Mantle's own bar, reserved the way Explorer expects.
  ///
  /// The whole reason this exists instead of SPI_SETWORKAREA: an app bar
  /// reservation is tied to a WINDOW. Kill Mantle and Explorer reclaims the
  /// space by itself, with no cleanup code of ours needing to run.
  static class AppBars {
    /// hwnd -> registered. ABM_NEW exactly once per window; every later call
    /// for the same window is a re-position (ABM_QUERYPOS + ABM_SETPOS).
    static readonly Dictionary<long, bool> _registered = new Dictionary<long, bool>();
    /// hwnd -> the shell window (Progman) when it registered: a different one now = Explorer restarted.
    static readonly Dictionary<long, IntPtr> _shellAt = new Dictionary<long, IntPtr>();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();

    public static List<string> Hwnds() {
      var list = new List<string>();
      foreach (KeyValuePair<long, bool> kv in _registered) list.Add(kv.Key.ToString());
      return list;
    }

    /// The primary monitor's FULL bounds (not its work area: the work area
    /// already has other app bars subtracted, and we want to position against
    /// the physical screen).
    static Win32.RECT PrimaryMonitor() {
      var pt = new Win32.POINT();
      pt.x = 0; pt.y = 0;
      IntPtr mon = Win32.MonitorFromPoint(pt, Win32.MONITOR_DEFAULTTOPRIMARY);
      var mi = new Win32.MONITORINFO();
      mi.cbSize = (uint)Marshal.SizeOf(typeof(Win32.MONITORINFO));
      if (mon != IntPtr.Zero && Win32.GetMonitorInfoW(mon, ref mi)) return mi.rcMonitor;

      // Fallback, and it SAYS SO rather than silently using different numbers.
      Program.EmitLog("warn", "could not read the primary monitor bounds (GetMonitorInfoW said no); " +
                              "falling back to GetSystemMetrics screen size");
      var r = new Win32.RECT();
      r.left = 0; r.top = 0;
      r.right = Win32.GetSystemMetrics(Win32.SM_CXSCREEN);
      r.bottom = Win32.GetSystemMetrics(Win32.SM_CYSCREEN);
      return r;
    }

    /// Reserve `size` px along `edge` of the primary monitor for `hwnd`.
    /// Returns null on success with `rc` filled: the rect the caller must move
    /// its window to. Positioning the window is NOT done here - that belongs to
    /// the process that owns the window.
    ///
    /// DPI: PHYSICAL PIXELS, and that is load-bearing. SHAppBarMessage is not
    /// DPI-virtualised (measured: ABM_GETTASKBARPOS answers physical even to a
    /// DPI-unaware process), so feeding it a virtualised rect put Mantle's bar
    /// 200 px too high and 80% wide on the first live run. Program.InitDpi
    /// makes this process DPI-aware so GetMonitorInfo and SHAppBarMessage agree.
    /// The caller positions its window in DIPs and must therefore DIVIDE this
    /// rect by the display's scale factor; `ping` reports dpiAware:true so it
    /// knows to.
    public static string Reserve(IntPtr hwnd, string edge, int size, out Win32.RECT rc, out bool isNew) {
      rc = new Win32.RECT();
      isNew = false;
      if (hwnd == IntPtr.Zero) return "appbar needs hwnd as a decimal string, e.g. \"131862\"";
      if (!Win32.IsWindow(hwnd)) return "window " + hwnd.ToInt64() + " no longer exists, so no space can be reserved for it";
      if (size <= 0) return "appbar needs size:<px> greater than 0";

      uint uEdge;
      if (edge == "top") uEdge = Win32.ABE_TOP;
      else if (edge == "bottom" || string.IsNullOrEmpty(edge)) uEdge = Win32.ABE_BOTTOM;
      else return "appbar edge must be \"bottom\" or \"top\" (got \"" + edge + "\"); left and right are not supported";

      long key = hwnd.ToInt64();
      var abd = new Win32.APPBARDATA();
      abd.cbSize = (uint)Marshal.SizeOf(typeof(Win32.APPBARDATA));
      abd.hWnd = hwnd;
      abd.uCallbackMessage = Win32.WM_APPBAR_CALLBACK;
      abd.uEdge = uEdge;

      // EXPLORER RESTARTED since this window registered (lane mantle-crash, 2026-10-15): the new Explorer
      // has no record of it, so QUERYPOS/SETPOS alone would reserve nothing and maximised windows would
      // slide under the bar. The shell window (Progman) is new after every Explorer start: register again.
      IntPtr shellNow = GetShellWindow();
      IntPtr shellThen;
      if (_registered.ContainsKey(key) && _shellAt.TryGetValue(key, out shellThen) &&
          shellNow != IntPtr.Zero && shellThen != shellNow) {
        _registered.Remove(key);
        _shellAt.Remove(key);
        Program.EmitLog("info", "app bar " + key + ": Explorer restarted since it was registered (the shell window changed), so it is registered again");
      }

      if (!_registered.ContainsKey(key)) {
        if (Win32.SHAppBarMessage(Win32.ABM_NEW, ref abd) == IntPtr.Zero)
          return "Windows refused to register the bar as an app bar (ABM_NEW failed), so no screen space is reserved";
        _registered[key] = true;
        _shellAt[key] = shellNow;
        isNew = true;
        ShellState.AddAppBar(key);
      }

      Win32.RECT mon = PrimaryMonitor();
      abd.rc = mon;
      if (uEdge == Win32.ABE_BOTTOM) abd.rc.top = mon.bottom - size;
      else abd.rc.bottom = mon.top + size;

      // ABM_QUERYPOS lets Explorer push the rect away from bars that are
      // already there; the height is then re-applied, because QUERYPOS may
      // move the edge but does not preserve our thickness.
      Win32.SHAppBarMessage(Win32.ABM_QUERYPOS, ref abd);
      if (uEdge == Win32.ABE_BOTTOM) abd.rc.top = abd.rc.bottom - size;
      else abd.rc.bottom = abd.rc.top + size;

      Win32.SHAppBarMessage(Win32.ABM_SETPOS, ref abd);
      rc = abd.rc;
      return null;
    }

    /// Give the space back. Explorer would do this by itself when the window
    /// dies; doing it explicitly just makes a clean quit instant.
    public static string Remove(IntPtr hwnd, out bool removed) {
      removed = false;
      if (hwnd == IntPtr.Zero) return "appbar needs hwnd as a decimal string, e.g. \"131862\"";
      long key = hwnd.ToInt64();
      if (!_registered.ContainsKey(key))
        return "window " + key + " is not registered as an app bar, so there is nothing to remove";
      var abd = new Win32.APPBARDATA();
      abd.cbSize = (uint)Marshal.SizeOf(typeof(Win32.APPBARDATA));
      abd.hWnd = hwnd;
      Win32.SHAppBarMessage(Win32.ABM_REMOVE, ref abd);
      _registered.Remove(key);
      _shellAt.Remove(key);
      ShellState.RemoveAppBar(key);
      removed = true;
      return null;
    }

    /// Exit path: never throws, tries every bar even if one fails.
    public static string RemoveAllForExit() {
      int n = 0, failed = 0;
      try {
        var keys = new List<long>(_registered.Keys);
        foreach (long key in keys) {
          try {
            var abd = new Win32.APPBARDATA();
            abd.cbSize = (uint)Marshal.SizeOf(typeof(Win32.APPBARDATA));
            abd.hWnd = new IntPtr(key);
            Win32.SHAppBarMessage(Win32.ABM_REMOVE, ref abd);
            n++;
          } catch (Exception) { failed++; }
          _registered.Remove(key);
          _shellAt.Remove(key);
          ShellState.RemoveAppBar(key);
        }
      } catch (Exception ex) {
        return "app bars: cleanup threw (" + ex.Message + "); Explorer reclaims the space when the window dies anyway";
      }
      if (n == 0 && failed == 0) return "app bars: none were registered";
      return "app bars: " + n + " removed" + (failed > 0 ? ", " + failed + " failed (Explorer reclaims those when the window dies)" : "");
    }
  }

  /// The global work area. Mantle NO LONGER SETS THIS - see the header: a
  /// global setting outlives the process that made it, which is the whole class
  /// of bug this file exists to avoid. What remains is the original capture
  /// (for the state file and for a recovery script) and a reset, so a machine
  /// left wrong by an older build can be put right.
  static class WorkArea {
    static Win32.RECT _original;
    static bool _captured;

    public static void CaptureOriginal() {
      if (_captured) return;
      _original = Current();
      _captured = true;
    }

    public static Win32.RECT Original { get { return _original; } }

    /// SPI_GETWORKAREA: passive-safe, runs at startup in every mode.
    public static Win32.RECT Current() {
      var r = new Win32.RECT();
      Win32.SystemParametersInfoW(Win32.SPI_GETWORKAREA, 0, ref r, 0);
      return r;
    }

    /// Belt and braces: put the work area back to what it was when this sidecar
    /// started. Safe to run at any time - the value is the one we read, not a
    /// guess at the screen size.
    public static Win32.RECT Reset() {
      var r = _original;
      if (!_captured || r.right <= r.left || r.bottom <= r.top)
        throw new InvalidOperationException(
          "the original work area was never captured, so there is nothing to reset to");
      if (!Win32.SystemParametersInfoW(Win32.SPI_SETWORKAREA, 0, ref r, Win32.SPIF_SENDCHANGE))
        throw new InvalidOperationException("Windows refused the work-area reset (SPI_SETWORKAREA failed)");
      return Current();
    }
  }
}
