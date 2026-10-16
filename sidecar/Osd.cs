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
// not be found on Windows 11 25H2 or 26H2 (26200/26300.9550: no NativeHWNDHost + DirectUIHWND in explorer, nothing
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
  ///      so without the brightness change nothing is touched for long: since P7 (2026-10-15) a
  ///      flyout-shaped explorer host is parked AT ITS SHOW and put back if no brightness change comes
  ///      within SpecMs (250 ms; see SpecMs for why and what else the host shows).
  ///   3. Move it: SetWindowPos off screen (NOSIZE|NOZORDER|NOACTIVATE|ASYNCWINDOWPOS: explorer's
  ///      thread applies it, ours never waits on it) to (Park + x, Park + y) - the parked spot ENCODES
  ///      where Windows had it, so putting it back needs no memory and survives a crash. Chosen over
  ///      SW_HIDE because it leaves explorer's own show/hide state machine alone (explorer still hides
  ///      it on its own timer and shows it again next time, so with Mantle off it simply works), and
  ///      because a window that stays parked may be shown next time ALREADY off screen ("prepark":
  ///      no flash at all) if explorer does not re-place it - which only a live press can tell.
  ///   4. Keep it off for the whole burst, with NO fixed cap on answers. Live (2026-09-25, mantle.log):
  ///      explorer puts the pop-up back on screen on most steps of a burst (7 moves back + 4 re-shows in
  ///      16 changes) and each answer won within a few ms, yet the old cap (re-park 3x, SW_HIDE, give up
  ///      at the 4th re-show) threw away bursts that were working: "showed Mantle's, then Windows'".
  ///      Now every time it is seen ON screen (visible, outside the park band) an on-screen SPAN opens
  ///      and is answered (SetWindowPos off screen; SW_HIDE only if that is refused); the span closes
  ///      when it is seen off screen (its LOCATIONCHANGE into the band, our HIDE, or a read at the
  ///      deadline). Give up the burst only when the answering stops working, measured (Judge, PURE,
  ///      proved by `op:'judge'`): a span longer than DeadlineMs (30 ms: two 60 Hz frames), or more
  ///      than BudgetMs (50 ms) on screen within any WindowMs (250 ms) = explorer puts it back faster
  ///      than Mantle can answer. A SLIDING window, not a per-burst total: at ~5 ms a step a long hold
  ///      would add up past 50 ms and fail a burst that works. Giving up: nothing of Mantle's is shown
  ///      (never two pop-ups), a parked window is put back so Windows' own shows, and the measured
  ///      reason is pushed. 3 failed BURSTS in a row = stop trying until the watch restarts; a burst
  ///      that ends hidden resets the count. Every burst logs moves, re-shows, answers and the worst
  ///      on-screen span.
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

    /// Park it AT ITS SHOW, before the brightness change is known (SpecMs)? Only a "wait" (it looks like the
    /// brightness pop-up, no change yet), on screen, while hiding is on, and never a --passive dry run.
    public static bool ParkAtShow(string verdict, bool parked, bool disabled, bool dry) {
      return verdict == "wait" && !parked && !disabled && !dry;
    }

    /// Answering a burst (see the route, step 4): each answer must get it off screen within DeadlineMs of
    /// Windows putting it on (checked by a timer that Windows fires 30-47 ms later: 15.6 ms ticks), and it
    /// may be on screen at most BudgetMs within any WindowMs. Live answers took 2.3-6.8 ms (2026-09-25).
    public const double DeadlineMs = 30, WindowMs = 250, BudgetMs = 50;

    /// PARK AT THE SHOW (P7, 2026-10-15). Live, Windows' pop-up was on screen 16.1 ms median / 59.8 p95 /
    /// 745 max (n=237, mantle.log 10-13..15) before it was parked, and almost all of that was the WAIT for
    /// the WmiMonitorBrightnessEvent: explorer's SHOW leads it by ~20 ms, and WMI is late at times. Keeping
    /// the window parked between presses cannot help: explorer DESTROYS this host between bursts (none
    /// exists between presses, enumerated 2026-10-15) and builds it on screen for every burst (prepark
    /// 0 of 246 live bursts). So a flyout-shaped explorer host is now parked AT ITS SHOW, before the
    /// brightness change is known ("suspect": Mantle shows nothing and pushes nothing yet), and:
    ///   - a brightness change within SpecMs makes it the brightness pop-up (pushed hidden, as before);
    ///   - none within SpecMs = it is one of the host's OTHER pop-ups (airplane mode, mic or camera,
    ///     volume when Mantle does not own the keys): it is put straight back where Windows had it, so it
    ///     shows SpecMs late and is never lost, and a 'phase:other' push names its size. A brightness
    ///     change after that still gets the old route (answered on screen) up to AfterMs.
    /// 250 ms covers 236 of 238 live first showings (the WMI change came after at most 133 ms in those).
    public const double SpecMs = 250;

    static string Ms(double v) { return Math.Round(v, 1).ToString(System.Globalization.CultureInfo.InvariantCulture); }

    /// On-screen ms inside (now - window, now]: closed spans [s0, e0, s1, e1, ...] plus an open one
    /// since `openSince` (0 = none open).
    public static double OnScreenWithin(IList<double> spans, double openSince, double now, double window) {
      double from = now - window, sum = 0;
      for (int i = 0; i + 1 < spans.Count; i += 2) {
        double a = Math.Max(spans[i], from), b = Math.Min(spans[i + 1], now);
        if (b > a) sum += b - a;
      }
      if (openSince > 0) { double a = Math.Max(openSince, from); if (now > a) sum += now - a; }
      return sum;
    }

    /// null = keep answering; otherwise why Mantle gives up this burst, in words with the measurement.
    /// spanMs: how long the current (or just-closed) on-screen span lasted; answers: Mantle's moves in it;
    /// inWindowMs: OnScreenWithin(..., WindowMs).
    public static string Judge(double spanMs, int answers, double inWindowMs) {
      if (spanMs > DeadlineMs)
        return answers > 1
          ? "Windows kept putting its brightness pop-up straight back: Mantle moved it off " + answers + " times and it was on screen " +
            Ms(spanMs) + " ms (the limit is " + DeadlineMs + " ms)"
          : "Windows' brightness pop-up was on screen " + Ms(spanMs) + " ms before moving it off took effect (the limit is " + DeadlineMs + " ms)";
      if (inWindowMs > BudgetMs)
        return "Windows kept putting its brightness pop-up back faster than Mantle could move it off: on screen " + Ms(inWindowMs) +
               " ms of the last " + WindowMs + " ms (the limit is " + BudgetMs + " ms)";
      return null;
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
    static string _disabled;                   // why hiding stopped (3 failed bursts in a row)
    static int _failStreak;                    // failed bursts in a row; a burst that ends hidden resets it
    static string _lastError;

    static double _lastBright = -1e12;
    static int _level = -1;
    static IntPtr _pend; static double _pendAt; static bool _pendParked; static int _pendX, _pendY; static uint _pendAge; static int _pendGen;
    // the session: one showing of Windows' pop-up, from its SHOW to its HIDE
    static IntPtr _s; static string _sState, _sHow, _sWhy; static double _sAt, _sHiddenAt, _sLastChange;
    static uint _sAge; static int _sFights, _sReshows, _sChanges, _sGen, _sEndGen; static bool _sPre, _sExpectHide;
    // parked at its SHOW, before a brightness change said what it is (see SpecMs); _sEarly stays set once confirmed
    static bool _sSuspect, _sEarly; static int _sW, _sH, _sOx, _sOy;
    static int _nEarly, _nOther; static string _lastOther;
    // its answers: a SPAN opens when it is seen on screen and closes when it is seen off (NowMs times)
    static double _sOnSince, _sWorst, _sOnTotal;
    static int _sAnswers, _sSpanAnswers, _sLocSince, _sSpanGen, _sSpanN;
    static readonly List<double> _sSpans = new List<double>();   // closed spans [start, end, ...] of the last WindowMs
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
      if (hwnd == _s && _sState == "failed") {               // this burst was given up: Windows' own shows
        if (parked) Unpark(hwnd, "Mantle gave up hiding it for this burst, so Windows' own pop-up shows");
        return;
      }
      if (hwnd == _s && _sState != null && _sState != "dry") {
        _sReshows++;                                         // shown again inside a burst (after an SW_HIDE)
        if (parked) { OffScreenNow(true); return; }          // shown where Mantle left it: already off screen
        OnScreenNow(hwnd, ox, oy, true);
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
      if (ParkAtShow("wait", parked, _disabled != null, IsDry(hwnd))) {   // park it NOW; the brightness change decides (SpecMs)
        uint dpi = 0;
        try { dpi = N.GetDpiForWindow(hwnd); } catch (Exception) { }
        double sc = dpi > 0 ? dpi / 96.0 : 1;
        if (_s != IntPtr.Zero && _s != hwnd) EndSession("another pop-up window took over");
        StartSession(hwnd, ox, oy, false, age, now, "parked at its show, before any brightness change", true);
        _sW = (int)Math.Round(w / sc); _sH = (int)Math.Round(h / sc);
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
      if (_sExpectHide) {                                    // our own SW_HIDE (only when a move was refused)
        _sExpectHide = false;
        if (_sState == "hiding" || _sState == "hidden") OffScreenNow(true);
        return;
      }
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
        if (_s != IntPtr.Zero && _sSuspect) {                 // parked at its show: it IS the brightness pop-up
          _sSuspect = false; _sChanges = 1; _sLastChange = now; ArmEnd();
          if (_sState == "failed") CountFail(_sWhy);
          else _sWhy = "a brightness change " + Math.Round(now - _sAt) + " ms after it showed (parked at its show)";
          if (_sState == "hidden") _nHidden++;
          if (_sState != "hiding") EmitChange();              // hiding: Confirm() pushes the level
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
      StartSession(hwnd, ox, oy, parked, age, showAt, why, false);
    }

    /// suspect: parked at its show before a brightness change said it is the brightness pop-up (SpecMs).
    static void StartSession(IntPtr hwnd, int ox, int oy, bool parked, uint age, double showAt, string why, bool suspect) {
      if (_s != IntPtr.Zero && _s != hwnd) EndSession("another pop-up window took over");
      _s = hwnd; _sAt = showAt; _sAge = age; _sWhy = why; _sHow = null; _sHiddenAt = 0; _sPre = false;
      _sFights = 0; _sReshows = 0; _sChanges = suspect ? 0 : 1; _sLastChange = NowMs(); _sExpectHide = false; _sGen++;
      _sOnSince = 0; _sWorst = 0; _sOnTotal = 0; _sAnswers = 0; _sSpanAnswers = 0; _sLocSince = 0; _sSpanN = 0;
      _sSpans.Clear(); _sSpanGen++;
      _sSuspect = suspect; _sEarly = suspect; _sOx = ox; _sOy = oy; _sW = 0; _sH = 0;
      ArmEnd();
      if (suspect) {
        _nEarly++;
        int g = _sGen;
        After((int)SpecMs, delegate { lock (_g) { if (g == _sGen && _sSuspect) NotBrightness(); } });
      }
      if (_disabled != null) {
        _sState = "failed"; _sWhy = _disabled; _nFailed++;
        if (parked) Unpark(hwnd, "Mantle has stopped hiding it (" + _disabled + ")");   // never NO pop-up
        EmitChange();
        return;
      }
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
      _sState = "hiding";
      OnScreenNow(hwnd, ox, oy, false);                      // its first span starts now: before, it was not known to be this pop-up
    }

    /// One answer: move it off screen (ASYNC: explorer's thread applies it, ours never waits). If Windows
    /// refuses the move, hide it instead; explorer shows it again on its next step (a re-show, answered
    /// the same way). Verified by OffScreenNow, never assumed.
    static void Answer(IntPtr hwnd, int ox, int oy) {
      _sState = "hiding"; _sAnswers++; _sSpanAnswers++; _sLocSince = 0;
      if (N.SetWindowPos(hwnd, IntPtr.Zero, Park + ox, Park + oy, 0, 0, SWP_MOVE_ONLY)) {
        _sHow = "parked"; _parked[hwnd] = true;
        return;
      }
      _lastError = "moving Windows' brightness pop-up off screen was refused (SetWindowPos, Win32 error " +
                   Marshal.GetLastWin32Error() + "), so it was hidden instead";
      if (_sHow != "hidden") Program.EmitLog("warn", "osd: " + _lastError);   // once per burst, not once per step
      _sHow = "hidden"; _sExpectHide = true;
      N.ShowWindowAsync(hwnd, 0);                            // SW_HIDE
    }

    static bool OffScreen(IntPtr h) {
      if (!N.IsWindowVisible(h)) return true;
      N.RECT r;
      return N.GetWindowRect(h, out r) && InBand(r.L, r.T);
    }

    /// Seen ON screen inside a burst (its first showing, a move back, a re-show). Opens a span and answers
    /// it; inside an open span it answers again only once our last move has landed and been undone (2+
    /// LOCATIONCHANGEs since it: its own plus Windows' - not one per event, which would multiply) or on a
    /// re-show. Then judges the burst. Returns whether it answered (= Windows put it back).
    static bool OnScreenNow(IntPtr hwnd, int ox, int oy, bool reshow) {
      double now = NowMs();
      bool open = _sOnSince > 0, answer = !open || reshow || _sLocSince >= 2;
      // judged BEFORE answering, so giving up never leaves a move of ours on its way
      string why = Judge(open ? now - _sOnSince : 0, _sSpanAnswers, OnScreenWithin(_sSpans, _sOnSince, now, WindowMs));
      if (why != null) { Fail(why); return answer; }
      if (!open) {
        _sOnSince = now; _sSpanAnswers = 0;
        int sg = ++_sSpanGen;
        After((int)DeadlineMs, delegate { lock (_g) { Deadline(sg); } });
      }
      if (answer) Answer(hwnd, ox, oy);
      return answer;
    }

    /// Closes the open span (if any) at `now`; returns its length (0 = none was open).
    static double CloseSpan(double now) {
      if (_sOnSince == 0) return 0;
      double span = now - _sOnSince;
      _sSpans.Add(_sOnSince); _sSpans.Add(now);
      while (_sSpans.Count >= 2 && _sSpans[1] <= now - WindowMs) _sSpans.RemoveRange(0, 2);
      if (span > _sWorst) _sWorst = span;
      _sOnTotal += span; _sSpanN++;
      _sOnSince = 0; _sSpanGen++;
      return span;
    }

    /// Seen OFF screen (parked or hidden). byEvent: its own event says so, so the span's length is exact;
    /// false = a read at the deadline (it went off at some unknown moment before), judged by the budget only.
    static void OffScreenNow(bool byEvent) {
      if (_sState == "failed" || _sState == "dry") return;
      double now = NowMs();
      if (_sOnSince > 0) {
        double span = CloseSpan(now);
        string why = Judge(byEvent ? span : 0, _sSpanAnswers, OnScreenWithin(_sSpans, 0, now, WindowMs));
        if (why != null) { Fail(why); return; }
      }
      if (_sState == "hiding") Confirm();
    }

    /// DeadlineMs after a span opened: if it is still open, it is read once more; still on screen = give up.
    static void Deadline(int sg) {
      if (sg != _sSpanGen || _sOnSince == 0 || _s == IntPtr.Zero || (_sState != "hiding" && _sState != "hidden")) return;
      if (OffScreen(_s)) { OffScreenNow(false); return; }
      double now = NowMs(), span = now - _sOnSince;
      string why = Judge(span, _sSpanAnswers, OnScreenWithin(_sSpans, _sOnSince, now, WindowMs));
      Fail(why ?? ("Windows' brightness pop-up was still on screen " + Ms(span) + " ms after it appeared (the limit is " + DeadlineMs + " ms)"));
    }

    static void OnMoved(IntPtr hwnd) {
      if (_sState == "failed") {                             // a move of ours landed after giving up: put it back
        N.RECT fr;
        if (N.GetWindowRect(hwnd, out fr) && InBand(fr.L, fr.T))
          Unpark(hwnd, "a move Mantle made before giving up landed late; Windows' own pop-up shows this burst");
        return;
      }
      if (_sState != "hiding" && _sState != "hidden") return;
      _sLocSince++;
      N.RECT r;
      if (!N.GetWindowRect(hwnd, out r)) return;
      if (InBand(r.L, r.T) || !N.IsWindowVisible(hwnd)) { OffScreenNow(true); return; }
      if (OnScreenNow(hwnd, r.L, r.T, false)) _sFights++;   // Windows put it back on screen
    }

    static void Confirm() {
      _sState = "hidden";
      if (_sHiddenAt == 0) { _sHiddenAt = NowMs(); if (!_sSuspect) _nHidden++; }   // a suspect counts once confirmed
      EmitChange();
    }

    static void CountFail(string reason) {
      _nFailed++; _failStreak++;
      if (_failStreak >= 3)
        _disabled = "Mantle stopped hiding Windows' brightness pop-up after 3 failed bursts in a row (last: " + reason +
                    "); switching the feature off and on tries again";
    }

    /// SpecMs after its SHOW and still no brightness change: not the brightness pop-up (or WMI is late).
    /// Put it back where Windows had it so Windows' own pop-up shows, say what showed, and keep the old
    /// wait for the rest of AfterMs: a late brightness change still gets it answered on screen.
    static void NotBrightness() {
      IntPtr h = _s; double at = _sAt; uint age = _sAge; int ox = _sOx, oy = _sOy;
      bool failed = _sState == "failed";
      EndSession("no brightness change within " + SpecMs + " ms of its show");   // suspect: quiet, puts it back
      if (failed || h == IntPtr.Zero || !N.IsWindowVisible(h)) return;
      _pend = h; _pendAt = at; _pendParked = false; _pendX = ox; _pendY = oy; _pendAge = age;
      int gen = ++_pendGen;
      After((int)(AfterMs - SpecMs) + 20, delegate {
        lock (_g) { if (gen == _pendGen && _pend == h) _pend = IntPtr.Zero; }
      });
    }

    /// Gives up THIS burst: Mantle's pop-up comes down (osd.js, on the push), and a parked window is put
    /// back so Windows' own pop-up shows the level instead - never two pop-ups, never none.
    static void Fail(string reason) {
      if (_sState == "failed") return;
      CloseSpan(NowMs());
      _sState = "failed"; _sWhy = reason;
      if (!_sSuspect) CountFail(reason);                     // a suspect counts once a brightness change confirms it
      if (_s != IntPtr.Zero) Unpark(_s, "Mantle gave up hiding it for this burst, so Windows' own pop-up shows");
      EmitChange();
    }

    static object HiddenAfter() {
      if (_sHiddenAt == 0) return null;
      if (_sPre) return 0;
      return Math.Round(_sAge + (_sHiddenAt - _sAt), 1);     // from explorer's SHOW, not from ours
    }

    static void EmitChange() {
      if (_sSuspect) return;                                 // not known to be the brightness pop-up yet: Mantle shows nothing
      Features.Event("osd", Json.Obj("kind", "brightness", "phase", "change", "level", _level >= 0 ? (object)_level : null,
        "flyout", _sState ?? "none", "how", _sHow, "hiddenAfterMs", HiddenAfter(), "prepark", _sPre, "early", _sEarly, "fights", _sFights,
        "reshows", _sReshows, "answers", _sAnswers, "dry", _sState == "dry", "reason", _sState == "failed" ? _sWhy : null));
    }

    static void ArmEnd() {
      int gen = ++_sEndGen;
      After(6000, delegate { lock (_g) { if (gen == _sEndGen && _s != IntPtr.Zero) EndSession("no brightness change for 6 s"); } });
    }

    static void EndSession(string why) {
      if (_s == IntPtr.Zero) return;
      CloseSpan(NowMs());
      if (_sSuspect) { EndOther(why); return; }
      if (_sState == "hidden") _failStreak = 0;            // a burst that ended hidden: the failures in a row start over
      object after = HiddenAfter();
      _lastSession = (_sState ?? "none") + (_sHow != null ? " (" + _sHow + ")" : "") +
                     (after != null ? ", off screen " + after + " ms after Windows showed it" : "") +
                     (_sEarly ? " (parked at its show)" : "") +
                     ", " + _sChanges + " change(s), explorer moved it back " + _sFights + "x, re-showed " + _sReshows + "x" +
                     (_sAnswers > 0 ? ", Mantle answered " + _sAnswers + "x (worst " + Ms(_sWorst) + " ms on screen, " +
                                      Ms(_sOnTotal) + " ms in all)" : "") +
                     (_sState == "failed" && _sWhy != null ? "; gave up: " + _sWhy : "") + "; ended: " + why;
      Features.Event("osd", Json.Obj("kind", "brightness", "phase", "end", "flyout", _sState, "how", _sHow,
        "hiddenAfterMs", after, "prepark", _sPre, "early", _sEarly, "fights", _sFights, "moves", _sFights, "reshows", _sReshows,
        "answers", _sAnswers, "worstOnScreenMs", Math.Round(_sWorst, 2), "onScreenMs", Math.Round(_sOnTotal, 2),
        "spans", _sSpanN, "changes", _sChanges, "failStreak", _failStreak,
        "dry", _sState == "dry", "why", why, "reason", _sState == "failed" ? _sWhy : null, "summary", _lastSession));
      _s = IntPtr.Zero; _sState = null; _sGen++; _sSpanGen++; _sExpectHide = false;
    }

    /// A suspect (parked at its show) that never got its brightness change: one of the host's OTHER
    /// pop-ups. Put back - the park, or an SW_HIDE of ours - so Windows' own shows; Mantle showed nothing.
    /// Logged and pushed as phase 'other' with its size, so live use says what else the host carries.
    static void EndOther(string why) {
      IntPtr h = _s;
      double held = NowMs() - _sAt;
      bool byWindows = why == "Windows hid it" || why == "its window closed";
      string putBack = "no brightness change came with it within " + SpecMs + " ms, so it is another Windows pop-up";
      bool back = Unpark(h, putBack);
      if (!back && _sAnswers > 0 && !byWindows) {            // our move may still be on its way: look again once it lands
        After(60, delegate { lock (_g) { if (_s != h) Unpark(h, putBack); } });
      }
      if (!byWindows && _sHow == "hidden" && !N.IsWindowVisible(h)) N.ShowWindowAsync(h, 8);   // SW_SHOWNA: undo our SW_HIDE
      _nOther++;
      _lastOther = "a " + _sW + "x" + _sH + " explorer pop-up, off screen " + Ms(held) + " ms (" + why + ")";
      Features.Event("osd", Json.Obj("kind", "brightness", "phase", "other", "flyout", "none", "w", _sW, "h", _sH,
        "heldMs", Math.Round(held, 1), "why", why, "failed", _sState == "failed", "summary", _lastOther));
      _s = IntPtr.Zero; _sState = null; _sSuspect = false; _sGen++; _sSpanGen++; _sExpectHide = false;
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

    /// The exit path (Program.RequestShutdown, after every restore step): end
    /// the hook thread so its system-wide WinEvent hooks come off ON THAT THREAD
    /// (the only one that can remove them) and it is never called back while
    /// Environment.Exit tears the runtime down - the 0xC000041D exit crash the
    /// loop thread had (2026-09-25). Parked pop-ups are not touched: the
    /// ProcessExit handler above still puts them back. Bounded; null when no
    /// watch was running.
    public static string EndHookThreadForExit(int ms) {
      Thread th = _thread;
      if (th == null) return null;
      try { N.PostThreadMessageW(_tid, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch (Exception) { }
      bool ended;
      try { ended = th.Join(ms); } catch (Exception) { ended = false; }
      return ended ? "brightness pop-up watch: hook thread ended, hooks off"
                   : "brightness pop-up watch: hook thread did not end within " + ms + " ms";
    }

    static IDictionary State() {
      lock (_g) {
        return Json.Obj("ok", true, "watching", _watching, "reason", _watchWhy, "disabled", _disabled,
          "dry", Program.Passive, "targetPid", _targetPid, "shellPid", (long)_shellPid, "locHooked", _hLoc != IntPtr.Zero,
          "level", _level >= 0 ? (object)_level : null, "session", _s == IntPtr.Zero ? null : _sState,
          "parked", _parked.Count, "shows", _nShows, "hidden", _nHidden, "prepark", _nPre, "dryRuns", _nDry,
          "failed", _nFailed, "ignored", _nIgnored, "lastIgnored", _lastIgnored, "lastSession", _lastSession,
          "early", _nEarly, "other", _nOther, "lastOther", _lastOther, "suspect", _s != IntPtr.Zero && _sSuspect,
          "lastError", _lastError, "failStreak", _failStreak,
          "limits", Json.Obj("deadlineMs", DeadlineMs, "windowMs", WindowMs, "budgetMs", BudgetMs, "specMs", SpecMs));
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
      if (op == "judge") {                                  // PURE: the give-up rule on made-up spans (ms)
        var spans = new List<double>();
        object so;
        var sl = Json.TryGet(req, "spans", out so) ? so as List<object> : null;
        if (sl != null) foreach (object v in sl) if (v is double) spans.Add((double)v);
        double jnow = Num(req, "now", 0), open = Num(req, "openSince", 0);
        double inWin = OnScreenWithin(spans, open, jnow, WindowMs);
        string jwhy = Judge(open > 0 ? jnow - open : Num(req, "spanMs", 0), Json.GetInt(req, "answers", 1), inWin);
        result = Json.Obj("ok", true, "giveUp", jwhy != null, "reason", jwhy, "inWindowMs", Math.Round(inWin, 3),
                          "deadlineMs", DeadlineMs, "windowMs", WindowMs, "budgetMs", BudgetMs);
        return null;
      }
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
        if (op == "match") {
          result = Json.Obj("ok", true, "verdict", verdict, "reason", why, "looks", looks == null,
                            "parkAtShow", ParkAtShow(verdict, Json.GetBool(req, "parked", false), Json.GetBool(req, "disabled", false), Json.GetBool(req, "dry", false)),
                            "specMs", SpecMs);
          return null;
        }
        if (!Program.Passive) return "osd.bright simulate is a test command and runs only in --passive";
        int lv = Json.GetInt(req, "level", 70);
        string flyout = verdict == "hide" ? "dry" : "none";
        Program.EmitLog("info", "osd: DRY RUN (simulated, --passive): a made-up brightness pop-up -> " + verdict + " (" + why + "); nothing was moved");
        Features.Event("osd", Json.Obj("kind", "brightness", "phase", "change", "level", lv, "flyout", flyout,
                                       "dry", true, "simulated", true, "reason", verdict == "hide" ? null : why));
        result = Json.Obj("ok", true, "verdict", verdict, "reason", why, "flyout", flyout, "level", lv);
        return null;
      }
      return "osd.bright needs op 'watch', 'state', 'restore', 'match', 'judge', 'inject' or 'simulate' (got '" + op + "')";
    }
  }
}
