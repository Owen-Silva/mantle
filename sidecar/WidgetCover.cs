// WidgetCover.cs - is an app window sitting over a desktop widget? (lane widgethide, 2026-10-10)
//
// WHY: the user, 2026-10-10: the desktop widgets (the clock, SYSTEM, MISSION CONTROL, NEEDS
// ATTENTION) should be hidden "when you arent actually on the wallpaper": each one fades out while
// a window sits over it and comes back when that window is minimised, moved away, or on Win+D.
// Apps may become see-through to the desktop later, so a widget must not show through a window.
//
// HOW: main (lib/features/widgethide.js) hands over the widgets' rects in PHYSICAL screen pixels
// with `widgethide.watch {on, areas:[{key, l, t, r, b}]}`. No new poll and no new hook: the
// window list's own WinEvent hooks (Windows.cs: foreground, minimise start/end, and the object
// range create..namechange, which includes LOCATIONCHANGE = a move or resize) already raise a
// dirty flag that its 250 ms timer coalesces, plus its 2 s safety-net poll. That timer calls
// Tick() here, on the same ui thread, and Tick emits {ev:"widgethide", covered, by} only when a
// widget's covered/uncovered answer CHANGES.
//
// WHAT COVERS: a top-level window that is visible, not minimised, not cloaked (another virtual
// desktop, a suspended Store app), not a tool window (tooltips, palettes, IME), not click-through
// (WS_EX_TRANSPARENT: game and recording overlays draw over everything and take no input), not
// fully transparent (a layered window at alpha 0, which is how a Mantle --test window hides), not
// shell furniture (desktop, taskbars, menus, Windows' own flyouts), not Mantle's own shell UI (the
// bar, top bar and pop-ups; Mantle's APP windows like Settings and Files DO cover), not zero-size,
// and ABOVE the desktop in z-order: EnumWindows walks top to bottom and stops at Progman, so a
// window Windows put behind the desktop (the older Show-desktop mechanism) never counts. Its rect
// is DWM's extended frame (what is drawn, without the invisible resize border), and it covers a
// widget when the two overlap by at least 2 px each way. Multi-monitor needs nothing special: the
// rects are virtual-screen pixels, so a window on another monitor cannot overlap.
//
// Read-only (nothing on screen changes), so it runs in passive mode too. `widgethide.check` is the
// same decision on demand; in passive it also accepts `fake` windows, so a test can run the real
// filter on windows no one can create invisibly (a cloaked one, a tooltip, the taskbar).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

namespace Mantle {
  [MantleFeature]
  static class WidgetCover {
    public static void Register(FeatureTable t) {
      t.Add("widgethide.watch", Lanes.Ui, Watch);
      t.Add("widgethide.check", Lanes.Ui, Check);
    }

    static class N {
      [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out Win32.RECT val, int size);
      [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint key, out byte alpha, out uint flags);
    }
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const long WS_EX_TRANSPARENT = 0x20, WS_EX_LAYERED = 0x80000;
    const uint LWA_ALPHA = 0x2;
    const int MinOverlap = 2;

    // Shell furniture and transient system UI that never means "an app is over the desktop".
    static readonly HashSet<string> Furniture = new HashSet<string>(StringComparer.Ordinal) {
      "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
      "TopLevelWindowForOverflowXamlIsland", "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow",
      "#32768" /* a menu */, "tooltips_class32", "SysShadow", "MSCTFIME UI", "IME", "Default IME",
      "ForegroundStaging", "Shell_InputSwitchTopLevelWindow", "EdgeUiInputTopWndClass",
    };

    sealed class Area { public string Key; public int L, T, R, B; }
    public sealed class Win {
      public string Hwnd = "", Cls = "", Title = "";
      public bool Visible = true, Iconic, Cloaked;
      public long ExStyle;
      public int Pid, Alpha = -1;   // Alpha: -1 = not a layered alpha window
      public int L, T, R, B;
      public bool Desktop;           // this is Progman: everything after it is behind the desktop
    }

    static List<Area> _areas = new List<Area>();
    static bool _on;
    static string _sig;
    static string _lastErr;

