// UnderPaint.cs - `underpaint`, `underhint`, `winproc`: the top bar's colour under it, painted by the sidecar
// itself in a native window right behind the bar (lane mantle-topbar-zero, 2026-10-11). DARK ONLY (main
// only asks in dark).
//
// Owen: "there is still a tiny delay. is there a way to make it so there is literally no delay?" The colour
// went screen -> sidecar (Desktop Duplication, UnderDup.cs) -> main -> the bar's page -> Chromium's compositor
// -> the GPU process -> DWM: 2-3 refreshes after the window under the bar changed. Now the sidecar paints the
// colour itself: a layered, click-through, never-focused tool window (WS_EX_LAYERED | TRANSPARENT | TOOLWINDOW
// | NOACTIVATE | TOPMOST) z-ordered directly UNDER the Electron top bar, filled by UpdateLayeredWindow on the
// frame duplication sees the change. The bar's page masks its glass where a window is under it (the colour
// shows through) and keeps its words, ink and contrast scrim (ui/topbar/under.js paintOverlay). The floor is
// one refresh: the bar can only react after the window under it has drawn.
//
// THE PAINT. n columns (the same buckets as UnderDup.Average / lib/topbar-under.js columnsOf), spread across
// the layer exactly like the page's canvas is scaled by Chromium (bilinear between column centres, clamped at
// the ends), every row the same colour: the exact colour, whose bottom row is the seam.
//
// PREDICTIONS (the window switch on the SAME frame). Duplication only sees a change after it is on screen.
// What will be under the bar after a switch is often known BEFORE it is on screen:
//   - a top-row HINT from Quartz or Helm (the look-sync named pipe, lib/toprow-hints.js -> `underhint`);
//   - this sidecar's own per-window CACHE: whenever duplication reads the row, each window covering part of
//     it is remembered as (hwnd, title) -> its columns and its rect then (memory only, 240 averaged colours,
//     LRU of CacheMax). A tab switch usually changes the title, so a tab seen before is cached too.
// On an event that changes which window or tab is under the bar (the foreground, a minimise / restore, a
// close or hide revealing another window, a title change of a window under the bar, a new hint) the columns
// of the window(s) now under the bar are painted from the hint (wins) or the cache AT ONCE (a z-order change
// lands on the next composition) or, for a title / hint (the app repaints a few frames after it), at the
// time this app's own pixels usually land (learned per app: event -> first frame that shows it).
// Duplication stays the truth: a capture that agrees confirms the prediction; one that disagrees for longer
// than the hold (a few frames; a minimise / close animation longer) wins, the stale cache entry is dropped
// and counted (`corrected`), and a hint that disagrees is reported to main (once per app; main says it).
//
// THE SWITCH FRAME (lane mn-underpaint, 2026-10-12, from the on-screen measurement in mantle-notes/toprow.md).
// EVENT_SYSTEM_FOREGROUND reaches this thread 14-20 ms before the window's first frame, but BEFORE Windows has
// moved the window up the z-order (1-3 ms later for a plain activation, 7-18 ms for an attached one). Reading
// the z-order on the event found the old window still on top in 105 of 105 switches, so nothing was predicted
// and the bar waited for the capture: one refresh late every time. Now the event's window is put where it is
// about to be (RAISED: above every non-topmost window, with the windows it owns or is owned with) and the
// cached colour is painted on the event, which lands on the switch frame. Windows also fires the event for a
// REFUSED SetForegroundWindow (an app trying to steal focus), and that used to flash the wrong colour for
// 67-83 ms, so a raised event is guarded: an HSHELL_FLASH for the same window just before it (the refusal's own
// taskbar flash) means no prediction; a flash just after it, or a z-order / GetForegroundWindow check that
// still disagrees RaiseCheckMs later, takes the prediction back at once (the cache entry is not stale, so it
// stays). Until that check passes the cache records nothing, so a refused raise cannot file the old window's
// pixels under the new one. Counted in raisePredicted / raiseConfirmed / raiseCorrected / raiseFlashSkipped.
//
// STOPS ITSELF: main asks with on:true every second; no ask for KeepAliveMs = the layer is destroyed.
// on:false destroys it at once. Passive (a --test Mantle): the layer is made but stays fully transparent
// unless MANTLE_UNDERPAINT_VISIBLE=1 is set for the sidecar (the on-screen latency harness).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  static class UnderPaint {
    static class N {
      public delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct WNDCLASSEX {
        public uint cbSize, style; public WndProc lpfnWndProc; public int cbClsExtra, cbWndExtra;
        public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string lpszMenuName, lpszClassName; public IntPtr hIconSm;
      }
      [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
      [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
      [StructLayout(LayoutKind.Sequential)] public struct BLEND { public byte Op, Flags, Alpha, Format; }
      [StructLayout(LayoutKind.Sequential)]
      public struct BMIH { public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant; }
      [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern ushort RegisterClassExW(ref WNDCLASSEX c);
      [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
      [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
      [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
      [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint remove);
      [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
      [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG m);
      [DllImport("user32.dll")] public static extern uint MsgWaitForMultipleObjectsEx(uint n, IntPtr handles, uint ms, uint wake, uint flags);
      [DllImport("user32.dll")] public static extern bool PostThreadMessageW(uint tid, uint m, IntPtr w, IntPtr l);
      [DllImport("user32.dll", SetLastError = true)]
      public static extern bool UpdateLayeredWindow(IntPtr h, IntPtr hdcDst, ref Win32.POINT dst, ref SIZE size, IntPtr hdcSrc, ref Win32.POINT src, uint key, ref BLEND blend, uint flags);
      [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
      [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
      [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
      [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
      [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
      [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
      [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
      [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
      [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
      [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BMIH bi, uint usage, out IntPtr bits, IntPtr sec, uint off);
      [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, Win32.WinEventProc cb, uint pid, uint tid, uint flags);
      [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterShellHookWindow(IntPtr h);
      [DllImport("user32.dll")] public static extern bool DeregisterShellHookWindow(IntPtr h);
      [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint RegisterWindowMessageW(string name);
      [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint p);
      [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint p);
      [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
      [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandleW(IntPtr n);
      [DllImport("kernel32.dll")] public static extern bool QueryPerformanceCounter(out long v);
      [DllImport("kernel32.dll")] public static extern bool QueryPerformanceFrequency(out long v);
      [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out Win32.RECT r, int size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    }

    // ------------------------------------------------------------------ constants
    public const string ClassName = "MantleUnderPaint";
    const uint WS_POPUP = 0x80000000;
    const uint WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000, WS_EX_TOPMOST = 0x8;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40, SWP_NOOWNERZORDER = 0x200, SWP_NOSENDCHANGING = 0x400;
    const uint WM_APP = 0x8000, WM_ROW = WM_APP + 1, WM_WAKE = WM_APP + 2, WM_STOP = WM_APP + 3;
    const uint QS_ALLINPUT = 0x04FF, MWMO_INPUTAVAILABLE = 0x4, PM_REMOVE = 1;
    const int KeepAliveMs = 3000;
    const int AgreeLevels = 6;       // the contract's 6 levels: a prediction and the capture agree within this
    const int HoldFrames = 4;        // a prediction holds against a disagreeing capture this long (the frame it lands + 3)
    const int AnimHoldMs = 450;      // ...after a minimise / restore / close / hide: Windows animates those
    const int SettleFrames = 2;      // the cache records a row only this long after the last event
    const int TitleWaitMs = 600;     // after a title change, the window's entry waits for its repaint (or this)
    const int CacheMax = 300;
    const int LearnN = 15;
    const double LeadMs = 6;         // a timed prediction is painted this long before the app's frame usually lands
    const int RaiseCheckFrames = 3;  // a raised FOREGROUND must be on top in the real z-order by then (3 frames,
    const double RaiseCheckMinMs = 30;   // ...but never under 30 ms: an attached activation moves up to 18 ms late)
    const double FlashSkipMs = 60;   // HSHELL_FLASH for a window this close before its FOREGROUND = a refused activation
    const double WatchMs = 1500;     // ...and its window is watched this long for Windows granting it later
    const double FastMinMs = 0.5;    // the fast path never paints sooner than this after its FOREGROUND event,
    const double FastAfterZMs = 0.6; // ...nor sooner than this after the z-order showed the window raised,
    const double FastWaitMaxMs = 4;  // ...and gives up (the full pass paints) when the z-order has not moved by then
    const long HSHELL_FLASH = 0x8006;    // HSHELL_REDRAW | HSHELL_HIGHBIT: a taskbar button flashes
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    // ------------------------------------------------------------------ main's side (under _gate)
    static readonly object _gate = new object();
    static Thread _thread;
    static uint _tid;
    static volatile bool _active;          // UnderDup reads it: paint every frame that crosses the row
    static bool _want, _sim, _visibleAsk;
    static int _askTick, _gen;
    static IntPtr _barAsk;
    static int _lxA, _lyA, _lwA, _lhA, _rxA, _ryA, _rwA, _nA;
    static double _hzA = 60;
    static string _sigA;
    static byte[] _washA;
    static string _mode = "off", _reason;
    // the capture slot (UnderDup's thread -> this thread)
    static byte[] _slot;
    static long _slotQ;
    static readonly Queue<object[]> _inbox = new Queue<object[]>();   // sim rows / windows / events, hints, flushes
    // stats (written by the thread, read under _gate)
    static long _paints, _capPaints, _predPaints, _held, _confirmed, _corrected, _cacheHits, _cacheMiss, _hintUsed, _records, _events, _ulwFails;
    // the raised FOREGROUND path: events whose window was not on top yet, predictions painted on one, the check's
    // verdicts, and refused activations skipped on their taskbar flash
    static long _raiseMoved, _raisePred, _raiseOk, _raiseBad, _raiseFlashSkip, _flashSeen, _cacheDrop, _predSame, _raiseLate;
    static readonly Dictionary<string, long> _raiseBadBy = new Dictionary<string, long>(StringComparer.Ordinal);
    // the FOREGROUND event's own timing: entry -> the paint's UpdateLayeredWindow returned (fgPaintMs), entry ->
    // the full pass (z-order walk + prediction) done (fgFullMs); events that painted nothing, by why; the fast path
    static readonly List<double> _fgPaintMs = new List<double>(), _fgFullMs = new List<double>();   // last FgKeep
    // the fast path's stages: event -> its colours ready, event -> the z-order seen moved, the paint's own cost
    static readonly List<double> _fastReadyMs = new List<double>(), _fastZMs = new List<double>(), _fastLandMs = new List<double>();
    static long _fastZAtOnce;   // the z-order had moved already at the first look
    static readonly Dictionary<string, long> _fgNoPaintBy = new Dictionary<string, long>(StringComparer.Ordinal);
    static readonly Dictionary<string, long> _fastSkipBy = new Dictionary<string, long>(StringComparer.Ordinal);
    static long _fgEvents, _fastPaints, _fastKept, _fastExtended, _fastChanged, _fastTakenBack;
    static readonly Queue<string> _fgRecent = new Queue<string>();   // "hwnd evMs paintMs how" (QPC ms), last FgKeep
    const int FgKeep = 100;
    static volatile bool _fastOn = true;   // `underpaint` fast:false turns the fast path off (the A/B harness)
    static string _shellHook = "off";   // on | off | the reason it could not be registered
    static readonly Dictionary<string, long> _predBy = new Dictionary<string, long>(StringComparer.Ordinal);
    static readonly Dictionary<string, long> _corrBy = new Dictionary<string, long>(StringComparer.Ordinal);
    static readonly List<double> _predLags = new List<double>();    // event -> first agreeing capture (ms), last 50
    static string _layerInfo;

    public static bool Active { get { return _active; } }
    /// The layer has no row yet (it just started, or its row moved): UnderDup hands it the row it read last,
    /// or a still desktop (no frame crossing the row) would leave it hidden until something changed there.
    public static bool NeedsRow { get { return _needRow && _active; } }
    static volatile bool _needRow;

    // ------------------------------------------------------------------ commands
    public static string Cmd(Dictionary<string, object> req, ref object result) {
      object v;
      if (req.TryGetValue("inject", out v) || req.TryGetValue("wins", out v) || req.TryGetValue("ev", out v) ||
          req.TryGetValue("flash", out v) || req.TryGetValue("fg", out v)) {
        lock (_gate) {
          if (!_sim) return "underpaint: inject / wins / ev / flash / fg need a running sim:true layer";
          object x;
          // wins ALONE = the windows as they are now (coverage re-read, like Record's own check); wins WITH an
          // ev in the same ask = the world when that event arrives (the event re-reads it, so it can predict the
          // change; a foreground's window need not be on top yet: Windows moves it a few ms after the event)
          // fg = what GetForegroundWindow says from now on (a foreground ev sets it to its window unless it has
          // its own fg); flash = an HSHELL_FLASH for that window
          if (req.TryGetValue("fg", out x)) _inbox.Enqueue(new object[] { "fg", Json.GetHwnd(req, "fg") });
          if (req.TryGetValue("flash", out x)) _inbox.Enqueue(new object[] { "flash", Json.GetHwnd(req, "flash") });
          if (req.TryGetValue("wins", out x)) _inbox.Enqueue(new object[] { "wins", x, req.ContainsKey("ev") });
          if (req.TryGetValue("inject", out x)) _inbox.Enqueue(new object[] { "row", x, Json.GetBool(req, "old", false) });
          if (req.TryGetValue("ev", out x)) _inbox.Enqueue(new object[] { "ev", x });
        }
        Wake();
        result = Json.Obj("ok", true);
        return null;
      }
      if (req.TryGetValue("flush", out v) && Json.GetBool(req, "flush", false)) {
        lock (_gate) _inbox.Enqueue(new object[] { "flush", Json.GetString(req, "why") ?? "asked" });
        Wake();
      }
      if (Json.GetBool(req, "peek", false)) return Peek(req, ref result);
      if (!req.ContainsKey("on")) { result = View(); return null; }
      bool on = Json.GetBool(req, "on", true);
      lock (_gate) {
        if (!on) {
          bool was = _want;
          _want = false; _gen++;
          if (_tid != 0) N.PostThreadMessageW(_tid, WM_STOP, IntPtr.Zero, IntPtr.Zero);
          result = Json.Obj("ok", true, "on", false, "was", was, "mode", "off");
          return null;
        }
        int lw = Json.GetInt(req, "w", 0), lh = Json.GetInt(req, "h", 0), n = Json.GetInt(req, "n", 0), rw = Json.GetInt(req, "rowW", lw);
        if (lw <= 0 || lw > 16384 || lh <= 0 || lh > 512) return "underpaint: the layer must be 1..16384 x 1..512 physical pixels";
        if (n <= 0 || n > 4096 || rw <= 0 || n > rw) return "underpaint: n must be between 1 and rowW";
        _barAsk = Json.GetHwnd(req, "bar");
        _lxA = Json.GetInt(req, "x", 0); _lyA = Json.GetInt(req, "y", 0); _lwA = lw; _lhA = lh;
        _rxA = Json.GetInt(req, "rowX", _lxA); _ryA = Json.GetInt(req, "rowY", _lyA + lh); _rwA = rw; _nA = n;
        int hz = Json.GetInt(req, "hz", 60); _hzA = hz >= 24 && hz <= 500 ? hz : 60;
        bool vis = Json.GetBool(req, "visible", false);
        if (Program.Passive && Environment.GetEnvironmentVariable("MANTLE_UNDERPAINT_VISIBLE") != "1") vis = false;
        _visibleAsk = vis;
        _sim = Json.GetBool(req, "sim", false);
        _fastOn = Json.GetBool(req, "fast", true);   // (main never sends it: on)
        if (req.TryGetValue("wash", out v)) {
          string b = v as string;
          byte[] w = null;
          if (!string.IsNullOrEmpty(b)) { try { w = Convert.FromBase64String(b); } catch (FormatException) { w = null; } }
          _washA = w != null && w.Length == n * 3 ? w : null;
        }
        string sig = _barAsk + "|" + _lxA + "," + _lyA + "," + _lwA + "," + _lhA + "|" + _rxA + "," + _ryA + "," + _rwA + "," + _nA + "|" + _hzA + "|" + vis + "|" + _sim + "|" + (_washA == null ? "" : Convert.ToBase64String(_washA));
        _askTick = Environment.TickCount;
        if (!_want || sig != _sigA) _gen++;
        _sigA = sig;
        _want = true;
        if (_thread == null || !_thread.IsAlive) {
          _thread = new Thread(Run);
          _thread.IsBackground = true;
          _thread.Name = "underpaint";
          _thread.Priority = ThreadPriority.Highest;
          _thread.Start();
        } else if (_tid != 0) N.PostThreadMessageW(_tid, WM_WAKE, IntPtr.Zero, IntPtr.Zero);
      }
      result = View();
      return null;
    }

    /// `underhint` {hwnd, app, top} | {hwnd, top:null} | {clear:true}: main's checked, normalised hints.
    public static string Hint(Dictionary<string, object> req, ref object result) {
      if (Json.GetBool(req, "clear", false)) {
        lock (_gate) _inbox.Enqueue(new object[] { "hintclear" });
        Wake();
        result = Json.Obj("ok", true);
        return null;
      }
      IntPtr h = Json.GetHwnd(req, "hwnd");
      if (h == IntPtr.Zero) return "underhint: hwnd is required";
      object top; req.TryGetValue("top", out top);
      HintRec rec = null;
      var t = top as Dictionary<string, object>;
      if (t != null) {
        string why = ParseHint(t, Json.GetString(req, "app") ?? "", out rec);
        if (why != null) return "underhint: " + why;
      }
      lock (_gate) _inbox.Enqueue(new object[] { "hint", h, rec });
      Wake();
      result = Json.Obj("ok", true);
      return null;
    }

    /// `winproc` {hwnd} -> {ok, pid, path}: whose window is it (main's check of a hint's sender).
    public static string WinProc(Dictionary<string, object> req, ref object result) {
      IntPtr h = Json.GetHwnd(req, "hwnd");
      if (h == IntPtr.Zero || !N.IsWindow(h)) { result = Json.Obj("ok", false, "reason", "there is no such window"); return null; }
      int pid;
      Win32.GetWindowThreadProcessId(h, out pid);
      if (pid == 0) { result = Json.Obj("ok", false, "reason", "the window has no process"); return null; }
      IntPtr p = N.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
      if (p == IntPtr.Zero) { result = Json.Obj("ok", false, "pid", pid, "reason", "its process could not be opened (error " + Marshal.GetLastWin32Error() + ")"); return null; }
      try {
        var sb = new StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        if (!N.QueryFullProcessImageNameW(p, 0, sb, ref size)) { result = Json.Obj("ok", false, "pid", pid, "reason", "its path could not be read (error " + Marshal.GetLastWin32Error() + ")"); return null; }
        result = Json.Obj("ok", true, "pid", pid, "path", sb.ToString(0, (int)size));
        return null;
      } finally { N.CloseHandle(p); }
    }

    static void Wake() { uint t; lock (_gate) t = _tid; if (t != 0) N.PostThreadMessageW(t, WM_WAKE, IntPtr.Zero, IntPtr.Zero); }

    /// UnderDup's frame thread: a new row (averaged) presented at presentQ. Only the newest is kept.
    public static void Row(byte[] cols, long presentQ) {
      uint t;
      lock (_gate) {
        if (!_active || _sim) return;
        _slot = cols; _slotQ = presentQ; t = _tid; _needRow = false;
      }
      if (t != 0) N.PostThreadMessageW(t, WM_ROW, IntPtr.Zero, IntPtr.Zero);
    }

    static IDictionary View() {
      lock (_gate) {
        var pb = Json.Obj(); foreach (var kv in _predBy) pb[kv.Key] = kv.Value;
        var cb = Json.Obj(); foreach (var kv in _corrBy) cb[kv.Key] = kv.Value;
        var rb = Json.Obj(); foreach (var kv in _raiseBadBy) rb[kv.Key] = kv.Value;
        var lags = new List<double>(_predLags); lags.Sort();
        double med = lags.Count > 0 ? lags[lags.Count / 2] : -1, p95 = lags.Count > 0 ? lags[Math.Min(lags.Count - 1, (int)(lags.Count * 0.95))] : -1;
        long dec = _confirmed + _corrected;
        var nb = Json.Obj(); foreach (var kv in _fgNoPaintBy) nb[kv.Key] = kv.Value;
        var fs = Json.Obj(); foreach (var kv in _fastSkipBy) fs[kv.Key] = kv.Value;
        var fg = Json.Obj("events", _fgEvents, "paintMs", Pct(_fgPaintMs), "fullMs", Pct(_fgFullMs), "noPaintBy", nb,
          "fast", _fastOn, "fastPainted", _fastPaints, "fastKept", _fastKept, "fastExtended", _fastExtended,
          "fastChanged", _fastChanged, "fastTakenBack", _fastTakenBack, "fastSkippedBy", fs,
          "fastReadyMs", Pct(_fastReadyMs), "fastZMs", Pct(_fastZMs), "fastZAtOnce", _fastZAtOnce, "fastLandMs", Pct(_fastLandMs));
        return Json.Obj("foreground", fg, "ok", true, "on", _want, "mode", _mode, "reason", _reason, "sim", _sim, "layer", _layerInfo,
          "paints", _paints, "capturePaints", _capPaints, "predictionPaints", _predPaints, "held", _held,
          "predictions", pb, "confirmed", _confirmed, "corrected", _corrected, "correctedBy", cb,
          "correctionRate", dec > 0 ? Math.Round((double)_corrected / dec, 3) : 0.0,
          "cacheHits", _cacheHits, "cacheMisses", _cacheMiss, "hintUsed", _hintUsed, "records", _records, "events", _events,
          "cache", _cacheCount, "hints", _hintCount, "ulwFails", _ulwFails,
          "predLagMedianMs", Math.Round(med, 1), "predLagP95Ms", Math.Round(p95, 1),
          "raiseMoved", _raiseMoved, "raisePredicted", _raisePred, "raiseConfirmed", _raiseOk, "raiseCorrected", _raiseBad,
          "raiseCorrectedBy", rb, "raiseFlashSkipped", _raiseFlashSkip, "shellHook", _shellHook, "shellFlashes", _flashSeen, "cacheDropped", _cacheDrop, "predictedNoChange", _predSame, "raiseGrantedLater", _raiseLate);
      }
    }
    static int _cacheCount, _hintCount;
    /// {n, p50, p95, max} of a list of ms (under _gate).
    static IDictionary Pct(List<double> l) {
      var s = new List<double>(l); s.Sort();
      if (s.Count == 0) return Json.Obj("n", 0);
      return Json.Obj("n", s.Count, "p50", Math.Round(s[s.Count / 2], 2), "p95", Math.Round(s[Math.Min(s.Count - 1, (int)(s.Count * 0.95))], 2), "max", Math.Round(s[s.Count - 1], 2));
    }
    static void Keep(List<double> l, double v) { l.Add(Math.Round(v, 3)); if (l.Count > FgKeep) l.RemoveAt(0); }

    static void SetMode(string mode, string reason) {
      bool emit;
      lock (_gate) { emit = mode != _mode || reason != _reason; _mode = mode; _reason = reason; }
      if (emit) Features.Event("underrow", Json.Obj("kind", "paint", "mode", mode, "reason", reason));
    }
    static void Count(Dictionary<string, long> d, string k) { long c; d.TryGetValue(k, out c); d[k] = c + 1; }

    // ------------------------------------------------------------------ the thread's own state
    sealed class HintRec {
      public string App, Kind;                // flat | cols | wash | none
      public byte R, G, B; public double Alpha;
      public byte[] Cols;                     // cols: k*3, the window's width left to right
      public long AtQ;
    }
    sealed class Win {
      public IntPtr H; public string Title = ""; public int L, T, R, B, Pid;
      public bool Top;                        // WS_EX_TOPMOST
      public IntPtr Owner;                    // its root owner (itself when unowned); Zero = not read yet (OwnerOf)
    }
    /// A FOREGROUND prediction made with its window raised, waiting for the real z-order to agree.
    sealed class Raise {
      public IntPtr H;                        // the event's window
      public long EvQ, CheckQ;                // CheckQ: the last moment it may still disagree
      public Pred P;                          // the prediction it painted (null: none, only the coverage is raised)
    }
    sealed class Entry {
      public string Key; public IntPtr H; public string Title; public int L, T, R, B;
      public byte[] Cols; public bool[] Mask; public LinkedListNode<Entry> Node;
    }
    sealed class Pred {
      public string Kind, LearnKey, App;      // switch | anim | title | hint
      public long EvQ, DueQ, HoldQ;
      public byte[] Cols; public bool[] Mask;
      public bool Painted, FromHint, FromCache;
      public List<string> Keys = new List<string>();
    }

    static long _qpf;
    static IntPtr _wnd, _memDC, _dib, _oldBmp, _bits;
    static int _dibW, _dibH;
    static int[] _line = new int[0];
    static N.WndProc _proc;                   // kept alive: the class's window procedure
    static Win32.WinEventProc _evProc;        // kept alive: the hooks' callback
    static readonly List<IntPtr> _hooks = new List<IntPtr>();
    static IntPtr _barHook;
    static int _hookedBarPid;
    // config as the thread last applied it
    static IntPtr _bar;
    static int _lx, _ly, _lw, _lh, _rx, _ry, _rw, _n, _offX, _offY;
    static bool _visible, _shown, _barHidden;
    static double _frameMs = 1000.0 / 60;
    static byte[] _wash;
    // the row
    static byte[] _cap, _painted;             // the last capture (the truth) and what the layer shows
    static long _capQ;
    // the windows under the row
    static IntPtr[] _owner = new IntPtr[0];   // per column: the window, or Zero for the desktop
    static Dictionary<IntPtr, Win> _cov = new Dictionary<IntPtr, Win>();
    static List<Win> _simWins;
    static long _settleQ, _covQ;
    static IntPtr _titleWaitH; static long _titleWaitUntilQ; static byte[] _titleWaitCols;
    // the cache, hints, the prediction
    static readonly Dictionary<string, Entry> _cache = new Dictionary<string, Entry>(StringComparer.Ordinal);
    static readonly LinkedList<Entry> _lru = new LinkedList<Entry>();
    static readonly Dictionary<IntPtr, HintRec> _hints = new Dictionary<IntPtr, HintRec>();
    static readonly Dictionary<string, int> _appBad = new Dictionary<string, int>(StringComparer.Ordinal);   // consecutive mismatches
    static readonly HashSet<string> _distrust = new HashSet<string>(StringComparer.Ordinal);
    static readonly Dictionary<IntPtr, long> _hintBadFromQ = new Dictionary<IntPtr, long>();
    static readonly Dictionary<string, List<double>> _learn = new Dictionary<string, List<double>>(StringComparer.Ordinal);
    static Pred _pred;
    static Raise _raise;                       // a raised FOREGROUND not yet checked against the real z-order
    static IntPtr _flashH; static long _flashQ;   // the last HSHELL_FLASH (a refused activation flashes its button)
    static IntPtr _simFg;                      // sim: what GetForegroundWindow says
    static byte[] _pendRec;                    // a frame that came before the settle time: Record at it (Timers)
    static IntPtr _watchH; static long _watchUntilQ;   // a refused activation's window, watched by the frames (Watch)
    static uint _shellMsg;                     // RegisterWindowMessage("SHELLHOOK"), 0 = no shell hook
    static bool _fine;                         // timeBeginPeriod(1) is on
    static long _ulwQ, _ulwSeq;                // when the last UpdateLayeredWindow returned, and how many so far
    static string _predWhy;                    // what the last Predict did ("painted", or why it painted nothing)
    static bool _fastRecount;                  // Predict is the full pass after a fast paint: it counts no lookups

    static long Q() { long v; N.QueryPerformanceCounter(out v); return v; }
    static double Ms(long dq) { return dq * 1000.0 / _qpf; }
    static long Dq(double ms) { return (long)(ms * _qpf / 1000.0); }

    // ------------------------------------------------------------------ the thread
    static void Run() {
      N.QueryPerformanceFrequency(out _qpf);
      int gen = -1;
      try {
        lock (_gate) _tid = N.GetCurrentThreadId();
        N.MSG m;
        N.PeekMessageW(out m, IntPtr.Zero, 0, 0, 0);   // make the queue before anyone posts to it
        for (;;) {
          bool want; int ask, g;
          lock (_gate) { want = _want; ask = _askTick; g = _gen; }
          if (want && unchecked(Environment.TickCount - ask) > KeepAliveMs) {
            // an ask that landed since the read above keeps it (it used to stop anyway, and the new thread
            // only came with the NEXT ask, a second later)
            lock (_gate) { if (_askTick == ask) _want = false; want = _want; }
            if (!want) Program.EmitLog("info", "underpaint: main stopped asking for " + KeepAliveMs + " ms, so the layer was taken down");
          }
          if (!want) break;
          if (g != gen) { gen = g; string why = Apply(); if (why != null) { Teardown(); SetMode("failed", why); lock (_gate) _want = false; break; } }
          Drain();
          Timers();
          long now = Q();
          long next = NextWakeQ(now);
          uint wait = next == long.MaxValue ? 250u : (uint)Math.Max(0, Math.Min(250, Math.Ceiling(Ms(next - now))));
          Fine(next != long.MaxValue && wait < 40);
          N.MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, wait, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
          while (N.PeekMessageW(out m, IntPtr.Zero, 0, 0, PM_REMOVE)) {
            if (m.hwnd == IntPtr.Zero) {
              if (m.message == WM_ROW) TakeRow();
              continue;   // WM_WAKE / WM_STOP: the top of the loop reads the state
            }
            N.TranslateMessage(ref m); N.DispatchMessageW(ref m);
          }
        }
      } catch (Exception ex) {
        SetMode("failed", "the layer stopped (" + ex.GetType().Name + ": " + ex.Message + ")");
        Program.EmitLog("warn", "underpaint: the thread stopped: " + ex);
      } finally {
        Fine(false);
        Teardown();
        bool again;
        lock (_gate) {
          _active = false; _tid = 0; if (_thread == Thread.CurrentThread) _thread = null;
          // an on:true that came while this thread was on its way out found it alive and only woke it: start again
          again = _want && _thread == null && _mode != "failed";
        }
        if (_mode != "failed") SetMode("off", null);
        if (again) {
          lock (_gate) {
            if (_want && _thread == null) {
              _thread = new Thread(Run); _thread.IsBackground = true; _thread.Name = "underpaint"; _thread.Priority = ThreadPriority.Highest;
              _thread.Start();
            }
          }
        }
      }
    }

    static void Fine(bool on) {
      if (on == _fine) return;
      if (on) N.timeBeginPeriod(1); else N.timeEndPeriod(1);
      _fine = on;
    }

    /// Main's latest ask -> the layer. -> null | why it cannot run
    static string Apply() {
      IntPtr bar; int lx, ly, lw, lh, rx, ry, rw, n; bool vis, sim; double hz; byte[] wash;
      lock (_gate) {
        bar = _barAsk; lx = _lxA; ly = _lyA; lw = _lwA; lh = _lhA; rx = _rxA; ry = _ryA; rw = _rwA; n = _nA;
        vis = _visibleAsk; sim = _sim; hz = _hzA; wash = _washA;
      }
      bool rowMoved = n != _n || rx != _rx || ry != _ry || rw != _rw;
      _bar = bar; _lx = lx; _ly = ly; _lw = lw; _lh = lh; _rx = rx; _ry = ry; _rw = rw; _n = n; _visible = vis; _frameMs = 1000.0 / hz;
      _wash = wash;
      if (rowMoved) {
        _cap = null; _painted = null; _shownCols = null; _pred = null; _raise = null; _pendRec = null; _owner = new IntPtr[n]; _cov.Clear();
        FlushCache("the row under the bar moved");
      }
      if (_wnd == IntPtr.Zero) {
        string why = MakeWindow();
        if (why != null) return why;
        Hook();
      }
      ShellHook(sim);
      if (_bar != IntPtr.Zero && !N.IsWindow(_bar)) return "the top bar's window is gone";
      if (_bar != IntPtr.Zero) {
        Win32.RECT br;
        if (Win32.GetWindowRect(_bar, out br)) { _offX = _lx - br.left; _offY = _ly - br.top; }
        HookBar();
        _barHidden = !Win32.IsWindowVisible(_bar);
      } else { _offX = 0; _offY = 0; _barHidden = false; }
      if (!EnsureDib()) return "the layer's bitmap could not be made";
      Place();
      if (!sim) Cov(Q());
      if (!sim && _cap == null) _needRow = true;
      lock (_gate) _active = true;
      if (_painted != null) PaintNow(_painted, true);
      else if (_cap != null) PaintNow(_cap, true);
      return null;
    }

    static string MakeWindow() {
      IntPtr inst = N.GetModuleHandleW(IntPtr.Zero);
      if (_proc == null) {
        _proc = WndProcImpl;
        var wc = new N.WNDCLASSEX();
        wc.cbSize = (uint)Marshal.SizeOf(typeof(N.WNDCLASSEX));
        wc.lpfnWndProc = _proc; wc.hInstance = inst; wc.lpszClassName = ClassName;
        if (N.RegisterClassExW(ref wc) == 0) {
          int e = Marshal.GetLastWin32Error();
          if (e != 1410 /* already registered */) { _proc = null; return "the layer's window class could not be registered (error " + e + ")"; }
        }
      }
      _wnd = N.CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
        ClassName, "Mantle top bar colour", WS_POPUP, _lx, _ly, _lw, _lh, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
      if (_wnd == IntPtr.Zero) return "the layer's window could not be made (error " + Marshal.GetLastWin32Error() + ")";
      return null;
    }
    static IntPtr WndProcImpl(IntPtr h, uint m, IntPtr w, IntPtr l) {
      const uint WM_MOUSEACTIVATE = 0x21, WM_NCHITTEST = 0x84;
      if (m == WM_MOUSEACTIVATE) return new IntPtr(3);      // MA_NOACTIVATE
      if (m == WM_NCHITTEST) return new IntPtr(-1);         // HTTRANSPARENT
      if (m == _shellMsg && _shellMsg != 0) {
        try { if (!_sim && w.ToInt64() == HSHELL_FLASH) Flash(Win32.GetAncestor(l, 2 /* GA_ROOT */), Q()); }
        catch (Exception ex) { Program.EmitLog("warn", "underpaint: a shell message threw: " + ex.Message); }
        return IntPtr.Zero;
      }
      return N.DefWindowProcW(h, m, w, l);
    }
    /// HSHELL_FLASH reaches the layer's window: Windows fires EVENT_SYSTEM_FOREGROUND even for a refused
    /// SetForegroundWindow, and flashes the window's taskbar button with it (102 of 102 refusals measured).
    /// Every Apply: a layer can turn sim / live without being made again.
    static void ShellHook(bool sim) {
      if (sim) {
        if (_shellMsg != 0) N.DeregisterShellHookWindow(_wnd);
        _shellMsg = 0;
        lock (_gate) _shellHook = "off (a sim layer takes only injected events)";
        return;
      }
      if (_shellMsg != 0) return;
      string state;
      uint msg = N.RegisterWindowMessageW("SHELLHOOK");
      if (msg == 0) state = "off: the SHELLHOOK message could not be registered (error " + Marshal.GetLastWin32Error() + ")";
      else if (!N.RegisterShellHookWindow(_wnd)) state = "off: RegisterShellHookWindow failed (error " + Marshal.GetLastWin32Error() + ")";
      else { state = "on"; _shellMsg = msg; }
      if (state != "on") Program.EmitLog("warn", "underpaint: the shell hook is " + state + ", so a refused activation is caught only by the z-order check (the bar may show the wrong colour for " + RaiseCheckFrames + " frames)");
      lock (_gate) _shellHook = state;
    }

    static bool EnsureDib() {
      if (_dib != IntPtr.Zero && _dibW == _lw && _dibH == _lh) return true;
      FreeDib();
      IntPtr screen = N.GetDC(IntPtr.Zero);
      try {
        _memDC = N.CreateCompatibleDC(screen);
        var bi = new N.BMIH();
        bi.biSize = (uint)Marshal.SizeOf(typeof(N.BMIH)); bi.biWidth = _lw; bi.biHeight = -_lh; bi.biPlanes = 1; bi.biBitCount = 32;
        _dib = N.CreateDIBSection(screen, ref bi, 0, out _bits, IntPtr.Zero, 0);
        if (_dib == IntPtr.Zero || _memDC == IntPtr.Zero) { FreeDib(); return false; }
        _oldBmp = N.SelectObject(_memDC, _dib);
        _dibW = _lw; _dibH = _lh;
        _line = new int[_lw];
        return true;
      } finally { N.ReleaseDC(IntPtr.Zero, screen); }
    }
    static void FreeDib() {
      if (_memDC != IntPtr.Zero && _oldBmp != IntPtr.Zero) N.SelectObject(_memDC, _oldBmp);
      if (_dib != IntPtr.Zero) N.DeleteObject(_dib);
      if (_memDC != IntPtr.Zero) N.DeleteDC(_memDC);
      _dib = _memDC = _oldBmp = _bits = IntPtr.Zero; _dibW = _dibH = 0;
    }

    /// Follow the bar: its rect + the layer's offset in it, directly under it in the z-order; hidden with it.
    static void Place() {
      if (_wnd == IntPtr.Zero) return;
      int x = _lx, y = _ly;
      if (_bar != IntPtr.Zero) {
        Win32.RECT br;
        if (Win32.GetWindowRect(_bar, out br)) { x = br.left + _offX; y = br.top + _offY; _lx = x; _ly = y; }
      }
      bool show = !_barHidden && _painted != null;
      if (!show) {
        if (_shown) { N.ShowWindow(_wnd, 0 /* SW_HIDE */); _shown = false; }
      } else {
        Win32.SetWindowPos(_wnd, _bar != IntPtr.Zero ? _bar : HWND_TOPMOST, x, y, _lw, _lh,
          SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING);
        _shown = true;
      }
      bool zOk = _bar == IntPtr.Zero || N.GetWindow(_bar, 2 /* GW_HWNDNEXT */) == _wnd;
      string info = _wnd.ToInt64().ToString(CultureInfo.InvariantCulture) + " " + x + "," + y + " " + _lw + "x" + _lh +
        (_shown ? " shown" : " hidden") + (_visible ? "" : " (transparent: a test)") + (zOk ? " under the bar" : " NOT directly under the bar");
      lock (_gate) _layerInfo = info;
      bool native = _shown || (_barHidden && _painted != null);
      if (_painted != null) SetMode(native ? "native" : "off", native ? null : "waiting for the first row");
    }

    static void Teardown() {
      lock (_gate) _active = false;
      Unhook();
      if (_wnd != IntPtr.Zero) {
        if (_shellMsg != 0) N.DeregisterShellHookWindow(_wnd);
        N.DestroyWindow(_wnd); _wnd = IntPtr.Zero;
      }
      _shellMsg = 0;
      FreeDib();
      _shown = false; _painted = null; _shownCols = null; _cap = null; _pred = null; _raise = null; _pendRec = null; _watchH = IntPtr.Zero; _flashH = IntPtr.Zero; _bar = IntPtr.Zero;
      lock (_gate) { _layerInfo = null; _shellHook = "off"; }
    }

    // ------------------------------------------------------------------ painting
    /// cols (n*3) across the layer, bilinear between column centres like the page's scaled canvas.
    static bool PaintNow(byte[] cols, bool force) {
      if (_wnd == IntPtr.Zero || cols == null || cols.Length != _n * 3) return false;
      byte[] logical = cols, show = Fill(cols);
      if (!force && _painted != null && Same(_painted, cols) && Same(_shownCols, show)) return false;
      int n = _n, w = _lw;
      cols = show;   // the bitmap gets the filled columns; _painted keeps the logical ones (predictions compare those)
      for (int x = 0; x < w; x++) {
        double u = (x + 0.5) * n / w - 0.5;
        int i0 = (int)Math.Floor(u); double f = u - i0;
        if (i0 < 0) { i0 = 0; f = 0; }
        int i1 = i0 + 1;
        if (i1 >= n) { i1 = n - 1; if (i0 > n - 1) i0 = n - 1; }
        int a = i0 * 3, b = i1 * 3;
        int r = (int)(cols[a] + (cols[b] - cols[a]) * f + 0.5), g = (int)(cols[a + 1] + (cols[b + 1] - cols[a + 1]) * f + 0.5),
            bl = (int)(cols[a + 2] + (cols[b + 2] - cols[a + 2]) * f + 0.5);
        _line[x] = unchecked((int)0xFF000000) | (r << 16) | (g << 8) | bl;
      }
      for (int y = 0; y < _lh; y++) Marshal.Copy(_line, 0, new IntPtr(_bits.ToInt64() + (long)y * w * 4), w);
      var dst = new Win32.POINT(); dst.x = _lx; dst.y = _ly;
      var size = new N.SIZE(); size.cx = _lw; size.cy = _lh;
      var src = new Win32.POINT();
      var bf = new N.BLEND(); bf.Op = 0; bf.Flags = 0; bf.Alpha = (byte)(_visible ? 255 : 0); bf.Format = 1;
      bool ok = N.UpdateLayeredWindow(_wnd, IntPtr.Zero, ref dst, ref size, _memDC, ref src, 0, ref bf, 2 /* ULW_ALPHA */);
      _ulwQ = Q(); _ulwSeq++;
      bool first = _painted == null;
      _painted = (byte[])logical.Clone();
      _shownCols = show;
      lock (_gate) { _paints++; if (!ok) _ulwFails++; }
      if (first || !_shown) Place();
      return true;
    }

    /// What the layer really shows per column (lane zero-ship, from the page lane's measurement): a column with
    /// no window under it (the desktop: the page keeps its glass there) takes the colour of its NEAREST column
    /// that has one. The page's glass mask runs linearly from a covered column's centre to an uncovered one's,
    /// so between them the layer shows through part-way; painted with the desktop column's own colour there the
    /// layer blended toward it and the composite came out 16-18 levels off at every cover step (2 with this).
    /// No window anywhere (or the coverage not read yet): the columns as they are.
    static byte[] _shownCols;
    static byte[] Fill(byte[] cols) {
      IntPtr[] own = _owner;
      int n = _n;
      if (own == null || own.Length != n || cols.Length != n * 3) return cols;
      bool anyWin = false, anyDesk = false;
      for (int c = 0; c < n; c++) { if (own[c] != IntPtr.Zero) anyWin = true; else anyDesk = true; }
      if (!anyWin || !anyDesk) return cols;
      var left = new int[n];
      int last = -1;
      for (int c = 0; c < n; c++) { if (own[c] != IntPtr.Zero) last = c; left[c] = last; }
      var o = (byte[])cols.Clone();
      last = -1;
      for (int c = n - 1; c >= 0; c--) {
        if (own[c] != IntPtr.Zero) { last = c; continue; }
        int l = left[c], r = last;
        int src = l < 0 ? r : r < 0 ? l : (c - l <= r - c ? l : r);
        o[c * 3] = cols[src * 3]; o[c * 3 + 1] = cols[src * 3 + 1]; o[c * 3 + 2] = cols[src * 3 + 2];
      }
      return o;
    }

    static byte[] Compose() {
      byte[] baseCols = _cap ?? _painted;
      if (baseCols == null) return null;
      if (_pred == null || !_pred.Painted) return baseCols;
      var o = (byte[])baseCols.Clone();
      for (int c = 0; c < _n; c++) if (_pred.Mask[c]) { o[c * 3] = _pred.Cols[c * 3]; o[c * 3 + 1] = _pred.Cols[c * 3 + 1]; o[c * 3 + 2] = _pred.Cols[c * 3 + 2]; }
      return o;
    }

    // ------------------------------------------------------------------ the row (the truth)
    static void TakeRow() {
      byte[] cols; long q;
      lock (_gate) { cols = _slot; q = _slotQ; _slot = null; }
      if (cols == null || cols.Length != _n * 3) return;
      OnCapture(cols, q);
    }

    static void OnCapture(byte[] cols, long presentQ) {
      _cap = cols; _capQ = presentQ;
      if (_pred != null) {
        if (Agree(cols, _pred.Cols, _pred.Mask, AgreeLevels)) Confirm(presentQ);
        else if (_pred.Painted && presentQ < _pred.HoldQ) { lock (_gate) _held++; }
        else if (_pred.Painted) Correct("the screen disagreed after the hold");
      }
      byte[] o = Compose();
      bool predShown = _pred != null && _pred.Painted;
      if (o != null && PaintNow(o, false)) { lock (_gate) { if (predShown) _predPaints++; else _capPaints++; } }   // (PaintNow skips a row it shows already, filled the same)
      // a frame came: has the z-order caught up with a raised FOREGROUND? (after the paint: the frame's own paint
      // must not wait for a z-order walk)
      if (_raise != null) { long nq = Q(); RaiseCheck(nq, nq >= _raise.CheckQ); }
      if (_watchH != IntPtr.Zero) Watch(Q());
      // a frame before the settle time (or before a raise is checked) is kept and recorded then, if no newer
      // frame or event replaced it: a window that is still after its switch sends its only frame ~14 ms after
      // the event, so it was never cached (and its next switch had nothing to predict from)
      if (Settled(presentQ) && _raise == null) { _pendRec = null; Record(cols, presentQ); }
      else { _pendRec = cols; }
      HintSteady(cols, presentQ);
    }

    static bool Same(byte[] a, byte[] b) {
      if (a == null || b == null || a.Length != b.Length) return false;
      for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
      return true;
    }
    static bool Agree(byte[] a, byte[] b, bool[] mask, int lv) {
      for (int c = 0; c < mask.Length; c++) {
        if (!mask[c]) continue;
        int i = c * 3;
        if (Math.Abs(a[i] - b[i]) > lv || Math.Abs(a[i + 1] - b[i + 1]) > lv || Math.Abs(a[i + 2] - b[i + 2]) > lv) return false;
      }
      return true;
    }

    // ------------------------------------------------------------------ the windows under the row
    /// Re-read the windows under the row (a raised FOREGROUND still waiting for its check stays raised).
    static void Cov(long nowQ) { bool moved; Cov(nowQ, _raise != null ? _raise.H : IntPtr.Zero, out moved); }
    /// ...with `raised` (not Zero) where its activation is about to put it; moved = that changed the order.
    static void Cov(long nowQ, IntPtr raised, out bool moved) {
      List<Win> wins = _sim ? (_simWins ?? new List<Win>()) : Live();
      moved = false;
      if (raised != IntPtr.Zero) wins = Raised(wins, raised, out moved);
      Cover(wins, out _owner, out _cov);
      _covQ = nowQ;
    }
    /// The z-order an activation of h is about to make: h first among the non-topmost windows (a topmost h:
    /// first of all), with the windows of its owner group right under it in their order (Windows raises the
    /// owner and the windows it owns with it). Everything else keeps its order. h not in the list (minimised,
    /// hidden, a tool window, Mantle's own): the list as it is.
    static List<Win> Raised(List<Win> wins, IntPtr h, out bool moved) {
      moved = false;
      int at = -1;
      for (int i = 0; i < wins.Count; i++) if (wins[i].H == h) { at = i; break; }
      if (at < 0) return wins;
      IntPtr root = OwnerOf(wins[at]);
      var block = new List<Win>(); var rest = new List<Win>(wins.Count);
      block.Add(wins[at]);
      for (int i = 0; i < wins.Count; i++) {
        if (i == at) continue;
        if (OwnerOf(wins[i]) == root) block.Add(wins[i]); else rest.Add(wins[i]);
      }
      int ins = 0;
      if (!wins[at].Top) while (ins < rest.Count && rest[ins].Top) ins++;
      var o = new List<Win>(wins.Count);
      for (int i = 0; i < ins; i++) o.Add(rest[i]);
      o.AddRange(block);
      for (int i = ins; i < rest.Count; i++) o.Add(rest[i]);
      for (int i = 0; i < o.Count; i++) if (o[i].H != wins[i].H) { moved = true; break; }
      return o;
    }
    static IntPtr OwnerOf(Win w) {
      if (w.Owner == IntPtr.Zero) {
        IntPtr r = _sim ? IntPtr.Zero : Win32.GetAncestor(w.H, Win32.GA_ROOTOWNER);
        w.Owner = r != IntPtr.Zero ? r : w.H;
      }
      return w.Owner;
    }
    static void Cover(List<Win> wins, out IntPtr[] ownerOut, out Dictionary<IntPtr, Win> covOut) {
      var owner = new IntPtr[_n];
      var cov = new Dictionary<IntPtr, Win>();
      int left = _n;
      foreach (Win w in wins) {
        if (left == 0) break;
        if (!(w.T <= _ry && w.B > _ry)) continue;
        bool any = false;
        for (int c = 0; c < _n; c++) {
          if (owner[c] != IntPtr.Zero) continue;
          double xc = _rx + (c + 0.5) * _rw / _n;
          if (xc >= w.L && xc < w.R) { owner[c] = w.H; left--; any = true; }
        }
        if (any) cov[w.H] = w;
      }
      ownerOut = owner; covOut = cov;
    }

    /// Top of the z-order first, up to the desktop; only what WidgetCover counts as a window.
    static List<Win> Live() {
      var o = new List<Win>();
      int own = Program.OwnPid, parent = Program.ParentPid;
      foreach (WidgetCover.Win w in WidgetCover.LiveList()) {
        if (w.Desktop) break;
        if (WidgetCover.Ignored(w, own, parent) != null) continue;
        long h; long.TryParse(w.Hwnd, NumberStyles.Integer, CultureInfo.InvariantCulture, out h);
        var x = new Win(); x.H = new IntPtr(h); x.Title = w.Title ?? ""; x.L = w.L; x.T = w.T; x.R = w.R; x.B = w.B; x.Pid = w.Pid;
        x.Top = (w.ExStyle & WS_EX_TOPMOST) != 0;
        o.Add(x);
      }
      return o;
    }
    static bool ReadWin(IntPtr h, out Win w) {
      w = null;
      if (_sim) {
        if (_simWins != null) foreach (Win s in _simWins) if (s.H == h) { w = s; return true; }
        return false;
      }
      if (!N.IsWindow(h) || !Win32.IsWindowVisible(h) || Win32.IsIconic(h)) return false;
      Win32.RECT r;
      if (N.DwmGetWindowAttribute(h, 9 /* EXTENDED_FRAME_BOUNDS */, out r, Marshal.SizeOf(typeof(Win32.RECT))) != 0 && !Win32.GetWindowRect(h, out r)) return false;
      w = new Win(); w.H = h; w.L = r.left; w.T = r.top; w.R = r.right; w.B = r.bottom; w.Title = Win32.GetWindowText(h) ?? "";
      return true;
    }

    // ------------------------------------------------------------------ the cache
    static string KeyOf(IntPtr h, string title) { return h.ToInt64().ToString(CultureInfo.InvariantCulture) + "\n" + (title ?? ""); }

    static bool Settled(long presentQ) { return presentQ >= _settleQ; }

    /// A row duplication read: remember each window's columns, when nothing just changed.
    static void Record(byte[] cols, long presentQ) {
      if (!Settled(presentQ) || _owner.Length != _n) return;
      // a raised coverage is a guess until the z-order agrees: a refused raise would file the old window's
      // pixels under the window that never came forward
      if (_raise != null) return;
      // the windows the snapshot says are under the row: still there, same place, same title?
      foreach (Win w in _cov.Values) {
        Win now;
        if (!ReadWin(w.H, out now) || now.L != w.L || now.T != w.T || now.R != w.R || now.B != w.B || now.Title != w.Title) {
          Cov(Q()); _settleQ = Q() + Dq(SettleFrames * _frameMs);
          return;
        }
      }
      // after a title change: that window's entry waits for its repaint (or TitleWaitMs)
      if (_titleWaitH != IntPtr.Zero) {
        bool repainted = _titleWaitCols != null && !AgreeOwned(cols, _titleWaitCols, _titleWaitH, 0);
        if (repainted || presentQ >= _titleWaitUntilQ) _titleWaitH = IntPtr.Zero;
      }
      var seen = new HashSet<IntPtr>();
      for (int c = 0; c < _n; c++) {
        IntPtr h = _owner[c];
        if (seen.Contains(h)) continue;
        seen.Add(h);
        if (h != IntPtr.Zero && h == _titleWaitH) continue;
        Win w = null;
        if (h != IntPtr.Zero && !_cov.TryGetValue(h, out w)) continue;
        string key = h == IntPtr.Zero ? "desktop" : KeyOf(h, w.Title);
        var mask = new bool[_n];
        for (int k = 0; k < _n; k++) mask[k] = _owner[k] == h;
        Entry e;
        if (!_cache.TryGetValue(key, out e)) {
          e = new Entry(); e.Key = key; e.H = h; e.Title = w != null ? w.Title : "";
          e.Node = _lru.AddFirst(e); _cache[key] = e;
          while (_cache.Count > CacheMax) { Entry old = _lru.Last.Value; _lru.RemoveLast(); _cache.Remove(old.Key); }
        } else { _lru.Remove(e.Node); _lru.AddFirst(e.Node); }
        int nl, nt, nr, nb;
        if (w != null) { nl = w.L; nt = w.T; nr = w.R; nb = w.B; } else { nl = _rx; nt = _ry; nr = _rx + _rw; nb = _ry + 1; }
        // the same window at the same place, now partly covered: keep the columns seen before where it is covered
        // now (they used to be replaced, so switching back to it predicted only the part last seen)
        if (e.Cols != null && e.Mask != null && e.Mask.Length == _n && e.L == nl && e.T == nt && e.R == nr && e.B == nb) {
          var mc = (byte[])e.Cols.Clone(); var mm = (bool[])e.Mask.Clone();
          for (int k = 0; k < _n; k++) if (mask[k]) { mc[k * 3] = cols[k * 3]; mc[k * 3 + 1] = cols[k * 3 + 1]; mc[k * 3 + 2] = cols[k * 3 + 2]; mm[k] = true; }
          e.Cols = mc; e.Mask = mm;
        } else { e.Cols = (byte[])cols.Clone(); e.Mask = mask; }
        e.L = nl; e.T = nt; e.R = nr; e.B = nb;
        lock (_gate) _records++;
      }
      lock (_gate) _cacheCount = _cache.Count;
    }
    static bool AgreeOwned(byte[] a, byte[] b, IntPtr h, int lv) {
      var m = new bool[_n];
      for (int c = 0; c < _n; c++) m[c] = _owner[c] == h;
      return Agree(a, b, m, lv);
    }

    static void FlushCache(string why) {
      _cache.Clear(); _lru.Clear();
      lock (_gate) _cacheCount = 0;
    }
    static void DropWindow(IntPtr h) {
      var gone = new List<string>();
      foreach (var kv in _cache) if (kv.Value.H == h && h != IntPtr.Zero) gone.Add(kv.Key);
      foreach (string k in gone) { _lru.Remove(_cache[k].Node); _cache.Remove(k); }
      lock (_gate) _cacheCount = _cache.Count;
    }

    /// The cached colour of column c for window w (at its rect now), or false. A window that only moved
    /// sideways keeps its entry, shifted; resized or moved up/down = dropped.
    static bool FromCache(Win w, IntPtr h, int c, byte[] o, List<string> keys) {
      string key = h == IntPtr.Zero ? "desktop" : KeyOf(h, w.Title);
      Entry e;
      if (!_cache.TryGetValue(key, out e)) return false;
      int src = c;
      if (h != IntPtr.Zero) {
        if (e.T != w.T || e.B != w.B || (e.R - e.L) != (w.R - w.L)) { _lru.Remove(e.Node); _cache.Remove(key); lock (_gate) { _cacheCount = _cache.Count; _cacheDrop++; } return false; }
        int dx = w.L - e.L;
        if (dx != 0) {
          double xc = _rx + (c + 0.5) * _rw / _n - dx;
          src = (int)Math.Floor((xc - _rx) * _n / _rw);
          if (src < 0 || src >= _n) return false;
        }
      }
      if (!e.Mask[src]) return false;
      o[c * 3] = e.Cols[src * 3]; o[c * 3 + 1] = e.Cols[src * 3 + 1]; o[c * 3 + 2] = e.Cols[src * 3 + 2];
      if (!keys.Contains(key)) keys.Add(key);
      return true;
    }

    // ------------------------------------------------------------------ hints
    static string ParseHint(Dictionary<string, object> t, string app, out HintRec rec) {
      rec = new HintRec(); rec.App = app;
      string kind = Json.GetString(t, "kind") ?? "";
      rec.Kind = kind;
      if (kind == "none") return null;
      if (kind == "flat" || kind == "wash") {
        object rgb; t.TryGetValue("rgb", out rgb);
        var l = rgb as List<object>;
        if (l == null || l.Count != 3) return "rgb must be [r, g, b]";
        for (int i = 0; i < 3; i++) if (!(l[i] is double) || (double)l[i] < 0 || (double)l[i] > 255) return "rgb must be 0..255";
        rec.R = (byte)Math.Round((double)l[0]); rec.G = (byte)Math.Round((double)l[1]); rec.B = (byte)Math.Round((double)l[2]);
        if (kind == "wash") {
          object a; t.TryGetValue("alpha", out a);
          if (!(a is double) || (double)a < 0 || (double)a > 1) return "alpha must be 0..1";
          rec.Alpha = (double)a;
        }
        return null;
      }
      if (kind == "cols") {
        object cs; t.TryGetValue("cols", out cs);
        var l = cs as List<object>;
        if (l == null || l.Count < 3 || l.Count % 3 != 0 || l.Count > 4096 * 3) return "cols must be a flat list of r, g, b";
        rec.Cols = new byte[l.Count];
        for (int i = 0; i < l.Count; i++) {
          if (!(l[i] is double) || (double)l[i] < 0 || (double)l[i] > 255) return "cols must be 0..255";
          rec.Cols[i] = (byte)Math.Round((double)l[i]);
        }
        return null;
      }
      return "kind must be flat, cols, wash or none";
    }

    /// The hint's colour for column c of window w, or false (no hint, untrusted, not lined up, unknown).
    static bool FromHint(Win w, IntPtr h, int c, byte[] o, out string app) {
      app = null;
      HintRec hr;
      if (h == IntPtr.Zero || !_hints.TryGetValue(h, out hr) || hr.Kind == "none") return false;
      app = hr.App;
      if (_distrust.Contains(hr.App)) return false;
      if (Math.Abs(w.T - _ry) > 1) return false;   // the hint is the window's TOP row: only when that is the row under the bar
      int i = c * 3;
      if (hr.Kind == "flat") { o[i] = hr.R; o[i + 1] = hr.G; o[i + 2] = hr.B; return true; }
      if (hr.Kind == "wash") {
        if (_wash == null) return false;
        double a = hr.Alpha;
        o[i] = (byte)Math.Round(_wash[i] * (1 - a) + hr.R * a); o[i + 1] = (byte)Math.Round(_wash[i + 1] * (1 - a) + hr.G * a);
        o[i + 2] = (byte)Math.Round(_wash[i + 2] * (1 - a) + hr.B * a);
        return true;
      }
      if (hr.Kind == "cols") {
        int k = hr.Cols.Length / 3, ww = w.R - w.L;
        if (ww <= 0) return false;
        double xc = _rx + (c + 0.5) * _rw / _n;
        int j = (int)Math.Floor((xc - w.L) * k / ww);
        if (j < 0 || j >= k) return false;
        o[i] = hr.Cols[j * 3]; o[i + 1] = hr.Cols[j * 3 + 1]; o[i + 2] = hr.Cols[j * 3 + 2];
        return true;
      }
      return false;
    }

    /// Steady state: a hinted window under the row whose capture disagrees with its hint for more than 3
    /// frames (after the hint's own landing time) = a mismatch, said to main once per app; agreeing again = ok.
    static void HintSteady(byte[] cols, long presentQ) {
      if (!Settled(presentQ)) return;
      foreach (var kv in _hints) {
        IntPtr h = kv.Key; HintRec hr = kv.Value;
        Win w;
        if (hr.Kind == "none" || !_cov.TryGetValue(h, out w) || Math.Abs(w.T - _ry) > 1) { _hintBadFromQ.Remove(h); continue; }
        var o = new byte[_n * 3]; var m = new bool[_n]; bool any = false;
        string app;
        bool was = _distrust.Remove(hr.App);
        for (int c = 0; c < _n; c++) if (_owner[c] == h && FromHint(w, h, c, o, out app)) { m[c] = true; any = true; }
        if (was) _distrust.Add(hr.App);
        if (!any) continue;
        if (Agree(cols, o, m, AgreeLevels)) {
          _hintBadFromQ.Remove(h);
          HintOk(hr.App);
          continue;
        }
        long from;
        if (!_hintBadFromQ.TryGetValue(h, out from)) { from = Math.Max(presentQ, hr.AtQ + Dq(LearnedMs("hint:" + hr.App, 34))); _hintBadFromQ[h] = from; }
        if (presentQ - from > Dq(3 * _frameMs)) HintBad(hr.App, h, cols, o, m);
      }
    }
    static void HintOk(string app) {
      _appBad[app] = 0;
      if (_distrust.Remove(app)) Features.Event("underrow", Json.Obj("kind", "hint", "app", app, "ok", true));
    }
    static void HintBad(string app, IntPtr h, byte[] cap, byte[] hint, bool[] m) {
      int worst = 0, at = -1;
      for (int c = 0; c < _n; c++) {
        if (!m[c]) continue;
        int i = c * 3;
        int d = Math.Max(Math.Abs(cap[i] - hint[i]), Math.Max(Math.Abs(cap[i + 1] - hint[i + 1]), Math.Abs(cap[i + 2] - hint[i + 2])));
        if (d > worst) { worst = d; at = c; }
      }
      int n; _appBad.TryGetValue(app, out n); _appBad[app] = n + 1;
      if (_distrust.Contains(app)) return;
      _distrust.Add(app);
      _hintBadFromQ.Remove(h);
      string why = "its hint differs from the screen by " + worst + " levels at column " + at +
        (at >= 0 ? " (hint " + hint[at * 3] + "," + hint[at * 3 + 1] + "," + hint[at * 3 + 2] + ", screen " + cap[at * 3] + "," + cap[at * 3 + 1] + "," + cap[at * 3 + 2] + ")" : "");
      Features.Event("underrow", Json.Obj("kind", "hint", "app", app, "ok", false, "hwnd", h.ToInt64().ToString(CultureInfo.InvariantCulture), "why", why, "levels", worst));
    }

    // ------------------------------------------------------------------ predictions
    static double LearnedMs(string key, double dflt) {
      List<double> l;
      if (!_learn.TryGetValue(key, out l) || l.Count < 3) return dflt;
      var s = new List<double>(l); s.Sort();
      return s[s.Count / 2];
    }
    static void Learn(string key, double ms) {
      List<double> l;
      if (!_learn.TryGetValue(key, out l)) { l = new List<double>(); _learn[key] = l; }
      l.Add(Math.Max(0, Math.Min(300, ms)));
      if (l.Count > LearnN) l.RemoveAt(0);
    }

    /// Build a prediction for the columns `only` says (null = every column whose window or title changed).
    static void Predict(string kind, long evQ, IntPtr[] prevOwner, Dictionary<IntPtr, Win> prevCov, IntPtr only, string learnKey) {
      if (_n == 0 || _owner.Length != _n) { _predWhy = "the layer has no row yet"; return; }
      var o = new byte[_n * 3]; var m = new bool[_n];
      var p = new Pred(); p.Kind = kind; p.EvQ = evQ; p.LearnKey = learnKey;
      bool any = false, differs = false, changed = false;
      for (int c = 0; c < _n; c++) {
        IntPtr h = _owner[c];
        if (only != IntPtr.Zero) { if (h != only) continue; }
        else if (prevOwner != null && prevOwner.Length == _n && prevOwner[c] == h) {
          Win a, b;
          // same window, same title AND same rect: a window that moved or resized shows its columns shifted (or
          // not at all) where it still covers, so those columns are predicted too (and a stale entry dropped)
          bool same = h == IntPtr.Zero || (prevCov.TryGetValue(h, out a) && _cov.TryGetValue(h, out b) && a.Title == b.Title &&
                                           a.L == b.L && a.T == b.T && a.R == b.R && a.B == b.B);
          if (same) continue;
        }
        changed = true;
        Win w = null;
        if (h != IntPtr.Zero && !_cov.TryGetValue(h, out w)) continue;
        string app;
        if (h != IntPtr.Zero && FromHint(w, h, c, o, out app)) { m[c] = true; p.FromHint = true; p.App = app; any = true; }
        else if (FromCache(w, h, c, o, p.Keys)) { m[c] = true; p.FromCache = true; any = true; }
        else continue;
        byte[] cur = _painted ?? _cap;
        int i = c * 3;
        if (cur == null || Math.Abs(cur[i] - o[i]) > 3 || Math.Abs(cur[i + 1] - o[i + 1]) > 3 || Math.Abs(cur[i + 2] - o[i + 2]) > 3) differs = true;
      }
      if (!_fastRecount) {   // (after a fast paint the lookup was counted by FastPaint)
        lock (_gate) { if (any) { if (p.FromHint) _hintUsed++; if (p.FromCache) _cacheHits++; } else _cacheMiss++; }
        if (any && !differs) { lock (_gate) _predSame++; }   // known, and already what the layer shows
      }
      if (!any || !differs) { _predWhy = !changed ? "nothing changed under the row" : !any ? "not in the cache" : "already shown"; return; }
      _predWhy = "painted";
      // a newer event replaces an unconfirmed prediction (not a correction: nothing disagreed with it yet)
      p.Cols = o; p.Mask = m;
      Count(_predBy, kind + (p.FromHint ? ":hint" : ":cache"));
      if (kind == "title" || kind == "hint") {
        double d = LearnedMs(learnKey, kind == "hint" ? 34 : 50);
        p.DueQ = evQ + Dq(Math.Max(0, d - LeadMs));
        _pred = p;
        if (Q() >= p.DueQ) Land();
      } else {
        p.DueQ = evQ;
        _pred = p;
        Land();
      }
    }
    static void Land() {
      if (_pred == null || _pred.Painted) return;
      _pred.Painted = true;
      double hold = _pred.Kind == "anim" ? AnimHoldMs : HoldFrames * _frameMs;
      _pred.HoldQ = Q() + Dq(hold);
      byte[] o = Compose();
      if (o != null && PaintNow(o, false)) { lock (_gate) _predPaints++; }
    }
    static void Confirm(long presentQ) {
      Pred p = _pred; _pred = null;
      double lag = Ms(presentQ - p.EvQ);
      if (p.LearnKey != null) Learn(p.LearnKey, lag);
      lock (_gate) {
        _confirmed++;
        _predLags.Add(Math.Round(lag, 1)); if (_predLags.Count > 50) _predLags.RemoveAt(0);
      }
      if (p.FromHint && p.App != null) HintOk(p.App);
    }
    static void Correct(string why) {
      Pred p = _pred; _pred = null;
      if (p == null || !p.Painted) return;
      lock (_gate) { _corrected++; Count(_corrBy, p.Kind + (p.FromHint ? ":hint" : ":cache")); }
      // a stale entry is dropped, so it is not used again before a fresh read replaces it
      foreach (string k in p.Keys) { Entry e; if (_cache.TryGetValue(k, out e)) { _lru.Remove(e.Node); _cache.Remove(k); } }
      lock (_gate) _cacheCount = _cache.Count;
      byte[] o = Compose();
      if (o != null) PaintNow(o, false);
    }

    static long NextWakeQ(long now) {
      long next = long.MaxValue;
      if (_pred != null) next = _pred.Painted ? _pred.HoldQ : _pred.DueQ;
      if (_raise != null && _raise.CheckQ < next) next = _raise.CheckQ;
      if (_pendRec != null && _raise == null && _settleQ < next) next = _settleQ;
      return next;
    }
    static long _zCheckQ;
    static void Timers() {
      long now = Q();
      if (_wnd != IntPtr.Zero && _shown && _bar != IntPtr.Zero && now - _zCheckQ > Dq(1000)) {
        _zCheckQ = now;
        if (N.GetWindow(_bar, 2 /* GW_HWNDNEXT */) != _wnd) Place();
      }
      if (_raise != null && now >= _raise.CheckQ) RaiseCheck(now, true);
      if (_pendRec != null && _raise == null && now >= _settleQ) { byte[] c = _pendRec; _pendRec = null; if (c.Length == _n * 3) Record(c, now); }
      if (_pred == null) return;
      if (!_pred.Painted && now >= _pred.DueQ) Land();
      else if (_pred.Painted && now >= _pred.HoldQ) {
        // the hold ran out: did the screen ever show it? (a capture that agreed would have confirmed it)
        if (_cap != null && Agree(_cap, _pred.Cols, _pred.Mask, AgreeLevels)) Confirm(_capQ);
        else Correct("no frame showed it within the hold");
      }
    }

    // ------------------------------------------------------------------ events
    static void Hook() {
      _evProc = OnEvent;
      const uint OUT = 0x0 /* OUTOFCONTEXT */ | 0x2 /* SKIPOWNPROCESS */;
      _hooks.Add(N.SetWinEventHook(Win32.EVENT_SYSTEM_FOREGROUND, Win32.EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _evProc, 0, 0, OUT));
      _hooks.Add(N.SetWinEventHook(0x000B /* MOVESIZEEND */, 0x000B, IntPtr.Zero, _evProc, 0, 0, OUT));
      _hooks.Add(N.SetWinEventHook(Win32.EVENT_SYSTEM_MINIMIZESTART, Win32.EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, _evProc, 0, 0, OUT));
      _hooks.Add(N.SetWinEventHook(Win32.EVENT_OBJECT_DESTROY, Win32.EVENT_OBJECT_HIDE, IntPtr.Zero, _evProc, 0, 0, OUT));
      _hooks.Add(N.SetWinEventHook(Win32.EVENT_OBJECT_NAMECHANGE, Win32.EVENT_OBJECT_NAMECHANGE, IntPtr.Zero, _evProc, 0, 0, OUT));
    }
    static void HookBar() {
      int pid = 0;
      if (_bar != IntPtr.Zero) Win32.GetWindowThreadProcessId(_bar, out pid);
      if (pid == _hookedBarPid && (_barHook != IntPtr.Zero || pid == 0)) return;
      if (_barHook != IntPtr.Zero) { N.UnhookWinEvent(_barHook); _barHook = IntPtr.Zero; }
      _hookedBarPid = pid;
      if (pid != 0) _barHook = N.SetWinEventHook(Win32.EVENT_OBJECT_LOCATIONCHANGE, Win32.EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, _evProc, (uint)pid, 0, 0);
    }
    static void Unhook() {
      foreach (IntPtr h in _hooks) if (h != IntPtr.Zero) N.UnhookWinEvent(h);
      _hooks.Clear();
      if (_barHook != IntPtr.Zero) { N.UnhookWinEvent(_barHook); _barHook = IntPtr.Zero; }
      _hookedBarPid = 0;
    }

    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      try {
        if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero || _wnd == IntPtr.Zero) return;
        if (hwnd == _bar && _bar != IntPtr.Zero) {
          if (ev == Win32.EVENT_OBJECT_LOCATIONCHANGE) Place();
          else if (ev == Win32.EVENT_OBJECT_HIDE) { _barHidden = true; Place(); }
          else if (ev == Win32.EVENT_OBJECT_SHOW) { _barHidden = false; Place(); }
          return;
        }
        if (_sim) return;   // a sim layer takes only its injected events
        if (ev == Win32.EVENT_OBJECT_LOCATIONCHANGE) return;
        if (ev == Win32.EVENT_OBJECT_NAMECHANGE) { if (_cov.ContainsKey(hwnd)) Title(hwnd, Q()); return; }
        if ((ev == Win32.EVENT_OBJECT_DESTROY || ev == Win32.EVENT_OBJECT_HIDE) && !_cov.ContainsKey(hwnd)) {
          if (ev == Win32.EVENT_OBJECT_DESTROY) { DropWindow(hwnd); _hints.Remove(hwnd); }
          return;
        }
        if (ev == Win32.EVENT_OBJECT_SHOW && Win32.GetAncestor(hwnd, 2 /* GA_ROOT */) != hwnd) return;
        if (ev == Win32.EVENT_SYSTEM_FOREGROUND) {
          IntPtr root = Win32.GetAncestor(hwnd, 2 /* GA_ROOT */);
          Foreground(root != IntPtr.Zero ? root : hwnd, Q());
          return;
        }
        string kind = ev == 0x000B ? "switch" : "anim";
        Switch(kind, Q());
        if (ev == Win32.EVENT_OBJECT_DESTROY) DropWindow(hwnd);
      } catch (Exception ex) {
        Program.EmitLog("warn", "underpaint: an event threw: " + ex.Message);
      }
    }

    /// Which window is under the row may have changed: re-read it and paint the new parts from what is known.
    static void Switch(string kind, long evQ) {
      lock (_gate) _events++;
      _pendRec = null;   // a frame from before this event is not what it leaves on screen
      var prevOwner = _owner; var prevCov = _cov;
      Cov(evQ);
      _settleQ = Math.Max(_settleQ, evQ + Dq(kind == "anim" ? AnimHoldMs : SettleFrames * _frameMs));
      Predict(kind, evQ, prevOwner, prevCov, IntPtr.Zero, null);
    }

    /// EVENT_SYSTEM_FOREGROUND for h (a root window). It arrives 14-20 ms before h's first frame but before
    /// Windows moves h up the z-order, so the coverage is read with h raised (Raised) and the cached colour is
    /// painted now, on the switch frame. The real z-order then has to agree (RaiseCheck, Flash).
    static void Foreground(IntPtr h, long evQ) {
      if (h == IntPtr.Zero) { Switch("switch", evQ); return; }
      lock (_gate) { _events++; _fgEvents++; }
      _raise = null; _pendRec = null; _watchH = IntPtr.Zero;   // a newer activation: the coverage is re-read below with this one raised instead
      if (h == _flashH && evQ - _flashQ <= Dq(FlashSkipMs) && FgRoot() != h) {
        // a refused SetForegroundWindow: its taskbar button flashed just now and it is not the foreground.
        // Nothing is predicted (this used to flash its colour on the bar for 67-83 ms, the old window still there)
        _flashH = IntPtr.Zero;
        lock (_gate) _raiseFlashSkip++;
        // when Windows grants it later (an attach-input retry, a click), no new FOREGROUND comes (measured: one
        // event per refused-then-granted switch), so the frames watch for it (Watch)
        _watchH = h; _watchUntilQ = evQ + Dq(WatchMs);
        Cov(evQ);
        _settleQ = Math.Max(_settleQ, evQ + Dq(SettleFrames * _frameMs));
        FgDone(h, evQ, 0, "refused (taskbar flash)");
        return;
      }
      var prevOwner = _owner; var prevCov = _cov;
      Pred before = _pred;
      long seq0 = _ulwSeq, paintQ = 0;
      Pred fast = FastPaint(h, evQ);
      if (_ulwSeq != seq0) paintQ = _ulwQ;
      bool moved;
      Cov(evQ, h, out moved);
      _settleQ = Math.Max(_settleQ, evQ + Dq(SettleFrames * _frameMs));
      long seq1 = _ulwSeq;
      _predWhy = null; _fastRecount = fast != null;
      try { Predict("switch", evQ, prevOwner, prevCov, IntPtr.Zero, null); } finally { _fastRecount = false; }
      if (paintQ == 0 && _ulwSeq != seq1) paintQ = _ulwQ;
      string fastHow = fast != null ? FastCheck(fast, h) : null;
      bool painted = _pred != null && _pred != before && _pred.Painted;
      lock (_gate) { if (moved) _raiseMoved++; if (painted) _raisePred++; Keep(_fgFullMs, Ms(Q() - evQ)); }
      string how = fastHow != null ? fastHow : paintQ != 0 ? "full" : !_cov.ContainsKey(h) ? "not on the row" : (_predWhy ?? "no prediction");
      FgDone(h, evQ, paintQ, how);
      if (!moved && !painted) return;   // already on top and nothing painted: there is nothing to take back
      var r = new Raise(); r.H = h; r.EvQ = evQ; r.P = painted ? _pred : null;
      r.CheckQ = evQ + Dq(Math.Max(RaiseCheckFrames * _frameMs, RaiseCheckMinMs));
      _raise = r;
    }
    /// The FOREGROUND event's timing for View / Peek: when it painted (0 = it did not), and how or why not.
    static void FgDone(IntPtr h, long evQ, long paintQ, string how) {
      lock (_gate) {
        if (paintQ != 0) Keep(_fgPaintMs, Ms(paintQ - evQ)); else Count(_fgNoPaintBy, how);
        _fgRecent.Enqueue(h.ToInt64().ToString(CultureInfo.InvariantCulture) + " " + Ms(evQ).ToString("F3", CultureInfo.InvariantCulture) + " " +
          (paintQ != 0 ? Ms(paintQ).ToString("F3", CultureInfo.InvariantCulture) : "0") + " " + how.Replace(' ', '_'));
        while (_fgRecent.Count > FgKeep) _fgRecent.Dequeue();
      }
    }

    /// THE FAST PATH (lane wk-underpaint, 2026-10-14). The full pass walks every top-level window (Live) before it
    /// predicts: measured on Owen's PC (m3.js A/B, passive sidecar, plain switches) event -> paint 5.7-7.0 ms p50,
    /// 7.3-10 ms p95, 30/35 on the switch frame. With this path 1.7-2.3 ms p50 (colours ready ~0.3 ms, the
    /// UpdateLayeredWindow itself ~0.9 ms) and 45/47 on the frame, none early, no wrong colour.
    /// On screen (wk-refresh-floor) a paint 0.5-1 ms after the event lands on the switch frame
    /// 96% of the time, at once 90% (the rest a frame EARLY: the z-order has not moved yet), from 2 ms on later
    /// and later. So when h's own cache entry covers the row at its rect now, its columns are painted here,
    /// without the walk: only where the row's window now is NOT h, not topmost and not of h's owner group, and
    /// only once the real z-order shows h above those windows (polled; never sooner than FastMinMs after the
    /// event or FastAfterZMs after the z-order moved, the composition lag of a z-order change). A z-order that
    /// has not moved by FastWaitMaxMs (a refused or slow activation) = no fast paint: a refused activation still
    /// never shows its colour. The full pass then runs as before and confirms or corrects it (FastCheck).
    static Pred FastPaint(IntPtr h, long evQ) {
      if (!_fastOn) return null;
      if (_n == 0 || _owner.Length != _n) { FastSkip("the layer has no row yet"); return null; }
      Win w;
      if (!ReadWin(h, out w)) { FastSkip("not a visible window"); return null; }
      if (!(w.T <= _ry && w.B > _ry)) { FastSkip("not on the row"); return null; }
      IntPtr group = OwnerOf(w);
      var o = new byte[_n * 3]; var m = new bool[_n];
      var p = new Pred(); p.Kind = "switch"; p.EvQ = evQ; p.DueQ = evQ;
      var over = new List<IntPtr>();   // the windows h has to come above
      bool any = false, differs = false, unknown = false;
      byte[] cur = _painted ?? _cap;
      for (int c = 0; c < _n; c++) {
        double xc = _rx + (c + 0.5) * _rw / _n;
        if (!(xc >= w.L && xc < w.R)) continue;
        IntPtr x = _owner[c];
        // h there already, or the desktop (h was not on the row: minimised, restoring, another desktop) = the full pass
        if (x == h || x == IntPtr.Zero) continue;
        Win xw;
        if (!_cov.TryGetValue(x, out xw) || xw.Top || OwnerOf(xw) == group) continue;   // stays over h
        if (!over.Contains(x)) over.Add(x);
        string app;   // the same order as Predict: the app's own hint, then the cache
        if (FromHint(w, h, c, o, out app)) { p.FromHint = true; p.App = app; }
        else if (FromCache(w, h, c, o, p.Keys)) p.FromCache = true;
        else { unknown = true; continue; }
        m[c] = true; any = true;
        int i = c * 3;
        if (cur == null || Math.Abs(cur[i] - o[i]) > 3 || Math.Abs(cur[i + 1] - o[i + 1]) > 3 || Math.Abs(cur[i + 2] - o[i + 2]) > 3) differs = true;
      }
      if (!any) { FastSkip(unknown ? "not in the cache" : "nothing changes under the row"); return null; }
      if (!differs) { FastSkip("already shown"); return null; }
      long readyQ = Q(), minQ = evQ + Dq(FastMinMs), maxQ = evQ + Dq(FastWaitMaxMs), zQ = 0;
      bool zFirst = false;
      for (int k = 0; ; k++) {
        long now = Q();
        if (zQ == 0 && AboveAll(h, over)) { zQ = now; zFirst = k == 0; }
        if (zQ != 0 && now >= minQ && now >= zQ + Dq(FastAfterZMs)) break;
        if (zQ == 0 && now >= maxQ) { FastSkip("the z-order did not move within " + FastWaitMaxMs + " ms"); return null; }
        Thread.SpinWait(20);
      }
      p.Cols = o; p.Mask = m;
      // counted like the full pass's own prediction (which then counts nothing again: _fastRecount)
      Count(_predBy, "switch" + (p.FromHint ? ":hint" : ":cache"));
      lock (_gate) { if (p.FromHint) _hintUsed++; if (p.FromCache) _cacheHits++; }
      _pred = p;
      long landQ = Q();
      Land();
      long doneQ = Q();
      lock (_gate) {
        _fastPaints++; if (zFirst) _fastZAtOnce++;
        Keep(_fastReadyMs, Ms(readyQ - evQ)); Keep(_fastZMs, Ms(zQ - evQ)); Keep(_fastLandMs, Ms(doneQ - landQ));
      }
      return p;
    }
    static void FastSkip(string why) { lock (_gate) Count(_fastSkipBy, why); }
    /// Is h above every window in xs in the real z-order now (sim: the sim list's order)?
    static bool AboveAll(IntPtr h, List<IntPtr> xs) {
      if (_sim) {
        var l = _simWins; if (l == null) return false;
        int ih = -1;
        for (int i = 0; i < l.Count; i++) if (l[i].H == h) { ih = i; break; }
        if (ih < 0) return false;
        foreach (IntPtr x in xs) for (int i = 0; i < ih; i++) if (l[i].H == x) return false;
        return true;
      }
      foreach (IntPtr x in xs) {
        // up from x (it is near the top: it had the row): h is above it once Windows moved it
        IntPtr u = x; bool found = false;
        for (int k = 0; k < 4096; k++) { u = N.GetWindow(u, 3 /* GW_HWNDPREV */); if (u == IntPtr.Zero) break; if (u == h) { found = true; break; } }
        if (!found) return false;
      }
      return true;
    }
    /// After the full pass: did it agree with the fast paint? Kept as it is, extended (the full prediction covers
    /// more), changed (a fast column's colour or window differed: counted, the full one shows now), or taken back
    /// at once (the full pass predicts nothing there, and its coverage says h does not own those columns).
    static string FastCheck(Pred f, IntPtr h) {
      Pred now = _pred;
      if (now != f) {
        bool same = now != null && now.Painted && now.Mask != null;
        for (int c = 0; same && c < _n; c++) {
          if (!f.Mask[c]) continue;
          int i = c * 3;
          if (!now.Mask[c] || Math.Abs(now.Cols[i] - f.Cols[i]) > AgreeLevels || Math.Abs(now.Cols[i + 1] - f.Cols[i + 1]) > AgreeLevels ||
              Math.Abs(now.Cols[i + 2] - f.Cols[i + 2]) > AgreeLevels) same = false;
        }
        lock (_gate) { if (same) _fastExtended++; else _fastChanged++; }
        return same ? "fast" : "fast, then changed";
      }
      for (int c = 0; c < _n; c++) {
        if (!f.Mask[c]) continue;
        if (_owner.Length == _n && _owner[c] == h) continue;
        _pred = null;
        lock (_gate) _fastTakenBack++;
        byte[] o = Compose();
        if (o != null) PaintNow(o, false);
        return "fast, taken back";
      }
      lock (_gate) _fastKept++;
      return "fast";
    }
    /// Has the real z-order caught up with the raised FOREGROUND? Yes (h is the foreground window and the row's
    /// windows are the ones the raise said): the real coverage takes over and the cache may record again. Still
    /// not by the final check: Windows did not bring it forward (refused, cancelled, or the window went away),
    /// so the prediction is taken back at once, keeping its cache entry (it was right for that window).
    static void RaiseCheck(long now, bool final) {
      Raise r = _raise;
      if (r == null) return;
      List<Win> real = _sim ? (_simWins ?? new List<Win>()) : Live();
      IntPtr[] realOwner; Dictionary<IntPtr, Win> realCov;
      Cover(real, out realOwner, out realCov);
      bool ok = FgRoot() == r.H;
      if (ok) {
        bool moved;
        List<Win> up = Raised(real, r.H, out moved);
        if (moved) {
          IntPtr[] upOwner; Dictionary<IntPtr, Win> upCov;
          Cover(up, out upOwner, out upCov);
          for (int c = 0; c < realOwner.Length && c < upOwner.Length; c++) if (upOwner[c] != realOwner[c]) { ok = false; break; }
        }
      }
      if (!ok && !final) return;   // an attached activation moves up to ~18 ms after its event: wait
      _raise = null;
      _owner = realOwner; _cov = realCov; _covQ = now;
      if (ok) { lock (_gate) _raiseOk++; return; }
      RaiseFail(r, "zorder");
    }
    /// HSHELL_FLASH for h: a refused activation flashes the window's taskbar button. Just before its FOREGROUND
    /// (the usual order) it makes Foreground skip; just after it, the raised prediction is taken back now.
    static void Flash(IntPtr h, long q) {
      if (h == IntPtr.Zero) return;
      _flashH = h; _flashQ = q;
      lock (_gate) _flashSeen++;
      Raise r = _raise;
      if (r == null || r.H != h || FgRoot() == h) return;
      _flashH = IntPtr.Zero;
      _raise = null;
      Cov(q);   // no raise pending now: the real coverage
      RaiseFail(r, "flash");
    }
    /// A frame came while a refused activation's window is watched: is it the foreground now? Then the coverage
    /// is re-read (it still says the old window: nothing told it) and this frame waits for the settle time,
    /// or the next record would file the new window's pixels under the old one.
    static void Watch(long now) {
      if (now > _watchUntilQ) { _watchH = IntPtr.Zero; return; }
      if (FgRoot() != _watchH) return;
      _watchH = IntPtr.Zero;
      lock (_gate) _raiseLate++;
      Cov(now);
      _settleQ = Math.Max(_settleQ, now + Dq(SettleFrames * _frameMs));
    }
    static void RaiseFail(Raise r, string why) {
      lock (_gate) { _raiseBad++; Count(_raiseBadBy, why); }
      if (r.P == null || _pred != r.P) return;   // nothing it painted is still showing
      _pred = null;
      byte[] o = Compose();
      if (o != null) PaintNow(o, false);
    }
    /// What GetForegroundWindow says, as a root window (sim: what the test said).
    static IntPtr FgRoot() {
      if (_sim) return _simFg;
      IntPtr f = Win32.GetForegroundWindow();
      if (f == IntPtr.Zero) return IntPtr.Zero;
      IntPtr r = Win32.GetAncestor(f, 2 /* GA_ROOT */);
      return r != IntPtr.Zero ? r : f;
    }
    /// A title changed on a window under the row (a tab switch): its new look, at the time it usually lands.
    static void Title(IntPtr h, long evQ) {
      lock (_gate) _events++;
      Win w;
      if (!ReadWin(h, out w)) return;
      Win old;
      if (_cov.TryGetValue(h, out old) && old.Title == w.Title) return;
      _cov[h] = w; _pendRec = null;
      _titleWaitH = h; _titleWaitUntilQ = evQ + Dq(TitleWaitMs); _titleWaitCols = _cap;
      HintRec hr;
      if (_hints.TryGetValue(h, out hr) && hr.Kind != "none" && !_distrust.Contains(hr.App)) return;   // the app's own hint says it
      int pid; Win32.GetWindowThreadProcessId(h, out pid);
      Predict("title", evQ, null, null, h, "title:" + (_sim ? "sim" : pid.ToString(CultureInfo.InvariantCulture)));
    }

    // ------------------------------------------------------------------ the inbox: hints, flushes, and the test's injections
    static void Drain() {
      for (;;) {
        object[] it;
        lock (_gate) { if (_inbox.Count == 0) return; it = _inbox.Dequeue(); }
        string k = (string)it[0];
        long now = Q();
        if (k == "flush") { FlushCache((string)it[1]); _pred = null; _pendRec = null; continue; }
        if (k == "fg") { _simFg = (IntPtr)it[1]; continue; }
        if (k == "flash") { Flash((IntPtr)it[1], now); continue; }
        if (k == "hintclear") { _hints.Clear(); _hintBadFromQ.Clear(); lock (_gate) _hintCount = 0; continue; }
        if (k == "hint") {
          IntPtr h = (IntPtr)it[1]; var rec = (HintRec)it[2];
          if (rec == null || rec.Kind == "none") { _hints.Remove(h); _hintBadFromQ.Remove(h); }
          else {
            rec.AtQ = now;
            _hints[h] = rec;
            _hintBadFromQ.Remove(h);
            if (_cov.ContainsKey(h)) Predict("hint", now, null, null, h, "hint:" + rec.App);
          }
          lock (_gate) _hintCount = _hints.Count;
          continue;
        }
        if (k == "wins") {
          _simWins = SimWins(it[1]);
          // without an event the coverage must follow, or later rows record against the old windows (all "desktop")
          // (while a raised FOREGROUND waits for its check, wins alone is the z-order catching up: on screen that
          // is no event, so the settle time stays the event's)
          if (!(bool)it[2] && _watchH == IntPtr.Zero) { Cov(now); if (_raise == null) _settleQ = now; }   // (watched: the frames notice it, Watch)
          continue;
        }
        if (k == "row") {
          byte[] cols = null;
          try { cols = Convert.FromBase64String((it[1] as string) ?? ""); } catch (FormatException) { }
          if (cols != null && cols.Length == _n * 3) OnCapture(cols, (bool)it[2] ? now - Dq(500) : now);
          continue;
        }
        if (k == "ev") {
          var e = it[1] as Dictionary<string, object>;
          if (e == null) continue;
          string type = Json.GetString(e, "type") ?? "";
          IntPtr h = Json.GetHwnd(e, "hwnd");
          if (type == "title") Title(h, now);
          else if (type == "foreground") { _simFg = e.ContainsKey("fg") ? Json.GetHwnd(e, "fg") : h; Foreground(h, now); }
          else if (type == "minimize" || type == "close") { Switch("anim", now); if (type == "close") DropWindow(h); }
          continue;
        }
      }
    }
    static List<Win> SimWins(object raw) {
      var o = new List<Win>();
      var l = raw as List<object>;
      if (l == null) return o;
      foreach (object x in l) {
        var d = x as Dictionary<string, object>;
        if (d == null) continue;
        object r; d.TryGetValue("rect", out r);
        var rl = r as List<object>;
        if (rl == null || rl.Count != 4) continue;
        var w = new Win(); w.H = Json.GetHwnd(d, "hwnd"); w.Title = Json.GetString(d, "title") ?? "";
        w.L = (int)(double)rl[0]; w.T = (int)(double)rl[1]; w.R = (int)(double)rl[2]; w.B = (int)(double)rl[3];
        w.Top = Json.GetBool(d, "topmost", false);
        if (d.ContainsKey("owner")) w.Owner = Json.GetHwnd(d, "owner");
        o.Add(w);
      }
      return o;
    }

    /// Test: what the layer shows now (n*3, base64) and its prediction state.
    public static string Peek(Dictionary<string, object> req, ref object result) {
      byte[] painted = null; string pred = null; bool zOk = false; IntPtr wnd = IntPtr.Zero;
      // read on the caller's thread: the fields are only replaced whole, never mutated in place
      painted = _painted; wnd = _wnd;
      byte[] shown = _shownCols;
      Pred p = _pred;
      if (p != null) pred = p.Kind + (p.Painted ? " painted" : " waiting") + (p.FromHint ? " hint" : "") + (p.FromCache ? " cache" : "");
      if (_bar != IntPtr.Zero && wnd != IntPtr.Zero) zOk = N.GetWindow(_bar, 2) == wnd;
      var v = View();
      v["painted"] = painted != null ? Convert.ToBase64String(painted) : null;
      v["shown"] = shown != null ? Convert.ToBase64String(shown) : null;   // what the bitmap holds (desktop columns filled)
      v["pred"] = pred;
      Raise rz = _raise;
      v["raise"] = rz != null ? (rz.P != null ? "waiting painted" : "waiting") : null;   // a raised FOREGROUND not checked yet
      var own = new List<object>(); IntPtr[] ow = _owner; IntPtr lastOw = new IntPtr(-1);
      foreach (IntPtr h in ow) if (h != lastOw) { own.Add(h.ToInt64().ToString(CultureInfo.InvariantCulture)); lastOw = h; }
      v["owners"] = own;   // the row's windows left to right (hwnds, "0" = desktop), runs merged
      v["hwnd"] = wnd.ToInt64().ToString(CultureInfo.InvariantCulture);
      v["zUnderBar"] = zOk;
      lock (_gate) v["fgRecent"] = new List<object>(_fgRecent.ToArray());   // "hwnd evMs paintMs how", QPC ms (0 = no paint)
      result = v;
      return null;
    }
  }
}
