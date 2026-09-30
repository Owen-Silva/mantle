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
//   progman-front    Win11 24H2/25H2: SHELLDLL_DefView (the icons), any
//                    wallpaper app's player and the WorkerW are all CHILDREN of
//                    Progman, top to bottom. We become a child of Progman placed
//                    straight under the icons, so we sit IN FRONT of a video
//                    wallpaper instead of inside the WorkerW behind it.
//                    Expected on this box.
//   workerw-sibling  classic Win10: a TOP-LEVEL WorkerW after the one hosting
//                    SHELLDLL_DefView.
//   workerw-child    the WorkerW is a CHILD of Progman but the icons are not
//                    there. A wallpaper app's player covers us in this mode.
//   progman          nothing else worked; parent straight to Progman. Icons may
//                    draw over us, but we are still behind every app.
//
// Why progman-front exists (2026-09-22): Lively Wallpaper parents its mpv
// player to Progman between the icons and the WorkerW, so a layer INSIDE the
// WorkerW was drawn over by the video, the whole time, with every check green.
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

      // 24H2+: after the spawn message the icons STAY under Progman (on Win10
      // they move out into a top-level WorkerW), so this test cannot pick up a
      // classic desktop.
      IntPtr defView = Win32.FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
      IntPtr target = IntPtr.Zero;
      if (defView != IntPtr.Zero) {
        target = progman;
        mode = "progman-front";
      }

      if (target == IntPtr.Zero) {
        target = FindSiblingWorkerW();
        if (target != IntPtr.Zero) mode = "workerw-sibling";
      }

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
      // Read the error code IMMEDIATELY: the very next P/Invoke overwrites it.
      int lastErr = System.Runtime.InteropServices.Marshal.GetLastWin32Error();

      // SetParent's RETURN VALUE cannot be trusted as a success flag: it hands
      // back the OLD parent, and IntPtr.Zero is the normal answer for a window
      // that had none. Ask Windows what the parent is now instead - and ask it
      // three ways, because ONE IS NOT ENOUGH:
      //
      // The 2026-09-21 live run reported "SetParent did not take (Win32 error
      // 0)" while the window had in fact LEFT the top-level window list, i.e.
      // the reparent had worked. GetParent() alone lies in both directions: it
      // returns the OWNER for an owned top-level window, and Chromium/Electron
      // windows are owned. So: success if ANY of GetParent, GA_PARENT or
      // IsChild says we are under the target, and failure ONLY when the window
      // is demonstrably still top-level (its GA_PARENT is the desktop itself).
      IntPtr parent = Win32.GetParent(hwnd);
      IntPtr ancestor = Win32.GetAncestor(hwnd, Win32.GA_PARENT);
      IntPtr desktopRoot = Win32.GetDesktopWindow();
      bool took = parent == target || ancestor == target || Win32.IsChild(target, hwnd);

      if (!took) {
        // Every number a human would need at 2am, in the answer itself.
        string numbers = "GetParent=" + parent.ToInt64() +
                         ", GetAncestor(GA_PARENT)=" + ancestor.ToInt64() +
                         ", target=" + target.ToInt64() +
                         ", GetDesktopWindow=" + desktopRoot.ToInt64() +
                         ", mode=" + mode + ", Win32 error " + lastErr;
        if (ancestor == desktopRoot || ancestor == IntPtr.Zero)
          return "SetParent did not take: the window is still top-level (" + numbers +
                 "). It is not part of the desktop.";
        // Reparented, but under something we did not ask for (an explorer
        // restart can swap the WorkerW mid-call). Behind every app is still
        // behind every app, so take it - and SAY what happened.
        Program.EmitLog("warn", "the desktop layer ended up under a different window than the one " +
                                "we asked for, so it is behind every app but not under the one we picked (" +
                                numbers + ")");
      }

      // A child window needs WS_CHILD, or Windows keeps treating it as
      // top-level and it will not clip to the desktop.
      long style = before.ToInt64();
      if ((style & Win32.WS_CHILD) == 0) {
        style |= Win32.WS_CHILD | Win32.WS_VISIBLE;
        Win32.SetWindowLongPtr(hwnd, Win32.GWL_STYLE, new IntPtr(style));
      }
      // progman-front: insert-after the icons = directly under them, above any
      // wallpaper player. Every other mode: the bottom of whatever we joined.
      Win32.SetWindowPos(hwnd, mode == "progman-front" ? defView : Win32.HWND_BOTTOM, 0, 0, 0, 0,
        Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE | Win32.SWP_FRAMECHANGED);
      return null;
    }

    /// progman-front only: is the layer still straight under the icons? A
    /// wallpaper app that (re)starts or changes wallpaper re-inserts its player,
    /// which can land between the icons and us and cover us again. Puts the
    /// layer back and says what had got in the way (class + process), or
    /// returns covering=null when nothing had.
    public static string Recheck(IntPtr hwnd, out bool moved, out string covering) {
      moved = false;
      covering = null;
      if (hwnd == IntPtr.Zero) return "no hwnd given";
      if (!Win32.IsWindow(hwnd)) return "window " + hwnd.ToInt64() + " no longer exists";
      IntPtr progman = Win32.FindWindowW("Progman", null);
      if (progman == IntPtr.Zero)
        return "no Progman window: the desktop is not running (explorer may have crashed)";
      if (Win32.GetAncestor(hwnd, Win32.GA_PARENT) != progman) {
        // Explorer restarted (a crash, or Task Manager's Restart): the Progman we joined died and a
        // new one runs, and our window survived as an orphan. This used to be reported every 30 s
        // forever; now the layer simply joins the new desktop, the way it joined the first one.
        string mode;
        string aerr = Attach(hwnd, out mode);
        if (aerr != null)
          return "the desktop layer lost its place when explorer restarted and could not rejoin the desktop: " + aerr;
        moved = true;
        covering = "explorer restarted, so the layer rejoined the new desktop (" + mode + ")";
        return null;
      }
      IntPtr defView = Win32.FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (defView == IntPtr.Zero)
        return "Progman has no SHELLDLL_DefView any more, so there is no icon layer to sit under";

      // Walk up from us to the icons: every VISIBLE sibling in between is
      // drawn over us. Invisible ones cost nothing and are left alone.
      IntPtr w = Win32.GetWindow(hwnd, GW_HWNDPREV);
      while (w != IntPtr.Zero && w != defView) {
        if (Win32.IsWindowVisible(w)) {
          int pid;
          Win32.GetWindowThreadProcessId(w, out pid);
          string proc = "pid " + pid;
          try { proc = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch (Exception) { }
          covering = Win32.GetClassName(w) + " (" + proc + ")";
          break;
        }
        w = Win32.GetWindow(w, GW_HWNDPREV);
      }
      if (covering == null) return null;

      Win32.SetWindowPos(hwnd, defView, 0, 0, 0, 0,
        Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
      moved = true;
      return null;
    }

    const uint GW_HWNDPREV = 3;

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
