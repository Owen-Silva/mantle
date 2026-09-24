// Osd.cs - `osd.*`: what Mantle's volume pop-up needs from the sidecar (osd lane, wave 3,
// 2026-09-24).
//
//   osd.volume {op, step?, dry?, from?}   one VOLUME KEY press, done the way Windows does it:
//                    op 'up' / 'down' move the master volume by `step` (default 2, Windows' own
//                    step: 50 notches from 0 to 100), snapped to a multiple of the step (33 -> 34
//                    up, 33 -> 32 down), clamped to 0-100, and they UNMUTE (Windows' keys unmute
//                    on either; not measured here - a test may not press a key). op 'mute' toggles
//                    mute and leaves the level. Audio lane, so a held key's repeats are applied one
//                    after another and none reads a level the previous one has not written yet.
//                    dry:true computes the answer WITHOUT writing (allowed in passive): from the
//                    real device, or from `from:{level, muted}` so a --test instance can step a
//                    pretend level up and down with this exact arithmetic. A real step is refused
//                    in passive.
//   osd.qs           {qsOpen}: is the quick-settings panel open. The pop-up stays down while it is:
//                    the open panel already shows the level (QuickSettings.PanelOpen).
//
// WHY MANTLE STEPS THE VOLUME ITSELF (2026-09-24): Windows' own volume/brightness flyout host could
// not be found on Windows 11 25H2 (26200.9550: no NativeHWNDHost + DirectUIHWND in explorer, nothing
// flyout-like among explorer.exe / ShellHost.exe windows at rest), so it cannot be hidden. Instead the
// keyboard hook TAKES VolumeUp / VolumeDown / VolumeMute (KeyMachine chords in AltTab.cs, only while
// lib/features/osd.js is on and healthy): a key Windows never sees shows no Windows flyout, and this
// command does what the key would have done.
//
//   osd.bright {op, ...}   Windows' own BRIGHTNESS pop-up, replaced (OsdBright below):
//                    op 'watch' {on, targetPid?}  start/stop watching for it; off puts back every
//                        window Mantle moved. targetPid: --passive ONLY, a test's OWN stand-in window
//                        process (never explorer) whose windows may really be moved, to measure the road.
//                    op 'state'     what the watch has seen and done (counts, the last session, why not)
//                    op 'match'     PURE: the matching rules on a made-up window + event times
//                    op 'inject'    --passive only: a pretend WmiMonitorBrightnessEvent (no write)
//                    op 'simulate'  --passive only: a made-up flyout + brightness change through the
//                                   decision, pushed as a DRY event (nothing is touched)
//                    op 'restore'   put back every window Mantle moved (dry in --passive)
//   pushes {ev:"osd", kind:"brightness", phase:"change"|"end", level, flyout, how, hiddenAfterMs, ...}
//
// WHY THE BRIGHTNESS KEYS ARE DIFFERENT (measured 2026-09-24): they are firmware/ACPI hotkeys, so no
// key ever reaches the hook and they cannot be taken like volume. What CAN be seen (a read-only probe
// while Owen pressed brightness, scratchpad brightprobe/): Windows' brightness pop-up is an explorer.exe
// top-level XamlExplorerHostIslandWindow (ex-style NOACTIVATE|NOREDIRECTIONBITMAP|TOOLWINDOW|TOPMOST,
// about 213x61 or 169x61 logical px, bottom-centre), shown ~20 ms BEFORE the first
// WmiMonitorBrightnessEvent of a press, reused (one hwnd) through a burst of presses, hidden by explorer
// 2-4 s after the last one, and DESTROYED some time later (none existed at rest 2 h after). So Mantle
// watches SHOW/HIDE of top-level windows plus WmiMonitorBrightnessEvent and, when a flyout-shaped
// explorer window shows within -600..+800 ms of a brightness change, moves it off screen and pushes
// the level; main shows Mantle's own pop-up only once the move is VERIFIED. See OsdBright for the route.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class Osd {
    public static void Register(FeatureTable t) {
      t.Add("osd.volume", Lanes.Audio, Step);   // CoreAudio COM: the same lane as `volume`
      t.Add("osd.qs", Lanes.Ui, Qs);            // one field read: fast
      // Slow lane: starting a WMI watcher can take a while, and the hook it installs lives on its
      // OWN thread (OsdBright.Pump), never the ui lane's, so nothing here can stall the keyboard hook.
      t.Add("osd.bright", Lanes.Slow, OsdBright.Command);
      OsdBright.AtStartup();
    }

    // ------------------------------------------------------------------ is the panel open

    static string Qs(Dictionary<string, object> req, ref object result) {
      result = Json.Obj("ok", true, "qsOpen", QuickSettings.PanelOpen);
      return null;
    }

    // ------------------------------------------------------------------ one volume key

    /// The arithmetic of one press. PURE (proved through `dry` in sidecar/test-osd.js).
    public static void Target(string op, int step, int level, bool muted, out int toLevel, out bool toMuted) {
      level = Math.Max(0, Math.Min(100, level));
      if (op == "mute") { toLevel = level; toMuted = !muted; return; }
      toMuted = false;
      if (op == "up") toLevel = Math.Min(100, (level / step) * step + step);
      else toLevel = Math.Max(0, ((level + step - 1) / step) * step - step);
    }

    static string Step(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op");
      if (op != "up" && op != "down" && op != "mute")
        return "osd.volume needs op 'up', 'down' or 'mute' (got " + (op == null ? "none" : "'" + op + "'") + ")";
      int step = Json.GetInt(req, "step", 2);
      if (step < 1 || step > 10) return "osd.volume step must be 1-10 (got " + step + ")";
      bool dry = Json.GetBool(req, "dry", false);
      object fromRaw;
      var from = Json.TryGet(req, "from", out fromRaw) ? fromRaw as Dictionary<string, object> : null;
      if (from != null && !dry) return "osd.volume: `from` is for a dry run only (a real press always reads the device)";
      if (!dry && Program.Passive) return FeatureTable.PassiveRefusal + ": it would have stepped the volume " + op;

      long t0 = Stopwatch.GetTimestamp();
      int level; bool muted;
      try {
        if (from != null) {
          if (!Json.HasKey(from, "level")) return "osd.volume: `from` needs a level";
          level = Math.Max(0, Math.Min(100, Json.GetInt(from, "level", 0)));
          muted = Json.GetBool(from, "muted", false);
        } else {
          Volume.Apply(null, null, out level, out muted);
        }
      } catch (Exception ex) {
        return "the volume could not be read: " + ex.Message;
      }
      int toLevel; bool toMuted;
      Target(op, step, level, muted, out toLevel, out toMuted);
      bool changed = toLevel != level || toMuted != muted;
      int gotLevel = toLevel; bool gotMuted = toMuted;
      if (!dry && changed) {
        try {
          Volume.Apply(toLevel != level ? (int?)toLevel : null, toMuted != muted ? (bool?)toMuted : null,
                       out gotLevel, out gotMuted);
        } catch (Exception ex) {
          return "the volume could not be stepped " + op + ": " + ex.Message;
        }
      }
      long ms = (Stopwatch.GetTimestamp() - t0) * 1000 / Stopwatch.Frequency;
      result = Json.Obj("ok", true, "op", op, "dry", dry, "level", gotLevel, "muted", gotMuted,
                        "from", Json.Obj("level", level, "muted", muted), "changed", changed, "ms", ms);
      return null;
    }
  }

  /// Windows' own BRIGHTNESS pop-up, moved off screen so Mantle's can replace it (osd3, 2026-09-24).
  ///
  /// THE ROUTE, and why:
  ///   1. See it. An out-of-context WinEvent hook (SHOW/HIDE/DESTROY, every process, own thread with
  ///      its own message loop: never the ui lane, which the keyboard hook shares) + its own
  ///      WmiMonitorBrightnessEvent watcher. A SHOW is only looked at if its process is explorer's
  ///      and its class is XamlExplorerHostIslandWindow; anything else returns before a single read.
  ///   2. Match it (Looks + Decide, PURE, proved by `op:'match'`): explorer + that class + about the
  ///      pop-up's size (120-360 x 40-110 logical px) + bottom-centre of its monitor + a brightness
  ///      change 600 ms before to 800 ms after the SHOW. That class is explorer's GENERIC XAML host,
  ///      so without the brightness change nothing is touched.
  ///   3. Move it: SetWindowPos off screen (NOSIZE|NOZORDER|NOACTIVATE|ASYNCWINDOWPOS: explorer's
  ///      thread applies it, ours never waits on it) to (Park + x, Park + y) - the parked spot ENCODES
  ///      where Windows had it, so putting it back needs no memory and survives a crash. Chosen over
  ///      SW_HIDE because it leaves explorer's own show/hide state machine alone (explorer still hides
  ///      it on its own timer and shows it again next time, so with Mantle off it simply works), and
  ///      because a window that stays parked may be shown next time ALREADY off screen ("prepark":
  ///      no flash at all) if explorer does not re-place it - which only a live press can tell.
  ///   4. Verify: its LOCATIONCHANGE into the parked band, or a read at 40 ms / 250 ms. Explorer moving
  ///      it back is re-parked up to 3 times, then ShowWindowAsync(SW_HIDE) is the fallback; if that
  ///      does not stick either the session FAILS: nothing of Mantle's is shown (never two pop-ups),
  ///      and the reason is pushed. 3 failed sessions in a row = stop trying until the watch restarts.
  ///   5. Put back: a parked window that shows WITHOUT a brightness change (the generic host reused for
  ///      something else) is put back at once; `watch off`, `restore`, sidecar exit, and the next
  ///      sidecar start (a crash) put back every parked explorer window of that class.
  /// --passive: the watch runs and matches for real, but every move is a DRY RUN with a log line,
  /// except on a window of the test's own `targetPid` process (never explorer's).
  /// NOT MEASURABLE HERE: a test may not press a brightness key or change the brightness (a same-value
  /// WmiSetBrightness shows no pop-up and fires no event, measured 2026-09-24), so how explorer reacts
  /// to the move (keeps it parked / re-places it / fights) is unknown until a live press; every session
  /// pushes phase:'end' with how, prepark, fights and hiddenAfterMs, so one press measures it.
  static class OsdBright {
    static class N {
      public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
      public delegate bool EnumProc(IntPtr h, IntPtr l);
      [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
      [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public int x, y; }
      [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
      [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
      [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
      [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
      [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
      [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT r, uint f);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO mi);
      [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
      [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
      [DllImport("user32.dll")] public static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
      [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint remove);
      [DllImport("user32.dll")] public static extern bool PostThreadMessageW(uint tid, uint msg, IntPtr w, IntPtr l);
      [DllImport("user32.dll")] public static extern UIntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, IntPtr proc);
      [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    }

    const uint EV_DESTROY = 0x8001, EV_SHOW = 0x8002, EV_HIDE = 0x8003, EV_LOC = 0x800B;
    const uint OUTOFCONTEXT_SKIPOWN = 0x0002;
    const uint SWP_MOVE_ONLY = 0x0001 | 0x0004 | 0x0010 | 0x0200 | 0x4000;  // NOSIZE NOZORDER NOACTIVATE NOOWNERZORDER ASYNCWINDOWPOS
    const uint WM_TIMER = 0x0113, WM_QUIT = 0x0012;
    public const string FlyoutClass = "XamlExplorerHostIslandWindow";
    public const int Park = -24000, Band = 8000;          // parked at (Park + x, Park + y): never on a monitor
    public const double BeforeMs = 600, AfterMs = 800;    // brightness change vs the SHOW (probe: SHOW led by ~20 ms)

    // ================================================================ the rules (PURE)

    public static bool InBand(int x, int y) { return Math.Abs(x - Park) <= Band && Math.Abs(y - Park) <= Band; }

    /// null = it looks like Windows' brightness pop-up; otherwise why it does not.
    public static string Looks(string cls, string proc, bool shell, int x, int y, int w, int h, double scale,
                               int monL, int monT, int monR, int monB) {
      if (cls != FlyoutClass) return "its class is " + (cls ?? "unknown") + ", not explorer's XAML flyout host";
      if (!shell) return "it belongs to " + (string.IsNullOrEmpty(proc) ? "an unknown process" : proc) + ", not explorer";
      if (!(scale > 0)) scale = 1;
      double lw = w / scale, lh = h / scale;
      if (lw < 120 || lw > 360 || lh < 40 || lh > 110)
        return "its size (" + Math.Round(lw) + "x" + Math.Round(lh) + " logical px) is not the brightness pop-up's (about 213x61)";
      int mw = monR - monL, mh = monB - monT;
      if (mw <= 0 || mh <= 0) return "the monitor it is on is unknown";
      if (Math.Abs(x + w / 2.0 - (monL + mw / 2.0)) > mw * 0.12) return "it is not centred on its monitor";
      if (y < monT + mh / 2.0 || y + h < monT + mh * 0.6) return "it is not in the bottom part of its monitor";
      return null;
    }

    /// "hide" / "wait" / "ignore", with why. `looks` is Looks()'s answer.
    public static string Decide(string looks, double showAt, IList<double> brightAt, double now, out string why) {
      if (looks != null) { why = looks; return "ignore"; }
      double best = double.NaN;
      foreach (double b in brightAt) {
        if (b < showAt - BeforeMs || b > showAt + AfterMs) continue;
        if (double.IsNaN(best) || Math.Abs(b - showAt) < Math.Abs(best - showAt)) best = b;
      }
      if (!double.IsNaN(best)) {
        why = "a brightness change " + Math.Round(Math.Abs(best - showAt)) + " ms " + (best <= showAt ? "before" : "after") + " it showed";
        return "hide";
      }
      if (now < showAt + AfterMs) { why = "no brightness change yet: waiting up to " + AfterMs + " ms after it showed"; return "wait"; }
      why = "no brightness change from " + BeforeMs + " ms before to " + AfterMs + " ms after it showed";
      return "ignore";
    }

    // ================================================================ live state (all under _g)

    static readonly object _g = new object();
    static Thread _thread;
    static uint _tid;
    static N.WinEventProc _cb;                 // kept alive: the hook calls it
    static IntPtr _hShow, _hLoc, _hLocT;
    static uint _shellPid, _locPid, _locTPid;
    static int _targetPid;                     // --passive test only
    static string _hookErr;
    static ManagementEventWatcher _wmi;
    static bool _watching, _exitHooked;
    static string _watchWhy = "not started";
    static string _disabled;                   // why hiding stopped (3 failed sessions in a row)
    static int _failStreak;
    static string _lastError;

    static double _lastBright = -1e12;
    static int _level = -1;
    static IntPtr _pend; static double _pendAt; static bool _pendParked; static int _pendX, _pendY; static uint _pendAge; static int _pendGen;
    // the session: one showing of Windows' pop-up, from its SHOW to its HIDE
    static IntPtr _s; static string _sState, _sHow, _sWhy; static double _sAt, _sHiddenAt, _sLastChange;
    static uint _sAge; static int _sFights, _sReshows, _sChanges, _sGen, _sEndGen; static bool _sPre, _sExpectHide;
    static readonly Dictionary<IntPtr, bool> _parked = new Dictionary<IntPtr, bool>();
    static int _nShows, _nHidden, _nDry, _nFailed, _nIgnored, _nPre;
    static string _lastIgnored, _lastSession;
    static readonly HashSet<Timer> _timers = new HashSet<Timer>();

    static double NowMs() { return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency; }

    static void After(int ms, ThreadStart fn) {
      Timer t = null;
      t = new Timer(delegate (object o) {
        try { fn(); } catch (Exception ex) { _lastError = "a timer failed: " + ex.Message; }
        lock (_timers) { _timers.Remove(t); }
        t.Dispose();
      }, null, Timeout.Infinite, Timeout.Infinite);
      lock (_timers) { _timers.Add(t); }
      t.Change(ms, Timeout.Infinite);
    }

    static string ClassOf(IntPtr h) { var s = new StringBuilder(64); N.GetClassNameW(h, s, 64); return s.ToString(); }

    static uint ShellPid() {
      uint pid = 0;
      IntPtr sh = N.GetShellWindow();
      if (sh != IntPtr.Zero) N.GetWindowThreadProcessId(sh, out pid);
      if (pid == 0) {
        try { var ps = Process.GetProcessesByName("explorer"); if (ps.Length > 0) pid = (uint)ps[0].Id; } catch (Exception) { }
      }
      return pid;
    }

    static bool IsShell(uint pid) { return pid != 0 && (pid == _shellPid || (_targetPid != 0 && pid == (uint)_targetPid)); }

    /// In --passive only the test's own stand-in may really be moved.
    static bool IsDry(IntPtr h) {
      if (!Program.Passive) return false;
      uint pid; N.GetWindowThreadProcessId(h, out pid);
      return !(_targetPid != 0 && pid == (uint)_targetPid);
    }

    static string LooksLive(IntPtr h, int x, int y, int w, int hh) {
      uint dpi = 0;
      try { dpi = N.GetDpiForWindow(h); } catch (Exception) { }
      var r = new N.RECT(); r.L = x; r.T = y; r.R = x + w; r.B = y + hh;
      var mi = new N.MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(N.MONITORINFO));
      IntPtr mon = N.MonitorFromRect(ref r, 2);
      if (mon == IntPtr.Zero || !N.GetMonitorInfoW(mon, ref mi)) mi.rcMonitor = new N.RECT();
      return Looks(ClassOf(h), "explorer", true, x, y, w, hh, dpi > 0 ? dpi / 96.0 : 1,
                   mi.rcMonitor.L, mi.rcMonitor.T, mi.rcMonitor.R, mi.rcMonitor.B);
    }

    // ================================================================ the hook thread

    static void Pump(object readyObj) {
      N.MSG m;
      N.PeekMessageW(out m, IntPtr.Zero, 0, 0, 0);      // the queue exists before anyone posts to it
      _tid = N.GetCurrentThreadId();
      _cb = OnWinEvent;
      lock (_g) { _shellPid = ShellPid(); }
      _hShow = N.SetWinEventHook(EV_DESTROY, EV_HIDE, IntPtr.Zero, _cb, 0, 0, OUTOFCONTEXT_SKIPOWN);
      if (_hShow == IntPtr.Zero) _hookErr = "Windows refused the window-show hook (SetWinEventHook returned 0)";
      else Rehook();
      N.SetTimer(IntPtr.Zero, UIntPtr.Zero, 5000, IntPtr.Zero);   // explorer restarted? (a new pid)
      ((ManualResetEvent)readyObj).Set();
      if (_hShow == IntPtr.Zero) return;
      while (N.GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) {
        if (m.m == WM_TIMER) {
          uint pid = ShellPid();
          bool changed;
          lock (_g) { changed = pid != 0 && pid != _shellPid; if (changed) _shellPid = pid; }
          if (changed || (uint)_targetPid != _locTPid) Rehook();
        }
      }
      if (_hLoc != IntPtr.Zero) N.UnhookWinEvent(_hLoc);
      if (_hLocT != IntPtr.Zero) N.UnhookWinEvent(_hLocT);
      N.UnhookWinEvent(_hShow);
      _hShow = _hLoc = _hLocT = IntPtr.Zero; _locTPid = 0;
    }

    /// LOCATIONCHANGE fires constantly system-wide, so it is hooked for explorer (and the test's
    /// stand-in) only. Runs on the hook thread.
    static void Rehook() {
      uint pid; int tpid;
      lock (_g) { pid = _shellPid; tpid = _targetPid; }
      if (_hLoc != IntPtr.Zero) { N.UnhookWinEvent(_hLoc); _hLoc = IntPtr.Zero; }
      if (pid != 0) _hLoc = N.SetWinEventHook(EV_LOC, EV_LOC, IntPtr.Zero, _cb, pid, 0, OUTOFCONTEXT_SKIPOWN);
      _locPid = pid;
      if ((uint)tpid != _locTPid) {
        if (_hLocT != IntPtr.Zero) { N.UnhookWinEvent(_hLocT); _hLocT = IntPtr.Zero; }
        if (tpid != 0) _hLocT = N.SetWinEventHook(EV_LOC, EV_LOC, IntPtr.Zero, _cb, (uint)tpid, 0, OUTOFCONTEXT_SKIPOWN);
        _locTPid = (uint)tpid;
      }
    }

    static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
      try {
        if (ev == EV_DESTROY) {
          lock (_g) {
            _parked.Remove(hwnd);
            if (hwnd == _pend) _pend = IntPtr.Zero;
            if (hwnd == _s) EndSession("its window closed");
          }
          return;
        }
        if (ev == EV_LOC) { lock (_g) { if (hwnd == _s) OnMoved(hwnd); } return; }
        uint pid; N.GetWindowThreadProcessId(hwnd, out pid);
        bool shell;
        lock (_g) { shell = IsShell(pid); }
        if (!shell) return;                                   // another process: never read, never touched
        if (ClassOf(hwnd) != FlyoutClass) return;
        if (N.GetAncestor(hwnd, 2) != hwnd) return;           // top-level only
        uint age = unchecked((uint)Environment.TickCount - time);
        if (age > 10000) age = 0;
        lock (_g) { if (ev == EV_SHOW) OnShow(hwnd, age); else OnHide(hwnd); }
      } catch (Exception ex) {
        _lastError = "the window hook failed: " + ex.Message;
      }
    }

    // ================================================================ what happens (under _g)

    static void OnShow(IntPtr hwnd, uint age) {
      _nShows++;
      N.RECT r;
      if (!N.GetWindowRect(hwnd, out r)) return;
      int w = r.R - r.L, h = r.B - r.T;
      bool parked = InBand(r.L, r.T);
      int ox = parked ? r.L - Park : r.L, oy = parked ? r.T - Park : r.T;
      double now = NowMs();
      if (hwnd == _s && _sState != null && _sState != "failed" && _sState != "dry") {
        _sReshows++;                                         // shown again inside a session (after our SW_HIDE)
        if (parked) return;
        if (_sReshows > 3) { Fail("Windows kept showing its brightness pop-up again after Mantle hid it (" + _sReshows + " times)"); return; }
        Park1(hwnd, ox, oy);
        return;
      }
      string looks = LooksLive(hwnd, ox, oy, w, h);
      if (looks != null) {
        _nIgnored++; _lastIgnored = looks;
        if (parked) Unpark(hwnd, "it showed as something other than the brightness pop-up (" + looks + ")");
        return;
      }
      string why;
      if (Decide(null, now, new double[] { _lastBright }, now, out why) == "hide") {
        StartSession(hwnd, ox, oy, parked, age, now, why);
        return;
      }
      _pend = hwnd; _pendAt = now; _pendParked = parked; _pendX = ox; _pendY = oy; _pendAge = age;
      int gen = ++_pendGen;
      After((int)AfterMs + 20, delegate {
        lock (_g) {
          if (gen != _pendGen || _pend == IntPtr.Zero) return;
          IntPtr p = _pend; bool pk = _pendParked;
          _pend = IntPtr.Zero; _nIgnored++;
          _lastIgnored = "a flyout-shaped explorer window showed with no brightness change within " + AfterMs + " ms";
          if (pk) Unpark(p, "no brightness change came with it, so it is not the brightness pop-up");
        }
      });
    }

    static void OnHide(IntPtr hwnd) {
      if (hwnd == _pend) { _pend = IntPtr.Zero; _pendGen++; }
      if (hwnd != _s) return;
      if (_sExpectHide) { _sExpectHide = false; return; }   // our own SW_HIDE
      EndSession("Windows hid it");
    }

    static void OnBrightness(int level, bool injected) {
      lock (_g) {
        double now = NowMs();
        _lastBright = now; _level = level;
        if (_pend != IntPtr.Zero && now <= _pendAt + AfterMs) {
          IntPtr p = _pend; _pend = IntPtr.Zero; _pendGen++;
          StartSession(p, _pendX, _pendY, _pendParked, _pendAge, _pendAt,
                       "a brightness change " + Math.Round(now - _pendAt) + " ms after it showed");
          return;
        }
        if (_s != IntPtr.Zero && _sState != null) {
          _sChanges++; _sLastChange = now; ArmEnd();
          if (_sState != "hiding") EmitChange();              // hiding: Confirm() pushes the level
          return;
        }
        Features.Event("osd", Json.Obj("kind", "brightness", "phase", "change", "level", level, "flyout", "none",
                                       "injected", injected, "reason", "no Windows brightness pop-up came with this change"));
      }
    }

    static void StartSession(IntPtr hwnd, int ox, int oy, bool parked, uint age, double showAt, string why) {
      if (_s != IntPtr.Zero && _s != hwnd) EndSession("another pop-up window took over");
      _s = hwnd; _sAt = showAt; _sAge = age; _sWhy = why; _sHow = null; _sHiddenAt = 0; _sPre = false;
      _sFights = 0; _sReshows = 0; _sChanges = 1; _sLastChange = NowMs(); _sExpectHide = false; _sGen++;
      ArmEnd();
      if (_disabled != null) { _sState = "failed"; _sWhy = _disabled; _nFailed++; EmitChange(); return; }
      if (IsDry(hwnd)) {
        _sState = "dry"; _nDry++;
        Program.EmitLog("info", "osd: DRY RUN (--passive): Windows' brightness pop-up would have been moved off screen (" + why + "); nothing was moved");
        EmitChange();
        return;
      }
      if (parked) {                                          // explorer showed it where Mantle left it
        _sHow = "prepark"; _sPre = true; _nPre++; _parked[hwnd] = true;
        Confirm();
        return;
      }
      Park1(hwnd, ox, oy);
    }

    /// Move it off screen and check it went. Keeps the session "hiding" until verified.
    static void Park1(IntPtr hwnd, int ox, int oy) {
      _sState = "hiding"; _sHow = "parked";
      if (!N.SetWindowPos(hwnd, IntPtr.Zero, Park + ox, Park + oy, 0, 0, SWP_MOVE_ONLY)) {
        HideFallback("SetWindowPos was refused (Win32 error " + Marshal.GetLastWin32Error() + ")");
        return;
      }
      _parked[hwnd] = true;
      int gen = _sGen;
      After(40, delegate { Verify(gen, false); });
      After(250, delegate { Verify(gen, true); });
    }

    static bool OffScreen(IntPtr h) {
      if (!N.IsWindowVisible(h)) return true;
      N.RECT r;
      return N.GetWindowRect(h, out r) && InBand(r.L, r.T);
    }

    static void Verify(int gen, bool last) {
      lock (_g) {
        if (gen != _sGen || _sState != "hiding" || _sHow != "parked") return;
        if (OffScreen(_s)) { Confirm(); return; }
        if (last) HideFallback("it was still on screen 250 ms after it was moved");
      }
    }

    static void HideFallback(string why) {
      _sState = "hiding"; _sHow = "hidden"; _sExpectHide = true;
      N.ShowWindowAsync(_s, 0);                              // SW_HIDE
      int gen = _sGen;
      After(150, delegate {
        lock (_g) {
          if (gen != _sGen || _sState != "hiding") return;
          if (!N.IsWindowVisible(_s)) Confirm();
          else Fail("Windows' brightness pop-up stayed on screen: moving it off did not stick (" + why + ") and hiding it did not either");
        }
      });
    }

    static void OnMoved(IntPtr hwnd) {
      if (_sState != "hiding" && _sState != "hidden") return;
      N.RECT r;
      if (!N.GetWindowRect(hwnd, out r)) return;
      if (InBand(r.L, r.T)) { if (_sState == "hiding" && _sHow == "parked") Confirm(); return; }
      if (!N.IsWindowVisible(hwnd)) return;
      _sFights++;                                            // Windows put it back on screen
      if (_sFights > 3) { HideFallback("Windows moved it back on screen " + _sFights + " times"); return; }
      Park1(hwnd, r.L, r.T);
    }

    static void Confirm() {
      _sState = "hidden";
      if (_sHiddenAt == 0) { _sHiddenAt = NowMs(); _nHidden++; }
      _failStreak = 0;
      EmitChange();
    }

    static void Fail(string reason) {
      _sState = "failed"; _sWhy = reason; _nFailed++; _failStreak++;
      if (_failStreak >= 3)
        _disabled = "Mantle stopped hiding Windows' brightness pop-up after 3 failed tries in a row (last: " + reason +
                    "); switching the feature off and on tries again";
      EmitChange();
    }

    static object HiddenAfter() {
      if (_sHiddenAt == 0) return null;
      if (_sPre) return 0;
      return Math.Round(_sAge + (_sHiddenAt - _sAt), 1);     // from explorer's SHOW, not from ours
    }

    static void EmitChange() {
      Features.Event("osd", Json.Obj("kind", "brightness", "phase", "change", "level", _level >= 0 ? (object)_level : null,
        "flyout", _sState ?? "none", "how", _sHow, "hiddenAfterMs", HiddenAfter(), "prepark", _sPre, "fights", _sFights,
        "dry", _sState == "dry", "reason", _sState == "failed" ? _sWhy : null));
    }

    static void ArmEnd() {
      int gen = ++_sEndGen;
      After(6000, delegate { lock (_g) { if (gen == _sEndGen && _s != IntPtr.Zero) EndSession("no brightness change for 6 s"); } });
    }

    static void EndSession(string why) {
      if (_s == IntPtr.Zero) return;
      object after = HiddenAfter();
      _lastSession = (_sState ?? "none") + (_sHow != null ? " (" + _sHow + ")" : "") +
                     (after != null ? ", off screen " + after + " ms after Windows showed it" : "") +
                     ", " + _sChanges + " change(s), explorer moved it back " + _sFights + "x, re-showed " + _sReshows + "x; ended: " + why;
      Features.Event("osd", Json.Obj("kind", "brightness", "phase", "end", "flyout", _sState, "how", _sHow,
        "hiddenAfterMs", after, "prepark", _sPre, "fights", _sFights, "reshows", _sReshows, "changes", _sChanges,
        "dry", _sState == "dry", "why", why, "reason", _sState == "failed" ? _sWhy : null, "summary", _lastSession));
      _s = IntPtr.Zero; _sState = null; _sGen++; _sExpectHide = false;
    }

    /// Put one parked window back where Windows had it (the park encodes it). False when dry or not parked.
    static bool Unpark(IntPtr hwnd, string why) {
      N.RECT r;
      if (!N.GetWindowRect(hwnd, out r) || !InBand(r.L, r.T)) { _parked.Remove(hwnd); return false; }
      if (IsDry(hwnd)) {
        Program.EmitLog("info", "osd: DRY RUN (--passive): would have put a parked pop-up window back on screen (" + why + ")");
        return false;
      }
      N.SetWindowPos(hwnd, IntPtr.Zero, r.L - Park, r.T - Park, 0, 0, SWP_MOVE_ONLY);
      _parked.Remove(hwnd);
      Program.EmitLog("info", "osd: put a Windows pop-up window back where Windows had it: " + why);
      return true;
    }

    /// Every parked window Mantle knows of, plus every explorer window of that class in the parked band.
    static int RestoreAll(string why, out int found) {
      var all = new List<IntPtr>(_parked.Keys);
      uint shell = _shellPid != 0 ? _shellPid : ShellPid();
      int tpid = _targetPid;
      N.EnumWindows(delegate (IntPtr h, IntPtr l) {
        uint pid; N.GetWindowThreadProcessId(h, out pid);
        if (pid == 0 || (pid != shell && !(tpid != 0 && pid == (uint)tpid))) return true;
        N.RECT r;
        if (!N.GetWindowRect(h, out r) || !InBand(r.L, r.T) || ClassOf(h) != FlyoutClass) return true;
        if (!all.Contains(h)) all.Add(h);
        return true;
      }, IntPtr.Zero);
      found = 0;
      int n = 0;
      foreach (IntPtr h in all) {
        N.RECT r;
        if (N.GetWindowRect(h, out r) && InBand(r.L, r.T)) found++;
        if (Unpark(h, why)) n++;
      }
      return n;
    }

    // ================================================================ start / stop

    /// A crash skipped the put-back: the next sidecar start does it (after `ready`, off the ui lane).
    public static void AtStartup() {
      if (Program.Passive) return;
      After(1500, delegate {
        int found, n;
        lock (_g) { n = RestoreAll("an earlier Mantle left it parked off screen (it exited without putting it back)", out found); }
        if (n > 0) Program.EmitLog("warn", "osd: put " + n + " Windows brightness pop-up window(s) back on screen at start: an earlier Mantle had parked them and did not put them back");
      });
    }

    static IDictionary StartWatch(int targetPid) {
      lock (_g) { _targetPid = targetPid; _disabled = null; _failStreak = 0; }
      if (_thread == null) {
        _hookErr = null;
        var ready = new ManualResetEvent(false);
        var th = new Thread(Pump);
        th.IsBackground = true; th.Name = "osd-bright";
        th.Start(ready);
        ready.WaitOne(3000);
        if (_hookErr != null) { _thread = null; lock (_g) { _watching = false; _watchWhy = _hookErr; } return State(); }
        _thread = th;
      } else if (targetPid != 0) {
        N.PostThreadMessageW(_tid, WM_TIMER, IntPtr.Zero, IntPtr.Zero);
      }
      if (_wmi == null) {
        try {
          var w = new ManagementEventWatcher(new ManagementScope("root\\wmi"),
                                             new WqlEventQuery("SELECT * FROM WmiMonitorBrightnessEvent"));
          w.EventArrived += delegate (object s, EventArrivedEventArgs e) {
            int lv = -1;
            try { lv = Convert.ToInt32(e.NewEvent["Brightness"]); } catch (Exception) { }
            if (lv >= 0) OnBrightness(lv, false);
          };
          w.Start();
          _wmi = w;
        } catch (Exception ex) {
          StopWatch();
          lock (_g) { _watchWhy = "brightness changes cannot be watched (WMI: " + ex.GetType().Name + ": " + ex.Message.Trim() + ")"; }
          return State();
        }
      }
      if (!Program.Passive && !_exitHooked) {
        _exitHooked = true;
        AppDomain.CurrentDomain.ProcessExit += delegate {
          try { int f; lock (_g) { RestoreAll("Mantle's sidecar is exiting", out f); } } catch (Exception) { }
        };
      }
      lock (_g) { _watching = true; _watchWhy = null; }
      return State();
    }

    static int StopWatch() {
      int n, found;
      lock (_g) {
        n = RestoreAll("Mantle's brightness pop-up was switched off", out found);
        EndSession("the watch stopped");
        _pend = IntPtr.Zero; _pendGen++;
        _watching = false; _watchWhy = "switched off"; _disabled = null; _failStreak = 0;
      }
      if (_wmi != null) {
        try { _wmi.Stop(); } catch (Exception) { }
        try { _wmi.Dispose(); } catch (Exception) { }
        _wmi = null;
      }
      if (_thread != null) {
        N.PostThreadMessageW(_tid, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        _thread.Join(1000);
        _thread = null;
      }
      return n;
    }

    static IDictionary State() {
      lock (_g) {
        return Json.Obj("ok", true, "watching", _watching, "reason", _watchWhy, "disabled", _disabled,
          "dry", Program.Passive, "targetPid", _targetPid, "shellPid", (long)_shellPid, "locHooked", _hLoc != IntPtr.Zero,
          "level", _level >= 0 ? (object)_level : null, "session", _s == IntPtr.Zero ? null : _sState,
          "parked", _parked.Count, "shows", _nShows, "hidden", _nHidden, "prepark", _nPre, "dryRuns", _nDry,
          "failed", _nFailed, "ignored", _nIgnored, "lastIgnored", _lastIgnored, "lastSession", _lastSession,
          "lastError", _lastError);
      }
    }

    // ================================================================ the command

    static double Num(Dictionary<string, object> d, string k, double dflt) {
      object v;
      return Json.TryGet(d, k, out v) && v is double ? (double)v : dflt;
    }

    public static string Command(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op") ?? "watch";
      if (op == "watch") {
        bool on = Json.GetBool(req, "on", true);
        int tpid = Json.GetInt(req, "targetPid", 0);
        if (tpid != 0) {
          if (!Program.Passive) return "osd.bright targetPid is for a --passive test's own stand-in window only";
          string name = null;
          try { name = Process.GetProcessById(tpid).ProcessName; } catch (Exception) { }
          if (name == null) return "osd.bright targetPid " + tpid + " is not a running process";
          if (name.Equals("explorer", StringComparison.OrdinalIgnoreCase)) return "osd.bright targetPid may never be explorer's";
        }
        if (!on) { int n = StopWatch(); var st = State(); st["restored"] = n; result = st; return null; }
        result = StartWatch(tpid);
        return null;
      }
      if (op == "state") { result = State(); return null; }
      if (op == "restore") {
        int found, n;
        lock (_g) { n = RestoreAll("asked to put it back", out found); }
        result = Json.Obj("ok", true, "restored", n, "found", found, "dry", Program.Passive);
        return null;
      }
      if (op == "inject") {
        if (!Program.Passive) return "osd.bright inject is a test command and runs only in --passive";
        int lv = Json.GetInt(req, "level", -1);
        if (lv < 0 || lv > 100) return "osd.bright inject needs a level 0-100";
        OnBrightness(lv, true);
        result = Json.Obj("ok", true, "level", lv);
        return null;
      }
      if (op == "match" || op == "simulate") {
        object wo;
        var win = Json.TryGet(req, "window", out wo) ? wo as Dictionary<string, object> : null;
        if (win == null) win = new Dictionary<string, object>();
        string cls = Json.GetString(win, "cls") ?? FlyoutClass;
        string proc = Json.GetString(win, "proc") ?? "explorer";
        double scale = Num(win, "scale", 1.25);
        int x = (int)Num(win, "x", 827), y = (int)Num(win, "y", 1004), w = (int)Num(win, "w", 266), h = (int)Num(win, "h", 76);
        int[] mon = new int[] { 0, 0, 1920, 1080 };
        object mo;
        var ml = Json.TryGet(win, "monitor", out mo) ? mo as List<object> : null;
        if (ml != null && ml.Count == 4) for (int i = 0; i < 4; i++) mon[i] = ml[i] is double ? (int)(double)ml[i] : 0;
        double showAt = Num(req, "showAt", 0), now = Num(req, "now", showAt + 1000);
        var bright = new List<double>();
        object bo;
        var bl = Json.TryGet(req, "brightAt", out bo) ? bo as List<object> : null;
        if (bl != null) foreach (object b in bl) if (b is double) bright.Add((double)b);
        if (op == "simulate" && bl == null) bright.Add(showAt + 20);
        string looks = Looks(cls, proc, string.Equals(proc, "explorer", StringComparison.OrdinalIgnoreCase),
                             x, y, w, h, scale, mon[0], mon[1], mon[2], mon[3]);
        string why;
        string verdict = Decide(looks, showAt, bright, now, out why);
        if (op == "match") { result = Json.Obj("ok", true, "verdict", verdict, "reason", why, "looks", looks == null); return null; }
        if (!Program.Passive) return "osd.bright simulate is a test command and runs only in --passive";
        int lv = Json.GetInt(req, "level", 70);
        string flyout = verdict == "hide" ? "dry" : "none";
        Program.EmitLog("info", "osd: DRY RUN (simulated, --passive): a made-up brightness pop-up -> " + verdict + " (" + why + "); nothing was moved");
        Features.Event("osd", Json.Obj("kind", "brightness", "phase", "change", "level", lv, "flyout", flyout,
                                       "dry", true, "simulated", true, "reason", verdict == "hide" ? null : why));
        result = Json.Obj("ok", true, "verdict", verdict, "reason", why, "flyout", flyout, "level", lv);
        return null;
      }
      return "osd.bright needs op 'watch', 'state', 'restore', 'match', 'inject' or 'simulate' (got '" + op + "')";
    }
  }
}
