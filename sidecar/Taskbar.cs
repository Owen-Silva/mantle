// Taskbar.cs - hiding Windows' own taskbar, and reserving screen space for ours.
//
// Two separate ideas live here because they are always used together:
//
//   Taskbar   ShowWindow(SW_HIDE) on Shell_TrayWnd and friends. explorer.exe
//             keeps running; only its bar goes away. This is reversible in one
//             call, which is the whole reason Mantle is a LAYER and not a
//             shell replacement.
//   WorkArea  SPI_SETWORKAREA, so maximised apps stop short of Mantle's bar
//             instead of hiding underneath it.
//
// BOTH are undone on every exit path (see Program.SafetyRestore). A crashed
// sidecar that left the taskbar hidden and the work area shrunk would look
// exactly like a broken Windows install, so restoring is not best-effort: it is
// the first thing that runs on the way out.
using System;
using System.Collections.Generic;
using System.Windows.Forms;

namespace Mantle {
  static class Taskbar {
    public static bool Hidden { get; private set; }
    static Timer _watch;

    /// Every top-level bar explorer owns: the primary one plus one per extra
    /// monitor. Re-found on every call because an explorer restart replaces
    /// them all with new HWNDs.
    static List<IntPtr> Bars() {
      var bars = new List<IntPtr>();
      IntPtr primary = Win32.FindWindowW("Shell_TrayWnd", null);
      if (primary != IntPtr.Zero) bars.Add(primary);
      Win32.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        if (Win32.GetClassName(hwnd) == "Shell_SecondaryTrayWnd") bars.Add(hwnd);
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return bars;
    }

    /// show:false hides, show:true restores. Returns the resulting hidden state.
    public static bool Set(bool show) {
      var bars = Bars();
      if (bars.Count == 0) {
        Program.EmitLog("warn", "no taskbar window found (explorer may be restarting)");
        Hidden = false;
        return false;
      }
      foreach (IntPtr h in bars) Win32.ShowWindow(h, show ? Win32.SW_SHOW : Win32.SW_HIDE);

      bool wasHidden = Hidden;
      Hidden = !show;
      if (Hidden) StartWatch(); else StopWatch();
      if (wasHidden != Hidden)
        Program.Emit(Json.Obj("ev", "taskbar", "hidden", Hidden,
          "reason", Hidden ? "hidden by request" : "shown by request"));
      return Hidden;
    }

    /// explorer re-shows its bar on all sorts of events (display change, a
    /// shell notification, Win+B). A 1 s watcher puts it back and SAYS SO, so a
    /// flapping taskbar is visible in the UI rather than a mystery.
    static void StartWatch() {
      if (_watch != null) return;
      _watch = new Timer();
      _watch.Interval = 1000;
      _watch.Tick += delegate {
        if (!Hidden) return;
        try {
          var bars = Bars();
          bool reHid = false;
          foreach (IntPtr h in bars) {
            if (Win32.IsWindowVisible(h)) { Win32.ShowWindow(h, Win32.SW_HIDE); reHid = true; }
          }
          if (reHid)
            Program.Emit(Json.Obj("ev", "taskbar", "hidden", true,
              "reason", "re-hidden: explorer showed it"));
        } catch (Exception ex) {
          Program.EmitLog("error", "taskbar watcher failed: " + ex.Message);
        }
      };
      _watch.Start();
    }

    static void StopWatch() {
      if (_watch == null) return;
      _watch.Stop();
      _watch.Dispose();
      _watch = null;
    }

    /// Exit path. Deliberately not routed through Set(): it must work from any
    /// thread, must not depend on a message loop, and must never throw.
    public static void RestoreForExit() {
      try {
        if (!Hidden) return;
        foreach (IntPtr h in Bars()) Win32.ShowWindow(h, Win32.SW_SHOW);
        Hidden = false;
      } catch (Exception) { }
    }
  }

  static class WorkArea {
    static Win32.RECT _full;        // the primary monitor, whole
    static bool _changed;           // have we touched it?

    /// Read once at startup. We rebuild from the monitor's full bounds rather
    /// than the work area we found, because the work area we found already has
    /// the Windows taskbar subtracted - and that bar is about to be hidden.
    public static void CaptureOriginal() {
      _full.left = 0;
      _full.top = 0;
      _full.right = Win32.GetSystemMetrics(Win32.SM_CXSCREEN);
      _full.bottom = Win32.GetSystemMetrics(Win32.SM_CYSCREEN);
    }

    public static Win32.RECT Current() {
      var r = new Win32.RECT();
      Win32.SystemParametersInfoW(Win32.SPI_GETWORKAREA, 0, ref r, 0);
      return r;
    }

    /// Reserve `px` at the bottom or the top of the primary monitor, or give it
    /// all back. Returns the work area Windows actually settled on.
    public static Win32.RECT Apply(int bottomPx, int topPx, bool reset) {
      var r = _full;
      if (!reset) {
        if (bottomPx > 0) r.bottom = Math.Max(_full.top + 1, _full.bottom - bottomPx);
        if (topPx > 0) r.top = Math.Min(_full.bottom - 1, _full.top + topPx);
      }
      if (!Win32.SystemParametersInfoW(Win32.SPI_SETWORKAREA, 0, ref r, Win32.SPIF_SENDCHANGE))
        throw new InvalidOperationException("Windows refused the work-area change (SPI_SETWORKAREA failed)");
      _changed = !reset;
      return Current();
    }

    public static void ResetForExit() {
      try {
        if (!_changed) return;
        var r = _full;
        Win32.SystemParametersInfoW(Win32.SPI_SETWORKAREA, 0, ref r, Win32.SPIF_SENDCHANGE);
        _changed = false;
      } catch (Exception) { }
    }
  }
}
