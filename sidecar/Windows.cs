// Windows.cs - the window list, the change detector, and the four verbs that act
// on a window (focus / minimize / close / toggle).
//
// The class is called WindowList, not Windows, so nothing in this project ever
// has to disambiguate it from System.Windows.*.
//
// THE LIST IS THE PRODUCT. Everything the Mantle bar draws comes from here, so
// the filter below is the definition of "a window a human would click in a
// taskbar". Get it wrong and the bar fills with invisible junk (tooltips, IME
// helpers, cloaked UWP apps parked on another virtual desktop) or loses real
// apps (Store apps live inside ApplicationFrameWindow and must be KEPT).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Windows.Forms;

namespace Mantle {
  static class WindowList {
    // Shell furniture and helper classes that are never "an app window".
    static readonly HashSet<string> SkipClasses = new HashSet<string>(StringComparer.Ordinal) {
      "Progman",                    // the desktop
      "WorkerW",                    // the desktop's wallpaper host
      "Shell_TrayWnd",              // the taskbar
      "Shell_SecondaryTrayWnd",     // taskbars on other monitors
      "Windows.UI.Core.CoreWindow", // UWP cores; the real window is their ApplicationFrameWindow
      "MSCTFIME UI",                // IME helper
      "Default IME",
      "Button",                     // the old Start button
      "NotifyIconOverflowWindow",
      "TopLevelWindowForOverflowXamlIsland"
    };

    static Win32.WinEventProc _evProc;      // static: the GC must never collect a live hook proc
    static IntPtr _hookSystem, _hookObject;
    static Timer _timer;                    // Forms timer: ticks on the message-loop thread
    static bool _dirty;                     // a WinEvent arrived since the last emit
    static string _sig = null;              // signature of the last emitted list
    static int _ticks;
    static bool _firstEmitted;

    const int TickMs = 250;                 // coalescing window
    const int PollEveryTicks = 8;           // 8 * 250ms = the 2 s safety-net poll

    /// Called once on the message-loop thread. Read-only, so it runs in passive
    /// mode too - watching windows never touches the live shell.
    public static void Start() {
      _evProc = OnWinEvent;
      // Two ranges rather than eight hooks: fewer cross-process callbacks, and
      // the proc filters anyway. SKIPOWNPROCESS keeps our own noise out.
      _hookSystem = Win32.SetWinEventHook(
        Win32.EVENT_SYSTEM_FOREGROUND, Win32.EVENT_SYSTEM_MINIMIZEEND,
        IntPtr.Zero, _evProc, 0, 0, Win32.WINEVENT_OUTOFCONTEXT | Win32.WINEVENT_SKIPOWNPROCESS);
      _hookObject = Win32.SetWinEventHook(
        Win32.EVENT_OBJECT_CREATE, Win32.EVENT_OBJECT_NAMECHANGE,
        IntPtr.Zero, _evProc, 0, 0, Win32.WINEVENT_OUTOFCONTEXT | Win32.WINEVENT_SKIPOWNPROCESS);

      if (_hookSystem == IntPtr.Zero || _hookObject == IntPtr.Zero)
        Program.EmitLog("warn", "window change hooks could not be installed; the 2s poll is the only updater");

      _timer = new Timer();
      _timer.Interval = TickMs;
      _timer.Tick += OnTick;
      _timer.Start();
    }

    /// Idempotent, callable from any thread - but ONLY THE LOOP THREAD CAN UNHOOK.
    /// UnhookWinEvent fails on any thread other than the one that called
    /// SetWinEventHook (measured 2026-09-25: false on every stdin-EOF exit, from
    /// mantle-stdin). This used to zero the handles anyway, so the hooks stayed
    /// live through Environment.Exit and the loop thread kept being called back
    /// into a runtime that was shutting down - the 0xC000041D exit crash. A
    /// handle that did not come off is now KEPT, so the loop thread's own call
    /// (Program.ParkLoopForExit) finishes the job. True when both are off.
    public static bool Stop() {
      try { if (_timer != null) _timer.Stop(); } catch (Exception) { }
      _hookSystem = Unhook(_hookSystem);
      _hookObject = Unhook(_hookObject);
      return _hookSystem == IntPtr.Zero && _hookObject == IntPtr.Zero;
    }

