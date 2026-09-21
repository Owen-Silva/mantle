// Desktop.cs - park an Electron window BEHIND every app, as part of the desktop.
//
// This is the wallpaper trick every "live desktop" app uses. Progman (the
// desktop) owns a WorkerW window that sits under the icons; making our window a
// child of it means Windows itself keeps us at the very bottom of the z-order -
// no polling, no fighting with other apps, and Show Desktop still works.
//
// The undocumented part: SendMessageTimeout(Progman, 0x052C, 0xD, ...) asks
// Progman to spawn that WorkerW. Where the WorkerW then LIVES has changed with
// Windows versions, so we probe for all three known shapes and report which one
// we got - a caller that gets "progman" knows it is on the fallback and can say
// so in the UI instead of silently rendering in the wrong place.
//
//   workerw-sibling  classic Win10: a TOP-LEVEL WorkerW after the one hosting
//                    SHELLDLL_DefView.
//   workerw-child    Win11 24H2/25H2: SHELLDLL_DefView hangs off Progman and
//                    the WorkerW is a CHILD of Progman. Expected on this box.
//   progman          nothing else worked; parent straight to Progman. Icons may
//                    draw over us, but we are still behind every app.
using System;
using System.Collections.Generic;

namespace Mantle {
  static class Desktop {
    const uint WM_SPAWN_WORKER = 0x052C;   // undocumented Progman message
    const uint SMTO_NORMAL = 0x0000;

    /// hwnd -> the window style it had before we made it a child, so detach can
    /// hand back exactly what we were given.
    static readonly Dictionary<long, IntPtr> _originalStyle = new Dictionary<long, IntPtr>();

    public static string Attach(IntPtr hwnd, out string mode) {
      mode = null;
      if (hwnd == IntPtr.Zero) return "no hwnd given";
      if (!Win32.IsWindow(hwnd)) return "window " + hwnd.ToInt64() + " no longer exists";

      IntPtr progman = Win32.FindWindowW("Progman", null);
      if (progman == IntPtr.Zero)
        return "no Progman window: the desktop is not running (explorer may have crashed)";

      // Ask Progman to create the wallpaper WorkerW. Both wParam shapes are sent
      // because different builds respond to one or the other; a timeout here is
      // normal and not fatal.
      IntPtr res;
      Win32.SendMessageTimeoutW(progman, WM_SPAWN_WORKER, new IntPtr(0xD), IntPtr.Zero, SMTO_NORMAL, 1000, out res);
      Win32.SendMessageTimeoutW(progman, WM_SPAWN_WORKER, new IntPtr(0xD), new IntPtr(1), SMTO_NORMAL, 1000, out res);

      IntPtr target = FindSiblingWorkerW();
      if (target != IntPtr.Zero) mode = "workerw-sibling";

      if (target == IntPtr.Zero) {
        target = Win32.FindWindowExW(progman, IntPtr.Zero, "WorkerW", null);
        if (target != IntPtr.Zero) mode = "workerw-child";
      }
      if (target == IntPtr.Zero) {
        target = progman;
        mode = "progman";
      }

      IntPtr before = Win32.GetWindowLongPtr(hwnd, Win32.GWL_STYLE);
      if (!_originalStyle.ContainsKey(hwnd.ToInt64())) _originalStyle[hwnd.ToInt64()] = before;

      Win32.SetParent(hwnd, target);
      // SetParent's RETURN VALUE cannot be trusted as a success flag: it hands
      // back the OLD parent, and IntPtr.Zero is the normal answer for a window
      // that had none. Ask Windows what the parent is now instead.
      if (Win32.GetParent(hwnd) != target)
        return "SetParent did not take (Win32 error " +
               System.Runtime.InteropServices.Marshal.GetLastWin32Error() +
               "); the window is not part of the desktop, mode would have been " + mode;

      // A child window needs WS_CHILD, or Windows keeps treating it as
      // top-level and it will not clip to the desktop.
      long style = before.ToInt64();
      if ((style & Win32.WS_CHILD) == 0) {
        style |= Win32.WS_CHILD | Win32.WS_VISIBLE;
        Win32.SetWindowLongPtr(hwnd, Win32.GWL_STYLE, new IntPtr(style));
      }
      Win32.SetWindowPos(hwnd, Win32.HWND_BOTTOM, 0, 0, 0, 0,
        Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED);
      return null;
    }

    /// Classic layout: walk the top-level windows; the one hosting
    /// SHELLDLL_DefView is followed in z-order by the WorkerW we want.
    static IntPtr FindSiblingWorkerW() {
      IntPtr found = IntPtr.Zero;
      bool seenDefView = false;
      Win32.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        if (Win32.FindWindowExW(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
          seenDefView = true;
          return true;
        }
        if (seenDefView && Win32.GetClassName(hwnd) == "WorkerW") {
          found = hwnd;
          return false;   // stop
        }
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return found;
    }

    public static string Detach(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero) return "no hwnd given";
      if (!Win32.IsWindow(hwnd)) return "window " + hwnd.ToInt64() + " no longer exists";
      Win32.SetParent(hwnd, IntPtr.Zero);
      IntPtr orig;
      if (_originalStyle.TryGetValue(hwnd.ToInt64(), out orig)) {
        // Leaving WS_CHILD on a window with no parent makes it unmanageable, so
        // the exact style we found is put back.
        Win32.SetWindowLongPtr(hwnd, Win32.GWL_STYLE, orig);
        _originalStyle.Remove(hwnd.ToInt64());
        Win32.SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0,
          Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED);
      }
      return null;
    }
  }
}
