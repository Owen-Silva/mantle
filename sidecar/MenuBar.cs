// MenuBar.cs - `topbar.*`: the sidecar half of the macOS-style menu bar (wave 3, 2026-09-24).
//
// The user: "it might be cool to make the thing that macbooks have at the very top of your screen".
// The top bar shows the FOCUSED app's name and ITS menus. Windows has no one place that answers
// "what are this app's menus", so this file asks the two places that exist:
//
//   Win32     GetMenu(hwnd) + GetMenuItemInfoW. A classic menu bar is a USER object, so another
//             process can read it without sending the app a single message: a hung app cannot
//             stall the read, and reading changes nothing. Invoking an item is WM_COMMAND with its
//             id - exactly what the app's own menu loop posts when the item is clicked.
//   UIA       for frameworks that draw their own menu bar but describe it to UI Automation
//             (WinForms MenuStrip, WPF Menu, WinUI MenuBar - e.g. the new Notepad). Only the items
//             the app has already built are readable; a submenu the app builds on open is marked
//             `lazy`, and opening it opens the APP's own menu (live only, user-driven).
//
// Chromium and Electron windows (Chrome_WidgetWin_*) have neither, and asking UIA about them is
// not free: the first UIA client turns on Chromium's whole accessibility tree, which costs that
// app CPU for as long as it runs. So they are never asked; the page shows window actions instead.
//
// Everything that READS runs in passive (a --test sidecar). Everything that WRITES - a menu
// command, a window action, the app bar - refuses in passive, with ONE exception: the test
// fixture window sidecar/test-topbar.js compiles into %TEMP% (IsFixture). That is how a test
// proves invoke end to end without ever sending anything to one of the user's apps.
//
// THE APP BAR. Like macOS, the bar reserves its strip (ABM_NEW on the top edge) so maximised
// windows sit below it - live only. It goes through Taskbar.cs's AppBars, so the sidecar's own
// exit path (RemoveAllForExit) and the state file cover it too. A crash is covered three ways:
// Explorer drops a reservation by itself when its window dies; a sidecar that crashed while
// Electron lived leaves the registration on a living window, so topbar.reserve/release send a
// raw ABM_REMOVE for a window AppBars does not know; and a marker file lets the next sidecar
// start remove a reservation whose window outlived its Mantle (ClearStaleAppBar).
//
// C# 5 (see build.ps1): no string interpolation, no ?., no nameof, no expression bodies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
#if MANTLE_UIA
using System.Windows.Automation;
#endif

