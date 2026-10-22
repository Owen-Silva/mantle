// Foreground.cs - `foreground`: what is the user actually looking at, and is it
// covering the whole screen?
//
// The bar needs this for one decision above all others: GET OUT OF THE WAY. A
// game, a full-screen video or a presentation must not have a shell bar
// floating over it, and the only reliable signal for "this window owns the
// screen" is geometry - a window whose rect covers its monitor's ENTIRE rect
// (not the work area, the whole monitor) is full-screen, whatever it calls
// itself.
//
// THREE THINGS THAT WOULD OTHERWISE BE FALSE POSITIVES, and all three matter:
//
//   the desktop      Progman and WorkerW cover the monitor by definition. The
//                    desktop being "full-screen" would hide the bar whenever
//                    the user clicked the wallpaper.
//   the taskbar      Shell_TrayWnd / Shell_SecondaryTrayWnd: clicking the real
//                    taskbar would do the same.
//   Mantle itself    the bar, the launcher and the desktop layer all belong to
//                    the parent Electron process, and Mantle's own desktop
//                    layer is exactly monitor-sized. A shell that hides itself
//                    because it saw itself is a very confusing bug.
//
// The rect is PHYSICAL pixels, like every rect in this protocol (see
// Program.InitDpi): the process is PER_MONITOR_AWARE_V2, so GetWindowRect and
// GetMonitorInfo are in the same coordinate system and the comparison below is
// meaningful. From a DPI-unaware process it would not be.
using System;
using System.Collections;
using System.Globalization;

namespace Mantle {
  static class Foreground {
    /// Never throws and never returns null: "nothing is in the foreground" is a
    /// real answer (the lock screen, a desktop switch mid-flight) and comes
    /// back as hwnd "0" with an empty rect rather than an error.
    public static IDictionary Read() {
      IntPtr hwnd = Win32.GetForegroundWindow();
      var rect = new Win32.RECT();
      string title = "", exe = "";
      bool full = false;
      int pid = 0;

      if (hwnd != IntPtr.Zero && Win32.IsWindow(hwnd)) {
        Win32.GetWindowRect(hwnd, out rect);
        title = Win32.GetWindowText(hwnd);
        Win32.GetWindowThreadProcessId(hwnd, out pid);
        exe = Win32.GetProcessPath(pid);
        full = IsFullScreen(hwnd, rect, pid);
      }

      return Json.Obj(
        "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
        "title", title,
        "exe", exe,
        "pid", pid,
        "rect", new object[] { rect.left, rect.top, rect.right, rect.bottom },
        "fullscreen", full);
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    /// The same question EdgeClip has to ask before it confines the cursor:
    /// is the thing in front of the user covering its whole monitor? Shares
    /// ONE definition of full-screen with the `foreground` command, because two
    /// definitions would eventually disagree and the bar would hide itself
    /// while the cursor stayed clipped (or the other way round).
    public static bool ForegroundIsFullScreen() {
      IntPtr hwnd = Win32.GetForegroundWindow();
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return false;
      var r = new Win32.RECT();
      Win32.GetWindowRect(hwnd, out r);
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      return IsFullScreen(hwnd, r, pid);
    }

    static bool IsFullScreen(IntPtr hwnd, Win32.RECT r, int pid) {
      // A maximised window overhangs its monitor by the invisible resize border, so its rect
      // "covers" rcMonitor too; it is not fullscreen (the user's maximised browser must not hide the bar).
      if (IsZoomed(hwnd)) return false;
      // Shell furniture is never "full-screen" however big it is.
      string cls = Win32.GetClassName(hwnd);
      if (cls == "Progman" || cls == "WorkerW" ||
          cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return false;

      // Never Mantle's own windows: the parent Electron process owns the bar,
      // the launcher and the monitor-sized desktop layer, and this process owns
      // one hidden window.
      if (IsMantlePid(pid)) return false;

      IntPtr mon = Win32.MonitorFromWindow(hwnd, Win32.MONITOR_DEFAULTTONEAREST);
      if (mon == IntPtr.Zero) return false;
      var mi = new Win32.MONITORINFO();
      mi.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Win32.MONITORINFO));
      if (!Win32.GetMonitorInfoW(mon, ref mi)) return false;

      // rcMonitor, NOT rcWork: a maximised window fills the work area, and a
      // maximised window is not full-screen - the bar should stay visible over
      // it. Covering means covering, so <= / >= rather than equality: a game
      // may legitimately extend a pixel past the edge.
      return r.left <= mi.rcMonitor.left && r.top <= mi.rcMonitor.top &&
             r.right >= mi.rcMonitor.right && r.bottom >= mi.rcMonitor.bottom;
    }

    /// Mantle's own processes: this sidecar, and the Electron main process that started it
    /// (--parent-pid), which creates every Mantle window - the bar, the launcher, the panels,
    /// the desktop layer.
    public static bool IsMantlePid(int pid) {
      return pid != 0 && (pid == Program.OwnPid || (Program.ParentPid > 0 && pid == Program.ParentPid));
    }

    /// THE OWNERSHIP GATE for every command that restyles or moves a window it is handed
    /// (glass, corners, region, morph, place, raise, traywatch, appbar, desktop). Their
    /// comments always said "a window Mantle owns", but nothing checked it: until 2026-09-29
    /// any hwnd went through, so one bad argument could blur, round, clip or move another
    /// app's window - and SetWindowPos on a window whose thread is not pumping blocked the ui
    /// lane for good (core-sc, measured: `place` on a stalled test window never answered).
    /// Returns null when the command may go on: a Mantle window, OR a handle that is 0, dead
    /// or the taskbar, which each command refuses itself with its own long-standing words.
    public static string NotMantleWindow(IntPtr hwnd, string what) {
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return null;
      string cls = Win32.GetClassName(hwnd);
      if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return null;
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      if (IsMantlePid(pid)) return null;
      return what + ": window " + hwnd.ToInt64().ToString(CultureInfo.InvariantCulture) +
             " is not one of Mantle's own windows, so it was left alone";
    }
  }
}