    static IntPtr Unhook(IntPtr h) {
      if (h == IntPtr.Zero) return h;
      try { return Win32.UnhookWinEvent(h) ? IntPtr.Zero : h; } catch (Exception) { return h; }
    }

    /// Hook procs must return in microseconds: no I/O, no allocation, no work.
    /// All we do is raise a flag the 250 ms timer picks up.
    static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      // Exiting: a burst of these can keep the loop from ever reaching the
      // posted park request, so the first one to arrive parks it instead.
      if (Program.ParkWanted) Program.ParkLoopIfAsked();
      if (idObject != Win32.OBJID_WINDOW) return;   // ignore caret/menu/focus sub-objects
      if (hwnd == IntPtr.Zero) return;
      _dirty = true;
    }

    static void OnTick(object sender, EventArgs e) {
      if (Program.ParkWanted) Program.ParkLoopIfAsked();
      _ticks++;
      bool poll = (_ticks % PollEveryTicks) == 0;
      if (!_dirty && !poll && _firstEmitted) return;
      _dirty = false;
      try {
        EmitIfChanged(!_firstEmitted);
      } catch (Exception ex) {
        Program.EmitLog("error", "window poll failed: " + ex.Message);
      }
    }

    /// Rebuild, compare, and emit only when something a human would notice moved.
    /// `force` makes the very first emit unconditional so the Electron side has a
    /// list within the first 2 s without having to ask for one.
    public static void EmitIfChanged(bool force) {
      var list = Build();
      string sig = Signature(list);
      if (!force && sig == _sig) return;
      _sig = sig;
      _firstEmitted = true;
      Program.Emit(Json.Obj("ev", "windows", "list", list));
    }

    /// Per-hwnd app identity (who really owns the window, its AUMID, its exe).
    /// CACHED because none of it changes while the window lives, and the list
    /// is rebuilt ten times a second: resolving a UWP frame means enumerating
    /// child windows, opening a process and asking the property system, which
    /// is far too much to pay per tick. The dictionary is rebuilt from the
    /// windows actually seen, so closed windows drop out on their own.
    static Dictionary<string, Apps.WinApp> _appCache = new Dictionary<string, Apps.WinApp>(StringComparer.Ordinal);

