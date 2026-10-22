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
    static Timer _timer;                    // Forms timer: ticks on the message-loop thread; ONE-SHOT, see Arm
    static Timer _pollTimer;                // the 2 s safety-net poll, always running
    static bool _dirty;                     // a structural WinEvent arrived since the last build
    static bool _titleDirty;                // a listed window's title changed and has not been sent yet
    static string _sig = null;              // signature of the last emitted list
    static string _shapeSig = null;         // the same, titles left out: what the consumers react to at once
    static bool _firstEmitted;
    static int _lastEmitAt;                 // Environment.TickCount of the last `ev windows`
    // The hwnds in the last built list. Read by the hook proc (same thread) to tell a listed
    // window's title change (coalesced) from anything else (immediate). Replaced, never mutated.
    static HashSet<long> _listed = new HashSet<long>();
    // The icon last SENT for each hwnd in the last emitted list. An entry whose icon is the same
    // is sent without its "icon" key, and main puts the one it kept back (lib/winlist-icons.js).
    static Dictionary<string, string> _sentIcons = new Dictionary<string, string>(StringComparer.Ordinal);

    const int TickMs = 250;                 // coalescing window for structural changes
    const int PollMs = 2000;                // the safety-net poll
    const int TitleEveryMs = 1000;          // title-only changes go out at most once a second

    // IDLE CPU (idlefix-winlist, 2026-10-17). A terminal with a spinner in its title (Claude Code)
    // renames its window ~4 times a second. Each rename used to be a full Build, an `ev windows`
    // carrying every window's icon data-URL, and in main a broadcast to every renderer plus a pinned
    // rebuild: ~4 Hz forever. Now (1) the 250 ms timer only runs while something is owed (the hook
    // proc arms it), the 2 s poll stays; (2) a rename of a window already in the list is held to one
    // list a second -- anything structural (a window appearing or going, minimised, foreground, an
    // unlisted window's rename, which can make it listable) still goes out on the next 250 ms tick,
    // and carries any held titles with it; (3) icons ride a list only when they changed for that
    // hwnd (or the hwnd is new); main reassembles the exact same full list for every consumer.

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
      _timer.Start();                     // the first list is owed: it runs until that is sent
      _pollTimer = new Timer();
      _pollTimer.Interval = PollMs;
      _pollTimer.Tick += OnPoll;
      _pollTimer.Start();
    }

    /// Start the 250 ms timer if it is not running. Loop thread only (the hook proc, Build, OnTick):
    /// a Forms timer belongs to the thread that made it. Cheap: a field read when it already runs.
    static void Arm() {
      Timer t = _timer;
      if (t != null && !t.Enabled) t.Start();
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
      try { if (_pollTimer != null) _pollTimer.Stop(); } catch (Exception) { }
      _hookSystem = Unhook(_hookSystem);
      _hookObject = Unhook(_hookObject);
      return _hookSystem == IntPtr.Zero && _hookObject == IntPtr.Zero;
    }

    static IntPtr Unhook(IntPtr h) {
      if (h == IntPtr.Zero) return h;
      try { return Win32.UnhookWinEvent(h) ? IntPtr.Zero : h; } catch (Exception) { return h; }
    }

    /// Hook procs must return in microseconds: no I/O, no allocation, no work.
    /// All we do is raise a flag and arm the 250 ms timer that picks it up.
    static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      // Exiting: a burst of these can keep the loop from ever reaching the
      // posted park request, so the first one to arrive parks it instead.
      if (Program.ParkWanted) Program.ParkLoopIfAsked();
      if (idObject != Win32.OBJID_WINDOW) return;   // ignore caret/menu/focus sub-objects
      if (hwnd == IntPtr.Zero) return;
      // A rename of a window the list already has is a title change and nothing else: held to one
      // list a second. Any other rename (a child control, a hidden window, a window whose first
      // title makes it listable) is structural, as before: built on the next tick.
      if (ev == Win32.EVENT_OBJECT_NAMECHANGE && _listed.Contains(hwnd.ToInt64())) _titleDirty = true;
      else _dirty = true;
      Arm();
    }

    static void OnTick(object sender, EventArgs e) { Step(false); }
    static void OnPoll(object sender, EventArgs e) { Step(true); }

    static void Step(bool poll) {
      if (Program.ParkWanted) Program.ParkLoopIfAsked();
      // Icons read off the ui lane have landed (QueueIcon): the list is sent again even though the
      // signature (which leaves icons out) has not moved. Same when an app's exe changed on disk
      // and its new picture was read in the background (Icons.TakeRefreshed: a rebuilt app), or a
      // Store app's package changed and its new picture was read (Apps.TakeRefreshed: an update).
      bool landed = _iconsLanded;
      if (landed) _iconsLanded = false;
      if (Icons.TakeRefreshed()) landed = true;
      if (Apps.TakeRefreshed()) landed = true;
      // The desktop widgets' covered check (WidgetCover.cs) rides the same hooks: a window event since
      // the last tick (a move is LOCATIONCHANGE, in the object range above), or the 2 s safety poll.
      if (_dirty || poll) WidgetCover.Tick();
      bool titleDue = _titleDirty && unchecked(Environment.TickCount - _lastEmitAt) >= TitleEveryMs;
      if (_dirty || poll || landed || !_firstEmitted || titleDue) {
        _dirty = false;
        try {
          EmitIfChanged(!_firstEmitted || landed);
        } catch (Exception ex) {
          Program.EmitLog("error", "window poll failed: " + ex.Message);
        }
      }
      // One-shot: the 250 ms timer stops once nothing is owed -- no structural change waiting, no
      // held title, no icon being read, the first list sent. The next window event arms it again.
      if (!_dirty && !_titleDirty && _firstEmitted && !WarmBusy()) {
        Timer t = _timer;
        if (t != null) t.Stop();
      }
    }

    /// Rebuild, compare, and emit only when something a human would notice moved.
    /// `force` makes the very first emit unconditional so the Electron side has a
    /// list within the first 2 s without having to ask for one. A change of titles
    /// alone is held until a second has passed since the last emit (_titleDirty
    /// keeps the timer running until then); any other change goes now, titles and all.
    public static void EmitIfChanged(bool force) {
      var list = Build();
      var listed = new HashSet<long>();
      foreach (IDictionary d in list) {
        long h;
        if (long.TryParse((string)d["hwnd"], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out h)) listed.Add(h);
      }
      _listed = listed;
      string shape = ShapeSignature(list);
      string sig = shape + "\u0003" + TitleSignature(list);
      if (!force && sig == _sig) { _titleDirty = false; return; }
      if (!force && shape == _shapeSig && unchecked(Environment.TickCount - _lastEmitAt) < TitleEveryMs) {
        _titleDirty = true;   // titles only, and a list went out under a second ago: hold it
        Arm();                // (found by the 2 s poll with no hook event: the 250 ms timer sends it)
        return;
      }
      _sig = sig;
      _shapeSig = shape;
      _titleDirty = false;
      _firstEmitted = true;
      _lastEmitAt = Environment.TickCount;
      Program.Emit(Json.Obj("ev", "windows", "list", WithoutSentIcons(list), "iconDiff", true));
    }

    /// The emitted copy of the list: an entry whose icon is the one last sent for its hwnd has no
    /// "icon" key (main fills it back in, lib/winlist-icons.js); a new hwnd or a changed icon has it.
    /// _sentIcons then holds exactly this list's hwnds, so a closed window's icon is not kept.
    static List<object> WithoutSentIcons(List<object> list) {
      var sent = new Dictionary<string, string>(StringComparer.Ordinal);
      var outList = new List<object>(list.Count);
      foreach (IDictionary d in list) {
        string h = (string)d["hwnd"];
        string icon = d["icon"] as string;
        string prev;
        bool same = _sentIcons.TryGetValue(h, out prev) && string.Equals(prev, icon, StringComparison.Ordinal);
        sent[h] = icon;
        if (!same) { outList.Add(d); continue; }
        var e = new System.Collections.Specialized.OrderedDictionary();
        foreach (DictionaryEntry kv in d) if ((string)kv.Key != "icon") e[kv.Key] = kv.Value;
        outList.Add(e);
      }
      _sentIcons = sent;
      return outList;
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
          // Same order as ever (a Store app's package icon, else the exe's), but ONLY from what is
          // already known: reading an icon is never done here, on the ui lane (see QueueIcon).
          bool pkg = icon == null && app.Aumid != null && (app.Host == "frame" || Apps.IsPackagedPath(exe));
          bool pending = false;
          if (pkg) {
            if (!Apps.TryIconCached(app.Aumid, out icon)) pending = true;
            else if (icon != null) iconFrom = "package";
          }
          if (icon == null && !pending && exe.Length > 0) {
            if (!Icons.TryCached(exe, out icon)) pending = true;
            else if (icon != null) iconFrom = "exe";
          }
          if (pending) pending = QueueIcon(pkg ? app.Aumid : null, exe);
          // Build runs on the loop thread (OnTick, or the ui lane's `windows` request), so the
          // one-shot timer can be armed here: the list with the icon follows within ~1 s.
          if (pending) Arm();

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
            "iconFrom", iconFrom,
            // true: its icon is being read off the ui lane and a fresh list follows within ~1 s
            // (icon is null meanwhile; a caller shows no icon rather than guess one).
            "iconPending", pending));
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

    // ------------------------------------------- app icons, read OFF the ui lane
    //
    // Lane r7-fg, 2026-10-01. MEASURED (a diagnostic build, 2 ship-style --test starts): the first
    // list after the sidecar starts took 1025-1093 ms, 952-961 ms of it reading icons (2 Store apps'
    // package icons ~580 ms, 6 exe icons ~380 ms; app ids only 15-84 ms). That ran on the ui lane, so
    // every quick request queued behind it at start waited 1.4-1.9 s (ping, place, glass, foreground),
    // and a front-window check with a 1.5 s budget ran out. Now Build takes only icons already known;
    // one it lacks is read here, on a background STA thread (a package icon is a shell COM read), in
    // the same order as before, and the next 250 ms tick sends the whole list again with it. Nothing
    // is guessed meanwhile: the window says iconPending and has no icon. The caches are never emptied,
    // so each app's icon is read once per sidecar run, as before -- except an exe that changes on
    // disk (a rebuilt or updated app): Icons re-reads that one itself (Icons.TryCached, TakeRefreshed),
    // and a Store app whose package changed (an update): Apps re-reads that one itself the same way
    // (Apps.TryIconCached, TakeRefreshed; storeicons, 2026-10-08).
    static readonly object _warmLock = new object();
    static readonly List<string[]> _warmQueue = new List<string[]>();     // { aumid or null, exe, key }
    static readonly HashSet<string> _warmQueued = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static readonly HashSet<string> _warmTried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static System.Threading.Thread _warmThread;
    static volatile bool _iconsLanded;     // read by OnTick: send the list again, with the new icons

    /// A window's icon is not known yet: read it off the ui lane. -> true while it is being read;
    /// false once it was read and is still unknown (that app has no icon: never asked again).
    static bool QueueIcon(string aumid, string exe) {
      string key = (aumid ?? "") + "|" + (exe ?? "");
      lock (_warmLock) {
        if (_warmTried.Contains(key)) return false;
        if (_warmQueued.Add(key)) _warmQueue.Add(new string[] { aumid, exe, key });
        if (_warmThread != null) return true;
        try {
          var t = new System.Threading.Thread(WarmIcons);
          t.IsBackground = true;
          t.Name = "mantle-icon-read";
          t.SetApartmentState(System.Threading.ApartmentState.STA);
          t.Start();
          _warmThread = t;
          return true;
        } catch (Exception ex) {
          foreach (string[] j in _warmQueue) { _warmQueued.Remove(j[2]); _warmTried.Add(j[2]); }
          _warmQueue.Clear();
          Program.EmitLog("warn", "app icons could not be read in the background, so the bar shows those apps without one (" + ex.Message + ")");
          return false;
        }
      }
    }

    static void WarmIcons() {
      while (true) {
        string[] job;
        lock (_warmLock) {
          // _iconsLanded BEFORE _warmThread goes null, both under the lock: WarmBusy never sees
          // "not reading" without "landed", so the one-shot timer cannot stop in between.
          if (_warmQueue.Count == 0) { _iconsLanded = true; _warmThread = null; break; }
          job = _warmQueue[0];
          _warmQueue.RemoveAt(0);
        }
        try {
          // Fills the same caches Build reads (Apps._iconCache, Icons._cache); both remember a miss too.
          string icon = job[0] != null ? Apps.IconFor(job[0]) : null;
          if (icon == null && !string.IsNullOrEmpty(job[1])) Icons.ForPath(job[1]);
        } catch (Exception ex) {
          Program.EmitLog("warn", "an app icon could not be read: " + ex.Message);
        }
        lock (_warmLock) { _warmQueued.Remove(job[2]); _warmTried.Add(job[2]); }
      }
      // all read: _iconsLanded was set above, so one fresh list goes on the next tick, not one per icon
    }

    /// Icons are being read, or have landed and not been sent: the 250 ms timer must keep running.
    static bool WarmBusy() {
      lock (_warmLock) { return _warmThread != null || _iconsLanded; }
    }

    // ------------------------------------------------------ a window's OWN icon
    //
    // Icons lane, 2026-09-28. The user: "they need to have there own icons that replace windows
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

    /// Cheap fingerprint of the things the bar renders, in two halves: the shape (which windows,
    /// in which order, minimised, in front) and the titles. Together they are the old signature.
    /// Icons are excluded because they are a pure function of the exe path.
    static string ShapeSignature(List<object> list) {
      var sb = new StringBuilder(list.Count * 32);
      foreach (IDictionary d in list) {
        sb.Append(d["hwnd"]).Append('\u0001')
          .Append(d["minimized"]).Append('\u0001')
          .Append(d["foreground"]).Append('\u0002');
      }
      return sb.ToString();
    }

    static string TitleSignature(List<object> list) {
      var sb = new StringBuilder(list.Count * 32);
      foreach (IDictionary d in list) sb.Append(d["title"]).Append('\u0002');
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
      // SetLastError, unlike Win32's: the ladder reports WHY an attach was refused.
      [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
      public static extern bool AttachThreadInput(int idAttach, int idAttachTo, bool attach);
      // The last rung. Not "intended for general use" (MSDN), but it is what Windows' own Alt+Tab
      // called for years and it activates where a refused SetForegroundWindow only flashes.
      [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);
      // The input desktop check (InputElsewhere). SetLastError: a refused open says why.
      [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
      public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
      [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hdesk);
      [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(int threadId);
      [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
      public static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, int length, out int needed);
      // focus.inputdesk {offDesktop:true} only: a scratch desktop that is never switched to.
      [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
      public static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr sa);
      [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hdesk);
    }

    const uint DESKTOP_READOBJECTS = 0x0001;
    const uint DESKTOP_CREATEWINDOW = 0x0002;
    const int UOI_NAME = 2;

    static string DeskName(IntPtr hdesk) {
      if (hdesk == IntPtr.Zero) return null;
      var sb = new StringBuilder(256);
      int needed;
      return N.GetUserObjectInformationW(hdesk, UOI_NAME, sb, sb.Capacity * 2, out needed) ? sb.ToString() : null;
    }

    /// Null when the desktop that gets the keyboard and mouse is this thread's own; else why not, in
    /// words (lane wk-mantle-focus, 2026-10-14). While the PIN box of the sign-in screen (or a UAC
    /// prompt) is up, the input desktop is Windows' secure desktop, which a user process may not even
    /// open (error 5). Measured on a thread whose desktop was not the input desktop: GetForegroundWindow
    /// answers NULL (the live log's "attach: skipped: no thread to attach to") and GetCursorPos fails
    /// with error 5. No rung can win there, and the Alt rung would type into the switch. A name that
    /// cannot be read counts as ours: the ladder then runs exactly as before.
    public static string InputElsewhere() {
      IntPtr input = N.OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
      if (input == IntPtr.Zero) {
        int e = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
        return "the sign-in or lock screen has the keyboard (Windows' secure desktop" +
               (e != 0 ? ", which Mantle may not open: error " + e : "") + ")";
      }
      try {
        string inName = DeskName(input);
        string mine = DeskName(N.GetThreadDesktop(Win32.GetCurrentThreadId()));
        if (inName == null || mine == null || string.Equals(inName, mine, StringComparison.OrdinalIgnoreCase)) return null;
        return "another desktop has the keyboard (\"" + inName + "\", not Mantle's \"" + mine + "\")";
      } finally {
        N.CloseDesktop(input);
      }
    }

    /// `focus.inputdesk {offDesktop?}`: read-only. {ours, words, input, thread} for the sidecar's own
    /// thread. offDesktop:true runs the SAME check on a thread moved to a scratch desktop that is never
    /// switched to (nothing is shown), which is what Mantle's threads are while the secure desktop has
    /// the input, so the "elsewhere" branch runs on the real Win32 calls; the desktop is closed after.
    public static string InputDesk(Dictionary<string, object> req, ref object result) {
      if (!Json.GetBool(req, "offDesktop", false)) {
        string w = InputElsewhere();
        result = Json.Obj("ours", w == null, "words", w, "thread", DeskName(N.GetThreadDesktop(Win32.GetCurrentThreadId())));
        return null;
      }
      IntPtr scratch = N.CreateDesktopW("mantle-focus-test-" + System.Diagnostics.Process.GetCurrentProcess().Id + "-" + Environment.TickCount,
                                        IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW, IntPtr.Zero);
      if (scratch == IntPtr.Zero) return "could not make a scratch desktop (error " + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")";
      try {
        string words = null, thread = null, setErr = null;
        var t = new System.Threading.Thread(delegate () {
          if (!N.SetThreadDesktop(scratch)) { setErr = "SetThreadDesktop failed (error " + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")"; return; }
          thread = DeskName(N.GetThreadDesktop(Win32.GetCurrentThreadId()));
          words = InputElsewhere();
        });
        t.IsBackground = true;
        t.Start();
        if (!t.Join(2000)) return "the scratch-desktop check did not finish within 2 s";
        if (setErr != null) return setErr;
        result = Json.Obj("ours", words == null, "words", words, "thread", thread);
        return null;
      } finally {
        N.CloseDesktop(scratch);
      }
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

    /// Raise a window owned by another process. Windows deliberately makes this hard (the
    /// foreground lock), so this is an escalation ladder (FocusLadder below): direct ->
    /// AttachThreadInput -> the Alt nudge -> SwitchToThisWindow. Each rung is only taken if the one
    /// before did not land, and if none do we say so, rung by rung, rather than reporting a
    /// success that did not happen.
    public static string Focus(IntPtr hwnd) { return Focus(hwnd, null); }

    /// Focus, filling `report` (when given) with how it went: {how: already|direct|attach|alt|switch
    /// or null, tried: ["direct: refused", ...], ms}. No titles, names or paths in it (privacy).
    public static string Focus(IntPtr hwnd, IDictionary report) {
      string bad = Check(hwnd);
      if (bad != null) return bad;
      return FocusLadder.Run(hwnd, LiveOps.Instance, report);
    }

    /// How long a rung's accepted SetForegroundWindow gets to show in GetForegroundWindow. The
    /// activation of another thread's window is handed to that thread, and until it runs Windows
    /// can still report the app's previously active window (a second Quartz window, the window
    /// whose dialog is up) - the old ladder read it at once and called a win a refusal.
    public const int LandMs = 150;

    /// The real Win32 side of the ladder.
    sealed class LiveOps : FocusLadder.IOps {
      public static readonly LiveOps Instance = new LiveOps();
      public IntPtr Root(IntPtr h) {
        if (h == IntPtr.Zero) return h;
        IntPtr r = Win32.GetAncestor(h, Win32.GA_ROOTOWNER);
        return r == IntPtr.Zero ? h : r;
      }
      public IntPtr ForegroundRoot() { return Root(Win32.GetForegroundWindow()); }
      public string InputElsewhere() { return WindowList.InputElsewhere(); }
      // POSTED: the restore lands when the window's own thread gets to it, and a hung one can
      // never hold us (the table above). SetForegroundWindow on a still-minimised window is fine.
      public bool RestoreIfMinimised(IntPtr h) {
        if (!Win32.IsIconic(h)) return false;
        Win32.ShowWindowAsync(h, Win32.SW_RESTORE);
        return true;
      }
      // A window with a modal dialog up is really the dialog (Windows' own switcher does this).
      public IntPtr ActivationTarget(IntPtr h) {
        IntPtr popup = KeysNative.GetLastActivePopup(h);
        return popup != IntPtr.Zero && popup != h && Win32.IsWindowVisible(popup) &&
               KeysNative.IsWindowEnabled(popup) ? popup : h;
      }
      public bool SetForeground(IntPtr h) { return Win32.SetForegroundWindow(h); }
      public string Attach(IntPtr h, out string attach, out bool accepted) {
        var steps = Json.Obj();
        string late = AttachAndRaise(h, Win32.GetForegroundWindow(), false, steps);
        attach = steps["attachWords"] as string ?? "not tried";
        accepted = steps["sfw"] is bool && (bool)steps["sfw"];
        return late;
      }
      public void AltNudge() { Hotkey.TapAltForFocusLock(); }
      public string SwitchTo(IntPtr h) { return Bounded(delegate { N.SwitchToThisWindow(h, true); }, "SwitchToThisWindow"); }
      public bool WaitLanded(IntPtr root, int ms) {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true) {
          if (ForegroundRoot() == root) return true;
          if (sw.ElapsedMilliseconds >= ms) return false;
          System.Threading.Thread.Sleep(5);
        }
      }
    }

    /// Run `work` on a pool thread and wait at most AttachWaitMs, like AttachAndRaise: null when it
    /// finished in time, else the words for the caller. HelpersOut counts the ones still out.
    static string Bounded(System.Threading.WaitCallback work, string what) {
      var h = new Helper();
      var done = new System.Threading.ManualResetEvent(false);
      System.Threading.ThreadPool.QueueUserWorkItem(delegate {
        try { work(null); } catch (Exception) { /* the caller's own foreground check says whether it landed */ }
        finally {
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
      if (!inTime) return what + " did not return within " + AttachWaitMs + " ms, so Mantle stopped waiting";
      done.Close();
      return null;
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
    /// and never taps Alt, so a test run cannot move anything on the user's screen.
    static string AttachAndRaise(IntPtr hwnd, IntPtr fg, bool rehearse, IDictionary steps) {
      IntPtr to = rehearse ? hwnd : fg;
      int toPid = 0;
      int toThread = to == IntPtr.Zero ? 0 : Win32.GetWindowThreadProcessId(to, out toPid);
      bool hung = to != IntPtr.Zero && N.IsHungAppWindow(to);
      bool wantAttach = toThread != 0 && !hung;
      if (steps != null) steps["attach"] = wantAttach ? "tried" : hung ? "skipped: that window is not responding" : "skipped: no thread to attach to";

      var h = new Helper();
      var done = new System.Threading.ManualResetEvent(false);
      bool attachedOk = false, sfw = false;
      int attachErr = 0;
      System.Threading.ThreadPool.QueueUserWorkItem(delegate {
        int me = Win32.GetCurrentThreadId();
        bool attached = false;
        try {
          if (wantAttach && toThread != me) {
            attached = N.AttachThreadInput(me, toThread, true);
            if (!attached) attachErr = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
          }
          attachedOk = attached;
          if (!rehearse) sfw = Win32.SetForegroundWindow(hwnd);
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
      if (steps != null) {
        steps["attached"] = attachedOk;
        steps["sfw"] = inTime && sfw;
        // Plain words for the ladder's report. Error 5 is UIPI: the window in front runs as
        // administrator and Mantle does not, so Windows will not let it join that input queue.
        steps["attachWords"] = !wantAttach ? (string)steps["attach"]
                             : attachedOk ? "attached"
                             : attachErr == 5 ? "attach refused (the window in front runs as administrator)"
                             : "attach failed (error " + attachErr + ")";
      }
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

    /// `focus.fixture {hwnd, onScreen:true}`: the real Focus, with its report, on a focus-lab window
    /// only. It DOES take the foreground (onto the lab's own window), so it also wants onScreen:true,
    /// which only sidecar/focus-lab-run.js sends, inside the visible slot. Runs in passive: `focus`
    /// itself is refused there. Answers the report and the error words (null when it landed).
    public static string FixtureFocus(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      string bad = Check(hwnd);
      if (bad != null) return bad;
      if (!IsFixture(hwnd))
        return "focus.fixture only runs on the test fixture (\"" + FixtureTitle + "\", " + FixtureExe + " under %TEMP%)";
      if (!Json.GetBool(req, "onScreen", false))
        return "focus.fixture takes the real foreground, so it wants onScreen:true (the visible slot only)";
      var rep = Json.Obj();
      rep["error"] = Focus(hwnd, rep);
      result = rep;
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
    public static string Toggle(IntPtr hwnd) { return Toggle(hwnd, null); }
    public static string Toggle(IntPtr hwnd, IDictionary report) {
      string bad = Check(hwnd);
      if (bad != null) return bad;
      if (Win32.GetForegroundWindow() == hwnd) {
        if (report != null) report["how"] = "minimized";
        return Minimize(hwnd);
      }
      return Focus(hwnd, report);
    }
  }

  /// THE LADDER, as logic only (2026-10-12, lane mn-focus). The Win32 side is behind IOps so
  /// `focus.simulate` can drive every branch with a script, in passive, without touching a window.
  ///
  /// WHY CLICKS ON THE BAR LOST (live log, 10-10 to 10-12: 24 "did not open / did not switch"): the
  /// bar is focusable:false, so a click on it leaves the app the user was in as the foreground process,
  /// and the click itself lands in Electron's process. The process that then called
  /// SetForegroundWindow was the sidecar, which is neither - and with ForegroundLockTimeout at its
  /// maximum on this machine, Windows never relents on time. main.js now hands the right on
  /// (AllowSetForegroundWindow(sidecar pid), from the process that got the click, as switcher.pick
  /// already did), so rung 1 is a plain SetForegroundWindow and is expected to win. The others stay
  /// for callers with no click behind them (the clipboard history, a desktop switch).
  ///
  /// MEASURED ON SCREEN (sidecar/focus-lab.js, Windows 10.0.26300, 3 trials each, a real lock: app A
  /// clicked to the front, then a non-activating "bar" clicked, then another process asks for B):
  ///   SetForegroundWindow alone                refused every time (returns FALSE)
  ///   AttachThreadInput to A, then SFW         attach succeeds, SFW STILL refused: no longer a way in
  ///   bare Alt tap, then SFW                   accepted, but B showed in front 0-50 ms LATER in 2 of 3,
  ///                                            which the old ladder's immediate check called a refusal
  ///   Alt + VK 0xFF, then SFW                  accepted, in front by 50 ms every time
  ///   SwitchToThisWindow                       never landed
  ///   the bar's AllowSetForegroundWindow, SFW  "direct", in front in 5-12 ms every time
  /// So: the hand-over is the fix, the alt rung is the real fallback (25-29 ms), and LandMs matters.
  ///
  /// AFTER THE HAND-OVER WENT LIVE (10-12 22:32 to 10-13 23:39): every bar click "direct ... right
  /// granted" (13 of 13), no bar refusals. The only refusals left were Task View opened by the
  /// top-left hot corner 0.35-0.45 s after "the lock screen closed", five of five: the PIN box had the
  /// input (secure desktop), GetCursorPos fails there (error 5, measured), and Electron's
  /// screen.getCursorScreenPoint() does not report a failure, so the cursor read as resting in the
  /// top-left corner (inferred: all five fires were that corner; fixed in
  /// lib/features/corners.js). Rung 0 (InputElsewhere) makes the ladder say that, not "another app
  /// holds the foreground lock", and keeps it from typing an Alt into the desktop switch.
  static class FocusLadder {
    public interface IOps {
      IntPtr Root(IntPtr h);
      IntPtr ForegroundRoot();
      /// Null when the input desktop is ours; else why not (WindowList.InputElsewhere).
      string InputElsewhere();
      bool RestoreIfMinimised(IntPtr h);
      IntPtr ActivationTarget(IntPtr h);
      bool SetForeground(IntPtr h);
      /// AttachThreadInput to the thread in front + SetForegroundWindow, bounded. Null when it
      /// returned in time (else the words); attach says what the attach did; accepted is the
      /// SetForegroundWindow return value.
      string Attach(IntPtr h, out string attach, out bool accepted);
      void AltNudge();
      /// Bounded SwitchToThisWindow: null when it returned in time, else the words.
      string SwitchTo(IntPtr h);
      bool WaitLanded(IntPtr root, int ms);
    }

    public static string Run(IntPtr hwnd, IOps ops, IDictionary report) {
      var sw = System.Diagnostics.Stopwatch.StartNew();
      var tried = new List<object>();
      string how = null, err = null;
      // 0. Is the keyboard even on our desktop? While the PIN box or a UAC prompt is up it is not,
      //    and every rung below loses (the live log, 10-13: five Task View opens right after "the
      //    lock screen closed", each "direct: refused; attach: skipped: no thread to attach to,
      //    refused; alt: refused; switch: ..."). Say so, and touch nothing: no restore, no Alt.
      string away = ops.InputElsewhere();
      if (away != null) {
        err = "could not raise window " + hwnd.ToInt64() + ": " + away + ", so no window can come forward until it closes";
        if (report != null) {
          report["how"] = null;
          report["tried"] = tried;
          report["restored"] = false;
          report["inputDesktop"] = away;
          report["ms"] = sw.ElapsedMilliseconds;
        }
        return err;
      }
      IntPtr root = ops.Root(hwnd);
      bool restored = ops.RestoreIfMinimised(hwnd);
      if (ops.ForegroundRoot() == root) how = "already";
      else {
        IntPtr to = ops.ActivationTarget(hwnd);
        // 1. direct: lands whenever this process holds a foreground right (main hands it on at
        //    the click). A refused call answers FALSE at once, so only an accepted one waits.
        bool ok = ops.SetForeground(to);
        if (ok && ops.WaitLanded(root, WindowList.LandMs)) how = "direct";
        else {
          tried.Add(ok ? "direct: accepted, but another window stayed in front" : "direct: refused");
          // 2. attach: join the input queue of the thread in front, which may hand the
          //    foreground over.
          string attach; bool acc;
          string late = ops.Attach(to, out attach, out acc);
          if (ops.WaitLanded(root, late == null && acc ? WindowList.LandMs : 0)) how = "attach";
          else if (late != null) {
            // The helper is still attached to the app in front and waiting on it: anything more
            // now would only race it. The window may still come forward when that app answers.
            tried.Add("attach: " + late);
            err = late;
          } else {
            tried.Add("attach: " + attach + ", " + (acc ? "accepted, but another window stayed in front" : "refused"));
            // 3. alt: an injected Alt (with a partner key so the app in front does not open its
            //    menu - an open menu is itself a reason Windows refuses) then try again.
            ops.AltNudge();
            ok = ops.SetForeground(to);
            if (ok && ops.WaitLanded(root, WindowList.LandMs)) how = "alt";
            else {
              tried.Add(ok ? "alt: accepted, but another window stayed in front" : "alt: refused");
              // 4. switch: SwitchToThisWindow, bounded like the attach.
              string slate = ops.SwitchTo(to);
              if (ops.WaitLanded(root, slate == null ? WindowList.LandMs : 0)) how = "switch";
              else tried.Add("switch: " + (slate ?? "another window stayed in front"));
            }
          }
        }
      }
      if (how == null && err == null)
        err = "could not raise window " + hwnd.ToInt64() +
              ": Windows refused the foreground change (another app holds the foreground lock); tried " +
              string.Join("; ", tried.ConvertAll(x => (string)x).ToArray());
      if (report != null) {
        report["how"] = how;
        report["tried"] = tried;
        report["restored"] = restored;
        report["ms"] = sw.ElapsedMilliseconds;
      }
      return err;
    }

    /// `focus.simulate {script}`: the ladder against made-up Windows behaviour. Pure. script:
    ///   {elsewhere?: bool (the secure desktop has the input), already?, direct?: bool,
    ///    directLands?: bool, attach?: 'ok'|'refused'|'failed'|'late', alt?: bool, switchLands?: bool,
    ///    switchLate?: bool}
    /// Answers {how, error, tried, calls}: calls is every IOps call in order.
    public static string Simulate(Dictionary<string, object> req, ref object result) {
      object raw;
      var script = Json.TryGet(req, "script", out raw) ? raw as IDictionary : null;
      if (script == null) return "focus.simulate needs a script: {elsewhere?, already?, direct?, directLands?, attach?, alt?, switchLands?, switchLate?}";
      var ops = new ScriptOps(script);
      var rep = Json.Obj();
      string err = Run(new IntPtr(4242), ops, rep);
      rep["error"] = err;
      rep["calls"] = ops.Calls;
      result = rep;
      return null;
    }

    sealed class ScriptOps : IOps {
      readonly IDictionary s;
      public readonly List<object> Calls = new List<object>();
      bool landed;
      public ScriptOps(IDictionary script) { s = script; }
      bool B(string k) { return s.Contains(k) && s[k] is bool && (bool)s[k]; }
      string S(string k) { return s.Contains(k) ? s[k] as string : null; }
      public IntPtr Root(IntPtr h) { return h; }
      public IntPtr ForegroundRoot() { Calls.Add("foreground"); return B("already") || landed ? new IntPtr(4242) : new IntPtr(7); }
      public string InputElsewhere() {
        Calls.Add("inputdesk");
        return B("elsewhere") ? "the sign-in or lock screen has the keyboard (Windows' secure desktop, which Mantle may not open: error 5)" : null;
      }
      public bool RestoreIfMinimised(IntPtr h) { Calls.Add("restore"); return B("minimised"); }
      public IntPtr ActivationTarget(IntPtr h) { return h; }
      int sets;
      public bool SetForeground(IntPtr h) {
        sets++;
        Calls.Add(sets == 1 ? "direct" : "alt-set");
        bool ok = sets == 1 ? B("direct") : B("alt");
        if (ok && (sets > 1 || !s.Contains("directLands") || B("directLands"))) landed = true;
        return ok;
      }
      public string Attach(IntPtr h, out string attach, out bool accepted) {
        Calls.Add("attach");
        string a = S("attach") ?? "refused";
        attach = a == "failed" ? "attach refused (the window in front runs as administrator)" : "attached";
        accepted = a == "ok";
        if (a == "ok") landed = true;
        return a == "late" ? "the app in front did not answer within " + WindowList.AttachWaitMs + " ms" : null;
      }
      public void AltNudge() { Calls.Add("alt-nudge"); }
      public string SwitchTo(IntPtr h) {
        Calls.Add("switch");
        if (B("switchLands")) landed = true;
        return B("switchLate") ? "SwitchToThisWindow did not return within " + WindowList.AttachWaitMs + " ms, so Mantle stopped waiting" : null;
      }
      public bool WaitLanded(IntPtr root, int ms) { Calls.Add("wait " + ms); return landed; }
    }
  }

  /// focus.rehearse (WindowList.Rehearse): the test's way into Focus's blocking-prone steps.
  /// focus.simulate: the ladder's logic on a script. focus.fixture: the REAL ladder, on the focus
  /// lab's own windows only (sidecar/focus-lab.js), for the on-screen check in the visible slot.
  [MantleFeature]
  static class FocusRehearsal {
    public static void Register(FeatureTable t) {
      t.Add("focus.simulate", Lanes.Ui, FocusLadder.Simulate);
      t.Add("focus.fixture", Lanes.Ui, WindowList.FixtureFocus);
      Lanes.Register("focus.fixture", Lanes.Focus);
      t.Add("focus.inputdesk", Lanes.Ui, WindowList.InputDesk);
      t.Add("focus.rehearse", Lanes.Ui, WindowList.Rehearse);
      // On the focus lane, like `focus`. FeatureTable.Add only accepts the lanes it knew when it was
      // written, so the lane is set here (Lanes.Register overwrites the one Add just registered).
      Lanes.Register("focus.rehearse", Lanes.Focus);
    }
  }
}