    /// Windows.cs OnTick, on the ui thread, after a window event (or on its 2 s poll).
    public static void Tick() {
      if (!_on || _areas.Count == 0) return;
      try {
        IDictionary covered, by;
        Decide(_areas, Live(), out covered, out by);
        string sig = Sig(covered);
        _lastErr = null;
        if (sig == _sig) return;
        _sig = sig;
        Features.Event("widgethide", Json.Obj("covered", covered, "by", by));
      } catch (Exception ex) {
        string msg = "the covered-widget check failed: " + ex.Message;
        if (msg != _lastErr) { _lastErr = msg; Features.Event("widgethide", Json.Obj("error", msg)); }
      }
    }

    static string Watch(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      List<Area> areas;
      string err = ReadAreas(req, out areas);
      if (err != null) return err;
      _on = on;
      _areas = on ? areas : new List<Area>();
      _sig = null;
      IDictionary covered = Json.Obj(), by = Json.Obj();
      if (_on && _areas.Count > 0) {
        Decide(_areas, Live(), out covered, out by);
        _sig = Sig(covered);
      }
      result = Json.Obj("on", _on, "areas", _areas.Count, "covered", covered, "by", by);
      return null;
    }

    static string Check(Dictionary<string, object> req, ref object result) {
      List<Area> areas;
      string err = ReadAreas(req, out areas);
      if (err != null) return err;
      List<Win> wins;
      object raw;
      if (Json.TryGet(req, "fake", out raw)) {
        if (!Program.Passive) return "widgethide.check: fake windows are a test feature and only run in --passive";
        err = ReadFake(raw, out wins);
        if (err != null) return err;
      } else {
        wins = Live();
      }
      var why = new List<object>();
      IDictionary covered, by;
      Decide(areas, wins, out covered, out by, why);
      result = Json.Obj("covered", covered, "by", by, "windows", why);
      return null;
    }

    // ------------------------------------------------------------------ the decision (pure)

    /// Null when `w` can cover a widget, else the plain-words reason it is ignored.
    public static string Ignored(Win w, int ownPid, int parentPid) {
      if (!w.Visible) return "not visible";
      if (w.Iconic) return "minimised";
      if (w.Cloaked) return "cloaked (another desktop, or not shown by Windows)";
      if ((w.ExStyle & Win32.WS_EX_TOOLWINDOW) != 0) return "a tool window (tooltip, palette, helper)";
      if ((w.ExStyle & WS_EX_TRANSPARENT) != 0) return "click-through overlay";
      if (w.Alpha == 0) return "fully transparent";
      if (Furniture.Contains(w.Cls)) return "Windows shell furniture (" + w.Cls + ")";
      if (w.Pid != 0 && w.Pid == ownPid) return "Mantle's helper";
      if (parentPid > 0 && w.Pid == parentPid && !Switcher.IsMantleApp(w.Cls, w.Title)) return "Mantle's own bar or pop-up";
      if (w.R - w.L <= 1 || w.B - w.T <= 1) return "zero size";
      return null;
    }

    static void Decide(List<Area> areas, List<Win> wins, out IDictionary covered, out IDictionary by, List<object> why = null) {
      covered = Json.Obj();
      by = Json.Obj();
      foreach (Area a in areas) { covered[a.Key] = false; by[a.Key] = null; }
      int ownPid = Program.OwnPid, parentPid = Program.ParentPid;
      bool behind = false;
      foreach (Win w in wins) {
        if (w.Desktop) {
          behind = true;
          if (why != null) why.Add(Json.Obj("hwnd", w.Hwnd, "cls", w.Cls, "ignored", "the desktop"));
          continue;
        }
        string skip = behind ? "behind the desktop" : Ignored(w, ownPid, parentPid);
        var hits = new List<object>();
        if (skip == null) {
          foreach (Area a in areas) {
            int ow = Math.Min(w.R, a.R) - Math.Max(w.L, a.L), oh = Math.Min(w.B, a.B) - Math.Max(w.T, a.T);
            if (ow < MinOverlap || oh < MinOverlap) continue;
            hits.Add(a.Key);
            if (!(bool)covered[a.Key]) { covered[a.Key] = true; by[a.Key] = w.Title.Length > 0 ? w.Title : w.Cls; }
          }
        }
        if (why != null) why.Add(Json.Obj("hwnd", w.Hwnd, "cls", w.Cls, "title", w.Title, "rect", new List<object> { w.L, w.T, w.R, w.B }, "ignored", skip, "covers", hits));
      }
    }

    static string Sig(IDictionary covered) {
      var parts = new List<string>();
      foreach (DictionaryEntry kv in covered) parts.Add(kv.Key + "=" + ((bool)kv.Value ? "1" : "0"));
      parts.Sort(StringComparer.Ordinal);
      return string.Join(",", parts.ToArray());
    }

