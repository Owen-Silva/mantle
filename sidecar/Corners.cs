// Corners.cs - `corners`: ask DWM to round a window's corners.
//
// WHY THE SIDECAR: Mantle's bar, launcher and panels are frameless Electron
// windows. A frameless window has square corners, and CSS border-radius cannot
// round the WINDOW - it rounds the page inside it, leaving four opaque
// triangles of window behind the rounded page. The only thing that can round
// the actual window is the compositor, through
// DWMWA_WINDOW_CORNER_PREFERENCE.
//
// It is also free: DWM already composes the frame, so rounding costs no extra
// paint. That matters here - an earlier round of this project burned 27% of a
// core on a drifting gradient, and "make it look nice" is not a licence to
// spend CPU.
//
// SAFE BY CONSTRUCTION, like `glass` and `place`: this touches ONE window, the
// one the caller passes, and the attribute dies with that window. It holds no
// shell state, so there is nothing for --passive to protect - except the one
// window it must never be pointed at, which is the Windows taskbar.
//
// WINDOWS 10: the attribute did not exist before Windows 11 22000, and DWM
// answers E_INVALIDARG. That is reported as a refusal with the reason, not
// swallowed - a bar that quietly stayed square would be a mystery.
using System;

namespace Mantle {
  static class Corners {
    /// Returns null on success (with `used` naming the preference that was
    /// applied), or a refusal in plain words.
    public static string Apply(IntPtr hwnd, string mode, out string used) {
      used = null;
      if (hwnd == IntPtr.Zero) return "corners: no hwnd given";
      if (!Win32.IsWindow(hwnd)) return "corners: window " + hwnd.ToInt64() + " no longer exists";

      // The taskbar is Explorer's window, not ours. Rounding it would be a
      // visible change to the live shell that only a reboot of Explorer would
      // undo - exactly the class of thing that cost a reboot on 2026-09-21.
      string cls = Win32.GetClassName(hwnd);
      if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
        return "corners: that window IS the Windows taskbar (" + cls + "); this command only ever " +
               "changes a window Mantle owns";

      string m = (mode ?? "").Trim().ToLowerInvariant();
      int pref;
      if (m == "round") { pref = Win32.DWMWCP_ROUND; used = "round"; }
      else if (m == "roundsmall") { pref = Win32.DWMWCP_ROUNDSMALL; used = "roundsmall"; }
      else if (m == "default" || m.Length == 0) { pref = Win32.DWMWCP_DEFAULT; used = "default"; }
      else return "corners: unknown mode '" + mode + "'; it takes round, roundsmall or default";

      int hr;
      try {
        hr = Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int));
      } catch (Exception ex) {
        return "corners: DWM refused the call (" + ex.Message + ")";
      }
      if (hr != Win32.S_OK)
        return "corners: DWM refused DWMWA_WINDOW_CORNER_PREFERENCE (HRESULT 0x" + hr.ToString("X8") +
               "); rounded corners need Windows 11 (build 22000 or newer)";
      return null;
    }
  }
}
