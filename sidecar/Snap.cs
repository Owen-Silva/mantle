// Snap.cs - Mantle's own keyboard window snapping: Win+Left/Right/Up/Down and the Win+Z zones
// (wave 3, 2026-09-24).
//
// WHAT IT REPLACES. Windows' keyboard snap. While the `snap` feature is on and healthy, the hook
// hands Win+arrows and Win+Z to lib/features/snap.js, which calls snap.move / snap.zone here.
// Windows' mouse drag-to-edge snapping is left alone (Owen's brief).
//
// TWO CLASSES, ON PURPOSE:
//   SnapGeom  pure geometry and the Win+arrow state machine. No Win32 call anywhere in it, so
//             `snap.plan` can run any case (three monitors, 125 % and 150 %, a top app bar, odd
//             widths) in sidecar/test-snap.js without a real window being touched.
//   Snap      the live side: find the window, check it can be moved, ask SnapGeom, move it
//             with ONE SetWindowPos (SWP_NOACTIVATE | SWP_NOZORDER), measure, remember.
//
// THE INVISIBLE BORDERS. GetWindowRect includes the resize borders Windows 10/11 draw as
// transparent (7 px at 100 %, 9 px at 125 % for a standard frame; 0 for most frameless apps). The
// edge a person sees is DWMWA_EXTENDED_FRAME_BOUNDS. Every zone here is a VISIBLE-frame rectangle,
// and the window rect sent to SetWindowPos is that plus the window's own margins, so two windows
// side by side meet at exactly one pixel line, like Windows' own snap.
//
// THE SPEED BUDGET. One SetWindowPos for a normal window. A maximized or minimized window goes
// through ONE SetWindowPlacement instead (restore + move in a single animation; a restore then a
// move would be the "visible double move" Owen does not want). A second, corrective SetWindowPos
// happens only when the measurement after the first disagrees with the target: a move onto a
// monitor with another DPI (the app rescales itself, WM_DPICHANGED) or a first move out of a
// maximized state (its restored borders were estimated). `moves` in every answer says how many.
//
// NEVER CHANGES THE FOREGROUND. The moves are SWP_NOACTIVATE. Only the three show commands that
// Windows itself uses for the ACTIVE window (maximize, minimize, restore) may activate, and only
// when the target already is the foreground window; any other window gets the non-activating
// variants, and "maximize a window that is not the active one" is refused, because Windows has no
// maximize that leaves the focus where it is. Main gives the focus to a chosen window itself.
//
// THE LANE. snap.move and snap.zone run on `qs`, not `ui`: SetWindowPos on another process's
// window is a cross-process SendMessage, and a hung app would otherwise freeze the thread that
// owns the keyboard hook. They also refuse a window that does not answer a WM_NULL within
// 250 ms. snap.info / snap.monitors / snap.plan never send a message, so they stay on ui.
//
// PASSIVE (a --test run). A move is allowed only on a window of the harness itself or of a
// process the harness started (the audio mixer's fence): never on Owen's windows.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {

  /// A rectangle in PHYSICAL screen pixels (the sidecar is per-monitor-DPI-aware v2, so
  /// GetWindowRect, DWM's frame bounds and the monitor rects all agree). Win32 RECT layout.
  [StructLayout(LayoutKind.Sequential)]
  public struct SnapRect {
    public int Left, Top, Right, Bottom;
    public SnapRect(int l, int t, int r, int b) { Left = l; Top = t; Right = r; Bottom = b; }
    public int Width { get { return Right - Left; } }
    public int Height { get { return Bottom - Top; } }
    public bool Empty { get { return Right <= Left || Bottom <= Top; } }
    public IDictionary ToJson() { return Json.Obj("x", Left, "y", Top, "w", Right - Left, "h", Bottom - Top); }
    public override string ToString() {
      return Left.ToString(CultureInfo.InvariantCulture) + "," + Top.ToString(CultureInfo.InvariantCulture) + " " +
             Width.ToString(CultureInfo.InvariantCulture) + "x" + Height.ToString(CultureInfo.InvariantCulture);
    }
  }

  /// Window rect minus visible frame: the invisible borders, each >= 0.
  public struct SnapMargins {
    public int L, T, R, B;
    public SnapMargins(int l, int t, int r, int b) { L = l; T = t; R = r; B = b; }
    public IDictionary ToJson() { return Json.Obj("l", L, "t", T, "r", R, "b", B); }
  }

  public sealed class SnapMonitor {
    public string Id;          // the HMONITOR as a decimal string (a test's own name in snap.plan)
    public SnapRect Bounds;
    public SnapRect Work;      // Bounds minus app bars (the taskbar, Mantle's top bar)
    public int Dpi = 96;       // 96 = 100 %
    public bool Primary;
    public IDictionary ToJson() {
      return Json.Obj("id", Id, "bounds", Bounds.ToJson(), "work", Work.ToJson(), "dpi", Dpi,
                      "scale", Math.Round(Dpi / 96.0, 3), "primary", Primary);
    }
  }

  /// A zone = a cell span of a grid over a monitor's work area. Integer grid units, never float
  /// fractions: 2/3 as a double would be computed twice for the two zones that share that edge.
  public sealed class SnapZone {
    public string Name;
    public int Cols, Rows, X, Y, W, H;
    public SnapZone(string name, int cols, int rows, int x, int y, int w, int h) {
      Name = name; Cols = cols; Rows = rows; X = x; Y = y; W = w; H = h;
    }
    public IDictionary ToJson() {
      return Json.Obj("name", Name, "grid", new List<object> { Cols, Rows }, "cell", new List<object> { X, Y, W, H });
    }
  }

  public sealed class SnapPlan {
    public string From, To;            // states: normal max min left right tl tr bl br grid:...
    public string Action;              // snap | unsnap | maximize | minimize | restore | none
    public SnapZone Zone;              // for snap
    public SnapMonitor Monitor;        // where the result lies
    public SnapRect Frame;             // the visible frame wanted (snap, unsnap)
    public bool HasFrame;
    public string RestoredFrom;        // unsnap: remembered | windows | centered
    public string Why;                 // none: why nothing happens
    public List<SnapZone> Assist = new List<SnapZone>();   // the space left empty, for Snap Assist
  }

  /// Pure geometry and the Win+arrow state machine. Nothing in here calls Windows.
  public static class SnapGeom {
    /// Two frames within this many px on every edge are "the same place": DWM's bounds round
    /// fractional DIP positions either way by a pixel on scaled displays.
    public const int Tolerance = 2;

    /// One rounding rule (half up, in exact integers) for every edge, so two zones that share an
    /// edge compute the same pixel and never overlap or leave a gap.
    public static int Edge(int origin, int size, int num, int den) {
      if (den <= 0) return origin;
      return origin + (int)((2L * size * num + den) / (2L * den));
    }

    public static SnapRect Cell(SnapRect work, SnapZone z) {
      return new SnapRect(Edge(work.Left, work.Width, z.X, z.Cols), Edge(work.Top, work.Height, z.Y, z.Rows),
                          Edge(work.Left, work.Width, z.X + z.W, z.Cols), Edge(work.Top, work.Height, z.Y + z.H, z.Rows));
    }

    public static readonly string[] Named = { "left", "right", "tl", "tr", "bl", "br" };

    public static SnapZone ByName(string name) {
      switch (name) {
        case "left":  return new SnapZone("left", 2, 1, 0, 0, 1, 1);
        case "right": return new SnapZone("right", 2, 1, 1, 0, 1, 1);
        case "tl":    return new SnapZone("tl", 2, 2, 0, 0, 1, 1);
        case "tr":    return new SnapZone("tr", 2, 2, 1, 0, 1, 1);
        case "bl":    return new SnapZone("bl", 2, 2, 0, 1, 1, 1);
        case "br":    return new SnapZone("br", 2, 2, 1, 1, 1, 1);
      }
      return null;
    }

    /// A grid zone; one that IS a half or a quarter gets that name, so Win+arrows carry on from
    /// a Win+Z pick exactly as from their own snap. Null + why for a bad spec.
    public static SnapZone Grid(int cols, int rows, int x, int y, int w, int h, out string why) {
      why = null;
      if (cols < 1 || rows < 1 || cols > 12 || rows > 12) { why = "a zone grid must be 1-12 columns by 1-12 rows"; return null; }
      if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > cols || y + h > rows) {
        why = "the zone's cells do not fit its " + cols + "x" + rows + " grid"; return null;
      }
      // normalise 4x2 [0,0,2,2] to 2x1 [0,0,1,1] etc., per axis
      int gx = Gcd(cols, Gcd(x, w)), gy = Gcd(rows, Gcd(y, h));
      int c = cols / gx, cx = x / gx, cw = w / gx, r = rows / gy, ry = y / gy, rh = h / gy;
      if (c == 1 && r == 1) return new SnapZone("full", 1, 1, 0, 0, 1, 1);
      foreach (string n in Named) {
        SnapZone k = ByName(n);
        if (k.Cols == c && k.Rows == r && k.X == cx && k.Y == ry && k.W == cw && k.H == rh) return k;
      }
      return new SnapZone("grid:" + c + "x" + r + ":" + cx + "," + ry + "," + cw + "," + rh, c, r, cx, ry, cw, rh);
    }

    static int Gcd(int a, int b) {
      a = Math.Abs(a); b = Math.Abs(b);
      while (b != 0) { int t = a % b; a = b; b = t; }
      return a == 0 ? 1 : a;
    }

    public static bool Near(SnapRect a, SnapRect b, int tol) {
      return Math.Abs(a.Left - b.Left) <= tol && Math.Abs(a.Top - b.Top) <= tol &&
             Math.Abs(a.Right - b.Right) <= tol && Math.Abs(a.Bottom - b.Bottom) <= tol;
    }

    /// The invisible borders from a measurement. A frame that is not inside the window rect, or
    /// borders thicker than any Windows frame (40 px at 100 %), mean DWM gave us nothing usable:
    /// zero margins then, and `ok` false so the caller can say so.
    public static SnapMargins MarginsOf(SnapRect window, SnapRect frame, int dpi, out bool ok) {
      int l = frame.Left - window.Left, t = frame.Top - window.Top;
      int r = window.Right - frame.Right, b = window.Bottom - frame.Bottom;
      int max = 40 * Math.Max(dpi, 96) / 96;
      ok = !frame.Empty && l >= 0 && t >= 0 && r >= 0 && b >= 0 && l <= max && t <= max && r <= max && b <= max;
      return ok ? new SnapMargins(l, t, r, b) : new SnapMargins(0, 0, 0, 0);
    }

    public static SnapRect WindowFor(SnapRect frame, SnapMargins m) {
      return new SnapRect(frame.Left - m.L, frame.Top - m.T, frame.Right + m.R, frame.Bottom + m.B);
    }

    /// Borders scale with the window's DPI: moving from a 100 % to a 150 % monitor makes a 7 px
    /// border 10-11 px. Estimated before the move; measured and corrected after it if wrong.
    public static SnapMargins Scale(SnapMargins m, int fromDpi, int toDpi) {
      if (fromDpi <= 0 || toDpi <= 0 || fromDpi == toDpi) return m;
      return new SnapMargins(Sc(m.L, fromDpi, toDpi), Sc(m.T, fromDpi, toDpi), Sc(m.R, fromDpi, toDpi), Sc(m.B, fromDpi, toDpi));
    }

    static int Sc(int v, int from, int to) { return (int)Math.Round((double)v * to / from, MidpointRounding.AwayFromZero); }

    /// Monitors left to right (then top to bottom): the order Win+Left / Win+Right walk.
    public static List<SnapMonitor> Ordered(List<SnapMonitor> mons) {
      var list = new List<SnapMonitor>(mons);
      list.Sort(delegate (SnapMonitor a, SnapMonitor b) {
        int c = a.Bounds.Left.CompareTo(b.Bounds.Left);
        return c != 0 ? c : a.Bounds.Top.CompareTo(b.Bounds.Top);
      });
      return list;
    }

    /// The next monitor left (step -1) or right (+1), wrapping round like Windows: from the
    /// leftmost, Win+Left goes on to the rightmost. One monitor wraps onto itself.
    public static SnapMonitor Neighbor(List<SnapMonitor> mons, SnapMonitor cur, int step) {
      List<SnapMonitor> o = Ordered(mons);
      int i = -1;
      for (int k = 0; k < o.Count; k++) if (o[k].Id == cur.Id) { i = k; break; }
      if (i < 0 || o.Count == 0) return cur;
      return o[((i + step) % o.Count + o.Count) % o.Count];
    }

    /// The monitor holding most of `r` (Windows' MONITOR_DEFAULTTONEAREST, by area, then distance).
    public static SnapMonitor MonitorFor(SnapRect r, List<SnapMonitor> mons) {
      SnapMonitor best = null;
      long bestArea = -1;
      foreach (SnapMonitor m in mons) {
        long w = Math.Min(r.Right, m.Bounds.Right) - Math.Max(r.Left, m.Bounds.Left);
        long h = Math.Min(r.Bottom, m.Bounds.Bottom) - Math.Max(r.Top, m.Bounds.Top);
        long a = w > 0 && h > 0 ? w * h : 0;
        if (a > bestArea) { bestArea = a; best = m; }
      }
      if (bestArea > 0) return best;
      long bestD = long.MaxValue;
      int cx = (r.Left + r.Right) / 2, cy = (r.Top + r.Bottom) / 2;
      foreach (SnapMonitor m in mons) {
        long dx = Math.Max(0, Math.Max(m.Bounds.Left - cx, cx - m.Bounds.Right));
        long dy = Math.Max(0, Math.Max(m.Bounds.Top - cy, cy - m.Bounds.Bottom));
        long d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = m; }
      }
      return best;
    }

    /// Where the window is now, in the state machine's words. A window Windows snapped itself
    /// (dragged to an edge), or that Mantle snapped before a restart, is recognised by its frame.
    public static string Detect(bool minimized, bool maximized, SnapRect frame, SnapMonitor mon,
                                bool hasMemory, string memZone, SnapRect memFrame) {
      if (minimized) return "min";
      if (maximized) return "max";
      if (hasMemory && Near(frame, memFrame, Tolerance)) return memZone;
      if (mon != null) {
        foreach (string n in Named)
          if (Near(frame, Cell(mon.Work, ByName(n)), Tolerance)) return n;
      }
      return "normal";
    }

    /// The pre-snap frame put back on `to`: exactly where it was on its own monitor; on another
    /// monitor, the same offset into the work area and the same size (scaled for DPI), kept on it.
    public static SnapRect Translate(SnapRect f, SnapMonitor from, SnapMonitor to) {
      if (from == null || to == null || from.Id == to.Id) return f;
      int w = Sc(f.Width, from.Dpi, to.Dpi), h = Sc(f.Height, from.Dpi, to.Dpi);
      int dx = Sc(f.Left - from.Work.Left, from.Dpi, to.Dpi), dy = Sc(f.Top - from.Work.Top, from.Dpi, to.Dpi);
      return Fit(new SnapRect(to.Work.Left + dx, to.Work.Top + dy, to.Work.Left + dx + w, to.Work.Top + dy + h), to.Work);
    }

    /// Shrinks `f` to at most the work area and slides it fully onto it.
    public static SnapRect Fit(SnapRect f, SnapRect work) {
      int w = Math.Min(f.Width, work.Width), h = Math.Min(f.Height, work.Height);
      int l = Math.Max(work.Left, Math.Min(f.Left, work.Right - w));
      int t = Math.Max(work.Top, Math.Min(f.Top, work.Bottom - h));
      return new SnapRect(l, t, l + w, t + h);
    }

    /// The zones Snap Assist offers to fill after a snap into `zone`.
    public static List<SnapZone> Complement(string zone) {
      var z = new List<SnapZone>();
      switch (zone) {
        case "left": z.Add(ByName("right")); break;
        case "right": z.Add(ByName("left")); break;
        case "tl": z.Add(ByName("bl")); break;
        case "bl": z.Add(ByName("tl")); break;
        case "tr": z.Add(ByName("br")); break;
        case "br": z.Add(ByName("tr")); break;
      }
      return z;
    }

    /// THE WIN+ARROW STATE MACHINE (Windows 10/11's keyboard snap, as a table):
    ///   normal  Left/Right -> that half   Up -> maximize        Down -> minimize
    ///   max     Left/Right -> that half   Up -> nothing         Down -> restore
    ///   left    Left -> right half of the monitor to the left (wrapping)   Right -> back to the
    ///           pre-snap rect   Up -> top-left quarter   Down -> bottom-left quarter
    ///   right   the mirror image
    ///   tl      Up -> maximize  Down -> left half   Right -> tr   Left -> tr of the monitor to the left
    ///   bl      Up -> left half Down -> minimize    Right -> br   Left -> br of the monitor to the left
    ///   tr, br  the mirror images
    ///   a Win+Z zone (thirds, columns...)  Left/Right -> that half  Up -> maximize  Down -> pre-snap rect
    /// `placement` is Windows' own restore rect (as a frame), used for "back to the pre-snap rect"
    /// when Mantle did not snap the window itself.
    public static SnapPlan Next(string state, string dir, List<SnapMonitor> mons, SnapMonitor cur, SnapRect curFrame,
                                bool hasPre, SnapRect preFrame, SnapMonitor preMon,
                                bool hasPlacement, SnapRect placement) {
      var p = new SnapPlan();
      p.From = state;
      p.Monitor = cur;
      if (dir != "left" && dir != "right" && dir != "up" && dir != "down") {
        p.Action = "none"; p.To = state; p.Why = "the direction must be left, right, up or down"; return p;
      }
      switch (state) {
        case "min":
          return None(p, "it is minimized");
        case "normal":
          if (dir == "left" || dir == "right") return SnapTo(p, dir, cur);
          if (dir == "up") return Act(p, "maximize", "max");
          return Act(p, "minimize", "min");
        case "max":
          if (dir == "left" || dir == "right") return SnapTo(p, dir, cur);
          if (dir == "up") return None(p, "it is already maximized");
          return Act(p, "restore", "normal");
        case "left":
          if (dir == "left") return SnapTo(p, "right", Neighbor(mons, cur, -1));
          if (dir == "right") return Unsnap(p, cur, curFrame, hasPre, preFrame, preMon, hasPlacement, placement, mons);
          return SnapTo(p, dir == "up" ? "tl" : "bl", cur);
        case "right":
          if (dir == "right") return SnapTo(p, "left", Neighbor(mons, cur, +1));
          if (dir == "left") return Unsnap(p, cur, curFrame, hasPre, preFrame, preMon, hasPlacement, placement, mons);
          return SnapTo(p, dir == "up" ? "tr" : "br", cur);
        case "tl":
          if (dir == "up") return Act(p, "maximize", "max");
          if (dir == "down") return SnapTo(p, "left", cur);
          return dir == "right" ? SnapTo(p, "tr", cur) : SnapTo(p, "tr", Neighbor(mons, cur, -1));
        case "tr":
          if (dir == "up") return Act(p, "maximize", "max");
          if (dir == "down") return SnapTo(p, "right", cur);
          return dir == "left" ? SnapTo(p, "tl", cur) : SnapTo(p, "tl", Neighbor(mons, cur, +1));
        case "bl":
          if (dir == "up") return SnapTo(p, "left", cur);
          if (dir == "down") return Act(p, "minimize", "min");
          return dir == "right" ? SnapTo(p, "br", cur) : SnapTo(p, "br", Neighbor(mons, cur, -1));
        case "br":
          if (dir == "up") return SnapTo(p, "right", cur);
          if (dir == "down") return Act(p, "minimize", "min");
          return dir == "left" ? SnapTo(p, "bl", cur) : SnapTo(p, "bl", Neighbor(mons, cur, +1));
        default:
          if (dir == "left" || dir == "right") return SnapTo(p, dir, cur);
          if (dir == "up") return Act(p, "maximize", "max");
          return Unsnap(p, cur, curFrame, hasPre, preFrame, preMon, hasPlacement, placement, mons);
      }
    }

    static SnapPlan None(SnapPlan p, string why) { p.Action = "none"; p.To = p.From; p.Why = why; return p; }
    static SnapPlan Act(SnapPlan p, string action, string to) { p.Action = action; p.To = to; return p; }

    public static SnapPlan SnapTo(SnapPlan p, string zoneName, SnapMonitor mon) {
      return SnapToZone(p, ByName(zoneName), mon);
    }

    public static SnapPlan SnapToZone(SnapPlan p, SnapZone z, SnapMonitor mon) {
      p.Action = "snap";
      p.Zone = z;
      p.To = z.Name;
      p.Monitor = mon;
      p.Frame = Cell(mon.Work, z);
      p.HasFrame = true;
      p.Assist = Complement(z.Name);
      return p;
    }

    static SnapPlan Unsnap(SnapPlan p, SnapMonitor cur, SnapRect curFrame, bool hasPre, SnapRect preFrame, SnapMonitor preMon,
                           bool hasPlacement, SnapRect placement, List<SnapMonitor> mons) {
      p.Action = "unsnap";
      p.To = "normal";
      p.Monitor = cur;
      p.HasFrame = true;
      if (hasPre && !preFrame.Empty) {
        p.Frame = Translate(preFrame, preMon, cur);
        p.RestoredFrom = "remembered";
      } else if (hasPlacement && !placement.Empty && !Near(placement, curFrame, Tolerance) &&
                 placement.Width < cur.Work.Width && placement.Height <= cur.Work.Height) {
        p.Frame = Translate(placement, MonitorFor(placement, mons), cur);
        p.RestoredFrom = "windows";
      } else {
        // Nothing to go back to (snapped before Mantle saw it, and Windows' restore rect IS the
        // half): two thirds of the work area, centred - an obviously "floating" window.
        int w = cur.Work.Width * 2 / 3, h = cur.Work.Height * 2 / 3;
        int l = cur.Work.Left + (cur.Work.Width - w) / 2, t = cur.Work.Top + (cur.Work.Height - h) / 2;
        p.Frame = new SnapRect(l, t, l + w, t + h);
        p.RestoredFrom = "centered";
      }
      return p;
    }
  }

  [MantleFeature]
  static class Snap {
    public static void Register(FeatureTable t) {
      t.Add("snap.move", Lanes.Qs, Move);        // Win+arrow on a window (the foreground one by default)
      t.Add("snap.zone", Lanes.Qs, ZoneCmd);     // put a window in a grid zone (Win+Z, Snap Assist)
      t.Add("snap.info", Lanes.Ui, Info);        // read-only: where a window is and whether it can move
      t.Add("snap.monitors", Lanes.Ui, MonitorsCmd);
      t.Add("snap.plan", Lanes.Ui, PlanCmd);     // pure: the state machine on made-up monitors (tests)
    }

    // ---------------------------------------------------------------- memory
    // Per window: the zone Mantle put it in, the frame it MEASURED there afterwards (an app with a
    // minimum size may not fill the zone exactly), and the frame it had before its first snap.
    sealed class Rec {
      public string Zone;
      public SnapRect Frame;
      public bool HasPre;
      public SnapRect PreFrame;
      public string PreMon;
      public bool HasNormalMargins;
      public SnapMargins NormalMargins;
      public int NormalDpi;
    }

    static readonly object _gate = new object();
    static readonly Dictionary<long, Rec> _mem = new Dictionary<long, Rec>();

    static Rec Mem(IntPtr hwnd, bool create) {
      lock (_gate) {
        Rec r;
        if (_mem.TryGetValue(hwnd.ToInt64(), out r)) return r;
        if (!create) return null;
        if (_mem.Count > 256) Prune();
        r = new Rec();
        _mem[hwnd.ToInt64()] = r;
        return r;
      }
    }

    static void Prune() {
      var dead = new List<long>();
      foreach (long k in _mem.Keys) if (!N.IsWindow(new IntPtr(k))) dead.Add(k);
      foreach (long k in dead) _mem.Remove(k);
    }

    // ---------------------------------------------------------------- monitors
    static List<SnapMonitor> ReadMonitors() {
      var list = new List<SnapMonitor>();
      N.MonitorEnumProc cb = delegate (IntPtr hMon, IntPtr hdc, ref SnapRect rc, IntPtr data) {
        SnapMonitor m = ReadMonitor(hMon);
        if (m != null) list.Add(m);
        return true;
      };
      N.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return list;
    }

    static SnapMonitor ReadMonitor(IntPtr hMon) {
      var mi = new N.MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(N.MONITORINFO));
      if (hMon == IntPtr.Zero || !N.GetMonitorInfoW(hMon, ref mi)) return null;
      var m = new SnapMonitor();
      m.Id = hMon.ToInt64().ToString(CultureInfo.InvariantCulture);
      m.Bounds = mi.rcMonitor;
      m.Work = mi.rcWork;
      m.Primary = (mi.dwFlags & 1) != 0;
      uint dx, dy;
      try { if (N.GetDpiForMonitor(hMon, 0, out dx, out dy) == 0 && dx > 0) m.Dpi = (int)dx; } catch (Exception) { }
      return m;
    }

    // ---------------------------------------------------------------- a window, measured
    sealed class Win {
      public IntPtr Hwnd;
      public int Pid;
      public string Exe = "", Title = "", Class = "";
      public SnapRect Rect, Frame;
      public SnapMargins Margins;
      public bool MarginsOk;
      public int Dpi;
      public uint Style, ExStyle;
      public bool Minimized, Maximized, Foreground, Visible, Arranged;
      public SnapMonitor Monitor;
      public bool HasPlacement;
      public SnapRect PlacementFrame;     // Windows' restore rect, as a visible frame on screen
      public N.WINDOWPLACEMENT Placement;
    }

    static SnapRect FrameOf(IntPtr hwnd, SnapRect fallback) {
      SnapRect f;
      if (N.DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out f, Marshal.SizeOf(typeof(SnapRect))) == 0 && !f.Empty)
        return f;
      return fallback;
    }

    static Win Measure(IntPtr hwnd, List<SnapMonitor> mons) {
      var w = new Win();
      w.Hwnd = hwnd;
      N.GetWindowThreadProcessId(hwnd, out w.Pid);
      w.Title = TitleOf(hwnd);
      w.Class = ClassOf(hwnd);
      w.Exe = ExeOf(w.Pid);
      N.GetWindowRect(hwnd, out w.Rect);
      w.Frame = FrameOf(hwnd, w.Rect);
      w.Style = (uint)N.GetWindowLongW(hwnd, -16);
      w.ExStyle = (uint)N.GetWindowLongW(hwnd, -20);
      w.Minimized = N.IsIconic(hwnd);
      w.Maximized = N.IsZoomed(hwnd);
      w.Visible = N.IsWindowVisible(hwnd);
      w.Foreground = N.GetForegroundWindow() == hwnd;
      try { w.Dpi = (int)N.GetDpiForWindow(hwnd); } catch (Exception) { w.Dpi = 0; }
      w.Monitor = ReadMonitor(N.MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */));
      if (w.Monitor == null && mons.Count > 0) w.Monitor = SnapGeom.MonitorFor(w.Frame, mons);
      if (w.Dpi <= 0) w.Dpi = w.Monitor != null ? w.Monitor.Dpi : 96;
      w.Margins = SnapGeom.MarginsOf(w.Rect, w.Frame, w.Dpi, out w.MarginsOk);
      try { w.Arranged = N.IsWindowArranged(hwnd); } catch (Exception) { w.Arranged = false; }
      var pl = new N.WINDOWPLACEMENT();
      pl.length = Marshal.SizeOf(typeof(N.WINDOWPLACEMENT));
      if (N.GetWindowPlacement(hwnd, ref pl)) {
        w.Placement = pl;
        SnapRect normal = WorkspaceToScreen(pl.rcNormalPosition, w.ExStyle, mons);
        SnapMargins nm = NormalMargins(w);
        w.PlacementFrame = new SnapRect(normal.Left + nm.L, normal.Top + nm.T, normal.Right - nm.R, normal.Bottom - nm.B);
        w.HasPlacement = !w.PlacementFrame.Empty;
      }
      return w;
    }

    /// WINDOWPLACEMENT's rects are WORKSPACE coordinates for a window without WS_EX_TOOLWINDOW:
    /// relative to the work area, so an app bar at the top or left shifts them. The offset is the
    /// work area's inset on the monitor holding the rect (checked against a normal window's own
    /// GetWindowRect in sidecar/test-snap.js).
    static SnapRect WorkspaceToScreen(SnapRect r, uint exStyle, List<SnapMonitor> mons) {
      if ((exStyle & 0x80 /* WS_EX_TOOLWINDOW */) != 0 || mons.Count == 0) return r;
      int dx = 0, dy = 0;
      SnapMonitor m = SnapGeom.MonitorFor(r, mons);
      if (m != null) { dx = m.Work.Left - m.Bounds.Left; dy = m.Work.Top - m.Bounds.Top; }
      return new SnapRect(r.Left + dx, r.Top + dy, r.Right + dx, r.Bottom + dy);
    }

    static SnapRect ScreenToWorkspace(SnapRect r, uint exStyle, SnapMonitor m) {
      if ((exStyle & 0x80) != 0 || m == null) return r;
      int dx = m.Work.Left - m.Bounds.Left, dy = m.Work.Top - m.Bounds.Top;
      return new SnapRect(r.Left - dx, r.Top - dy, r.Right - dx, r.Bottom - dy);
    }

    /// The borders the window has when it is NOT maximized: measured if we have seen it normal at
    /// this DPI, else Windows' standard frame (SM_CXSIZEFRAME + SM_CXPADDEDBORDER at the window's
    /// DPI, minus the 1 px border DWM draws; 0 at the top), which is what a default-frame window has.
    static SnapMargins NormalMargins(Win w) {
      if (!w.Maximized && !w.Minimized && w.MarginsOk) return w.Margins;
      Rec r = Mem(w.Hwnd, false);
      if (r != null && r.HasNormalMargins) return SnapGeom.Scale(r.NormalMargins, r.NormalDpi, w.Dpi);
      int b = 7 * w.Dpi / 96;
      try {
        int f = N.GetSystemMetricsForDpi(32 /* SM_CXSIZEFRAME */, (uint)w.Dpi) + N.GetSystemMetricsForDpi(92 /* SM_CXPADDEDBORDER */, (uint)w.Dpi);
        if (f > 1 && f < 40) b = f - 1;
      } catch (Exception) { }
      if ((w.Style & 0x00040000) == 0) b = 0;   // no WS_THICKFRAME, no resize border
      return new SnapMargins(b, 0, b, b);
    }

    static string TitleOf(IntPtr hwnd) {
      var sb = new StringBuilder(256);
      // InternalGetWindowText never sends WM_GETTEXT, so a hung app cannot block us here.
      N.InternalGetWindowText(hwnd, sb, sb.Capacity);
      return sb.ToString();
    }

    static string ClassOf(IntPtr hwnd) {
      var sb = new StringBuilder(128);
      N.GetClassNameW(hwnd, sb, sb.Capacity);
      return sb.ToString();
    }

    static string ExeOf(int pid) {
      IntPtr h = N.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
      if (h == IntPtr.Zero) return "";
      try {
        var sb = new StringBuilder(520);
        int len = sb.Capacity;
        if (!N.QueryFullProcessImageNameW(h, 0, sb, ref len)) return "";
        string p = sb.ToString();
        int i = p.LastIndexOfAny(new char[] { '\\', '/' });
        return i >= 0 ? p.Substring(i + 1) : p;
      } finally { N.CloseHandle(h); }
    }

    // ---------------------------------------------------------------- can it move?
    static readonly HashSet<string> ShellClasses = new HashSet<string>(StringComparer.Ordinal) {
      "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
      "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland",
    };

    static int _ownIl = -1;

    /// The integrity level RID of a process (0x2000 medium, 0x3000 high = "as administrator",
    /// 0x4000 system), or -1 with the reason when its token cannot be read.
    static int IntegrityOf(int pid, out string why) {
      why = null;
      IntPtr proc = pid == 0 ? N.GetCurrentProcess() : N.OpenProcess(0x1000, false, pid);
      if (proc == IntPtr.Zero) { why = "its process could not be opened (Win32 error " + Marshal.GetLastWin32Error() + ")"; return -1; }
      IntPtr tok = IntPtr.Zero, buf = IntPtr.Zero;
      try {
        if (!N.OpenProcessToken(proc, 0x0008 /* TOKEN_QUERY */, out tok)) {
          why = "its token could not be read (Win32 error " + Marshal.GetLastWin32Error() + ")"; return -1;
        }
        int len;
        N.GetTokenInformation(tok, 25 /* TokenIntegrityLevel */, IntPtr.Zero, 0, out len);
        if (len <= 0) { why = "its integrity level could not be read"; return -1; }
        buf = Marshal.AllocHGlobal(len);
        if (!N.GetTokenInformation(tok, 25, buf, len, out len)) { why = "its integrity level could not be read"; return -1; }
        IntPtr sid = Marshal.ReadIntPtr(buf);
        int count = Marshal.ReadByte(N.GetSidSubAuthorityCount(sid));
        if (count < 1) { why = "its integrity label is empty"; return -1; }
        return Marshal.ReadInt32(N.GetSidSubAuthority(sid, (uint)(count - 1)));
      } finally {
        if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        if (tok != IntPtr.Zero) N.CloseHandle(tok);
        if (pid != 0) N.CloseHandle(proc);
      }
    }

    static int OwnIntegrity() {
      if (_ownIl < 0) { string why; _ownIl = IntegrityOf(0, out why); if (_ownIl < 0) _ownIl = 0x2000; }
      return _ownIl;
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

    /// The passive fence: a test may move only a window of its own harness (Program.ParentPid),
    /// of a process the harness started, or of the sidecar itself.
    static bool OursToMove(int pid) {
      if (pid == Program.OwnPid) return true;
      if (Program.ParentPid <= 0) return false;
      if (pid == Program.ParentPid) return true;
      return ParentOf(pid) == (uint)Program.ParentPid;
    }

    /// Null when the window may be moved; otherwise the plain-words reason. `sizing` = the action
    /// resizes it (a snap), which a fixed-size window cannot take.
    static string CheckMovable(IntPtr hwnd, bool sizing, out Win w, List<SnapMonitor> mons) {
      w = null;
      if (hwnd == IntPtr.Zero) return "there is no active window to snap";
      if (!N.IsWindow(hwnd)) return "that window has closed";
      int pid;
      N.GetWindowThreadProcessId(hwnd, out pid);
      var fw = Stopwatch.StartNew();
      bool ours = !Program.Passive || OursToMove(pid);
      _msFence = fw.Elapsed.TotalMilliseconds;
      if (!ours)
        return FeatureTable.PassiveRefusal + ": snap would move a window on the live desktop " +
               "(a test may only move a window its own harness made)";
      w = Measure(hwnd, mons);
      string name = w.Exe.Length > 0 ? w.Exe : "this window";
      if (!Program.Passive && Program.ParentPid > 0 && pid == Program.ParentPid) return "that is one of Mantle's own windows";
      if (pid == Program.OwnPid && !Program.Passive) return "that is one of Mantle's own windows";
      if (ShellClasses.Contains(w.Class)) return "the desktop and the taskbar are not windows that snap";
      if (!w.Visible) return name + " is not visible";
      if ((w.Style & 0x40000000) != 0 /* WS_CHILD */) return "that is part of another window, not a window of its own";
      if (w.Monitor == null) return "Windows reports no monitor for " + name;
      if (sizing && (w.Style & 0x00040000) == 0 /* WS_THICKFRAME */)
        return name + " has a fixed size (it has no resize border), so it cannot be snapped to fill a zone";
      if (sizing && (w.Style & 0x00C00000) != 0x00C00000 /* no WS_CAPTION */ && SnapGeom.Near(w.Frame, w.Monitor.Bounds, 0))
        return name + " is full screen";
      string ilWhy;
      int il = IntegrityOf(pid, out ilWhy);
      if (il > OwnIntegrity())
        return name + " is running as administrator and Mantle is not, so Windows will not let Mantle move it " +
               "(User Interface Privilege Isolation). Run Mantle as administrator to snap it.";
      if (N.IsHungAppWindow(hwnd)) return name + " is not responding, so it cannot be moved";
      UIntPtr res;
      if (N.SendMessageTimeoutW(hwnd, 0 /* WM_NULL */, UIntPtr.Zero, IntPtr.Zero, 0x0002 /* SMTO_ABORTIFHUNG */, 250, out res) == IntPtr.Zero)
        return name + " did not answer within 250 ms (busy or hung), so it was left where it is";
      return null;
    }

    // ---------------------------------------------------------------- moving
    sealed class Moved {
      public int Moves;
      public bool Corrected, Fit = true;
      public string FitWhy, Error;
      public SnapRect Frame, Rect;
      public SnapRect First;          // the frame after the FIRST move, when a second one was needed
      public double Ms;               // the move(s) and their measurements
    }

    /// Where one command's time went (the Qs lane runs one command at a time on one thread).
    [ThreadStatic] static double _msCheck, _msAssist, _msFence;

    const uint SWP_MOVE = 0x0004 /* NOZORDER */ | 0x0010 /* NOACTIVATE */ | 0x0200 /* NOOWNERZORDER */;

    /// Put the window's VISIBLE frame at `target`. One SetWindowPos (or one SetWindowPlacement
    /// out of maximized/minimized), then measure; one corrective SetWindowPos if it is off.
    static Moved PlaceFrame(Win w, SnapRect target, SnapMonitor mon, List<SnapMonitor> mons) {
      var mv = new Moved();
      SnapMargins m = NormalMargins(w);
      if (w.Monitor != null && mon != null && w.Monitor.Id != mon.Id) m = SnapGeom.Scale(m, w.Dpi, mon.Dpi);
      SnapRect want = SnapGeom.WindowFor(target, m);
      var sw = Stopwatch.StartNew();
      try { return PlaceFrameTimed(w, target, want, mons, mv); } finally { mv.Ms = Math.Round(sw.Elapsed.TotalMilliseconds, 2); }
    }

    static Moved PlaceFrameTimed(Win w, SnapRect target, SnapRect want, List<SnapMonitor> mons, Moved mv) {
      if (w.Maximized || w.Minimized) {
        var pl = w.Placement;
        pl.length = Marshal.SizeOf(typeof(N.WINDOWPLACEMENT));
        pl.flags = 0;
        // SW_SHOWNORMAL for the active window (Windows' own restore); SW_SHOWNOACTIVATE otherwise.
        pl.showCmd = w.Foreground ? 1 : 4;
        pl.rcNormalPosition = ScreenToWorkspace(want, w.ExStyle, SnapGeom.MonitorFor(want, mons));
        if (!N.SetWindowPlacement(w.Hwnd, ref pl)) {
          mv.Error = MoveError("SetWindowPlacement", Marshal.GetLastWin32Error(), w);
          return mv;
        }
      } else if (!N.SetWindowPos(w.Hwnd, IntPtr.Zero, want.Left, want.Top, want.Width, want.Height, SWP_MOVE)) {
        mv.Error = MoveError("SetWindowPos", Marshal.GetLastWin32Error(), w);
        return mv;
      }
      mv.Moves = 1;
      N.GetWindowRect(w.Hwnd, out mv.Rect);
      mv.Frame = FrameOf(w.Hwnd, mv.Rect);
      mv.First = mv.Frame;

      if (!SnapGeom.Near(mv.Frame, target, 1)) {
        // Measure the borders the window has NOW (its DPI may have changed with the monitor, or
        // they were estimated out of a maximized state) and correct once.
        int dpi = 0;
        try { dpi = (int)N.GetDpiForWindow(w.Hwnd); } catch (Exception) { }
        bool ok;
        SnapMargins now = SnapGeom.MarginsOf(mv.Rect, mv.Frame, dpi > 0 ? dpi : 96, out ok);
        if (ok) {
          SnapRect again = SnapGeom.WindowFor(target, now);
          if (N.SetWindowPos(w.Hwnd, IntPtr.Zero, again.Left, again.Top, again.Width, again.Height, SWP_MOVE)) {
            mv.Moves = 2;
            mv.Corrected = true;
            N.GetWindowRect(w.Hwnd, out mv.Rect);
            mv.Frame = FrameOf(w.Hwnd, mv.Rect);
          }
        }
        if (!SnapGeom.Near(mv.Frame, target, 1)) {
          mv.Fit = false;
          if (mv.Frame.Width > target.Width + 1 || mv.Frame.Height > target.Height + 1)
            mv.FitWhy = (w.Exe.Length > 0 ? w.Exe : "the app") + " will not go smaller than " + mv.Frame.Width + " x " +
                        mv.Frame.Height + " px, so it overlaps the zone (" + target.Width + " x " + target.Height + ")";
          else
            mv.FitWhy = (w.Exe.Length > 0 ? w.Exe : "the app") + " sized itself to " + mv.Frame.Width + " x " + mv.Frame.Height +
                        " px instead of " + target.Width + " x " + target.Height;
        }
      }
      return mv;
    }

    static string MoveError(string api, int err, Win w) {
      string name = w.Exe.Length > 0 ? w.Exe : "this window";
      if (err == 5)
        return name + " refused to be moved (access denied): it runs at a higher privilege than Mantle, so Windows " +
               "blocks it (User Interface Privilege Isolation)";
      return api + " failed on " + name + " (Win32 error " + err + ")";
    }

    /// Is some other window already filling `frame`? Then Snap Assist has nothing to fill there.
    static bool Occupied(SnapRect frame, IntPtr except) {
      bool hit = false;
      N.EnumWindowsProc cb = delegate (IntPtr h, IntPtr lp) {
        if (h == except || !N.IsWindowVisible(h) || N.IsIconic(h)) return true;
        if (N.GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
        if ((N.GetWindowLongW(h, -20) & 0x80) != 0) return true;
        int cloaked;
        if (N.DwmGetWindowAttributeInt(h, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) return true;
        SnapRect r;
        N.GetWindowRect(h, out r);
        if (SnapGeom.Near(FrameOf(h, r), frame, SnapGeom.Tolerance)) { hit = true; return false; }
        return true;
      };
      N.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return hit;
    }

    // ---------------------------------------------------------------- commands
    static IntPtr Target(Dictionary<string, object> req) {
      IntPtr h = Json.GetHwnd(req, "hwnd");
      return h != IntPtr.Zero ? h : N.GetForegroundWindow();
    }

    static IDictionary Refusal(IntPtr hwnd, Win w, string why, string action, Stopwatch sw) {
      return Json.Obj("ok", false, "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
                      "exe", w != null ? w.Exe : "", "title", w != null ? w.Title : "",
                      "action", action, "reason", why, "ms", Math.Round(sw.Elapsed.TotalMilliseconds, 2));
    }

    static string Move(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      string dir = (Json.GetString(req, "dir") ?? "").ToLowerInvariant();
      if (dir != "left" && dir != "right" && dir != "up" && dir != "down")
        return "snap.move needs dir: left, right, up or down";
      IntPtr hwnd = Target(req);
      List<SnapMonitor> mons = ReadMonitors();
      if (mons.Count == 0) return "Windows reports no monitors";
      Win w;
      // Up/Down on a normal window maximize/minimize (no resize border needed); a snap needs one.
      var cw = Stopwatch.StartNew();
      string refuse = CheckMovable(hwnd, false, out w, mons);
      _msCheck = cw.Elapsed.TotalMilliseconds;
      if (refuse != null && refuse.StartsWith(FeatureTable.PassiveRefusal, StringComparison.Ordinal)) return refuse;
      if (refuse != null) { result = Refusal(hwnd, w, refuse, "none", sw); return null; }

      Rec mem = Mem(hwnd, false);
      string state = SnapGeom.Detect(w.Minimized, w.Maximized, w.Frame, w.Monitor,
                                     mem != null && mem.Zone != null, mem != null ? mem.Zone : null,
                                     mem != null ? mem.Frame : new SnapRect());
      SnapMonitor preMon = null;
      if (mem != null && mem.HasPre) foreach (SnapMonitor m in mons) if (m.Id == mem.PreMon) preMon = m;
      bool hasPlacement = w.HasPlacement && (w.Arranged || w.Maximized);
      SnapPlan plan = SnapGeom.Next(state, dir, mons, w.Monitor, w.Frame,
                                    mem != null && mem.HasPre, mem != null ? mem.PreFrame : new SnapRect(), preMon,
                                    hasPlacement, w.PlacementFrame);
      result = Execute(w, plan, mons, mem, sw);
      return null;
    }

    static IDictionary Execute(Win w, SnapPlan plan, List<SnapMonitor> mons, Rec mem, Stopwatch sw) {
      string name = w.Exe.Length > 0 ? w.Exe : "this window";
      IntPtr hwnd = w.Hwnd;
      if (plan.Action == "none")
        return Answer(w, plan, true, null, null, sw, "nothing to do: " + name + " " + plan.Why);

      if (plan.Action == "maximize") {
        if ((w.Style & 0x00010000) == 0 /* WS_MAXIMIZEBOX */)
          return Answer(w, plan, false, null, null, sw, name + " cannot be maximized (it has no maximize button)");
        if (!w.Foreground)
          return Answer(w, plan, false, null, null, sw, "Mantle only maximizes the active window: Windows has no " +
                        "maximize that leaves the focus where it is, and " + name + " is not the active window");
        N.ShowWindow(hwnd, 3 /* SW_MAXIMIZE */);
        return Answer(w, plan, N.IsZoomed(hwnd), null, null, sw, N.IsZoomed(hwnd) ? null : name + " did not maximize");
      }
      if (plan.Action == "minimize") {
        if ((w.Style & 0x00020000) == 0 /* WS_MINIMIZEBOX */)
          return Answer(w, plan, false, null, null, sw, name + " cannot be minimized (it has no minimize button)");
        // SW_MINIMIZE hands the focus to the next window, as Windows' Win+Down does; a window that
        // is not the active one is minimized without touching the focus at all.
        N.ShowWindow(hwnd, w.Foreground ? 6 /* SW_MINIMIZE */ : 7 /* SW_SHOWMINNOACTIVE */);
        return Answer(w, plan, N.IsIconic(hwnd), null, null, sw, N.IsIconic(hwnd) ? null : name + " did not minimize");
      }
      if (plan.Action == "restore") {
        N.ShowWindow(hwnd, w.Foreground ? 9 /* SW_RESTORE */ : 4 /* SW_SHOWNOACTIVATE */);
        bool back = !N.IsZoomed(hwnd) && !N.IsIconic(hwnd);
        return Answer(w, plan, back, null, null, sw, back ? null : name + " did not restore");
      }

      // snap / unsnap: both resize.
      if ((w.Style & 0x00040000) == 0)
        return Answer(w, plan, false, null, null, sw, name + " has a fixed size (it has no resize border), so it cannot be snapped to fill a zone");
      if ((w.Style & 0x00C00000) != 0x00C00000 && SnapGeom.Near(w.Frame, w.Monitor.Bounds, 0))
        return Answer(w, plan, false, null, null, sw, name + " is full screen");

      // Remember where it was BEFORE its first snap, and its borders while it is still normal.
      Rec r = Mem(hwnd, true);
      if (!w.Maximized && !w.Minimized && w.MarginsOk) {
        r.HasNormalMargins = true; r.NormalMargins = w.Margins; r.NormalDpi = w.Dpi;
      }
      // From "normal" the window is floating NOW (even if Mantle snapped it once and the person has
      // since dragged it), so where it is now is what Win+opposite-arrow must put back. From a
      // maximize, an earlier pre-snap frame wins (left -> quarter -> maximize -> left keeps the first
      // one); failing that, Windows' own restore rect.
      if (plan.Action == "snap" && plan.From == "normal") {
        r.HasPre = true;
        r.PreFrame = w.Arranged && w.HasPlacement ? w.PlacementFrame : w.Frame;
        r.PreMon = (w.Arranged && w.HasPlacement ? SnapGeom.MonitorFor(w.PlacementFrame, mons) : w.Monitor).Id;
      } else if (plan.Action == "snap" && plan.From == "max" && !r.HasPre && w.HasPlacement) {
        r.HasPre = true;
        r.PreFrame = w.PlacementFrame;
        r.PreMon = SnapGeom.MonitorFor(w.PlacementFrame, mons).Id;
      }

      Moved mv = PlaceFrame(w, plan.Frame, plan.Monitor, mons);
      if (mv.Error != null) return Answer(w, plan, false, mv, null, sw, mv.Error);
      if (plan.Action == "unsnap") {
        lock (_gate) _mem.Remove(hwnd.ToInt64());
      } else {
        r.Zone = plan.To;
        r.Frame = mv.Frame;
      }
      List<object> assist = new List<object>();
      var aw = Stopwatch.StartNew();
      if (plan.Action == "snap") {
        foreach (SnapZone z in plan.Assist) {
          SnapRect f = SnapGeom.Cell(plan.Monitor.Work, z);
          if (Occupied(f, hwnd)) continue;
          assist.Add(Json.Obj("zone", z.ToJson(), "frame", f.ToJson()));
        }
        _msAssist = aw.Elapsed.TotalMilliseconds;
      }
      return Answer(w, plan, true, mv, assist, sw, null);
    }

    static IDictionary Answer(Win w, SnapPlan plan, bool ok, Moved mv, List<object> assist, Stopwatch sw, string reason) {
      var o = (IDictionary)Json.Obj(
        "ok", ok,
        "hwnd", w.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
        "exe", w.Exe, "title", w.Title, "pid", w.Pid,
        "from", plan.From, "to", ok ? plan.To : plan.From, "action", plan.Action,
        "monitor", plan.Monitor != null ? plan.Monitor.ToJson() : null,
        "target", plan.HasFrame ? plan.Frame.ToJson() : null,
        "frame", mv != null && mv.Moves > 0 ? mv.Frame.ToJson() : null,
        "rect", mv != null && mv.Moves > 0 ? mv.Rect.ToJson() : null,
        "moves", mv != null ? mv.Moves : 0,
        "corrected", mv != null && mv.Corrected,
        "fit", mv == null || mv.Fit,
        "fitReason", mv != null ? mv.FitWhy : null,
        "restoredFrom", plan.RestoredFrom,
        "foreground", w.Foreground,
        "firstFrame", mv != null && mv.Corrected ? mv.First.ToJson() : null,
        "assist", assist ?? new List<object>(),
        "reason", reason,
        "ms", Math.Round(sw.Elapsed.TotalMilliseconds, 2),
        // fence = the passive-only parent-process lookup (a Toolhelp snapshot); a live run skips it
        "timing", Json.Obj("check", Math.Round(_msCheck, 2), "fence", Math.Round(_msFence, 2),
                           "move", mv != null ? mv.Ms : 0, "assist", Math.Round(_msAssist, 2)));
      _msCheck = 0; _msAssist = 0; _msFence = 0;
      return o;
    }

    static string ZoneCmd(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      SnapZone z;
      string why = ParseZone(req, "grid", "cell", out z);
      if (why != null) return "snap.zone: " + why;
      IntPtr hwnd = Target(req);
      List<SnapMonitor> mons = ReadMonitors();
      if (mons.Count == 0) return "Windows reports no monitors";
      Win w;
      var cw = Stopwatch.StartNew();
      string refuse = CheckMovable(hwnd, true, out w, mons);
      _msCheck = cw.Elapsed.TotalMilliseconds;
      if (refuse != null && refuse.StartsWith(FeatureTable.PassiveRefusal, StringComparison.Ordinal)) return refuse;
      if (refuse != null) { result = Refusal(hwnd, w, refuse, "snap", sw); return null; }

      // The zone is on the monitor named, else the monitor of the window `of` (Snap Assist fills
      // the empty half of the FIRST window's monitor), else the window's own.
      SnapMonitor mon = w.Monitor;
      string monId = Json.GetString(req, "monitor");
      IntPtr of = Json.GetHwnd(req, "of");
      if (monId == null && of != IntPtr.Zero && N.IsWindow(of)) {
        SnapMonitor om = ReadMonitor(N.MonitorFromWindow(of, 2));
        if (om != null) monId = om.Id;
      }
      if (monId != null) {
        mon = null;
        foreach (SnapMonitor m in mons) if (m.Id == monId) mon = m;
        if (mon == null) return "snap.zone: monitor " + monId + " is not connected any more";
      }
      Rec mem = Mem(hwnd, false);
      string state = SnapGeom.Detect(w.Minimized, w.Maximized, w.Frame, w.Monitor,
                                     mem != null && mem.Zone != null, mem != null ? mem.Zone : null,
                                     mem != null ? mem.Frame : new SnapRect());
      var plan = new SnapPlan();
      plan.From = state;
      SnapGeom.SnapToZone(plan, z, mon);
      plan.Assist = new List<SnapZone>();
      object restObj;
      if (Json.TryGet(req, "rest", out restObj) && restObj is List<object>) {
        foreach (object o in (List<object>)restObj) {
          var d = o as Dictionary<string, object>;
          SnapZone rz;
          if (d != null && ParseZone(d, "grid", "cell", out rz) == null) plan.Assist.Add(rz);
        }
      }
      result = Execute(w, plan, mons, mem, sw);
      return null;
    }

    static string ParseZone(Dictionary<string, object> req, string gk, string ck, out SnapZone z) {
      z = null;
      object go, co;
      if (!Json.TryGet(req, gk, out go) || !Json.TryGet(req, ck, out co)) {
        string name = Json.GetString(req, "zone");
        if (name != null) { z = SnapGeom.ByName(name); return z == null ? "unknown zone \"" + name + "\"" : null; }
        return "needs grid:[cols,rows] and cell:[x,y,w,h] (or zone: left/right/tl/tr/bl/br)";
      }
      var g = go as List<object>;
      var c = co as List<object>;
      if (g == null || c == null || g.Count != 2 || c.Count != 4) return "grid must be [cols,rows] and cell [x,y,w,h]";
      int[] n = new int[6];
      for (int i = 0; i < 6; i++) {
        object v = i < 2 ? g[i] : c[i - 2];
        if (!(v is double)) return "grid and cell must be whole numbers";
        n[i] = (int)Math.Round((double)v);
      }
      string why;
      z = SnapGeom.Grid(n[0], n[1], n[2], n[3], n[4], n[5], out why);
      return why;
    }

    static string Info(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Target(req);
      if (hwnd == IntPtr.Zero) return "there is no active window";
      if (!N.IsWindow(hwnd)) return "that window has closed";
      List<SnapMonitor> mons = ReadMonitors();
      Win w = Measure(hwnd, mons);
      Rec mem = Mem(hwnd, false);
      string state = SnapGeom.Detect(w.Minimized, w.Maximized, w.Frame, w.Monitor,
                                     mem != null && mem.Zone != null, mem != null ? mem.Zone : null,
                                     mem != null ? mem.Frame : new SnapRect());
      string ilWhy;
      int il = IntegrityOf(w.Pid, out ilWhy);
      var monList = new List<object>();
      foreach (SnapMonitor m in SnapGeom.Ordered(mons)) monList.Add(m.ToJson());
      SnapRect normal = WorkspaceToScreen(w.Placement.rcNormalPosition, w.ExStyle, mons);
      result = Json.Obj(
        "hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),
        "exe", w.Exe, "title", w.Title, "class", w.Class, "pid", w.Pid,
        "rect", w.Rect.ToJson(), "frame", w.Frame.ToJson(),
        "margins", w.Margins.ToJson(), "marginsOk", w.MarginsOk, "dpi", w.Dpi,
        "state", state, "minimized", w.Minimized, "maximized", w.Maximized, "arranged", w.Arranged,
        "foreground", w.Foreground, "visible", w.Visible,
        "resizable", (w.Style & 0x00040000) != 0,
        "maximizable", (w.Style & 0x00010000) != 0,
        "minimizable", (w.Style & 0x00020000) != 0,
        "integrity", il < 0 ? null : (object)("0x" + il.ToString("x4", CultureInfo.InvariantCulture)),
        "integrityReason", ilWhy,
        "elevatedAboveMantle", il > OwnIntegrity(),
        "hung", N.IsHungAppWindow(hwnd),
        "placementRect", normal.ToJson(),
        "placementFrame", w.HasPlacement ? w.PlacementFrame.ToJson() : null,
        "remembered", mem == null ? null : Json.Obj("zone", mem.Zone, "frame", mem.Zone != null ? mem.Frame.ToJson() : null,
                                                    "pre", mem.HasPre ? mem.PreFrame.ToJson() : null, "preMonitor", mem.PreMon),
        "monitor", w.Monitor != null ? w.Monitor.ToJson() : null,
        "monitors", monList);
      return null;
    }

    static string MonitorsCmd(Dictionary<string, object> req, ref object result) {
      var list = new List<object>();
      foreach (SnapMonitor m in SnapGeom.Ordered(ReadMonitors())) list.Add(m.ToJson());
      result = Json.Obj("monitors", list);
      return null;
    }

    // ---------------------------------------------------------------- snap.plan (pure)
    static bool RectArg(Dictionary<string, object> d, string key, out SnapRect r) {
      r = new SnapRect();
      object v;
      if (!Json.TryGet(d, key, out v)) return false;
      var a = v as List<object>;
      if (a == null || a.Count != 4) return false;
      for (int i = 0; i < 4; i++) if (!(a[i] is double)) return false;
      r = new SnapRect((int)(double)a[0], (int)(double)a[1], (int)(double)a[2], (int)(double)a[3]);
      return true;
    }

    /// snap.plan {monitors:[{id,bounds:[l,t,r,b],work:[..],dpi,primary}], frame:[..], window:[..],
    ///   minimized, maximized, dir | zone/grid+cell, remembered:{zone,frame,pre,preMonitor},
    ///   placement:[..]} -> what snap.move / snap.zone would do, in rects. Touches nothing.
    static string PlanCmd(Dictionary<string, object> req, ref object result) {
      object mo;
      if (!Json.TryGet(req, "monitors", out mo) || !(mo is List<object>)) return "snap.plan needs monitors";
      var mons = new List<SnapMonitor>();
      foreach (object o in (List<object>)mo) {
        var d = o as Dictionary<string, object>;
        if (d == null) return "snap.plan: a monitor must be an object";
        var m = new SnapMonitor();
        m.Id = Json.GetString(d, "id") ?? ("m" + mons.Count);
        if (!RectArg(d, "bounds", out m.Bounds)) return "snap.plan: monitor " + m.Id + " needs bounds [l,t,r,b]";
        if (!RectArg(d, "work", out m.Work)) m.Work = m.Bounds;
        m.Dpi = Json.GetInt(d, "dpi", 96);
        m.Primary = Json.GetBool(d, "primary", false);
        mons.Add(m);
      }
      if (mons.Count == 0) return "snap.plan needs at least one monitor";
      SnapRect frame, window;
      if (!RectArg(req, "frame", out frame)) return "snap.plan needs frame [l,t,r,b]";
      if (!RectArg(req, "window", out window)) window = frame;
      SnapMonitor cur = null;
      string curId = Json.GetString(req, "monitor");
      foreach (SnapMonitor m in mons) if (m.Id == curId) cur = m;
      if (cur == null) cur = SnapGeom.MonitorFor(frame, mons);
      bool ok;
      SnapMargins margins = SnapGeom.MarginsOf(window, frame, cur.Dpi, out ok);

      bool hasMem = false, hasPre = false;
      string memZone = null;
      SnapRect memFrame = new SnapRect(), pre = new SnapRect();
      SnapMonitor preMon = null;
      object ro;
      if (Json.TryGet(req, "remembered", out ro) && ro is Dictionary<string, object>) {
        var rd = (Dictionary<string, object>)ro;
        memZone = Json.GetString(rd, "zone");
        hasMem = memZone != null && RectArg(rd, "frame", out memFrame);
        hasPre = RectArg(rd, "pre", out pre);
        string pm = Json.GetString(rd, "preMonitor");
        foreach (SnapMonitor m in mons) if (m.Id == pm) preMon = m;
        if (hasPre && preMon == null) preMon = SnapGeom.MonitorFor(pre, mons);
      }
      SnapRect placement;
      bool hasPlacement = RectArg(req, "placement", out placement);
      bool minimized = Json.GetBool(req, "minimized", false), maximized = Json.GetBool(req, "maximized", false);
      string state = Json.GetString(req, "state") ??
                     SnapGeom.Detect(minimized, maximized, frame, cur, hasMem, memZone, memFrame);

      SnapPlan plan;
      string dir = Json.GetString(req, "dir");
      if (dir != null) {
        plan = SnapGeom.Next(state, dir.ToLowerInvariant(), mons, cur, frame, hasPre, pre, preMon, hasPlacement, placement);
      } else {
        SnapZone z;
        string why = ParseZone(req, "grid", "cell", out z);
        if (why != null) return "snap.plan: " + why;
        plan = new SnapPlan();
        plan.From = state;
        SnapGeom.SnapToZone(plan, z, cur);
      }
      SnapMonitor target = plan.Monitor ?? cur;
      SnapMargins tm = SnapGeom.Scale(margins, cur.Dpi, target.Dpi);
      var assist = new List<object>();
      foreach (SnapZone z in plan.Assist) assist.Add(Json.Obj("zone", z.ToJson(), "frame", SnapGeom.Cell(target.Work, z).ToJson()));
      result = Json.Obj(
        "from", plan.From, "to", plan.To, "action", plan.Action, "why", plan.Why,
        "zone", plan.Zone != null ? plan.Zone.ToJson() : null,
        "monitor", target.Id,
        "frame", plan.HasFrame ? plan.Frame.ToJson() : null,
        "window", plan.HasFrame ? SnapGeom.WindowFor(plan.Frame, tm).ToJson() : null,
        "margins", tm.ToJson(), "marginsOk", ok,
        "restoredFrom", plan.RestoredFrom,
        "assist", assist);
      return null;
    }

    // ---------------------------------------------------------------- P/Invoke (this file's own)
    static class N {
      public delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref SnapRect rc, IntPtr data);
      public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

      [StructLayout(LayoutKind.Sequential)]
      public struct MONITORINFO { public int cbSize; public SnapRect rcMonitor; public SnapRect rcWork; public uint dwFlags; }

      [StructLayout(LayoutKind.Sequential)]
      public struct POINT { public int X, Y; }

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

      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern bool IsWindowArranged(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
      [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
      [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr hwnd, int index);
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out SnapRect rect);
      [DllImport("user32.dll", SetLastError = true)]
      public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
      [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
      [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFO mi);
      [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
      [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int index, uint dpi);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int InternalGetWindowText(IntPtr hwnd, StringBuilder s, int max);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder s, int max);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)]
      public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
      [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dpiX, out uint dpiY);
      [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out SnapRect val, int size);
      [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
      public static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int attr, out int val, int size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern bool QueryFullProcessImageNameW(IntPtr proc, int flags, StringBuilder name, ref int size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
      [DllImport("advapi32.dll", SetLastError = true)]
      public static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buf, int len, out int retLen);
      [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
      [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    }
  }
}
