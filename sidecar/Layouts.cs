// Layouts.cs - Window layouts: the Windows half (lane layouts, 2026-09-27).
//
// WHY: the user arranges the same windows again and again ("Work": Quartz with a video, their notes;
// "Code": terminals and editors). Windows' Snap Groups vanish on a reboot. lib/features/layouts.js
// saves an arrangement by name and puts it back with one click; this file only reads windows and
// moves ONE window at a time. The matching, the rect maths and the launching are the JS side's
// (lib/features/_layouts-core.js, _layouts-run.js), so they are unit-tested without a window.
//
//   layouts.monitors {}                        every monitor: HMONITOR id, device name, bounds and
//                                              work area (PHYSICAL px), dpi, primary
//   layouts.windows  {pids?}                   every normal app window, as facts (below)
//   layouts.place    {hwnd, pid?, frame:{x,y,w,h}, state:'normal'|'max', dryRun?}
//                                              put its VISIBLE frame there (or maximise it on the
//                                              monitor holding frame, with frame as its restore
//                                              rect), then measure: the answer is what Windows did
//
// WHICH WINDOWS: visible, top-level, unowned, titled, not cloaked (another virtual desktop), not a
// tool window (WS_EX_TOOLWINDOW, or WS_EX_NOACTIVATE without WS_EX_APPWINDOW, as Alt+Tab decides),
// not Windows' shell (desktop, taskbar, Start, search) and not Mantle's own (the sidecar and its
// Electron parent). Minimised windows ARE listed (state 'min'): the JS side leaves them out of a
// saved layout but puts a minimised match back in its spot. `skipped` counts what was left out.
//
// TITLES ARE PRIVATE: read with InternalGetWindowText (no message sent), returned only for matching
// and never logged. A passive (test) sidecar returns a title ONLY for a window of a process the
// test harness started (its fixtures): the user's titles never leave the sidecar in a test.
//
// NEVER BLOCKS: layouts.place runs on the slow lane, refuses a window Windows calls hung or that
// does not answer WM_NULL in 250 ms, and moves with SWP_ASYNCWINDOWPOS / WPF_ASYNCWINDOWPLACEMENT
// (posted to the window's own thread), then polls the result. Refused in words: Mantle's own
// windows, the shell, a window running as administrator while Mantle does not (UIPI: Windows would
// silently ignore the move), a hung one.
//
// FOCUS: a move is SWP_NOACTIVATE and a restore is SW_SHOWNOACTIVATE. Windows has no maximise that
// leaves the focus alone (sidecar/Snap.cs says the same), so a window that must be maximised may
// come to the front; one that already is maximised on the right monitor is left untouched.
//
// PASSIVE (every test sidecar): a move goes only to a window of a process the harness started
// (Snap.cs's fence); anything else answers FeatureTable.PassiveRefusal. dryRun says what it would do.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class Layouts {
    public static void Register(FeatureTable t) {
      t.Add("layouts.monitors", Lanes.Ui, MonitorsCmd);
      t.Add("layouts.windows", Lanes.Ui, WindowsCmd);
      t.Add("layouts.place", Lanes.Slow, PlaceCmd);
    }

    const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_NOOWNERZORDER = 0x0200, SWP_ASYNCWINDOWPOS = 0x4000;
    const int WPF_ASYNCWINDOWPLACEMENT = 0x0004;
    const int SW_SHOWMAXIMIZED = 3, SW_SHOWNOACTIVATE = 4;
    const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_NOACTIVATE = 0x08000000;
    const int TOL = 3;   // px: a DPI-virtualised app rounds its position by one or two

    static readonly HashSet<string> SkipClasses = new HashSet<string>(StringComparer.Ordinal) {
      "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow",
      "MSCTFIME UI", "Default IME", "Button", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
      "XamlExplorerHostIslandWindow", "ForegroundStaging", "MultitaskingViewFrame", "TaskListThumbnailWnd",
    };
    static readonly string[] ShellExes = {
      "StartMenuExperienceHost.exe", "SearchHost.exe", "SearchApp.exe", "ShellExperienceHost.exe",
      "ShellHost.exe", "LockApp.exe", "TextInputHost.exe"
    };

    static class N {
      public delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref SnapRect rc, IntPtr data);
      public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct MONITORINFOEX {
        public int cbSize; public SnapRect rcMonitor; public SnapRect rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
      }
      [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
      [StructLayout(LayoutKind.Sequential)]
      public struct WINDOWPLACEMENT {
        public int length, flags, showCmd;
        public POINT ptMinPosition, ptMaxPosition;
        public SnapRect rcNormalPosition;
      }
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct PROCESSENTRY32W {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
      }
      [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFOEX mi);
      [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
      [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref SnapRect r, uint flags);
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
      [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern bool IsWindowArranged(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out SnapRect rect);
      [DllImport("user32.dll", SetLastError = true)]
      public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
      [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int index, uint dpi);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int InternalGetWindowText(IntPtr hwnd, StringBuilder s, int max);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)]
      public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
      [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dpiX, out uint dpiY);
      [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out SnapRect val, int size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)]
      public static extern bool GetTokenInformation(IntPtr tok, int cls, out int val, int len, out int ret);
    }

    static string S(long v) { return v.ToString(CultureInfo.InvariantCulture); }

    // ------------------------------------------------------------------ monitors

    sealed class Mon {
      public IntPtr H;
      public string Device = "";
      public SnapRect Bounds, Work;
      public int Dpi = 96;
      public bool Primary;
      public IDictionary ToJson() {
        return Json.Obj("id", S(H.ToInt64()), "device", Device, "bounds", Bounds.ToJson(), "work", Work.ToJson(),
                        "dpi", Dpi, "scale", Math.Round(Dpi / 96.0, 3), "primary", Primary);
      }
    }

    static Mon ReadMon(IntPtr h) {
      var mi = new N.MONITORINFOEX();
      mi.cbSize = Marshal.SizeOf(typeof(N.MONITORINFOEX));
      if (h == IntPtr.Zero || !N.GetMonitorInfoW(h, ref mi)) return null;
      var m = new Mon { H = h, Device = mi.szDevice ?? "", Bounds = mi.rcMonitor, Work = mi.rcWork, Primary = (mi.dwFlags & 1) != 0 };
      uint dx, dy;
      try { if (N.GetDpiForMonitor(h, 0, out dx, out dy) == 0 && dx > 0) m.Dpi = (int)dx; } catch (Exception) { }
      return m;
    }

    static List<Mon> ReadMons() {
      var list = new List<Mon>();
      N.MonitorEnumProc cb = delegate (IntPtr h, IntPtr hdc, ref SnapRect rc, IntPtr data) {
        Mon m = ReadMon(h);
        if (m != null) list.Add(m);
        return true;
      };
      N.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return list;
    }

    static Mon MonFor(SnapRect r, List<Mon> mons) {
      IntPtr h = N.MonitorFromRect(ref r, 2 /* NEAREST */);
      foreach (Mon m in mons) if (m.H == h) return m;
      return ReadMon(h);
    }

    static string MonitorsCmd(Dictionary<string, object> req, ref object result) {
      var list = new List<object>();
      foreach (Mon m in ReadMons()) list.Add(m.ToJson());
      if (list.Count == 0) return "Windows reported no monitors (EnumDisplayMonitors found none)";
      result = Json.Obj("monitors", list);
      return null;
    }

    // ------------------------------------------------------------------ facts about a window

    static string Title(IntPtr hwnd) {
      var sb = new StringBuilder(512);
      N.InternalGetWindowText(hwnd, sb, sb.Capacity);
      return sb.ToString();
    }

    sealed class Ver { public string Desc, Product; }
    static readonly Dictionary<string, Ver> _vers = new Dictionary<string, Ver>(StringComparer.OrdinalIgnoreCase);
    static readonly object _verLock = new object();
    static Ver VersionOf(string exe) {
      if (string.IsNullOrEmpty(exe)) return new Ver();
      lock (_verLock) {
        Ver v;
        if (_vers.TryGetValue(exe, out v)) return v;
        v = new Ver();
        try {
          var fi = FileVersionInfo.GetVersionInfo(exe);
          v.Desc = fi.FileDescription == null ? null : fi.FileDescription.Trim();
          v.Product = fi.ProductName == null ? null : fi.ProductName.Trim();
        } catch (Exception) { }
        if (_vers.Count > 256) _vers.Clear();
        _vers[exe] = v;
        return v;
      }
    }

    static int _selfElevated = -1;
    static bool SelfElevated() {
      if (_selfElevated < 0) _selfElevated = TokenElevated(N.GetCurrentProcess()) == 1 ? 1 : 0;
      return _selfElevated == 1;
    }
    /// 1 elevated, 0 not, -1 unknown (its token cannot be read from here).
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

    static uint ParentOf(int pid) {
      IntPtr snap = N.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
      try {
        var e = new N.PROCESSENTRY32W();
        e.dwSize = (uint)Marshal.SizeOf(typeof(N.PROCESSENTRY32W));
        if (!N.Process32FirstW(snap, ref e)) return 0;
        do { if (e.th32ProcessID == (uint)pid) return e.th32ParentProcessID; } while (N.Process32NextW(snap, ref e));
        return 0;
      } finally { N.CloseHandle(snap); }
    }

    /// The passive fence (Snap.cs's): a test may touch only a window of a process its harness started.
    static bool Ours(int pid) {
      if (!Program.Passive) return true;
      if (Program.ParentPid <= 0 || pid <= 0) return false;
      return ParentOf(pid) == (uint)Program.ParentPid;
    }

    static SnapRect FrameOf(IntPtr hwnd, SnapRect fallback) {
      SnapRect f;
      if (N.DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out f, Marshal.SizeOf(typeof(SnapRect))) == 0 && !f.Empty)
        return f;
      return fallback;
    }

    /// Windows' standard frame at a DPI: SM_CXSIZEFRAME + SM_CXPADDEDBORDER, minus the 1 px DWM
    /// border, 0 at the top (7 px at 100 %). Used only when the real borders cannot be measured
    /// (the window is maximised or minimised).
    static SnapMargins Standard(int dpi) {
      int e = 7;
      try { e = N.GetSystemMetricsForDpi(32, (uint)dpi) + N.GetSystemMetricsForDpi(92, (uint)dpi) - 1; } catch (Exception) { }
      if (e < 0 || e > 64) e = 7;
      return new SnapMargins(e, 0, e, e);
    }

    static bool Measured(SnapRect rect, SnapRect frame, int dpi, out SnapMargins m) {
      m = new SnapMargins(frame.Left - rect.Left, frame.Top - rect.Top, rect.Right - frame.Right, rect.Bottom - frame.Bottom);
      int cap = 48 * Math.Max(96, dpi) / 96;
      return m.L >= 0 && m.T >= 0 && m.R >= 0 && m.B >= 0 && m.L <= cap && m.T <= cap && m.R <= cap && m.B <= cap;
    }

    static SnapRect Grow(SnapRect f, SnapMargins m) { return new SnapRect(f.Left - m.L, f.Top - m.T, f.Right + m.R, f.Bottom + m.B); }
    static SnapRect Shrink(SnapRect r, SnapMargins m) { return new SnapRect(r.Left + m.L, r.Top + m.T, r.Right - m.R, r.Bottom - m.B); }

    // WINDOWPLACEMENT's rects are WORKSPACE coordinates for a window without WS_EX_TOOLWINDOW: the
    // offset is the work area's inset on the monitor holding the rect (Snap.cs, test-snap.js).
    static SnapRect WorkspaceToScreen(SnapRect r, long ex, List<Mon> mons) {
      if ((ex & WS_EX_TOOLWINDOW) != 0 || mons.Count == 0) return r;
      Mon m = MonFor(r, mons);
      if (m == null) return r;
      int dx = m.Work.Left - m.Bounds.Left, dy = m.Work.Top - m.Bounds.Top;
      return new SnapRect(r.Left + dx, r.Top + dy, r.Right + dx, r.Bottom + dy);
    }
    static SnapRect ScreenToWorkspace(SnapRect r, long ex, Mon m) {
      if ((ex & WS_EX_TOOLWINDOW) != 0 || m == null) return r;
      int dx = m.Work.Left - m.Bounds.Left, dy = m.Work.Top - m.Bounds.Top;
      return new SnapRect(r.Left - dx, r.Top - dy, r.Right - dx, r.Bottom - dy);
    }

    sealed class Win {
      public IntPtr Hwnd;
      public int Pid;
      public Apps.WinApp App;
      public string Cls = "", Exe = "", Name = "", Desc, Product;
      public long Ex;
      public SnapRect Rect, Frame, NormalFrame;
      public bool HasNormal, Min, Max, Arranged, Hung, Self, Shell, Ours;
      public int Dpi = 96, Elevation;
      public Mon Monitor;
      public string Refuse;
    }

    static Win Read(IntPtr hwnd, List<Mon> mons, bool withApp) {
      var w = new Win { Hwnd = hwnd };
      Win32.GetWindowThreadProcessId(hwnd, out w.Pid);
      w.Cls = Win32.GetClassName(hwnd) ?? "";
      w.Ex = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();
      if (withApp) {
        w.App = Apps.ForWindow(hwnd, w.Cls, w.Pid);
        w.Exe = w.App.Exe ?? "";
      } else {
        w.Exe = Win32.GetProcessPath(w.Pid) ?? "";
      }
      Ver v = VersionOf(w.Exe);
      w.Desc = v.Desc; w.Product = v.Product;
      string bare = Path.GetFileNameWithoutExtension(w.Exe);
      w.Name = !string.IsNullOrEmpty(w.Desc) ? w.Desc : !string.IsNullOrEmpty(bare) ? bare : "this window";
      if (w.Name.Length > 48) w.Name = w.Name.Substring(0, 47) + "…";
      N.GetWindowRect(hwnd, out w.Rect);
      w.Frame = FrameOf(hwnd, w.Rect);
      w.Min = Win32.IsIconic(hwnd);
      w.Max = N.IsZoomed(hwnd);
      try { w.Arranged = N.IsWindowArranged(hwnd); } catch (Exception) { w.Arranged = false; }
      try { w.Dpi = (int)N.GetDpiForWindow(hwnd); } catch (Exception) { w.Dpi = 0; }
      w.Monitor = ReadMon(N.MonitorFromWindow(hwnd, 2 /* NEAREST */));
      if (w.Dpi <= 0) w.Dpi = w.Monitor != null ? w.Monitor.Dpi : 96;
      var pl = new N.WINDOWPLACEMENT();
      pl.length = Marshal.SizeOf(typeof(N.WINDOWPLACEMENT));
      if (N.GetWindowPlacement(hwnd, ref pl)) {
        SnapRect normal = WorkspaceToScreen(pl.rcNormalPosition, w.Ex, mons);
        SnapMargins m;
        if (w.Min || w.Max || !Measured(w.Rect, w.Frame, w.Dpi, out m)) m = Standard(w.Dpi);
        w.NormalFrame = Shrink(normal, m);
        w.HasNormal = !w.NormalFrame.Empty;
      }
      w.Hung = N.IsHungAppWindow(hwnd);
      w.Self = w.Pid != 0 && (w.Pid == Program.OwnPid || (Program.ParentPid > 0 && w.Pid == Program.ParentPid && !Program.Passive));
      w.Shell = hwnd == N.GetShellWindow() || hwnd == Win32.GetDesktopWindow() || SkipClasses.Contains(w.Cls) ||
                Array.Exists(ShellExes, delegate (string e) { return string.Equals(e, Path.GetFileName(w.Exe), StringComparison.OrdinalIgnoreCase); });
      w.Ours = Ours(w.Pid) || (w.App != null && w.App.Pid != w.Pid && Ours(w.App.Pid));
      w.Elevation = SelfElevated() ? 0 : Elevated(w.Pid);
      w.Refuse = Refusal(w);
      return w;
    }

    static string Refusal(Win w) {
      if (w.Self) return "that is one of Mantle's own windows";
      if (w.Shell) return "that is part of Windows' desktop, taskbar or Start, which Mantle leaves where Windows puts it";
      if (w.Hung) return w.Name + " is not responding, so it was left where it is";
      if (w.Elevation == 1)
        // plain words on screen (lane windows-layouts, 2026-09-29): no "UIPI", no API names or error numbers
        return w.Name + " runs as administrator, so Windows doesn't let Mantle move it";
      return null;
    }

    static string StateOf(Win w) { return w.Min ? "min" : w.Max ? "max" : "normal"; }

    // ------------------------------------------------------------------ layouts.windows

    static string WindowsCmd(Dictionary<string, object> req, ref object result) {
      HashSet<int> only = null;
      object pv;
      if (Json.TryGet(req, "pids", out pv) && pv is List<object>) {
        only = new HashSet<int>();
        foreach (object o in (List<object>)pv) if (o is double) only.Add((int)(double)o);
      }
      List<Mon> mons = ReadMons();
      var list = new List<object>();
      int tool = 0, shell = 0, self = 0, hidden = 0, failed = 0;
      N.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        try {
          if (!Win32.IsWindowVisible(hwnd)) return true;
          if (Win32.GetWindow(hwnd, Win32.GW_OWNER) != IntPtr.Zero) return true;   // a dialog of another window
          long ex = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();
          int pid;
          Win32.GetWindowThreadProcessId(hwnd, out pid);
          if (only != null && !only.Contains(pid)) return true;
          if ((ex & WS_EX_TOOLWINDOW) != 0 || ((ex & WS_EX_NOACTIVATE) != 0 && (ex & WS_EX_APPWINDOW) == 0)) { tool++; return true; }
          var sb = new StringBuilder(2);
          if (N.InternalGetWindowText(hwnd, sb, sb.Capacity) == 0) return true;   // untitled: not an app window
          string cls = Win32.GetClassName(hwnd) ?? "";
          if (SkipClasses.Contains(cls)) { shell++; return true; }
          if (Win32.IsCloaked(hwnd)) { hidden++; return true; }
          if (pid == Program.OwnPid || (Program.ParentPid > 0 && pid == Program.ParentPid && !Program.Passive)) { self++; return true; }
          Win w = Read(hwnd, mons, true);
          if (w.Shell) { shell++; return true; }
          // A passive sidecar hands out a title only for its harness's own fixtures.
          string title = w.Ours ? Title(hwnd) : null;
          if (title != null && title.Length > 256) title = title.Substring(0, 256);
          list.Add(Json.Obj(
            "hwnd", S(hwnd.ToInt64()), "pid", w.Pid, "appPid", w.App.Pid, "exe", w.Exe, "aumid", w.App.Aumid, "host", w.App.Host,
            "cls", w.Cls, "name", w.Name, "desc", w.Desc, "product", w.Product, "title", title,
            "state", StateOf(w), "arranged", w.Arranged,
            "frame", w.Frame.ToJson(), "rect", w.Rect.ToJson(), "normal", w.HasNormal ? w.NormalFrame.ToJson() : null,
            "monitor", w.Monitor != null ? S(w.Monitor.H.ToInt64()) : null, "dpi", w.Dpi,
            "hung", w.Hung, "elevated", w.Elevation == 1 ? (object)true : w.Elevation == 0 ? (object)false : null,
            "ours", w.Ours, "refuse", w.Refuse));
        } catch (Exception) {
          failed++;   // one bad window never truncates the list; counted, never silent
        }
        return true;
      };
      N.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      var mjson = new List<object>();
      foreach (Mon m in mons) mjson.Add(m.ToJson());
      result = Json.Obj("windows", list, "monitors", mjson, "passive", Program.Passive,
                        "skipped", Json.Obj("tool", tool, "shell", shell, "mantle", self, "otherDesktop", hidden, "unreadable", failed));
      return null;
    }

    // ------------------------------------------------------------------ layouts.place

    static bool FrameArg(Dictionary<string, object> req, string key, out SnapRect r) {
      r = new SnapRect();
      object v;
      if (!Json.TryGet(req, key, out v)) return false;
      var d = v as Dictionary<string, object>;
      if (d == null) return false;
      object x, y, w, h;
      if (!Json.TryGet(d, "x", out x) || !Json.TryGet(d, "y", out y) || !Json.TryGet(d, "w", out w) || !Json.TryGet(d, "h", out h)) return false;
      if (!(x is double && y is double && w is double && h is double)) return false;
      int ix = (int)Math.Round((double)x), iy = (int)Math.Round((double)y), iw = (int)Math.Round((double)w), ih = (int)Math.Round((double)h);
      if (iw < 1 || ih < 1 || iw > 32000 || ih > 32000) return false;
      r = new SnapRect(ix, iy, ix + iw, iy + ih);
      return true;
    }

    static bool Near(SnapRect a, SnapRect b, int tol) {
      return Math.Abs(a.Left - b.Left) <= tol && Math.Abs(a.Top - b.Top) <= tol &&
             Math.Abs(a.Right - b.Right) <= tol && Math.Abs(a.Bottom - b.Bottom) <= tol;
    }

    static bool WaitFor(Func<bool> done, int ms) {
      var sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < ms) {
        if (done()) return true;
        Thread.Sleep(25);
      }
      return done();
    }

    static SnapRect FrameNow(IntPtr hwnd) {
      SnapRect r;
      N.GetWindowRect(hwnd, out r);
      return FrameOf(hwnd, r);
    }

    static string Placement(IntPtr hwnd, int showCmd, SnapRect normalWindow, long ex, Mon target) {
      var pl = new N.WINDOWPLACEMENT();
      pl.length = Marshal.SizeOf(typeof(N.WINDOWPLACEMENT));
      if (!N.GetWindowPlacement(hwnd, ref pl)) return "Windows would not say where the window is";
      pl.flags = WPF_ASYNCWINDOWPLACEMENT;
      pl.showCmd = showCmd;
      pl.rcNormalPosition = ScreenToWorkspace(normalWindow, ex, target);
      if (!N.SetWindowPlacement(hwnd, ref pl)) {
        int err = Marshal.GetLastWin32Error();
        return err == 5 ? "it runs as administrator, or is protected" : "Windows would not change it";
      }
      return null;
    }

    static string PlaceCmd(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window has closed";
      string state = Json.GetString(req, "state") ?? "normal";
      // 'min' (lane windows-layouts, 2026-09-29): Undo puts a window that was minimised back minimised,
      // with frame as its restore spot
      if (state != "normal" && state != "max" && state != "min") return "layouts.place state must be 'normal', 'max' or 'min'";
      SnapRect target;
      if (!FrameArg(req, "frame", out target)) return "layouts.place needs frame {x, y, w, h} in physical pixels";
      bool dry = Json.GetBool(req, "dryRun", false);
      List<Mon> mons = ReadMons();
      Win w = Read(hwnd, mons, false);
      int want = Json.GetInt(req, "pid", 0);
      if (want != 0 && want != w.Pid) return "that window has closed (its handle now belongs to another program)";
      if (w.Self) return "that is one of Mantle's own windows";
      if (w.Shell) return "that is part of Windows' shell, which Mantle leaves where Windows puts it";
      string hs = S(hwnd.ToInt64());
      string from = StateOf(w);
      Mon mon = MonFor(target, mons);
      if (dry || (Program.Passive && !w.Ours)) {
        if (!dry) return FeatureTable.PassiveRefusal + ": layouts would move a window on the live desktop (a test may only move a window its own harness started)";
        string would = state == "min"
          ? (from == "min" ? "nothing (it is already minimised)" : "minimise it, with its restore spot at " + target.ToString())
          : state == "max"
          ? (from == "max" && w.Monitor != null && mon != null && w.Monitor.H == mon.H ? "nothing (it is already maximised there)" : "maximise it on the monitor at " + (mon != null ? mon.Bounds.ToString() : "?"))
          : (from == "normal" && Near(w.Frame, target, TOL) ? "nothing (it is already there)" : "put its frame at " + target.ToString() + (from != "normal" ? " (restored from " + from + ")" : ""));
        result = Json.Obj("hwnd", hs, "dryRun", true, "from", from, "state", state, "would", would, "refuse", w.Refuse,
                          "frame", w.Frame.ToJson(), "want", target.ToJson());
        return null;
      }
      if (w.Refuse != null) return w.Refuse;
      UIntPtr res;
      if (N.SendMessageTimeoutW(hwnd, 0 /* WM_NULL */, UIntPtr.Zero, IntPtr.Zero, 0x0002 /* SMTO_ABORTIFHUNG */, 250, out res) == IntPtr.Zero)
        return w.Name + " did not answer right away (busy, or not responding), so it was left where it is";
      int dpi = mon != null ? mon.Dpi : w.Dpi;
      int moves = 0;
      SnapRect before = w.Frame;

      if (state == "min") {
        if (w.Min) {
          result = Json.Obj("hwnd", hs, "placed", true, "already", true, "state", "min", "from", from,
                            "moves", 0, "ms", sw.ElapsedMilliseconds);
          return null;
        }
        SnapMargins mm;
        if (w.Max || !Measured(w.Rect, w.Frame, w.Dpi, out mm)) mm = Standard(dpi);
        string merr = Placement(hwnd, 7 /* SW_SHOWMINNOACTIVE */, Grow(target, mm), w.Ex, mon);
        if (merr != null) return "Windows refused to minimise " + w.Name + " (" + merr + ")";
        if (!WaitFor(delegate { return !Win32.IsWindow(hwnd) || Win32.IsIconic(hwnd); }, 1500) || !Win32.IsWindow(hwnd)) {
          if (!Win32.IsWindow(hwnd)) return "that window closed while it was being placed";
          return "Windows accepted the change, but " + w.Name + " did not minimise (the app may not allow it)";
        }
        result = Json.Obj("hwnd", hs, "placed", true, "already", false, "state", "min", "from", from,
                          "moves", 1, "ms", sw.ElapsedMilliseconds);
        return null;
      }

      if (state == "max") {
        bool there = w.Max && w.Monitor != null && mon != null && w.Monitor.H == mon.H;
        if (there) {
          result = Json.Obj("hwnd", hs, "placed", true, "already", true, "state", "max", "from", from, "monitorOk", true,
                            "frame", w.Frame.ToJson(), "moves", 0, "ms", sw.ElapsedMilliseconds);
          return null;
        }
        SnapMargins m;
        if (w.Min || w.Max || !Measured(w.Rect, w.Frame, w.Dpi, out m)) m = Standard(dpi);
        SnapRect normalWin = Grow(target, m);
        string err;
        if (w.Max) {   // maximised on another monitor: out of it first, so the new one is where it maximises
          err = Placement(hwnd, SW_SHOWNOACTIVATE, normalWin, w.Ex, mon);
          if (err != null) return "Windows refused to move " + w.Name + " (" + err + ")";
          moves++;
          WaitFor(delegate { return !N.IsZoomed(hwnd); }, 1200);
        }
        err = Placement(hwnd, SW_SHOWMAXIMIZED, normalWin, w.Ex, mon);
        if (err != null) return "Windows refused to maximise " + w.Name + " (" + err + ")";
        moves++;
        if (!WaitFor(delegate { return !Win32.IsWindow(hwnd) || N.IsZoomed(hwnd); }, 1500) || !Win32.IsWindow(hwnd)) {
          if (!Win32.IsWindow(hwnd)) return "that window closed while it was being placed";
          return "Windows accepted the change, but " + w.Name + " did not maximise (the app may not allow it)";
        }
        Mon now = ReadMon(N.MonitorFromWindow(hwnd, 2));
        bool monOk = now != null && mon != null && now.H == mon.H;
        result = Json.Obj("hwnd", hs, "placed", true, "already", false, "state", "max", "from", from, "monitorOk", monOk,
                          "frame", FrameNow(hwnd).ToJson(), "moves", moves, "ms", sw.ElapsedMilliseconds);
        return null;
      }

      // ---- normal: out of maximised / minimised first (margins estimated), then the exact frame
      if (w.Min || w.Max) {
        string err = Placement(hwnd, SW_SHOWNOACTIVATE, Grow(target, Standard(dpi)), w.Ex, mon);
        if (err != null) return "Windows refused to restore " + w.Name + " (" + err + ")";
        moves++;
        if (!WaitFor(delegate { return !Win32.IsWindow(hwnd) || (!Win32.IsIconic(hwnd) && !N.IsZoomed(hwnd)); }, 1500))
          return "Windows accepted the change, but " + w.Name + " stayed " + (w.Min ? "minimised" : "maximised");
        if (!Win32.IsWindow(hwnd)) return "that window closed while it was being placed";
      } else if (Near(w.Frame, target, TOL)) {
        result = Json.Obj("hwnd", hs, "placed", true, "already", true, "state", "normal", "from", from, "exact", true,
                          "frame", w.Frame.ToJson(), "want", target.ToJson(), "moves", 0, "ms", sw.ElapsedMilliseconds);
        return null;
      }
      SnapRect got = FrameNow(hwnd);
      int lastErr = 0;
      for (int pass = 0; pass < 3 && !Near(got, target, TOL); pass++) {
        SnapRect rect;
        N.GetWindowRect(hwnd, out rect);
        int wdpi = dpi;
        try { wdpi = (int)N.GetDpiForWindow(hwnd); } catch (Exception) { }
        SnapMargins m;
        if (!Measured(rect, got, wdpi, out m)) m = Standard(wdpi > 0 ? wdpi : dpi);
        SnapRect win = Grow(target, m);
        if (!N.SetWindowPos(hwnd, IntPtr.Zero, win.Left, win.Top, win.Width, win.Height,
                            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS)) {
          lastErr = Marshal.GetLastWin32Error();
          break;
        }
        moves++;
        // A move onto a monitor with another DPI makes the app rescale itself (WM_DPICHANGED): its
        // borders change, so the next pass measures them again.
        WaitFor(delegate { SnapRect f = FrameNow(hwnd); return !Win32.IsWindow(hwnd) || Near(f, target, TOL); }, 700);
        if (!Win32.IsWindow(hwnd)) return "that window closed while it was being placed";
        got = FrameNow(hwnd);
      }
      bool exact = Near(got, target, TOL);
      if (!exact && Near(got, before, 1) && lastErr != 0)
        return lastErr == 5 ? w.Name + " runs as administrator (or is protected), so Windows refused the move"
                            : "Windows refused to move " + w.Name + " (it may be closing, or protected)";
      if (!exact && Near(got, before, 1))
        return "Windows accepted the move, but " + w.Name + " stayed where it was (the app may position itself)";
      string note = null;
      if (!exact) {
        if (got.Width > target.Width + TOL || got.Height > target.Height + TOL)
          note = "it kept a bigger size (" + got.Width + "x" + got.Height + " px, it has a minimum size)";
        else if (got.Width < target.Width - TOL || got.Height < target.Height - TOL)
          note = "it kept a smaller size (" + got.Width + "x" + got.Height + " px, it may have a fixed or maximum size)";
        else note = "it ended " + Math.Max(Math.Abs(got.Left - target.Left), Math.Abs(got.Top - target.Top)) + " px off";
      }
      result = Json.Obj("hwnd", hs, "placed", true, "already", false, "state", "normal", "from", from, "exact", exact, "note", note,
                        "frame", got.ToJson(), "want", target.ToJson(), "moves", moves, "ms", sw.ElapsedMilliseconds);
      return null;
    }
  }
}