    public static List<object> Build() {
      var found = new List<object>();
      var seen = new Dictionary<string, Apps.WinApp>(StringComparer.Ordinal);
      int ownPid = Program.OwnPid;
      int parentPid = Program.ParentPid;

      Win32.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        // Exiting: park between two windows instead of finishing the list. The
        // first list after start resolves every app and icon cold and took up
        // to 1.3 s (measured 2026-09-25) - time the exit would spend waiting.
        if (Program.ParkWanted) Program.ParkLoopIfAsked();
        try {
          if (!Win32.IsWindowVisible(hwnd)) return true;
          // An owned window is a dialog/palette of another window; the owner is
          // the one that belongs in a taskbar.
          if (Win32.GetWindow(hwnd, Win32.GW_OWNER) != IntPtr.Zero) return true;
          IntPtr ex = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE);
          if ((ex.ToInt64() & Win32.WS_EX_TOOLWINDOW) != 0) return true;

          string title = Win32.GetWindowText(hwnd);
          if (title.Length == 0) return true;

          string cls = Win32.GetClassName(hwnd);
          if (SkipClasses.Contains(cls)) return true;

          // Cloaked = the compositor is not showing it (other virtual desktop,
          // suspended UWP). IsWindowVisible still says true for these.
          if (Win32.IsCloaked(hwnd)) return true;

          int pid;
          Win32.GetWindowThreadProcessId(hwnd, out pid);
          if (pid == ownPid) return true;
          if (parentPid > 0 && pid == parentPid) return true;   // never list the shell's own UI

          // The app behind the window. For a UWP app this is NOT the window's
          // own process: ApplicationFrameWindow is an empty shell owned by
          // ApplicationFrameHost.exe, and every UWP app on the machine would
          // otherwise report the same exe and group into one bogus pile.
          string key = hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + pid;
          Apps.WinApp app;
          if (!_appCache.TryGetValue(key, out app)) app = Apps.ForWindow(hwnd, cls, pid);
          seen[key] = app;

          string exe = app.Exe;
          // A packaged app's icon comes from its PACKAGE, not from its exe
          // (which usually has none), and is cached by AUMID.
          string icon = null;
          if (app.Aumid != null && (app.Host == "frame" || Apps.IsPackagedPath(exe)))
            icon = Apps.IconFor(app.Aumid);
          if (icon == null && exe.Length > 0) icon = Icons.ForPath(exe);

          found.Add(Json.Obj(
            "hwnd", hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            "title", title,
            "exe", exe,
            "pid", app.Pid,
            // The identity a pin can be matched against: an exe path cannot
            // group Discord (Update.exe pinned, Discord.exe running), Edge, or
            // anything from the Store. An AUMID can.
            "aumid", app.Aumid,
            "host", app.Host,
            "minimized", Win32.IsIconic(hwnd),
            "foreground", hwnd == Win32.GetForegroundWindow(),
            "icon", icon));
        } catch (Exception ex2) {
          // One bad window must never truncate the list.
          Program.EmitLog("warn", "skipped a window while listing: " + ex2.Message);
        }
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);   // the delegate must outlive the unmanaged call
      _appCache = seen;   // windows that have closed drop out of the cache here
      return found;
    }

    /// Cheap fingerprint of the things the bar renders. Icons are excluded
    /// because they are a pure function of the exe path.
    static string Signature(List<object> list) {
      var sb = new StringBuilder(list.Count * 48);
      foreach (IDictionary d in list) {
        sb.Append(d["hwnd"]).Append('\u0001')
          .Append(d["title"]).Append('\u0001')
          .Append(d["minimized"]).Append('\u0001')
          .Append(d["foreground"]).Append('\u0002');
      }
      return sb.ToString();
    }

    // ------------------------------------------------------------------- verbs

    static string Check(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero) return "no hwnd given";
      if (!Win32.IsWindow(hwnd)) return "window " + hwnd.ToInt64() + " no longer exists";
      return null;
    }

    /// Raise a window owned by another process. Windows deliberately makes this
    /// hard (foreground lock), so this is the documented escalation ladder:
    /// restore -> AttachThreadInput -> the Alt-key nudge. Each step is only
    /// taken if the previous one did not land, and if none do we say so rather
    /// than reporting a success that did not happen.
    public static string Focus(IntPtr hwnd) {
      string bad = Check(hwnd);
      if (bad != null) return bad;

      if (Win32.IsIconic(hwnd)) Win32.ShowWindow(hwnd, Win32.SW_RESTORE);

      IntPtr fg = Win32.GetForegroundWindow();
      if (fg == hwnd) return null;

      int fgPid;
      int fgThread = Win32.GetWindowThreadProcessId(fg, out fgPid);
      int me = Win32.GetCurrentThreadId();
      bool attached = false;
      try {
        if (fgThread != 0 && fgThread != me) attached = Win32.AttachThreadInput(me, fgThread, true);
        Win32.SetForegroundWindow(hwnd);
        Win32.BringWindowToTop(hwnd);
      } finally {
        if (attached) Win32.AttachThreadInput(me, fgThread, false);
      }

      if (Win32.GetForegroundWindow() == hwnd) return null;

      // Last resort: Windows relaxes the foreground lock for a process that has
      // just seen input, so we synthesise a bare Alt press/release.
      Hotkey.TapAltForFocusLock();
      Win32.SetForegroundWindow(hwnd);
      if (Win32.GetForegroundWindow() == hwnd) return null;

      return "could not raise window " + hwnd.ToInt64() +
             ": Windows refused the foreground change (another app holds the foreground lock)";
    }

    public static string Minimize(IntPtr hwnd) {
      string bad = Check(hwnd);
      if (bad != null) return bad;
      Win32.ShowWindow(hwnd, Win32.SW_MINIMIZE);
      return null;
    }

    public static string Close(IntPtr hwnd) {
      string bad = Check(hwnd);
      if (bad != null) return bad;
      // WM_CLOSE, never TerminateProcess: the app gets to run its save prompt.
      if (!Win32.PostMessageW(hwnd, Win32.WM_CLOSE, IntPtr.Zero, IntPtr.Zero))
        return "the window did not accept WM_CLOSE (it may be hung or already gone)";
      return null;
    }

    /// Taskbar-button behaviour: clicking the active app hides it, clicking any
    /// other app raises it.
    public static string Toggle(IntPtr hwnd) {
      string bad = Check(hwnd);
      if (bad != null) return bad;
      if (Win32.GetForegroundWindow() == hwnd) return Minimize(hwnd);
      return Focus(hwnd);
    }
  }
}
