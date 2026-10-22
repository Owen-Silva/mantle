// HitTest.cs - `hittest` and `raise`: what would a click here actually hit, and
// get Mantle's bar back on top of it.
//
// THE BUG THIS EXISTS FOR (measured live, 2026-09-21). The user, pressing the bar's
// buttons: "im pressing them and they arent doing anything". WindowFromPoint
// over EVERY point of the revealed bar returned an explorer.exe window of class
// LockScreenBackstopFrame - "Backstop Window", 0,0,1920,1080, visible,
// WS_EX_TOPMOST, not layered - sitting above Mantle's bar inside the topmost
// band, with about forty ThumbnailDeviceHelperWnd windows alongside it. Every
// click landed on Explorer's backstop, not on the pill.
//
// A shell that is invisibly covered looks IDENTICAL to a shell whose click
// handlers are broken, and the difference cost a debugging session. So:
//
//   hittest   the diagnosis. It answers with the ROOT window under a point -
//             class, title, pid and exe - so "my button does nothing" becomes
//             "LockScreenBackstopFrame, explorer.exe" in one line.
//   raise     the fix, and it PROVES ITSELF. It re-asserts topmost on the
//             caller's own window, then hit-tests that window's own centre (the
//             centre of its REGION when it has one; `at` says which point) and
//             reports whether the root there really is that window. When it is
//             not, `over` names what won - a raise that silently failed would
//             put us straight back in the same debugging session.
//
// THE Z-ORDER RULE IS UNCHANGED (see TrayWatch.cs): the only window either of
// these can move is the one the caller passes, with SWP_NOMOVE | SWP_NOSIZE |
// SWP_NOACTIVATE. Nothing else on the desktop is ever re-ordered, hidden or
// activated - not the backstop, not the taskbar, not the thumbnail helpers.
using System;
using System.Collections;
using System.Globalization;
using System.Runtime.InteropServices;

namespace Mantle {
  static class HitTest {

    /// What is under this PHYSICAL point. Read-only, so it runs in passive.
    /// "Nothing is there" is a real answer (off the desktop entirely) and comes
    /// back as hwnd "0" with a reason, not as an error.
    public static IDictionary At(int x, int y) {
      var pt = new Win32.POINT();
      pt.x = x;
      pt.y = y;
      IntPtr hwnd = Win32.WindowFromPoint(pt);
      if (hwnd == IntPtr.Zero)
        return Json.Obj("ok", true, "hwnd", "0", "root", "0", "cls", "", "title", "", "pid", 0, "exe", "",
                        "reason", "no window is at " + x + "," + y + " (the point may be off every monitor)");

      // The ROOT, not the child control: WindowFromPoint lands on whatever leaf
      // owns the pixel, and "Chrome_RenderWidgetHostHWND" tells a reader
      // nothing about which app is in the way.
      IntPtr root = Win32.GetAncestor(hwnd, Win32.GA_ROOT);
      if (root == IntPtr.Zero) root = hwnd;
      int pid;
      Win32.GetWindowThreadProcessId(root, out pid);

      return Json.Obj("ok", true,
                      "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
                      "root", root.ToInt64().ToString(CultureInfo.InvariantCulture),
                      "cls", Win32.GetClassName(root),
                      "title", Win32.GetWindowText(root),
                      "pid", pid,
                      "exe", Win32.GetProcessPath(pid),
                      "reason", null);
    }

    /// Re-assert topmost on the caller's own window and then CHECK. Returns
    /// null with `result` filled, or a refusal.
    public static string Raise(IntPtr hwnd, out IDictionary result) {
      result = null;
      if (hwnd == IntPtr.Zero) return "raise: no hwnd given";
      if (!Win32.IsWindow(hwnd)) return "raise: window " + hwnd.ToInt64() + " no longer exists";
      string cls = Win32.GetClassName(hwnd);
      if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
        return "raise: that window IS the Windows taskbar (" + cls + "); this command only ever " +
               "re-orders a window Mantle owns";

      string reason = null;
      if (!Win32.SetWindowPos(hwnd, Win32.HWND_TOPMOST, 0, 0, 0, 0,
                              Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE))
        reason = "SetWindowPos would not make the window topmost (Win32 error " +
                 Marshal.GetLastWin32Error() + ")";

      // THE PROOF. A raise that "succeeded" while something else still owns the
      // pixels is the exact failure this command was written for.
      Win32.RECT r;
      bool onTop = false;
      object over = null;
      object testedAt = null;
      if (!Win32.GetWindowRect(hwnd, out r)) {
        reason = (reason == null ? "" : reason + "; ") + "the window's rect could not be read, so being on top could not be verified";
      } else if (r.right <= r.left || r.bottom <= r.top) {
        reason = (reason == null ? "" : reason + "; ") + "the window has no area, so being on top could not be verified";
      } else {
        var pt = new Win32.POINT();
        pt.x = r.left + (r.right - r.left) / 2;
        pt.y = r.top + (r.bottom - r.top) / 2;
        // A SHAPED window is tested at the centre of its REGION, not of its rect (2026-09-24).
        // The bar window now reaches 480 DIP past the bar so a popover never has to resize it,
        // and a region is what makes only the bar part of it real. The rect's centre is then in
        // the empty part, where WindowFromPoint goes straight through to whatever is behind,
        // and that window would be reported as covering the bar. The region's box is in window
        // coordinates; for the bar at rest it is the pill (plus the air under it).
        Win32.RECT box;
        int kind = RegionApi.GetWindowRgnBox(hwnd, out box);
        if ((kind == RegionApi.SIMPLEREGION || kind == RegionApi.COMPLEXREGION) &&
            box.right > box.left && box.bottom > box.top) {
          pt.x = r.left + box.left + (box.right - box.left) / 2;
          pt.y = r.top + box.top + (box.bottom - box.top) / 2;
        }
        testedAt = new object[] { pt.x, pt.y };
        IntPtr hit = Win32.WindowFromPoint(pt);
        IntPtr root = hit == IntPtr.Zero ? IntPtr.Zero : Win32.GetAncestor(hit, Win32.GA_ROOT);
        if (root == IntPtr.Zero) root = hit;
        onTop = root == hwnd;
        if (!onTop) {
          if (root == IntPtr.Zero) {
            reason = (reason == null ? "" : reason + "; ") +
                     "nothing answers a hit test at the window's own centre, so it is not being clicked";
          } else {
            int pid;
            Win32.GetWindowThreadProcessId(root, out pid);
            over = Json.Obj("cls", Win32.GetClassName(root), "title", Win32.GetWindowText(root), "pid", pid);
            reason = (reason == null ? "" : reason + "; ") +
                     "another window is above this one at its own centre, so clicks land on it instead";
          }
        }
      }

      result = Json.Obj("ok", reason == null, "onTop", onTop, "over", over, "at", testedAt, "reason", reason);
      return null;
    }

    // Kept here rather than in Win32.cs: only `raise` reads a window's region.
    static class RegionApi {
      public const int SIMPLEREGION = 2;
      public const int COMPLEXREGION = 3;
      [DllImport("user32.dll")]
      public static extern int GetWindowRgnBox(IntPtr hWnd, out Win32.RECT lprc);
    }
  }
}
