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
      var ownSeen = new Dictionary<string, OwnIconEntry>(StringComparer.Ordinal);   // OwnIcon's, rebuilt the same way
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
          // never list the shell's own UI, except its app windows (Mantle Settings: Switcher.IsMantleApp)
          if (parentPid > 0 && pid == parentPid && !Switcher.IsMantleApp(cls, title)) return true;

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
          string icon = null, iconFrom = null;
          // Mantle's own APP windows (Mantle Settings, Mantle Task Manager) are electron.exe,
          // whose exe icon is Electron's: their OWN icon is the right one (OwnIcon below).
          if (Switcher.IsMantleApp(cls, title)) {
            icon = OwnIcon(hwnd, key, ownSeen);
            if (icon != null) iconFrom = "window";
          }
          if (icon == null && app.Aumid != null && (app.Host == "frame" || Apps.IsPackagedPath(exe))) {
            icon = Apps.IconFor(app.Aumid);
            if (icon != null) iconFrom = "package";
          }
          if (icon == null && exe.Length > 0) {
            icon = Icons.ForPath(exe);
            if (icon != null) iconFrom = "exe";
          }

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
            "icon", icon,
            // where the icon came from: "window" (its own, Mantle's app windows only),
            // "package" (a Store app), "exe", or null (none)
            "iconFrom", iconFrom));
        } catch (Exception ex2) {
          // One bad window must never truncate the list.
          Program.EmitLog("warn", "skipped a window while listing: " + ex2.Message);
        }
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);   // the delegate must outlive the unmanaged call
      _appCache = seen;   // windows that have closed drop out of the cache here
      _ownIcons = ownSeen;
      return found;
    }

    // ------------------------------------------------------ a window's OWN icon
    //
    // Icons lane, 2026-09-28. Owen: "they need to have there own icons that replace windows
    // icons not just be electron". Mantle Settings and Mantle Task Manager are electron.exe
    // windows; BrowserWindow's `icon` gives each its own (Electron sends WM_SETICON), which is
    // what Windows' own taskbar and Alt+Tab draw. So for THESE windows (Switcher.IsMantleApp:
    // Chromium's class + the exact title) ask the window, not the exe:
    //   WM_GETICON ICON_BIG, then ICON_SMALL2. NOT the class icon (GCLP_HICON): Chromium's
    //   window class carries electron.exe's own icon, the very thing this replaces.
    // Only these two windows: a WM_GETICON to every app on every rebuild would be a cross-process
    // call per window per tick, and the list must never wait on another app's thread. The ask is
    // SendMessageTimeout with SMTO_ABORTIFHUNG and 100 ms, cached per window once found; a window
    // that has no icon yet is asked again at most every 2 s. The handle belongs to the window:
    // never destroyed here (Icons.FromHIcon does not own it).
    struct OwnIconEntry { public string Url; public int MissAt; }
    static Dictionary<string, OwnIconEntry> _ownIcons = new Dictionary<string, OwnIconEntry>(StringComparer.Ordinal);

    static string OwnIcon(IntPtr hwnd, string key, Dictionary<string, OwnIconEntry> seenNow) {
      OwnIconEntry e;
      int now = Environment.TickCount;
      if (_ownIcons.TryGetValue(key, out e) && (e.Url != null || unchecked(now - e.MissAt) < 2000)) {
        seenNow[key] = e;
        return e.Url;
      }
      string url = null;
      try {
        const uint WM_GETICON = 0x007F, SMTO_ABORTIFHUNG = 0x0002;
        IntPtr h = IntPtr.Zero, res;
        if (Win32.SendMessageTimeoutW(hwnd, WM_GETICON, new IntPtr(1) /* ICON_BIG */, IntPtr.Zero, SMTO_ABORTIFHUNG, 100, out res) != IntPtr.Zero) h = res;
        if (h == IntPtr.Zero && Win32.SendMessageTimeoutW(hwnd, WM_GETICON, new IntPtr(2) /* ICON_SMALL2 */, IntPtr.Zero, SMTO_ABORTIFHUNG, 100, out res) != IntPtr.Zero) h = res;
        if (h != IntPtr.Zero) url = Icons.FromHIcon(h);
      } catch (Exception) {
        url = null;
      }
      e.Url = url;
      e.MissAt = now;
      seenNow[key] = e;
      return url;
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
    //
    // NONE OF THESE MAY WAIT ON ANOTHER APP'S THREAD (2026-09-27). They run on the focus lane
    // (Lanes.cs), but a lane that waits seconds still makes the NEXT click wait, and Focus is also
    // called from the switcher's own thread, the top bar and the clipboard history. Live, a focus
    // under Valorant took ~5.2 s. Measured against a fixture whose thread was asleep:
    //   ShowWindow(SW_RESTORE) on a minimised window  6,762 ms  (it SENDS WM_QUERYOPEN and waits)
    //   SetWindowPos, i.e. BringWindowToTop           6,757 ms  (it SENDS WM_WINDOWPOSCHANGING)
    //   AttachThreadInput itself                          1 ms  (but a call made WHILE attached,
    //                                                           like the activation
    //                                                           SetForegroundWindow sends, waits)
    //   ShowWindowAsync, SetWindowPos+ASYNCWINDOWPOS    0-1 ms
    // So the restore and the z-order are POSTED, and attach -> SetForegroundWindow -> detach runs
    // on a pool thread that Focus waits for at most AttachWaitMs (AttachAndRaise).

    /// How long Focus waits for the attach step before it stops waiting. Long enough for a loaded
    /// but healthy app to answer its activation; short enough that a game that is not answering
    /// costs one click under a second, not the 5.2 s measured live (and not the lane).
    public const int AttachWaitMs = 800;

    const int SW_SHOWNOACTIVATE = 4;
    const uint SWP_ASYNCWINDOWPOS = 0x4000;
    static readonly IntPtr HWND_TOP = IntPtr.Zero;

    static class N {
      [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
      // Never sends WM_GETTEXT, so a hung window cannot block the fixture check.
      [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
      public static extern int InternalGetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    }

    static int _helpersOut;
    /// Attach helpers Focus stopped waiting for that have not returned yet (ping reports it as
    /// load.focusHelpersOut). Each one detaches the moment its call returns.
    public static int HelpersOut { get { return System.Threading.Thread.VolatileRead(ref _helpersOut); } }

    sealed class Helper { public bool Done, Abandoned; }

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

      // POSTED: the restore lands when the window's own thread gets to it, and a hung one can
      // never hold us (the table above). SetForegroundWindow on a still-minimised window is fine:
      // the switcher's "direct" path has done it in this order since it shipped.
      if (Win32.IsIconic(hwnd)) Win32.ShowWindowAsync(hwnd, Win32.SW_RESTORE);

      IntPtr fg = Win32.GetForegroundWindow();
      if (fg == hwnd) return null;

      string late = AttachAndRaise(hwnd, fg, false, null);
      if (Win32.GetForegroundWindow() == hwnd) return null;
      // The helper is still attached to the app in front and waiting on it: an Alt tap now would
      // only race it. Say so; the window may still come forward when that app answers.
      if (late != null) return late;

      // Last resort: Windows relaxes the foreground lock for a process that has
      // just seen input, so we synthesise a bare Alt press/release. Not attached
      // here, so SetForegroundWindow posts the change and does not wait.
      Hotkey.TapAltForFocusLock();
      Win32.SetForegroundWindow(hwnd);
      if (Win32.GetForegroundWindow() == hwnd) return null;

      return "could not raise window " + hwnd.ToInt64() +
             ": Windows refused the foreground change (another app holds the foreground lock)";
    }

    /// The documented escalation step, BOUNDED: attach this thread's input to the thread in front
    /// (which is what lets Windows hand the foreground over), SetForegroundWindow, a POSTED raise to
    /// the top, detach. It runs on a pool thread and the caller waits at most AttachWaitMs. Null
    /// when it finished in time, else the words for the caller. The helper ALWAYS detaches, in its
    /// finally, whenever its call returns; HelpersOut counts the ones still out.
    ///
    /// No attach when the window in front is hung (IsHungAppWindow: ~5 s without pumping): joining
    /// the input queue of a thread that is not reading it is exactly the stall this exists to avoid.
    ///
    /// `rehearse` (focus.rehearse, the test only): attach to the TARGET's own thread (the fixture
    /// the test hung on purpose, standing in for a busy game) and, in place of SetForegroundWindow,
    /// make one synchronous no-op SetWindowPos on it - a call that waits on that thread exactly as
    /// the activation SetForegroundWindow sends while attached does. It never takes the foreground
    /// and never taps Alt, so a test run cannot move anything on Owen's screen.
    static string AttachAndRaise(IntPtr hwnd, IntPtr fg, bool rehearse, IDictionary steps) {
      IntPtr to = rehearse ? hwnd : fg;
      int toPid = 0;
      int toThread = to == IntPtr.Zero ? 0 : Win32.GetWindowThreadProcessId(to, out toPid);
      bool hung = to != IntPtr.Zero && N.IsHungAppWindow(to);
      bool wantAttach = toThread != 0 && !hung;
      if (steps != null) steps["attach"] = wantAttach ? "tried" : hung ? "skipped: that window is not responding" : "skipped: no thread to attach to";

      var h = new Helper();
      var done = new System.Threading.ManualResetEvent(false);
      bool attachedOk = false;
      System.Threading.ThreadPool.QueueUserWorkItem(delegate {
        int me = Win32.GetCurrentThreadId();
        bool attached = false;
        try {
          if (wantAttach && toThread != me) attached = Win32.AttachThreadInput(me, toThread, true);
          attachedOk = attached;
          if (!rehearse) Win32.SetForegroundWindow(hwnd);
          else if (attached) Win32.SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0,
                                                Win32.SWP_NOSIZE | Win32.SWP_NOMOVE | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
          // BringWindowToTop is a synchronous SetWindowPos(HWND_TOP): posted instead.
          Win32.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                             Win32.SWP_NOSIZE | Win32.SWP_NOMOVE | SWP_ASYNCWINDOWPOS | (rehearse ? Win32.SWP_NOACTIVATE : 0u));
        } catch (Exception) {
          // Nothing to add: the caller's own foreground check says whether it landed.
        } finally {
          if (attached) { try { Win32.AttachThreadInput(me, toThread, false); } catch (Exception) { } }
          lock (h) {
            h.Done = true;
            if (h.Abandoned) System.Threading.Interlocked.Decrement(ref _helpersOut);
          }
          try { done.Set(); } catch (ObjectDisposedException) { /* the caller finished first */ }
        }
      });

      bool inTime = done.WaitOne(AttachWaitMs);
      if (!inTime) {
        lock (h) {
          if (h.Done) inTime = true;
          else { h.Abandoned = true; System.Threading.Interlocked.Increment(ref _helpersOut); }
        }
      }
      if (steps != null) steps["attached"] = attachedOk;
      if (!inTime) return "the app in front" + (toPid > 0 ? " (pid " + toPid + ")" : "") + " did not answer within " +
                          AttachWaitMs + " ms while Mantle handed the foreground over, so Mantle stopped waiting; " +
                          "the window may still come forward once that app answers";
      done.Close();
      return null;
    }

    /// POSTED like Focus's restore: a synchronous ShowWindow on a hung window waits on it.
    public static string Minimize(IntPtr hwnd) {
      string bad = Check(hwnd);
      if (bad != null) return bad;
      Win32.ShowWindowAsync(hwnd, Win32.SW_MINIMIZE);
      return null;
    }

    // ---------------------------------------------------------- focus.rehearse (tests only)

    const string FixtureTitle = "Mantle focus fixture";
    const string FixtureExe = "mantle-focus-fixture.exe";

    /// The fixture sidecar/test-lanes.js compiles into %TEMP%, and only it: title, exe name AND an
    /// exe under %TEMP% (as WindowTop.IsFixture).
    static bool IsFixture(IntPtr hwnd) {
      var sb = new StringBuilder(256);
      N.InternalGetWindowText(hwnd, sb, sb.Capacity);
      if (!sb.ToString().StartsWith(FixtureTitle, StringComparison.Ordinal)) return false;
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      string exe = Win32.GetProcessPath(pid) ?? "";
      string temp;
      try { temp = System.IO.Path.GetFullPath(System.IO.Path.GetTempPath()); } catch (Exception) { return false; }
      return string.Equals(System.IO.Path.GetFileName(exe), FixtureExe, StringComparison.OrdinalIgnoreCase) &&
             exe.StartsWith(temp, StringComparison.OrdinalIgnoreCase);
    }

    /// `focus.rehearse {hwnd}`: every step of Focus that talks to another app's thread - the restore,
    /// the attach, a call made while attached, the raise - with the same code and the same bound,
    /// on the fixture only, without ever taking the foreground (AttachAndRaise's `rehearse`). Runs in
    /// passive, which is the point: `focus` itself is refused there. Answers what each step did.
    public static string Rehearse(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      string bad = Check(hwnd);
      if (bad != null) return bad;
      if (!IsFixture(hwnd))
        return "focus.rehearse only runs on the test fixture (\"" + FixtureTitle + "\", " + FixtureExe + " under %TEMP%)";
      var sw = System.Diagnostics.Stopwatch.StartNew();
      var steps = Json.Obj();
      bool iconic = Win32.IsIconic(hwnd);
      if (iconic) Win32.ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
      steps["restore"] = iconic ? "posted" : "not minimised";
      steps["late"] = AttachAndRaise(hwnd, IntPtr.Zero, true, steps);
      steps["ms"] = sw.ElapsedMilliseconds;
      steps["waitMs"] = AttachWaitMs;
      steps["helpersOut"] = HelpersOut;
      steps["thread"] = System.Threading.Thread.CurrentThread.Name ?? "ui";
      result = steps;
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

  /// focus.rehearse (WindowList.Rehearse): the test's way into Focus's blocking-prone steps.
  [MantleFeature]
  static class FocusRehearsal {
    public static void Register(FeatureTable t) {
      t.Add("focus.rehearse", Lanes.Ui, WindowList.Rehearse);
      // On the focus lane, like `focus`. FeatureTable.Add only accepts the lanes it knew when it was
      // written, so the lane is set here (Lanes.Register overwrites the one Add just registered).
      Lanes.Register("focus.rehearse", Lanes.Focus);
    }
  }
}