namespace Mantle {
  static class MenuNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct MENUITEMINFOW {
      public uint cbSize;
      public uint fMask;
      public uint fType;
      public uint fState;
      public uint wID;
      public IntPtr hSubMenu;
      public IntPtr hbmpChecked;
      public IntPtr hbmpUnchecked;
      public IntPtr dwItemData;
      public IntPtr dwTypeData;
      public uint cch;
      public IntPtr hbmpItem;
    }
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsMenu(IntPtr hmenu);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr hmenu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMenuItemInfoW(IntPtr hmenu, uint item, bool byPosition, ref MENUITEMINFOW mii);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr hmenu, int pos);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Win32.POINT pt);
    /// DWMWA_EXTENDED_FRAME_BOUNDS (9): the VISIBLE frame. GetWindowRect includes the invisible
    /// resize borders, so "is the title bar under the top bar" must be asked of this rect.
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out Win32.RECT val, int size);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref Win32.RECT rc, uint flags);
    /// QUERY_USER_NOTIFICATION_STATE: 2 QUNS_BUSY (a full-screen app or presentation mode),
    /// 3 QUNS_RUNNING_D3D_FULL_SCREEN (exclusive full screen), 4 presentation mode, 5 accepts
    /// notifications, 6 quiet time, 7 an app (Windows Store) in full screen.
    [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
  }

  [MantleFeature]
  static class MenuBar {
    /// The top bar window's title (lib/features/topbar.js sets it). The stale-app-bar check only
    /// ever removes a reservation from a window with exactly this title.
    public const string TopbarTitle = "Mantle top bar";
    /// The test fixture (sidecar/test-topbar.js). Passive writes are allowed on it and only it.
    const string FixtureTitle = "Mantle topbar fixture";
    const string FixtureExe = "mantle-topbar-fixture.exe";

    public static void Register(FeatureTable t) {
      t.Add("topbar.focus", Lanes.Ui, FocusCmd);          // what is in front, with its Win32 menu
      t.Add("topbar.watch", Lanes.Ui, WatchCmd);          // on:true|false - push focus/title/geometry changes
      t.Add("topbar.menus", Lanes.Ui, MenusCmd);          // hwnd [, init:[pos,...]] - one window's Win32 menu
      t.Add("topbar.invoke", Lanes.Ui, InvokeCmd);        // hwnd, item (NOT "id": that is the request id) - WM_COMMAND
      t.Add("topbar.window", Lanes.Ui, WindowCmd);        // hwnd, action - minimize/zoom/ontop/close/quit
      t.Add("topbar.reserve", Lanes.Ui, ReserveCmd);      // hwnd, size (physical px) - app bar, live only
      t.Add("topbar.release", Lanes.Ui, ReleaseCmd);      // hwnd - give the strip back
      t.Add("topbar.uia", Lanes.Slow, UiaCmd);            // hwnd - the UI Automation menu bar
      t.Add("topbar.uiaInvoke", Lanes.Slow, UiaInvokeCmd); // hwnd, path:[i,...], names:[...]
      t.Add("topbar.guard", Lanes.Ui, GuardCmd);          // on, bar:[l,t,r,b] px - put dragged windows back below the bar
      t.Add("topbar.classify", Lanes.Ui, ClassifyCmd);    // exe, title, covers, quns - the game verdict from given inputs
      if (!Program.Passive) {
        try {
          string s = ClearStaleAppBar();
          if (s != null) Program.EmitLog("warn", "topbar: " + s);
        } catch (Exception ex) {
          Program.EmitLog("warn", "topbar: the startup check for a stale top app bar failed (" + ex.Message + ")");
        }
      }
    }

    // ------------------------------------------------------------------ Win32 menus

    const uint MIIM_STATE = 0x1, MIIM_ID = 0x2, MIIM_SUBMENU = 0x4, MIIM_STRING = 0x40, MIIM_FTYPE = 0x100;
    const uint MFT_BITMAP = 0x4, MFT_OWNERDRAW = 0x100, MFT_RADIOCHECK = 0x200, MFT_SEPARATOR = 0x800;
    const uint MFS_GRAYED = 0x3, MFS_CHECKED = 0x8, MFS_DEFAULT = 0x1000;
    /// Deep enough for any real menu (Office-era apps nest 3-4); the item cap keeps one
    /// pathological app (a menu listing every open file) from sending megabytes per focus change.
    const int MaxDepth = 6, MaxItems = 2500;

    sealed class ReadBudget { public int Left = MaxItems; public bool Truncated; public int Count; }

    static bool ReadItem(IntPtr hmenu, int pos, out MenuNative.MENUITEMINFOW mii, out string text) {
      text = "";
      mii = new MenuNative.MENUITEMINFOW();
      mii.cbSize = (uint)Marshal.SizeOf(typeof(MenuNative.MENUITEMINFOW));
      mii.fMask = MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE | MIIM_STRING;
      if (!MenuNative.GetMenuItemInfoW(hmenu, (uint)pos, true, ref mii)) return false;
      if ((mii.fType & MFT_SEPARATOR) != 0 || mii.cch == 0) return true;
      uint cch = mii.cch + 1;
      IntPtr buf = Marshal.AllocHGlobal((int)cch * 2);
      try {
        var m2 = new MenuNative.MENUITEMINFOW();
        m2.cbSize = mii.cbSize;
        m2.fMask = MIIM_STRING;
        m2.dwTypeData = buf;
        m2.cch = cch;
        if (MenuNative.GetMenuItemInfoW(hmenu, (uint)pos, true, ref m2))
          text = Marshal.PtrToStringUni(buf, (int)Math.Min(m2.cch, cch - 1)) ?? "";
      } finally {
        Marshal.FreeHGlobal(buf);
      }
      return true;
    }

    /// "Save &As...\tCtrl+Shift+S" -> label "Save As...", key "Ctrl+Shift+S", mnemonic "a".
    /// "&&" is a literal ampersand. Some apps right-align the shortcut with \b instead of \t.
    public static void SplitText(string raw, out string label, out string key, out string mnemonic) {
      key = "";
      mnemonic = "";
      string s = raw ?? "";
      int tab = s.IndexOf('\t');
      if (tab < 0) tab = s.IndexOf('\b');
      if (tab >= 0) { key = s.Substring(tab + 1).Trim(); s = s.Substring(0, tab); }
      var sb = new StringBuilder(s.Length);
      for (int i = 0; i < s.Length; i++) {
        char c = s[i];
        if (c == '&') {
          if (i + 1 < s.Length && s[i + 1] == '&') { sb.Append('&'); i++; continue; }
          if (i + 1 < s.Length && mnemonic.Length == 0)
            mnemonic = char.ToLowerInvariant(s[i + 1]).ToString();
          continue;
        }
        sb.Append(c);
      }
      label = sb.ToString().Trim();
    }

    static List<object> ReadMenu(IntPtr hmenu, int depth, ReadBudget b, bool topLevel) {
      var list = new List<object>();
      int n = MenuNative.GetMenuItemCount(hmenu);
      for (int i = 0; i < n; i++) {
        if (b.Left <= 0) { b.Truncated = true; break; }
        MenuNative.MENUITEMINFOW mii;
        string text;
        if (!ReadItem(hmenu, i, out mii, out text)) continue;
        b.Left--;
        b.Count++;
        if ((mii.fType & MFT_SEPARATOR) != 0) { list.Add(Json.Obj("t", "sep", "pos", i)); continue; }
        // A maximised MDI child puts its system-menu icon and its min/restore/close buttons INTO
        // the menu bar as bitmap items. They are window chrome, not menus.
        if (topLevel && (mii.fType & MFT_BITMAP) != 0) continue;
        string label, key, mn;
        SplitText(text, out label, out key, out mn);
        bool ownerDraw = (mii.fType & MFT_OWNERDRAW) != 0;
        List<object> sub = null;
        bool lazy = false;
        if (mii.hSubMenu != IntPtr.Zero) {
          if (depth + 1 < MaxDepth) {
            sub = ReadMenu(mii.hSubMenu, depth + 1, b, false);
            // An app that fills a submenu on WM_INITMENUPOPUP (recent files, window lists)
            // leaves it empty until its own menu opens.
            lazy = sub.Count == 0;
          } else {
            b.Truncated = true;
            sub = new List<object>();
          }
        }
        list.Add(Json.Obj(
          "t", "item",
          "pos", i,
          "label", label,
          "key", key,
          "mn", mn,
          "id", sub == null ? (object)(long)mii.wID : null,
          "enabled", (mii.fState & MFS_GRAYED) == 0,
          "checked", (mii.fState & MFS_CHECKED) != 0,
          "radio", (mii.fType & MFT_RADIOCHECK) != 0,
          "isDefault", (mii.fState & MFS_DEFAULT) != 0,
          "ownerDraw", ownerDraw && label.Length == 0,
          "items", sub,
          "lazy", lazy));
      }
      return list;
    }

    /// The Win32 menu bar of `hwnd`, or null with why. `menuHwnd` is the window that OWNS the
    /// menu: the focused window itself, or - for a dialog with no menu of its own - the first
    /// owner up the chain that has one (macOS keeps showing an app's menus while its sheet is up).
    static IDictionary ReadWin32(IntPtr fg, out IntPtr menuHwnd, out string why, out string blocked) {
      menuHwnd = IntPtr.Zero;
      why = null;
      blocked = null;
      IntPtr h = fg;
      for (int hop = 0; hop < 5 && h != IntPtr.Zero; hop++) {
        IntPtr m = MenuNative.GetMenu(h);
        if (m != IntPtr.Zero && MenuNative.IsMenu(m) && MenuNative.GetMenuItemCount(m) > 0) {
          menuHwnd = h;
          if (hop > 0 && !MenuNative.IsWindowEnabled(h))
            blocked = "a dialog of this app is open, so it is not taking menu commands until it closes";
          var b = new ReadBudget();
          var sw = Stopwatch.StartNew();
          List<object> items = ReadMenu(m, 0, b, true);
          return Json.Obj(
            "source", "win32",
            "hwnd", h.ToInt64().ToString(CultureInfo.InvariantCulture),
            "owner", hop > 0,
            "items", items,
            "count", b.Count,
            "truncated", b.Truncated,
            "readMs", Math.Round(sw.Elapsed.TotalMilliseconds, 2));
        }
        h = Win32.GetWindow(h, Win32.GW_OWNER);
      }
      why = "no Win32 menu bar";
      return null;
    }

    /// The first item with command id `id` that is not a submenu.
    static bool FindCommand(IntPtr hmenu, uint id, int depth, out uint state, out string label) {
      state = 0;
      label = null;
      int n = MenuNative.GetMenuItemCount(hmenu);
      for (int i = 0; i < n; i++) {
        MenuNative.MENUITEMINFOW mii;
        string text;
        if (!ReadItem(hmenu, i, out mii, out text)) continue;
        if ((mii.fType & MFT_SEPARATOR) != 0) continue;
        if (mii.hSubMenu != IntPtr.Zero) {
          if (depth + 1 < MaxDepth && FindCommand(mii.hSubMenu, id, depth + 1, out state, out label)) return true;
          continue;
        }
        if (mii.wID == id) {
          string k, mn;
          SplitText(text, out label, out k, out mn);
          state = mii.fState;
          return true;
        }
      }
      return false;
    }

    // ------------------------------------------------------------------ who is in front

    static readonly Dictionary<string, string[]> _exeNames = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);

    /// [FileDescription, ProductName], cached per exe (a focus change must not re-read a PE header).
    static string[] ExeNames(string exe) {
      if (string.IsNullOrEmpty(exe)) return new string[] { "", "" };
      string[] v;
      lock (_exeNames) if (_exeNames.TryGetValue(exe, out v)) return v;
      string d = "", p = "";
      try {
        FileVersionInfo fi = FileVersionInfo.GetVersionInfo(exe);
        d = (fi.FileDescription ?? "").Trim();
        p = (fi.ProductName ?? "").Trim();
      } catch (Exception) { }
      v = new string[] { d, p };
      lock (_exeNames) _exeNames[exe] = v;
      return v;
    }

    /// A UWP window is an ApplicationFrameWindow owned by ApplicationFrameHost.exe; the app is the
    /// CoreWindow child's process. Report that, or every UWP app is called "Application Frame Host".
    static int AppPid(IntPtr hwnd, string cls, int pid) {
      if (cls != "ApplicationFrameWindow") return pid;
      int found = 0;
      Win32.EnumWindowsProc cb = delegate (IntPtr child, IntPtr lp) {
        if (Win32.GetClassName(child) == "Windows.UI.Core.CoreWindow") {
          int cp;
          Win32.GetWindowThreadProcessId(child, out cp);
          if (cp != 0 && cp != pid) { found = cp; return false; }
        }
        return true;
      };
      Win32.EnumChildWindows(hwnd, cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return found != 0 ? found : pid;
    }

    static bool IsChromium(string cls) {
      return cls != null && cls.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal);
    }

    static bool IsShell(string cls) {
      return cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd";
    }

    static bool IsTopmost(IntPtr hwnd) {
      return (Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64() & 0x8L) != 0;   // WS_EX_TOPMOST
    }

    /// Everything the page needs about the foreground window, in one read. `menuJson` is the
    /// serialised menu (for "did it change" checks).
    static IDictionary Snapshot(IntPtr fg, bool withMenu, out string menuJson) {
      menuJson = "";
      var sw = Stopwatch.StartNew();
      if (fg == IntPtr.Zero || !Win32.IsWindow(fg)) {
        return Json.Obj("hwnd", "0", "title", "", "cls", "", "exe", "", "pid", 0, "self", false, "shell", false,
                        "fullscreen", false, "zoomed", false, "topmost", false, "menu", null,
                        "menuReason", "nothing is in the foreground (the lock screen, or a desktop switch in flight)",
                        "uia", "no window", "ms", 0,
                        "game", GameVerdict(IntPtr.Zero, "", "", false, false, false));
      }
      string cls = Win32.GetClassName(fg) ?? "";
      string title = Win32.GetWindowText(fg) ?? "";
      int pid;
      Win32.GetWindowThreadProcessId(fg, out pid);
      bool self = pid != 0 && (pid == Program.OwnPid || (Program.ParentPid > 0 && pid == Program.ParentPid));
      int appPid = AppPid(fg, cls, pid);
      string exe = Win32.GetProcessPath(appPid) ?? "";
      string[] names = ExeNames(exe);
      bool shell = IsShell(cls);

      IDictionary menu = null;
      string menuReason = null, blocked = null, uia;
      if (withMenu && !self) {
        IntPtr menuHwnd;
        string why;
        menu = ReadWin32(fg, out menuHwnd, out why, out blocked);
        if (menu != null) menuJson = Json.Write(menu["items"]);
        else menuReason = why;
      }
      if (menu != null) uia = "not needed: the app has a Win32 menu bar";
      else if (self) uia = "Mantle's own window";
      else if (shell) uia = "the desktop and taskbar have no menus";
      else if (IsChromium(cls)) uia = "Chromium and Electron windows draw their own menus and describe none (asking UI Automation would switch on the app's whole accessibility tree)";
      else uia = "try";
      bool covers = Foreground.ForegroundIsFullScreen() && Win32.GetForegroundWindow() == fg;

      return Json.Obj(
        "hwnd", fg.ToInt64().ToString(CultureInfo.InvariantCulture),
        "title", title,
        "cls", cls,
        "exe", exe,
        "pid", pid,
        "appPid", appPid,
        "desc", names[0],
        "product", names[1],
        "self", self,
        "shell", shell,
        "fullscreen", covers,
        "game", GameVerdict(fg, exe, title, covers, self, shell),
        "zoomed", MenuNative.IsZoomed(fg),
        "topmost", IsTopmost(fg),
        "enabled", MenuNative.IsWindowEnabled(fg),
        "menu", menu,
        "menuReason", menuReason,
        "blocked", blocked,
        "uia", uia,
        "ms", Math.Round(sw.Elapsed.TotalMilliseconds, 2));
    }

    static string FocusCmd(Dictionary<string, object> req, ref object result) {
      string mj;
      IntPtr h = Json.HasKey(req, "hwnd") ? Json.GetHwnd(req, "hwnd") : Win32.GetForegroundWindow();
      result = Snapshot(h, Json.GetBool(req, "menu", true), out mj);
      return null;
    }

    // ------------------------------------------------------------------ watching focus

    // WinEvent hooks are tied to the thread that set them, and their callbacks arrive through that
    // thread's message loop - the ui lane (Lanes.cs). Out-of-context: nothing is injected into any
    // app. FOREGROUND and MINIMIZE* are system-wide and rare; NAMECHANGE/LOCATIONCHANGE are
    // frequent (a caret or a progress title), so that hook is scoped to the foreground PROCESS and
    // moved on every focus change.
    const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B, EVENT_OBJECT_NAMECHANGE = 0x800C;
    const int TitleEveryMs = 250;

    static Win32.WinEventProc _cb;
    static IntPtr _fgHook = IntPtr.Zero, _minHook = IntPtr.Zero, _objHook = IntPtr.Zero;
    static int _objPid;
    static IntPtr _last = IntPtr.Zero;
    static string _lastTitle = "", _lastMenuJson = "";
    static bool _lastFull, _lastZoomed;
    static int _lastTitleTick;
    static bool _titlePending;
    static System.Windows.Forms.Timer _titleTimer;
    static long _events;

    static string WatchCmd(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      if (!on) {
        Unhook();
        result = Json.Obj("watching", false, "events", _events);
        return null;
      }
      if (_fgHook == IntPtr.Zero) {
        if (_cb == null) _cb = OnWinEvent;
        const uint flags = 0x0000 | 0x0002;   // WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
        _fgHook = Win32.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _cb, 0, 0, flags);
        _minHook = Win32.SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, _cb, 0, 0, flags);
        if (_fgHook == IntPtr.Zero)
          return "Windows refused the focus-change hook (SetWinEventHook returned 0), so the top bar cannot follow focus";
      }
      if (_titleTimer == null) {
        _titleTimer = new System.Windows.Forms.Timer();
        _titleTimer.Interval = TitleEveryMs;
        _titleTimer.Tick += delegate (object s, EventArgs e) {
          _titleTimer.Stop();
          if (_titlePending) EmitTitle();
        };
      }
      string mj;
      IntPtr fg = Win32.GetForegroundWindow();
      IDictionary snap = Snapshot(fg, true, out mj);
      Remember(fg, snap, mj);
      MoveObjectHook(fg);
      result = Json.Obj("watching", true, "focus", snap);
      return null;
    }

    static void Unhook() {
      if (_fgHook != IntPtr.Zero) { Win32.UnhookWinEvent(_fgHook); _fgHook = IntPtr.Zero; }
      if (_minHook != IntPtr.Zero) { Win32.UnhookWinEvent(_minHook); _minHook = IntPtr.Zero; }
      if (_objHook != IntPtr.Zero) { Win32.UnhookWinEvent(_objHook); _objHook = IntPtr.Zero; }
      _objPid = 0;
      GuardOff();   // watch off = every hook of this file off (the undo main sends on stop)
      if (_titleTimer != null) _titleTimer.Stop();
      _titlePending = false;
    }

    static void Remember(IntPtr fg, IDictionary snap, string mj) {
      _last = fg;
      _lastTitle = (string)snap["title"] ?? "";
      _lastMenuJson = mj ?? "";
      _lastFull = (bool)snap["fullscreen"];
      _lastZoomed = (bool)snap["zoomed"];
    }

    static void MoveObjectHook(IntPtr fg) {
      int pid = 0;
      if (fg != IntPtr.Zero) Win32.GetWindowThreadProcessId(fg, out pid);
      if (pid == _objPid && _objHook != IntPtr.Zero) return;
      if (_objHook != IntPtr.Zero) { Win32.UnhookWinEvent(_objHook); _objHook = IntPtr.Zero; }
      _objPid = pid;
      if (pid == 0 || _cb == null) return;
      _objHook = Win32.SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_NAMECHANGE, IntPtr.Zero, _cb,
                                       (uint)pid, 0, 0x0000 | 0x0002);
    }

    static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      try {
        if (ev == EVENT_SYSTEM_MOVESIZEEND) {
          if (idObject == 0 && idChild == 0 && hook == _guardHook) OnMoveSizeEnd(hwnd);
          return;
        }
        if (ev == EVENT_SYSTEM_FOREGROUND || ev == EVENT_SYSTEM_MINIMIZEEND || ev == EVENT_SYSTEM_MINIMIZESTART) {
          IntPtr fg = Win32.GetForegroundWindow();
          if (ev != EVENT_SYSTEM_FOREGROUND && fg == _last) return;
          _events++;
          string mj;
          IDictionary snap = Snapshot(fg, true, out mj);
          Remember(fg, snap, mj);
          MoveObjectHook(fg);
          snap["kind"] = "focus";
          // How long after Windows raised the event this line leaves the sidecar (the hook's
          // share of the ~100 ms budget; dwmsEventTime is on GetTickCount's clock).
          snap["lagMs"] = unchecked(Environment.TickCount - (int)time);
          Features.Event("topbar", snap);
          return;
        }
        if (idObject != 0 || idChild != 0 || hwnd != _last || _fgHook == IntPtr.Zero) return;
        if (ev == EVENT_OBJECT_NAMECHANGE) {
          _titlePending = true;
          if (unchecked(Environment.TickCount - _lastTitleTick) >= TitleEveryMs) EmitTitle();
          else if (_titleTimer != null && !_titleTimer.Enabled) _titleTimer.Start();
          return;
        }
        if (ev == EVENT_OBJECT_LOCATIONCHANGE) {
          bool full = Foreground.ForegroundIsFullScreen() && Win32.GetForegroundWindow() == hwnd;
          bool zoomed = MenuNative.IsZoomed(hwnd);
          if (full == _lastFull && zoomed == _lastZoomed) return;
          _lastFull = full;
          _lastZoomed = zoomed;
          _events++;
          // A game going full screen (or back) is exactly this event, so the verdict rides on it.
          int gpid;
          Win32.GetWindowThreadProcessId(hwnd, out gpid);
          string gcls = Win32.GetClassName(hwnd) ?? "";
          string gexe = Win32.GetProcessPath(AppPid(hwnd, gcls, gpid)) ?? "";
          bool gself = gpid != 0 && (gpid == Program.OwnPid || (Program.ParentPid > 0 && gpid == Program.ParentPid));
          Features.Event("topbar", Json.Obj("kind", "geometry",
            "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture), "fullscreen", full, "zoomed", zoomed,
            "game", GameVerdict(hwnd, gexe, Win32.GetWindowText(hwnd) ?? "", full, gself, IsShell(gcls))));
        }
      } catch (Exception ex) {
        Program.EmitLog("warn", "topbar: a focus event could not be read (" + ex.GetType().Name + ": " + ex.Message + ")");
      }
    }

    /// A title change, and - because MDI apps swap their menu bar when the document changes, and
    /// the title changes with it - the menu again, sent only when it differs.
    static void EmitTitle() {
      _titlePending = false;
      _lastTitleTick = Environment.TickCount;
      IntPtr h = _last;
      if (h == IntPtr.Zero || !Win32.IsWindow(h)) return;
      string title = Win32.GetWindowText(h) ?? "";
      IntPtr menuHwnd;
      string why, blocked;
      IDictionary menu = ReadWin32(h, out menuHwnd, out why, out blocked);
      string mj = menu == null ? "" : Json.Write(menu["items"]);
      bool menuChanged = mj != _lastMenuJson;
      if (title == _lastTitle && !menuChanged) return;
      _lastTitle = title;
      _lastMenuJson = mj;
      _events++;
      Features.Event("topbar", Json.Obj("kind", "title",
        "hwnd", h.ToInt64().ToString(CultureInfo.InvariantCulture), "title", title,
        "menuChanged", menuChanged, "menu", menuChanged ? menu : null,
        "menuReason", menuChanged && menu == null ? why : null, "blocked", blocked));
    }

    // ------------------------------------------------------------------ one menu, fresh

    const uint WM_INITMENUPOPUP = 0x0117, WM_COMMAND = 0x0111, WM_NULL = 0x0000;
    const uint WM_SYSCOMMAND = 0x0112;
    const uint SMTO_ABORTIFHUNG = 0x0002;

    /// Re-reads one window's Win32 menu. With init:[pos, pos, ...] it first sends the app
    /// WM_INITMENUPOPUP for that submenu path - what the app's own menu loop sends just before a
    /// menu opens, and the ONLY moment many apps (every MFC app) set their items' greyed and
    /// checked states. LIVE ONLY: it is a message into the app, so passive sends it to the test
    /// fixture and nobody else, and says so.
    static string MenusCmd(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window is gone, so its menu cannot be read";
      string initNote = null;
      int inited = 0;
      object initObj;
      if (Json.TryGet(req, "init", out initObj) && initObj is IList) {
        if (Program.Passive && !IsFixture(hwnd)) {
          initNote = "passive: the app was not asked to refresh its menu (WM_INITMENUPOPUP), so greyed/checked states may be stale";
        } else {
          IntPtr m = MenuNative.GetMenu(hwnd);
          foreach (object o in (IList)initObj) {
            if (m == IntPtr.Zero) break;
            int pos = Convert.ToInt32(o, CultureInfo.InvariantCulture);
            IntPtr sub = MenuNative.GetSubMenu(m, pos);
            if (sub == IntPtr.Zero) { initNote = "menu position " + pos + " is not a submenu any more"; break; }
            IntPtr ignored;
            if (Win32.SendMessageTimeoutW(hwnd, WM_INITMENUPOPUP, sub, new IntPtr(pos & 0xFFFF), SMTO_ABORTIFHUNG, 300, out ignored) == IntPtr.Zero) {
              initNote = "the app did not answer WM_INITMENUPOPUP within 300 ms (busy or hung), so greyed/checked states may be stale";
              break;
            }
            inited++;
            m = sub;
          }
        }
      }
      IntPtr menuHwnd;
      string why, blocked;
      IDictionary menu = ReadWin32(hwnd, out menuHwnd, out why, out blocked);
      result = Json.Obj("menu", menu, "menuReason", menu == null ? why : null, "blocked", blocked,
                        "inited", inited, "initNote", initNote);
      return null;
    }

    // ------------------------------------------------------------------ invoking

    /// The test fixture, and only it: title, exe name AND an exe that lives under %TEMP%. A title
    /// alone could be anyone's; all three together are the window sidecar/test-topbar.js built.
    static bool IsFixture(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return false;
      string title = Win32.GetWindowText(hwnd) ?? "";
      if (!title.StartsWith(FixtureTitle, StringComparison.Ordinal)) return false;
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      string exe = Win32.GetProcessPath(pid) ?? "";
      string temp;
      try { temp = Path.GetFullPath(Path.GetTempPath()); } catch (Exception) { return false; }
      // both in long form: %TEMP% can be an 8.3 short path (a GitHub runner's C:\Users\RUNNER~1)
      return string.Equals(Path.GetFileName(exe), FixtureExe, StringComparison.OrdinalIgnoreCase) &&
             AppPower.LongPath(exe).StartsWith(AppPower.LongPath(temp), StringComparison.OrdinalIgnoreCase);
    }

    static string InvokeCmd(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window is gone, so its menu item cannot be run";
      bool fixture = IsFixture(hwnd);
      if (Program.Passive && !fixture)
        return FeatureTable.PassiveRefusal + ": would have sent a menu command to window " + hwnd.ToInt64();
      int id = Json.GetInt(req, "item", -1);
      if (id < 0) return "topbar.invoke needs item: the menu item's command id";
      IntPtr m = MenuNative.GetMenu(hwnd);
      if (m == IntPtr.Zero || !MenuNative.IsMenu(m)) return "the window has no menu bar any more";
      uint state;
      string label;
      if (!FindCommand(m, (uint)id, 0, out state, out label))
        return "the app no longer has a menu item with command id " + id + " (its menu changed after it was read)";
      if ((state & MFS_GRAYED) != 0) return "\"" + label + "\" is greyed out in the app right now";
      if (!MenuNative.IsWindowEnabled(hwnd)) return "the app has a dialog open, so it is not taking menu commands";
      // Give the app the focus back first when the top bar holds it (a menu was open from the
      // keyboard): a command that opens a dialog must open it in front. Never for the fixture,
      // which is never activated.
      string focusNote = null;
      if (!fixture && Json.GetBool(req, "focus", true) && Win32.GetForegroundWindow() != hwnd) {
        string ferr = WindowList.Focus(hwnd);
        if (ferr != null) focusNote = ferr;
      }
      if (!Win32.PostMessageW(hwnd, WM_COMMAND, new IntPtr(id & 0xFFFF), IntPtr.Zero))
        return "the app did not accept the command for \"" + label + "\" (PostMessage failed: it is closing, or runs as administrator above Mantle)";
      result = Json.Obj("ok", true, "label", label, "fixture", fixture, "focusNote", focusNote);
      return null;
    }

    // ------------------------------------------------------------------ window actions

    const int SW_SHOWMINNOACTIVE = 7;
    const uint SC_MINIMIZE = 0xF020, SC_MAXIMIZE = 0xF030, SC_CLOSE = 0xF060, SC_RESTORE = 0xF120;
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    /// What a window WITHOUT a menu still gets, macOS-style: Minimize, Zoom, Always on top, Close
    /// window, Quit (every window of the app). Close and Quit are WM_SYSCOMMAND SC_CLOSE - the
    /// title bar's X - so the app runs its own "save changes?" prompt. Mantle never kills a process.
    static string WindowCmd(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      string action = Json.GetString(req, "action") ?? "";
      bool dry = Json.GetBool(req, "dryRun", false);
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window is gone";
      bool fixture = IsFixture(hwnd);
      if (Program.Passive && !fixture && !dry)
        return FeatureTable.PassiveRefusal + ": would have run \"" + action + "\" on window " + hwnd.ToInt64();
      bool fg = Win32.GetForegroundWindow() == hwnd;
      switch (action) {
        case "minimize": {
          // SW_MINIMIZE activates the next window; for a window that is not in front that would
          // move the focus for nothing, so a background window is minimised without activation.
          int sw = fg ? Win32.SW_MINIMIZE : SW_SHOWMINNOACTIVE;
          if (!dry) MenuNative.ShowWindowAsync(hwnd, sw);
          result = Json.Obj("ok", true, "action", action, "dryRun", dry, "did", fg ? "SW_MINIMIZE" : "SW_SHOWMINNOACTIVE");
          return null;
        }
        case "zoom": {
          bool zoomed = MenuNative.IsZoomed(hwnd);
          if (fixture && !dry) return "zoom is never run on the test fixture: maximising it would put it on the screen";
          if (!dry) Win32.PostMessageW(hwnd, WM_SYSCOMMAND, new IntPtr(zoomed ? SC_RESTORE : SC_MAXIMIZE), IntPtr.Zero);
          result = Json.Obj("ok", true, "action", action, "dryRun", dry, "did", zoomed ? "SC_RESTORE" : "SC_MAXIMIZE");
          return null;
        }
        case "ontop": {
          bool top = IsTopmost(hwnd);
          bool want = Json.HasKey(req, "on") ? Json.GetBool(req, "on", !top) : !top;
          if (!dry) {
            if (!Win32.SetWindowPos(hwnd, want ? Win32.HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                                    Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE))
              return "Windows refused to change \"always on top\" for this window (it may run as administrator)";
          }
          result = Json.Obj("ok", true, "action", action, "dryRun", dry, "topmost", dry ? top : IsTopmost(hwnd), "wanted", want);
          return null;
        }
        case "close": {
          if (!dry && !Win32.PostMessageW(hwnd, WM_SYSCOMMAND, new IntPtr(SC_CLOSE), IntPtr.Zero))
            return "the window did not accept the close request (it is closing, or runs as administrator above Mantle)";
          result = Json.Obj("ok", true, "action", action, "dryRun", dry, "did", "SC_CLOSE");
          return null;
        }
        case "quit": {
          int pid;
          Win32.GetWindowThreadProcessId(hwnd, out pid);
          int appPid = AppPid(hwnd, Win32.GetClassName(hwnd) ?? "", pid);
          var targets = new List<IntPtr>();
          Win32.EnumWindowsProc cb = delegate (IntPtr w, IntPtr lp) {
            // Visible and unowned: the app's own windows. Owned windows (dialogs, palettes) close
            // with their owner; tool windows are included, because a floating palette the app
            // left open is still the app, and quitting should not leave one behind.
            if (!Win32.IsWindowVisible(w) || Win32.GetWindow(w, Win32.GW_OWNER) != IntPtr.Zero) return true;
            int wp;
            Win32.GetWindowThreadProcessId(w, out wp);
            if (wp != pid && wp != appPid) return true;
            if (AppPid(w, Win32.GetClassName(w) ?? "", wp) != appPid) return true;
            if (Program.Passive && !IsFixture(w)) return true;
            targets.Add(w);
            return true;
          };
          Win32.EnumWindows(cb, IntPtr.Zero);
          GC.KeepAlive(cb);
          int sent = 0, failed = 0;
          if (!dry) foreach (IntPtr w in targets) {
            if (Win32.PostMessageW(w, WM_SYSCOMMAND, new IntPtr(SC_CLOSE), IntPtr.Zero)) sent++; else failed++;
          }
          result = Json.Obj("ok", failed == 0, "action", action, "dryRun", dry, "windows", targets.Count,
                            "sent", sent, "failed", failed,
                            "note", "every window of the app was asked to close; an app that lives in the tray keeps running (Mantle never ends a process)");
          return null;
        }
        default:
          return "topbar.window: unknown action \"" + action + "\" (minimize, zoom, ontop, close, quit)";
      }
    }

    // ------------------------------------------------------------------ the app bar (live only)

    static string MarkerPath() {
      string dir = null;
      try { if (!string.IsNullOrEmpty(Program.StateFilePath)) dir = Path.GetDirectoryName(Path.GetFullPath(Program.StateFilePath)); }
      catch (Exception) { dir = null; }
      if (string.IsNullOrEmpty(dir))
        dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mantle");
      return Path.Combine(dir, "topbar-appbar.txt");
    }

    static void RawRemove(IntPtr hwnd) {
      var abd = new Win32.APPBARDATA();
      abd.cbSize = (uint)Marshal.SizeOf(typeof(Win32.APPBARDATA));
      abd.hWnd = hwnd;
      Win32.SHAppBarMessage(Win32.ABM_REMOVE, ref abd);
    }

    static bool KnownToAppBars(IntPtr hwnd) {
      return AppBars.Hwnds().Contains(hwnd.ToInt64().ToString());
    }

    static string ReserveCmd(Dictionary<string, object> req, ref object result) {
      if (Program.Passive)
        return FeatureTable.PassiveRefusal + ": would have reserved a strip at the top of the screen (ABM_NEW)";
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      int size = Json.GetInt(req, "size", 0);
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "topbar.reserve needs the top bar's hwnd, and that window does not exist";
      string cleared = null;
      // A sidecar that crashed while Electron lived left this window registered with Explorer;
      // this process's AppBars does not know it, and ABM_NEW would refuse a second registration.
      if (!KnownToAppBars(hwnd)) { RawRemove(hwnd); cleared = "cleared any earlier registration of this window first"; }
      Win32.RECT rc;
      bool isNew;
      string err = AppBars.Reserve(hwnd, "top", size, out rc, out isNew);
      if (err != null) return err;
      try {
        string path = MarkerPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, hwnd.ToInt64().ToString(CultureInfo.InvariantCulture) + " " +
                                Program.ParentPid.ToString(CultureInfo.InvariantCulture));
      } catch (Exception ex) {
        Program.EmitLog("warn", "topbar: the app bar is reserved but its crash marker could not be written (" + ex.Message +
                                "); a crash would still be cleaned up by Explorer when the window dies");
      }
      result = Json.Obj("rect", new object[] { rc.left, rc.top, rc.right, rc.bottom }, "isNew", isNew, "note", cleared);
      return null;
    }

    static string ReleaseCmd(Dictionary<string, object> req, ref object result) {
      if (Program.Passive)
        return FeatureTable.PassiveRefusal + ": no app bar is ever registered by a passive sidecar, so there is nothing to release";
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero) return "topbar.release needs the top bar's hwnd";
      string how;
      if (KnownToAppBars(hwnd)) {
        bool removed;
        string err = AppBars.Remove(hwnd, out removed);
        if (err != null) return err;
        how = "ABM_REMOVE via AppBars";
      } else {
        if (Win32.IsWindow(hwnd)) RawRemove(hwnd);
        how = Win32.IsWindow(hwnd) ? "raw ABM_REMOVE (this sidecar had not registered it; an earlier one had)"
                                   : "the window is gone, so Explorer has already given the space back";
      }
      try { File.Delete(MarkerPath()); } catch (Exception) { }
      result = Json.Obj("released", true, "how", how);
      return null;
    }

    /// Next sidecar start after a crash. The marker names the window the last reservation was
    /// made for. Gone: Explorer already reclaimed the strip. Alive in OUR parent Electron: the
    /// feature re-reserves it (leave it). Alive elsewhere with the top bar's title: a Mantle that
    /// is no longer ours left it - remove it. Anything else is a reused handle: never touched.
    static string ClearStaleAppBar() {
      string path = MarkerPath();
      if (!File.Exists(path)) return null;
      string[] parts = File.ReadAllText(path).Trim().Split(' ');
      long h;
      if (parts.Length < 1 || !long.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out h)) {
        File.Delete(path);
        return "an unreadable top-bar app bar marker was deleted";
      }
      IntPtr hwnd = new IntPtr(h);
      if (!Win32.IsWindow(hwnd)) {
        File.Delete(path);
        return "the last top bar's app bar was not released (a crash); its window is gone, so Explorer had already given the space back";
      }
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      if (Program.ParentPid > 0 && pid == Program.ParentPid) return null;
      if ((Win32.GetWindowText(hwnd) ?? "") != TopbarTitle) {
        File.Delete(path);
        return null;
      }
      RawRemove(hwnd);
      File.Delete(path);
      return "removed a top-bar app bar left registered by an earlier Mantle (window " + h + ", process " + pid + ")";
    }

    // ------------------------------------------------------------------ nothing goes past the bar
    //
    // The user: "nothing should be able to go past the topbar". A MAXIMISED window is kept below it
    // by the app bar reservation (the work area starts at the bar's bottom). A window DRAGGED or
    // RESIZED up into the strip is put back below it when the drag ENDS - EVENT_SYSTEM_MOVESIZEEND,
    // raised once when the user lets go. Never during the drag: fighting the move loop the user
    // is holding would make the window jitter under the cursor. SWP_NOACTIVATE | SWP_NOZORDER, so
    // the focus and the stacking order stay exactly as the user left them.
    //
    // PASSIVE (a --test sidecar): every window is only MEASURED and reported (dryRun:true), with
    // the one exception of the test fixture - the same guard as invoke.
    const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
    static IntPtr _guardHook = IntPtr.Zero;
    static Win32.RECT _guardBar;
    static bool _guardOn;
    static long _guardSeen, _guardMoved;

    static string GuardCmd(Dictionary<string, object> req, ref object result) {
      if (!Json.GetBool(req, "on", true)) {
        GuardOff();
        result = Json.Obj("guard", false, "seen", _guardSeen, "moved", _guardMoved, "lastSkip", _guardSkip);
        return null;
      }
      object raw;
      IList b = Json.TryGet(req, "bar", out raw) ? raw as IList : null;
      if (b == null || b.Count != 4)
        return "topbar.guard needs bar:[left, top, right, bottom], the top bar's rect in physical pixels";
      var rc = new Win32.RECT();
      rc.left = Convert.ToInt32(b[0], CultureInfo.InvariantCulture);
      rc.top = Convert.ToInt32(b[1], CultureInfo.InvariantCulture);
      rc.right = Convert.ToInt32(b[2], CultureInfo.InvariantCulture);
      rc.bottom = Convert.ToInt32(b[3], CultureInfo.InvariantCulture);
      if (rc.right <= rc.left || rc.bottom <= rc.top) return "topbar.guard: the bar's rect is empty";
      if (_guardHook == IntPtr.Zero) {
        if (_cb == null) _cb = OnWinEvent;
        _guardHook = Win32.SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND, IntPtr.Zero, _cb, 0, 0, 0x0000 | 0x0002);
        if (_guardHook == IntPtr.Zero)
          return "Windows refused the move/size hook (SetWinEventHook returned 0), so a window dragged into the top bar is not put back below it";
      }
      _guardBar = rc;
      _guardOn = true;
      result = Json.Obj("guard", true, "bar", new object[] { rc.left, rc.top, rc.right, rc.bottom }, "passive", Program.Passive);
      return null;
    }

    static void GuardOff() {
      if (_guardHook != IntPtr.Zero) { Win32.UnhookWinEvent(_guardHook); _guardHook = IntPtr.Zero; }
      _guardOn = false;
    }

    static bool CoversMonitor(Win32.RECT r, Win32.MONITORINFO mi) {
      return r.left <= mi.rcMonitor.left && r.top <= mi.rcMonitor.top &&
             r.right >= mi.rcMonitor.right && r.bottom >= mi.rcMonitor.bottom;
    }

    /// The decision and the move, for one window whose drag just ended. null = nothing to say
    /// (not near the strip, or a window the guard never touches).
    static string _guardSkip;   // why the last drag end was left alone (topbar.guard {on:false} reports it)

    static IDictionary Fit(IntPtr hwnd) {
      _guardSkip = null;
      if (!_guardOn || hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) { _guardSkip = "off, or the window is gone"; return null; }
      if (!Win32.IsWindowVisible(hwnd) || Win32.IsIconic(hwnd) || MenuNative.IsZoomed(hwnd)) { _guardSkip = "hidden, minimised or maximised"; return null; }
      if ((Win32.GetWindowLongPtr(hwnd, Win32.GWL_STYLE).ToInt64() & 0x40000000L) != 0) { _guardSkip = "a child window"; return null; }   // moves with its parent
      string cls = Win32.GetClassName(hwnd) ?? "";
      if (IsShell(cls)) { _guardSkip = "the desktop or taskbar"; return null; }
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      if (pid != 0 && (pid == Program.OwnPid || (Program.ParentPid > 0 && pid == Program.ParentPid))) { _guardSkip = "Mantle's own window"; return null; }
      Win32.RECT wr;
      if (!Win32.GetWindowRect(hwnd, out wr)) { _guardSkip = "GetWindowRect failed"; return null; }
      Win32.RECT vis;
      if (MenuNative.DwmGetWindowAttribute(hwnd, 9, out vis, Marshal.SizeOf(typeof(Win32.RECT))) != 0) vis = wr;
      Win32.RECT bar = _guardBar;
      if (vis.top >= bar.bottom || vis.right <= bar.left || vis.left >= bar.right || vis.bottom <= bar.top) { _guardSkip = "not under the bar (" + vis.left + "," + vis.top + "," + vis.right + "," + vis.bottom + " vs " + bar.left + "," + bar.top + "," + bar.right + "," + bar.bottom + ")"; return null; }
      // Only the bar's own monitor: a window on a monitor stacked above this one can legitimately
      // sit at the same y. The monitor is the one the window's centre is on; a window overlapping
      // the bar's rect whose centre is elsewhere is left alone.
      IntPtr mon = MenuNative.MonitorFromRect(ref bar, Win32.MONITOR_DEFAULTTONEAREST);
      if (mon == IntPtr.Zero || Win32.MonitorFromWindow(hwnd, Win32.MONITOR_DEFAULTTONEAREST) != mon) { _guardSkip = "on another monitor"; return null; }
      var mi = new Win32.MONITORINFO();
      mi.cbSize = (uint)Marshal.SizeOf(typeof(Win32.MONITORINFO));
      if (!Win32.GetMonitorInfoW(mon, ref mi)) { _guardSkip = "GetMonitorInfo failed"; return null; }
      // A window covering the whole monitor is a full-screen window: the full-screen rules
      // (topbar.js) decide about it, not a drag.
      if (CoversMonitor(wr, mi)) { _guardSkip = "full screen"; return null; }
      _guardSeen++;
      int dy = bar.bottom - vis.top;
      int cx = wr.right - wr.left, cy = wr.bottom - wr.top;
      string how = "moved down " + dy + " px";
      bool resize = false;
      // A top edge dragged up into the strip: moving the whole window down would push its bottom
      // past the work area, so put the top edge back and keep the bottom where the user left it.
      if (vis.bottom + dy > mi.rcWork.bottom && vis.bottom <= mi.rcWork.bottom && cy - dy >= 120) {
        resize = true;
        cy -= dy;
        how = "top edge put back " + dy + " px, bottom kept";
      }
      bool fixture = IsFixture(hwnd);
      bool dry = Program.Passive && !fixture;
      bool ok = true;
      if (!dry) {
        uint flags = Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE | (resize ? 0u : Win32.SWP_NOSIZE);
        ok = Win32.SetWindowPos(hwnd, IntPtr.Zero, wr.left, wr.top + dy, cx, cy, flags);
        if (ok) _guardMoved++;
      }
      return Json.Obj("kind", "guard",
        "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture), "cls", cls,
        "visible", new object[] { vis.left, vis.top, vis.right, vis.bottom },
        "barBottom", bar.bottom, "dy", dy, "how", how, "resize", resize,
        "dryRun", dry, "fixture", fixture, "ok", ok,
        "reason", dry ? "passive: measured only, nothing was moved" :
                  ok ? null : "Windows refused to move it (it runs as administrator above Mantle, or it is closing)");
    }

    static void OnMoveSizeEnd(IntPtr hwnd) {
      IDictionary r = Fit(hwnd);
      if (r != null) Features.Event("topbar", r);
    }

    // ------------------------------------------------------------------ games step aside
    //
    // The user: "unless its like valorant or whatever right then that will go fully fullscreen. or
    // anything else like that right?" The bar stays over a browser's F11 or a full-screen video,
    // but a GAME gets the whole screen in any full-screen mode - and Valorant runs BORDERLESS by
    // default, so "exclusive full screen" alone would miss the most important case. Two questions:
    //   is it a game?    a known game exe (the list below), OR an exe Windows' own Game Bar has
    //                    recognised on this account (HKCU\System\GameConfigStore\Children\*
    //                    MatchedExeFullPath - 11 of 84 entries have one here, 2026-09-24,
    //                    including Valorant, Minecraft and Roblox), OR exclusive full screen
    //                    (QUNS_RUNNING_D3D_FULL_SCREEN: nothing can draw over it anyway).
    //   is it full screen?  the window covers its whole monitor (Foreground.cs, the same test the
    //                    bar and the wallpaper pause rules use), OR SHQueryUserNotificationState
    //                    says a full-screen app / exclusive D3D is running.
    // Both must hold. A game in a normal window keeps the bar; a launcher (Riot Client) is not
    // full screen, so it keeps the bar too.
    static readonly string[] GameExes = {
      "VALORANT-Win64-Shipping.exe", "VALORANT.exe", "RobloxPlayerBeta.exe", "Minecraft.Windows.exe",
      "FortniteClient-Win64-Shipping.exe", "cs2.exe", "csgo.exe", "r5apex.exe", "RocketLeague.exe",
      "GTA5.exe", "Overwatch.exe", "League of Legends.exe", "EscapeFromTarkov.exe", "Cyberpunk2077.exe",
    };
    static readonly string[] GamePrefixes = { "RiotClient", "Minecraft", "VALORANT", "LeagueClient", "Roblox" };

    static HashSet<string> _gameStore;
    static int _gameStoreTick;
    static string _gameStoreNote;

    /// Re-read at most once a minute (84 keys, a few ms): a game installed or first played while
    /// Mantle runs is picked up without a restart, and a focus change never waits on the registry.
    static HashSet<string> GameStore() {
      if (_gameStore != null && unchecked(Environment.TickCount - _gameStoreTick) < 60000) return _gameStore;
      var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      try {
        using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"System\GameConfigStore\Children")) {
          if (k == null) _gameStoreNote = "HKCU\\System\\GameConfigStore\\Children does not exist (Game Bar has never recognised a game here)";
          else {
            foreach (string sub in k.GetSubKeyNames()) {
              using (var c = k.OpenSubKey(sub)) {
                string p = c == null ? null : c.GetValue("MatchedExeFullPath") as string;
                if (!string.IsNullOrEmpty(p)) set.Add(p.Trim());
              }
            }
            _gameStoreNote = null;
          }
        }
      } catch (Exception ex) {
        _gameStoreNote = "the Game Bar game list could not be read (" + ex.Message + ")";
      }
      _gameStore = set;
      _gameStoreTick = Environment.TickCount;
      return set;
    }

    static string KnownGame(string file, string title) {
      if (string.IsNullOrEmpty(file)) return null;
      foreach (string g in GameExes) if (string.Equals(g, file, StringComparison.OrdinalIgnoreCase)) return g;
      foreach (string p in GamePrefixes) if (file.StartsWith(p, StringComparison.OrdinalIgnoreCase)) return file;
      // Minecraft: Java Edition is javaw.exe, like every other Java desktop app; its window title
      // is what says Minecraft.
      if ((string.Equals(file, "javaw.exe", StringComparison.OrdinalIgnoreCase) || string.Equals(file, "java.exe", StringComparison.OrdinalIgnoreCase)) &&
          (title ?? "").StartsWith("Minecraft", StringComparison.OrdinalIgnoreCase)) return file + " (Minecraft)";
      return null;
    }

    static string QunsName(int q) {
      switch (q) {
        case 1: return "not present (screen saver, locked or switching user)";
        case 2: return "busy: a full-screen app or presentation mode";
        case 3: return "exclusive full-screen Direct3D";
        case 4: return "presentation mode";
        case 5: return "normal";
        case 6: return "quiet time";
        case 7: return "a full-screen Store app";
        default: return "unknown";
      }
    }

    /// The whole verdict from its inputs (topbar.classify runs exactly this with made-up inputs,
    /// so the rules are testable without a game).
    internal static IDictionary Verdict(string exe, string title, bool covers, int quns) {   // internal: GameMode.cs asks the same question (2026-09-25)
      string file = string.IsNullOrEmpty(exe) ? "" : Path.GetFileName(exe);
      string known = KnownGame(file, title);
      bool stored = !string.IsNullOrEmpty(exe) && GameStore().Contains(exe);
      bool d3d = quns == 3;
      bool busy = quns == 2 || quns == 7;
      bool game = known != null || stored || d3d;
      bool full = covers || d3d || busy;
      bool step = game && full;
      string signal = null;
      if (step) {
        string what = known != null ? file + " is a known game" :
                      stored ? file + " is on Windows' Game Bar list (GameConfigStore)" :
                      "an exclusive full-screen Direct3D app is running";
        string how = covers ? "it covers the whole monitor (borderless full screen)" :
                     d3d ? "exclusive full screen (SHQueryUserNotificationState = QUNS_RUNNING_D3D_FULL_SCREEN)" :
                     "Windows reports a full-screen app (SHQueryUserNotificationState = " + QunsName(quns) + ")";
        signal = what + "; " + how;
      }
      return Json.Obj("stepAside", step, "signal", signal, "known", known, "gameStore", stored,
                      "covers", covers, "quns", quns, "qunsName", QunsName(quns),
                      "storeNote", _gameStoreNote);
    }

    static IDictionary GameVerdict(IntPtr fg, string exe, string title, bool covers, bool self, bool shell) {
      int quns = -1;
      try { int s; if (MenuNative.SHQueryUserNotificationState(out s) == 0) quns = s; } catch (Exception) { }
      if (fg == IntPtr.Zero || self || shell)
        return Json.Obj("stepAside", false, "signal", null, "known", null, "gameStore", false, "covers", false,
                        "quns", quns, "qunsName", QunsName(quns), "storeNote", null);
      return Verdict(exe, title, covers, quns);
    }

    static string ClassifyCmd(Dictionary<string, object> req, ref object result) {
      result = Verdict(Json.GetString(req, "exe") ?? "", Json.GetString(req, "title") ?? "",
                       Json.GetBool(req, "covers", false), Json.GetInt(req, "quns", 5));
      return null;
    }

    // ------------------------------------------------------------------ UI Automation

    const string UiaMissing = "this sidecar was built without UI Automation (build.ps1 passed no /define:MANTLE_UIA), " +
                              "so menus that apps draw themselves cannot be read";

    static string UiaCmd(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window is gone, so its menus cannot be read";
      string cls = Win32.GetClassName(hwnd) ?? "";
      if (IsChromium(cls)) {
        result = Json.Obj("menu", null, "reason", "Chromium and Electron windows describe no menu bar, and asking would switch on the app's whole accessibility tree");
        return null;
      }
      IntPtr ignored;
      if (Win32.SendMessageTimeoutW(hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out ignored) == IntPtr.Zero) {
        result = Json.Obj("menu", null, "reason", "the app did not answer within 500 ms (busy or not responding), so its menus were not asked for");
        return null;
      }
#if MANTLE_UIA
      var sw = Stopwatch.StartNew();
      try {
        _pickDiag.Clear();
        AutomationElement bar = FindMenuBar(hwnd);
        if (bar == null) {
          result = Json.Obj("menu", null, "reason", "the app shows no menu bar that Windows can read", "ms", Math.Round(sw.Elapsed.TotalMilliseconds, 1),
                            "bars", new List<object>(_pickDiag));
          return null;
        }
        int budget = 800;
        List<object> items = UiaItems(bar, 0, ref budget);
        result = Json.Obj("menu", Json.Obj("source", "uia", "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
                                           "items", items, "truncated", budget <= 0,
                                           "readMs", Math.Round(sw.Elapsed.TotalMilliseconds, 1)),
                          "reason", items.Count == 0 ? "the app's menu bar is empty" : null, "bars", new List<object>(_pickDiag));
        return null;
      } catch (Exception ex) {
        result = Json.Obj("menu", null, "reason", "UI Automation could not read the app's menus: " + ex.Message);
        return null;
      }
#else
      result = Json.Obj("menu", null, "reason", UiaMissing);
      return null;
#endif
    }

    static string UiaInvokeCmd(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window is gone, so its menu item cannot be run";
      bool fixture = IsFixture(hwnd);
      if (Program.Passive && !fixture)
        return FeatureTable.PassiveRefusal + ": would have run a menu item in window " + hwnd.ToInt64() + " through UI Automation";
#if MANTLE_UIA
      object po, no;
      if (!Json.TryGet(req, "path", out po) || !(po is IList) || ((IList)po).Count == 0)
        return "topbar.uiaInvoke needs path: the item's position at each level, e.g. [1, 3]";
      IList path = (IList)po;
      IList names = Json.TryGet(req, "names", out no) ? no as IList : null;
      if (!fixture && Json.GetBool(req, "focus", true) && Win32.GetForegroundWindow() != hwnd) {
        string ferr = WindowList.Focus(hwnd);
        if (ferr != null) return "the app could not be brought forward to take its menu command: " + ferr;
      }
      try {
        AutomationElement bar = FindMenuBar(hwnd);
        if (bar == null) return "the app's menu bar is gone";
        AutomationElement cur = bar;
        for (int level = 0; level < path.Count; level++) {
          int idx = Convert.ToInt32(path[level], CultureInfo.InvariantCulture);
          List<AutomationElement> kids = UiaChildren(cur);
          if (kids.Count == 0 && level > 0) {
            // The app builds this submenu when it opens: open it (the app's own menu), then look again.
            Expand(cur);
            kids = UiaChildren(cur);
          }
          if (idx < 0 || idx >= kids.Count) return "the app's menu changed: there is no item " + idx + " at level " + level;
          cur = kids[idx];
          string want = names != null && level < names.Count ? Convert.ToString(names[level], CultureInfo.InvariantCulture) : null;
          string got, gk, gm;
          SplitText(cur.Current.Name ?? "", out got, out gk, out gm);
          if (want != null && got != want)
            return "the app's menu changed: expected \"" + want + "\" but found \"" + got + "\"";
        }
        if (!cur.Current.IsEnabled) return "\"" + cur.Current.Name + "\" is greyed out in the app right now";
        object pat;
        if (cur.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) {
          ((InvokePattern)pat).Invoke();
          result = Json.Obj("ok", true, "did", "invoke", "label", cur.Current.Name, "fixture", fixture);
          return null;
        }
        if (Json.GetBool(req, "expand", true) && Expand(cur)) {
          result = Json.Obj("ok", true, "did", "expand", "label", cur.Current.Name, "fixture", fixture,
                            "note", "the app builds this menu only when it opens, so its own menu was opened");
          return null;
        }
        object tp;
        if (cur.TryGetCurrentPattern(TogglePattern.Pattern, out tp)) {
          ((TogglePattern)tp).Toggle();
          result = Json.Obj("ok", true, "did", "toggle", "label", cur.Current.Name, "fixture", fixture);
          return null;
        }
        return "\"" + cur.Current.Name + "\" offers nothing to run (no Invoke, Expand or Toggle pattern)";
      } catch (Exception ex) {
        return "UI Automation could not run the menu item: " + ex.Message;
      }
#else
      return UiaMissing;
#endif
    }