    // ------------------------------------------------------------------ reading

    /// The same list for UnderPaint.cs (the top bar's colour layer: which windows are under its row).
    public static List<Win> LiveList() { return Live(); }

    /// Every top-level window, top of the z-order first, up to and including the desktop.
    static List<Win> Live() {
      var list = new List<Win>();
      IntPtr progman = Win32.FindWindowW("Progman", null);
      bool done = false;
      Win32.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        if (done) return false;
        var w = new Win();
        w.Hwnd = hwnd.ToInt64().ToString(CultureInfo.InvariantCulture);
        w.Cls = Win32.GetClassName(hwnd) ?? "";
        if (hwnd == progman) { w.Desktop = true; list.Add(w); done = true; return false; }
        w.Visible = Win32.IsWindowVisible(hwnd);
        if (!w.Visible) return true;   // the bulk of EnumWindows: not worth reading further
        w.Title = Win32.GetWindowText(hwnd) ?? "";
        w.Iconic = Win32.IsIconic(hwnd);
        w.Cloaked = Win32.IsCloaked(hwnd);
        w.ExStyle = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();
        int pid;
        Win32.GetWindowThreadProcessId(hwnd, out pid);
        w.Pid = pid;
        if ((w.ExStyle & WS_EX_LAYERED) != 0) {
          uint key, flags; byte alpha;
          if (N.GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags) && (flags & LWA_ALPHA) != 0) w.Alpha = alpha;
        }
        Win32.RECT r;
        if (N.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(Win32.RECT))) != 0)
          Win32.GetWindowRect(hwnd, out r);
        w.L = r.left; w.T = r.top; w.R = r.right; w.B = r.bottom;
        list.Add(w);
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return list;
    }

    static string ReadAreas(Dictionary<string, object> req, out List<Area> areas) {
      areas = new List<Area>();
      object raw;
      if (!Json.TryGet(req, "areas", out raw)) return null;   // none: nothing to watch
      var arr = raw as IList;
      if (arr == null) return "widgethide: areas must be a list of {key, l, t, r, b} in physical screen pixels";
      if (arr.Count > 16) return "widgethide: at most 16 areas, got " + arr.Count;
      foreach (object o in arr) {
        var d = o as Dictionary<string, object>;
        if (d == null) return "widgethide: every area must be an object {key, l, t, r, b}";
        string key = Json.GetString(d, "key");
        if (string.IsNullOrEmpty(key) || key.Length > 40) return "widgethide: every area needs a short key";
        var a = new Area { Key = key, L = Json.GetInt(d, "l", 0), T = Json.GetInt(d, "t", 0), R = Json.GetInt(d, "r", 0), B = Json.GetInt(d, "b", 0) };
        if (a.R <= a.L || a.B <= a.T) return "widgethide: area \"" + key + "\" has no size";
        areas.Add(a);
      }
      return null;
    }

    static string ReadFake(object raw, out List<Win> wins) {
      wins = new List<Win>();
      var arr = raw as IList;
      if (arr == null) return "widgethide.check: fake must be a list of windows";
      foreach (object o in arr) {
        var d = o as Dictionary<string, object>;
        if (d == null) return "widgethide.check: every fake window must be an object";
        var w = new Win {
          Hwnd = Json.GetString(d, "hwnd") ?? "0", Cls = Json.GetString(d, "cls") ?? "", Title = Json.GetString(d, "title") ?? "",
          Visible = Json.GetBool(d, "visible", true), Iconic = Json.GetBool(d, "minimized", false), Cloaked = Json.GetBool(d, "cloaked", false),
          ExStyle = Json.GetInt(d, "exStyle", 0), Pid = Json.GetInt(d, "pid", 0), Alpha = Json.GetInt(d, "alpha", -1),
          L = Json.GetInt(d, "l", 0), T = Json.GetInt(d, "t", 0), R = Json.GetInt(d, "r", 0), B = Json.GetInt(d, "b", 0),
          Desktop = Json.GetBool(d, "desktop", false),
        };
        // "parent" / "own" stand in for Mantle's and the helper's pid, which a test cannot know
        string who = Json.GetString(d, "who");
        if (who == "parent") w.Pid = Program.ParentPid;
        else if (who == "own") w.Pid = Program.OwnPid;
        wins.Add(w);
      }
      return null;
    }
  }
}
