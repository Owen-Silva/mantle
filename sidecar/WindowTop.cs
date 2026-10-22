// WindowTop.cs - "Keep on top": pin any window above every other one (lane ontop, 2026-09-27).
//
// WHY: Windows has no way to keep a window above the others (only PowerToys adds one). The user watches
// videos, codes and games: a video, his notes or a calculator pinned over whatever he is
// working in is the win. Win+Ctrl+T (PowerToys' own key, free on this machine: RegisterHotKey
// probe 2026-09-27) or "Keep on top" in the bar's right-click menu; lib/features/ontop.js decides,
// this file only does the Windows half.
//
//   ontop.front {}                     the window in front (its top-level root), as facts
//   ontop.info  {hwnd}                 the same facts for one window
//   ontop.check {hwnds:[{hwnd,pid}]}   is each still there (same process) and still on top
//   ontop.set   {hwnd, on, pid?, dryRun?}  SetWindowPos HWND_TOPMOST / HWND_NOTOPMOST, VERIFIED
//
// THE FACTS carry `refuse`: the plain-words reason Mantle will not pin it, or null. Refused:
// Mantle's own windows (the sidecar and its Electron parent), the desktop / taskbar / Start /
// search (Windows' shell), a window that is not showing, one that is not responding, and one that
// runs as administrator while Mantle does not (UIPI: Windows silently ignores or refuses the change,
// so it is refused up front, in words, instead of "nothing happened").
//
// NOTHING SILENT: ontop.set re-reads WS_EX_TOPMOST after the call and retries twice (40, 80 ms)
// before it says the change did not take. MEASURED 2026-09-27: sidecar/test-topbar.js "fixture:
// always-on-top on" failed once with SetWindowPos returning TRUE and WS_EX_TOPMOST still clear on
// the immediate re-read, then passed on every rerun (isolated and full): the change can land late or
// be undone at once, and a caller that trusts the return value reports a pin that is not there.
//
// NEVER BLOCKS THE UI LANE: SetWindowPos on another process's window SENDS it
// WM_WINDOWPOSCHANGING, so a hung app would hold the caller. ontop.set runs on the slow lane and
// refuses a window IsHungAppWindow calls hung. Titles are read with InternalGetWindowText (no
// message is sent), and never returned except as the display name of a UWP frame (whose title IS
// the app's name, e.g. "Calculator").
//
// PASSIVE (every test sidecar): writes go ONLY to the fixture sidecar/test-ontop.js compiles into
// %TEMP% (title, exe name AND %TEMP% all checked, as MenuBar.IsFixture); anything else answers
// FeatureTable.PassiveRefusal, and dryRun says what would have happened.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class WindowTop {
    public static void Register(FeatureTable t) {
      t.Add("ontop.front", Lanes.Ui, Front);
      t.Add("ontop.info", Lanes.Ui, Info);
      t.Add("ontop.check", Lanes.Ui, Check);
      t.Add("ontop.set", Lanes.Slow, Set);
    }

    const string FixtureTitle = "Mantle ontop fixture";
    const string FixtureExe = "mantle-ontop-fixture.exe";
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
    const int ERROR_ACCESS_DENIED = 5;

    // Windows' own shell surfaces: never pinned (the taskbar is Mantle's business, the rest are
    // Windows' and already sit in their own z-order bands).
    static readonly string[] ShellClasses = {
      "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
      "TopLevelWindowForOverflowXamlIsland", "XamlExplorerHostIslandWindow", "Windows.UI.Core.CoreWindow",
      "ForegroundStaging", "MultitaskingViewFrame", "TaskListThumbnailWnd"
    };
    static readonly string[] ShellExes = {
      "StartMenuExperienceHost.exe", "SearchHost.exe", "SearchApp.exe", "ShellExperienceHost.exe",
      "ShellHost.exe", "LockApp.exe", "TextInputHost.exe"
    };

    static class N {
      [DllImport("user32.dll", SetLastError = true)]
      public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)]
      public static extern int InternalGetWindowText(IntPtr hwnd, StringBuilder sb, int max);
      [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
      [DllImport("user32.dll", CharSet = CharSet.Unicode)]
      public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)]
      public static extern bool GetTokenInformation(IntPtr tok, int cls, out int val, int len, out int ret);
    }

    // ------------------------------------------------------------------ reading a window

    static bool IsTopmost(IntPtr hwnd) {
      return (Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64() & 0x8L) != 0;   // WS_EX_TOPMOST
    }

    static string Title(IntPtr hwnd) {
      var sb = new StringBuilder(256);
      N.InternalGetWindowText(hwnd, sb, sb.Capacity);
      return sb.ToString();
    }

    static readonly Dictionary<string, string> _descs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    static readonly object _descLock = new object();

    /// The app's own name for itself (FileDescription), else the exe's name without ".exe".
    static string ExeName(string exe) {
      if (string.IsNullOrEmpty(exe)) return "";
      lock (_descLock) {
        string d;
        if (_descs.TryGetValue(exe, out d)) return d;
        try {
          var v = FileVersionInfo.GetVersionInfo(exe);
          d = v.FileDescription == null ? null : v.FileDescription.Trim();
        } catch (Exception) { d = null; }
        if (string.IsNullOrEmpty(d)) d = Path.GetFileNameWithoutExtension(exe);
        if (_descs.Count > 256) _descs.Clear();
        _descs[exe] = d;
        return d;
      }
    }

    /// A UWP app lives in ApplicationFrameHost's frame; the app itself is its CoreWindow child.
    static int AppPid(IntPtr hwnd, string cls, int pid) {
      if (cls != "ApplicationFrameWindow") return pid;
      IntPtr core = N.FindWindowExW(hwnd, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
      if (core == IntPtr.Zero) return pid;
      int cp;
      Win32.GetWindowThreadProcessId(core, out cp);
      return cp != 0 ? cp : pid;
    }

    static int _selfElevated = -1;
    static bool SelfElevated() {
      if (_selfElevated < 0) _selfElevated = TokenElevated(N.GetCurrentProcess()) == 1 ? 1 : 0;
      return _selfElevated == 1;
    }

    /// 1 elevated, 0 not, -1 unknown (its token cannot be read from here - itself a sign it runs above us).
    static int Elevated(int pid) {
      IntPtr proc = N.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
      if (proc == IntPtr.Zero) return -1;
      try { return TokenElevated(proc); } finally { N.CloseHandle(proc); }
    }

    static int TokenElevated(IntPtr proc) {
      IntPtr tok;
      if (!N.OpenProcessToken(proc, 0x0008 /* TOKEN_QUERY */, out tok)) return -1;
      try {
        int v, len;
        if (!N.GetTokenInformation(tok, 20 /* TokenElevation */, out v, 4, out len)) return -1;
        return v != 0 ? 1 : 0;
      } finally { N.CloseHandle(tok); }
    }

    /// The fixture sidecar/test-ontop.js builds, and only it: title, exe name AND an exe under %TEMP%.
    static bool IsFixture(IntPtr hwnd, int pid) {
      if (!Title(hwnd).StartsWith(FixtureTitle, StringComparison.Ordinal)) return false;
      string exe = Win32.GetProcessPath(pid) ?? "";
      string temp;
      try { temp = Path.GetFullPath(Path.GetTempPath()); } catch (Exception) { return false; }
      return string.Equals(Path.GetFileName(exe), FixtureExe, StringComparison.OrdinalIgnoreCase) &&
             exe.StartsWith(temp, StringComparison.OrdinalIgnoreCase);
    }

    sealed class Facts {
      public IntPtr Hwnd;
      public int Pid, AppPid, Elevation;
      public string Cls, Exe, Name;
      public bool Topmost, Visible, Cloaked, Minimized, Self, Shell, Hung, Fixture;
      public string Refuse;   // the reason it will not be pinned, or null
    }

    static Facts Read(IntPtr hwnd) {
      var f = new Facts { Hwnd = hwnd };
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      f.Pid = pid;
      f.Cls = Win32.GetClassName(hwnd) ?? "";
      f.AppPid = AppPid(hwnd, f.Cls, pid);
      string exePath = Win32.GetProcessPath(f.AppPid) ?? "";
      f.Exe = Path.GetFileName(exePath);
      f.Name = f.Cls == "ApplicationFrameWindow" && f.AppPid == pid ? Title(hwnd) : ExeName(exePath);
      if (string.IsNullOrEmpty(f.Name)) f.Name = string.IsNullOrEmpty(f.Exe) ? "this window" : f.Exe;
      if (f.Name.Length > 48) f.Name = f.Name.Substring(0, 47) + "…";
      f.Topmost = IsTopmost(hwnd);
      f.Visible = Win32.IsWindowVisible(hwnd);
      f.Cloaked = Win32.IsCloaked(hwnd);
      f.Minimized = Win32.IsIconic(hwnd);
      f.Self = pid != 0 && (pid == Program.OwnPid || (Program.ParentPid > 0 && pid == Program.ParentPid));
      f.Shell = hwnd == N.GetShellWindow() || hwnd == Win32.GetDesktopWindow() ||
                Array.IndexOf(ShellClasses, f.Cls) >= 0 ||
                Array.Exists(ShellExes, delegate (string e) { return string.Equals(e, f.Exe, StringComparison.OrdinalIgnoreCase); });
      f.Hung = N.IsHungAppWindow(hwnd);
      f.Fixture = IsFixture(hwnd, pid);
      f.Elevation = SelfElevated() ? 0 : Elevated(pid);
      f.Refuse = Refusal(f);
      return f;
    }

    static string Refusal(Facts f) {
      if (f.Self) return "that is one of Mantle's own windows";
      if (f.Shell) return "that is part of Windows' desktop, taskbar or Start, which Mantle leaves where Windows puts it";
      if (!f.Visible || f.Cloaked) return f.Name + " is not showing (hidden, or on another desktop)";
      if (f.Hung) return f.Name + " is not responding, so Windows cannot move it right now";
      if (f.Elevation == 1)
        return f.Name + " runs as administrator, so Windows doesn't let Mantle keep it on top";
      return null;
    }

    static IDictionary Obj(Facts f) {
      return Json.Obj(
        "hwnd", f.Hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
        "pid", f.Pid, "appPid", f.AppPid, "exe", f.Exe, "name", f.Name, "cls", f.Cls,
        "topmost", f.Topmost, "visible", f.Visible && !f.Cloaked, "minimized", f.Minimized,
        "self", f.Self, "shell", f.Shell, "hung", f.Hung, "fixture", f.Fixture,
        "elevated", f.Elevation == 1 ? (object)true : f.Elevation == 0 ? (object)false : null,
        "refuse", f.Refuse);
    }

    // ------------------------------------------------------------------ commands

    static string Front(Dictionary<string, object> req, ref object result) {
      IntPtr fg = Win32.GetForegroundWindow();
      if (fg == IntPtr.Zero || !Win32.IsWindow(fg)) {
        result = Json.Obj("hwnd", "0", "refuse", "nothing is in front right now (the lock screen, or a switch in flight)");
        return null;
      }
      IntPtr root = Win32.GetAncestor(fg, Win32.GA_ROOT);
      result = Obj(Read(root != IntPtr.Zero ? root : fg));
      return null;
    }

    static string Info(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window has closed";
      result = Obj(Read(hwnd));
      return null;
    }

    /// Cheap enough to poll while something is pinned: no message is sent to any window.
    static string Check(Dictionary<string, object> req, ref object result) {
      object v;
      var list = Json.TryGet(req, "hwnds", out v) ? v as List<object> : null;
      if (list == null) return "ontop.check needs hwnds: [{hwnd, pid}]";
      var outList = new List<object>();
      foreach (object o in list) {
        IntPtr h = IntPtr.Zero;
        int want = 0;
        var d = o as Dictionary<string, object>;
        if (d != null) { h = Json.GetHwnd(d, "hwnd"); want = Json.GetInt(d, "pid", 0); }
        else if (o is string) { long n; if (long.TryParse((string)o, out n)) h = new IntPtr(n); }
        int pid = 0;
        bool alive = h != IntPtr.Zero && Win32.IsWindow(h);
        if (alive) { Win32.GetWindowThreadProcessId(h, out pid); if (want != 0 && pid != want) alive = false; }
        outList.Add(Json.Obj("hwnd", h.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
                             "alive", alive, "pid", pid, "topmost", alive && IsTopmost(h)));
      }
      result = Json.Obj("windows", outList);
      return null;
    }

    static bool Apply(IntPtr hwnd, bool on, out int err) {
      bool ok = N.SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      err = ok ? 0 : Marshal.GetLastWin32Error();
      return ok;
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window has closed";
      if (!Json.HasKey(req, "on")) return "ontop.set needs on: true (keep on top) or false (stop)";
      bool on = Json.GetBool(req, "on", false);
      bool dry = Json.GetBool(req, "dryRun", false);
      Facts f = Read(hwnd);
      int want = Json.GetInt(req, "pid", 0);
      if (want != 0 && want != f.Pid) return "that window has closed (its handle now belongs to another program)";
      // Putting a window BACK (on:false) is always allowed where Windows allows it: only its own
      // refusals stop it (a hidden or minimised window can still lose its pin).
      string why = on ? f.Refuse : (f.Self ? "that is one of Mantle's own windows" : f.Shell ? "that is part of Windows' shell" :
                                    f.Hung ? f.Name + " is not responding, so Windows cannot move it right now" : null);
      if (why != null) return why;
      bool was = f.Topmost;
      string hs = hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (dry || (Program.Passive && !f.Fixture)) {
        if (!dry) return FeatureTable.PassiveRefusal + ": would have " + (on ? "kept" : "stopped keeping") + " window " + hs + " on top";
        result = Json.Obj("hwnd", hs, "pid", f.Pid, "name", f.Name, "dryRun", true, "was", was, "topmost", was, "wanted", on,
                          "would", was == on ? "nothing (it already is)" : on ? "SetWindowPos HWND_TOPMOST" : "SetWindowPos HWND_NOTOPMOST");
        return null;
      }
      if (was == on) {
        result = Json.Obj("hwnd", hs, "pid", f.Pid, "name", f.Name, "was", was, "topmost", was, "changed", false, "tries", 0,
                          "fixture", f.Fixture, "ms", sw.ElapsedMilliseconds);
        return null;
      }
      int err;
      bool ok = Apply(hwnd, on, out err);
      bool now = IsTopmost(hwnd);
      int tries = 1;
      while (now != on && tries < 3 && Win32.IsWindow(hwnd)) {
        Thread.Sleep(40 * tries);
        now = IsTopmost(hwnd);
        if (now == on) break;
        ok = Apply(hwnd, on, out err);
        tries++;
        now = IsTopmost(hwnd);
      }
      if (now != on) {
        if (!Win32.IsWindow(hwnd)) return "that window closed while it was being changed";
        if (!ok && err == ERROR_ACCESS_DENIED)
          return f.Name + " runs as administrator (or is protected), so Windows refused the change";
        if (!ok) return "Windows refused to change " + f.Name + " (it may be closing, or protected)";
        return "Windows accepted the change, but " + f.Name + (on ? " is still not on top" : " is still on top") +
               " after " + tries + " tries (the app may put its own z-order back)";
      }
      result = Json.Obj("hwnd", hs, "pid", f.Pid, "name", f.Name, "was", was, "topmost", now, "changed", true, "tries", tries,
                        "fixture", f.Fixture, "ms", sw.ElapsedMilliseconds);
      return null;
    }
  }
}