#if MANTLE_UIA
    static readonly Condition MenuBarCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar);
    static readonly Condition ItemCond = new OrCondition(
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Separator));

    /// The app's menu bar, never the title bar's system menu. MEASURED on the WinForms fixture
    /// (2026-09-24, raw view): Window > [MenuBar (the MenuStrip, its own hwnd) > Tools > Ping,
    /// Pong; Go], [TitleBar > MenuBar "System Menu Bar" > "System"; Minimize; Maximize; Close].
    /// The system bar's AutomationId is empty and its FrameworkId is "WinForm", so neither tells
    /// it apart, and its name is localised; its PARENT does - it lives under the TitleBar, which
    /// the walk never enters. FindAll over the control view did not return the MenuStrip at all.
    static AutomationElement FindMenuBar(IntPtr hwnd) {
      AutomationElement root = AutomationElement.FromHandle(hwnd);
      // Breadth-first over the RAW view (the control view hid the MenuStrip from FindAll on the
      // fixture), shallowest bar first, never descending into a TitleBar, capped so a huge tree
      // costs a bounded number of round trips.
      TreeWalker w = TreeWalker.RawViewWalker;
      var q = new Queue<KeyValuePair<AutomationElement, int>>();
      q.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
      var found = new List<AutomationElement>();
      int seen = 0;
      while (q.Count > 0 && seen < 600 && found.Count == 0) {
        KeyValuePair<AutomationElement, int> at = q.Dequeue();
        AutomationElement c = w.GetFirstChild(at.Key);
        while (c != null && seen < 600) {
          seen++;
          ControlType ct = c.Current.ControlType;
          if (ct == ControlType.MenuBar) found.Add(c);
          else if (ct != ControlType.TitleBar && at.Value < 8) q.Enqueue(new KeyValuePair<AutomationElement, int>(c, at.Value + 1));
          c = w.GetNextSibling(c);
        }
      }
      _pickDiag.Add("walked " + seen + " elements" + (seen >= 600 ? " (the cap)" : ""));
      return PickBar(found, hwnd);
    }

    static AutomationElement PickBar(List<AutomationElement> found, IntPtr hwnd) {
      if (found == null) return null;
      // The title bar's system menu is a MenuBar too ("System", AutomationId empty on WinForms
      // windows, "SystemMenuBar" elsewhere; the name is localised). What is language-independent
      // is WHERE it is: the non-client area, above the client rectangle. An app's own menu bar
      // (MenuStrip, WPF Menu, WinUI MenuBar) is inside the client area - though an off-screen
      // window reports empty rectangles, so the framework is the first test. A Win32 menu bar is
      // non-client too, but GetMenu has already read those before UIA is ever asked.
      var origin = new Win32.POINT();
      bool haveOrigin = MenuNative.ClientToScreen(hwnd, ref origin);
      foreach (AutomationElement e in found) {
        AutomationElement.AutomationElementInformation cur = e.Current;
        System.Windows.Rect r = cur.BoundingRectangle;
        string d = "aid=" + (cur.AutomationId ?? "") + " fw=" + (cur.FrameworkId ?? "") + " cls=" + (cur.ClassName ?? "") +
                   " rect=" + (r.IsEmpty ? "empty" : ((int)r.Top).ToString(CultureInfo.InvariantCulture) + ".." +
                   ((int)r.Bottom).ToString(CultureInfo.InvariantCulture)) + " client.y=" + origin.y.ToString(CultureInfo.InvariantCulture);
        if ((cur.AutomationId ?? "") == "SystemMenuBar") { _pickDiag.Add(d + ": skipped (system menu)"); continue; }
        // The Win32 proxy provides the system menu (and native menu bars, which GetMenu read).
        if ((cur.FrameworkId ?? "") == "Win32") { _pickDiag.Add(d + ": skipped (Win32 proxy)"); continue; }
        if (haveOrigin && !r.IsEmpty && r.Bottom <= origin.y + 1) { _pickDiag.Add(d + ": skipped (non-client)"); continue; }
        _pickDiag.Add(d + ": used");
        return e;
      }
      return null;
    }

    /// Why each candidate menu bar was used or skipped, for the reply (no names: a bar's name can
    /// be a document title).
    [ThreadStatic] static List<object> _pickDiagTs;
    static List<object> _pickDiag { get { if (_pickDiagTs == null) _pickDiagTs = new List<object>(); return _pickDiagTs; } }

    static List<AutomationElement> UiaChildren(AutomationElement parent) {
      var list = new List<AutomationElement>();
      TreeWalker w = TreeWalker.RawViewWalker;
      for (AutomationElement c = w.GetFirstChild(parent); c != null; c = w.GetNextSibling(c)) {
        ControlType ct = c.Current.ControlType;
        if (ct == ControlType.MenuItem || ct == ControlType.Separator) list.Add(c);
      }
      return list;
    }

    static bool Expand(AutomationElement e) {
      object p;
      if (!e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) return false;
      ((ExpandCollapsePattern)p).Expand();
      return true;
    }

    static List<object> UiaItems(AutomationElement parent, int depth, ref int budget) {
      var list = new List<object>();
      List<AutomationElement> kids = UiaChildren(parent);
      for (int i = 0; i < kids.Count; i++) {
        if (budget <= 0) break;
        budget--;
        AutomationElement e = kids[i];
        AutomationElement.AutomationElementInformation cur = e.Current;
        if (cur.ControlType == ControlType.Separator) { list.Add(Json.Obj("t", "sep", "pos", i)); continue; }
        object p;
        bool canExpand = e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p);
        bool isChecked = false;
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p))
          isChecked = ((TogglePattern)p).Current.ToggleState == ToggleState.On;
        List<object> sub = depth < 4 ? UiaItems(e, depth + 1, ref budget) : new List<object>();
        bool hasSub = canExpand || sub.Count > 0;
        string label, key, mn;
        SplitText(cur.Name ?? "", out label, out key, out mn);
        if (key.Length == 0) key = cur.AcceleratorKey ?? "";
        if (mn.Length == 0 && !string.IsNullOrEmpty(cur.AccessKey)) {
          string ak = cur.AccessKey;
          mn = ak.Substring(ak.Length - 1).ToLowerInvariant();
        }
        list.Add(Json.Obj(
          "t", "item",
          "pos", i,
          "label", label,
          "key", key,
          "mn", mn,
          "id", null,
          "enabled", cur.IsEnabled,
          "checked", isChecked,
          "radio", false,
          "isDefault", false,
          "ownerDraw", false,
          "items", hasSub ? sub : null,
          "lazy", hasSub && sub.Count == 0));
      }
      return list;
    }
#endif
  }
}
