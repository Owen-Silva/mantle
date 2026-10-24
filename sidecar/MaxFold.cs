// MaxFold.cs - a QUICK unfold when any app window maximizes or restores (lane unfold-max, 2026-10-23).
//
// WHAT THE USER SEES (Owen: "EXACTLY like the iPhone Duo", ONE version; 23:10: "barely any" tint, lighter):
// for ~0.24 s after a window maximizes or restores, its live content holds still at the NEW rect while the
// "display opens around it": the cover half (left by default) is in place and sharp, the other half
// swings open from the hinge in the centre (its visible width grows 0 -> W/2), blurred progressively toward
// its moving free edge (cubic falloff, sharp AT the hinge), darkened toward that edge in one smooth
// gradient, a faint Mantle indigo (#4436E8) hint only right at that edge; the not-yet-open part shows the
// window's outline, dim and soft; the whole screen starts a little darker and brightens; the last frame is
// identical to the window, so hiding the overlay is invisible. Click-through, never activates, never delays input.
// "Animation effects" off (SPI_GETCLIENTAREAANIMATION) = a 120 ms cross-fade only.
//
// HOW (phase 1, measured on Owen's i3-1215U, 1920x1080 @125 %; scratch notes in the lane's handoff):
// - Detection: a global out-of-context WinEvent hook (EVENT_OBJECT_LOCATIONCHANGE + the IsZoomed
//   transition) knows 1.1-2.4 ms (median) after ShowWindow; ~4 events/s while working, 0.10 % of a core.
//   There is no earlier warning out of process (the shell hook sends no GETMINRECT for max/restore).
// - CPU captures are too slow (PrintWindow 24-39 ms, BitBlt 31-50 ms, + blur/scale): REJECTED. Instead the
//   overlay draws DWM thumbnails of the LIVE window ("taps"): registering 8-16 costs 0.6-1.2 ms, updating
//   0.4-1.0 ms a frame; on screen 12/16/24 full-screen taps gave 0 missed/dropped/late DWM frames.
//   A tap is pixel-exact only with rcSource = rcDestination in size (1:1), and a rcDestination outside the
//   overlay is CLAMPED, so every offset is made by shifting rcSource, never rcDestination.
// - Blur = several 1:1 taps of the same strip, ~1.4 px apart along the opening axis with gaussian weights,
//   stacked (alpha_k = w_k / what is still uncovered above it) over the overlay's own opaque near-black
//   base; strips on small steps of radius (cubic in the distance from the hinge, capped at R_CAP where the
//   taps would stand apart as copies). Darkening = two more thumbnails over the taps, of a tiny cloaked
//   per-pixel-alpha ramp window stretched over the panel (a linear ramp and a cubic faint-indigo one), so it
//   is one smooth gradient, not a step per strip; without them it falls back to per-strip coverage (said).
//   Tap budget 80 (+2 veils), shrunk for the rest of a play when a frame's taps take > 7 ms to set.
//
// WINDOWS' OWN ANIMATION STAYS ON (no SPI change, nothing global). Maximize: Windows' morph grows inside the
// new rect, under our opaque overlay, which stays up (converged = identical) until holdMs after the event.
// Restore: Windows' shrink morph would show OUTSIDE the new rect, so the FOREGROUND window, while it is
// maximized, gets DWMWA_TRANSITIONS_FORCEDISABLED (at most ONE window at a time; side effect: that one
// window also minimizes/closes without Windows' animation); cleared once its restore play has started, when
// it stops being foreground, minimizes or closes, and on off/stop/rest/exit. A restore of a window that is
// not flagged is skipped ("Windows animates this restore itself").
// CRASH SAFETY: that attribute is the ONE thing changed in Windows. Before setting it the record
// "maxfold-windows.json" ({hwnd, pid, set:true, assumedOriginal:false}; the attribute cannot be read back:
// DwmGetWindowAttribute answers E_INVALIDARG for it) is written beside Program.StateFilePath (else %TEMP%;
// passive: %TEMP%\mantle-maxfold-test). A record still there at the next start (Register, which Program runs
// before ready) or at the first config = a crash: the attribute is cleared if the pid still matches, the
// record deleted, and it is said (event restored-stale + a warn log). tools/restore-windows.ps1 f5 does the
// same from the record. RestoreForExit() is the Program.SafetyRestore hook.
//
// Commands (lane Ui): maxfold.config / maxfold.state / maxfold.decide (pure) / maxfold.flag (test only) /
// maxfold.pose (test only: one frozen frame at a given p, for the frame checks). Events: "maxfold"
// {kind: play | skip | done | restored-stale}. NEVER a window title, class, exe name or path, ever.
// A passive (test) sidecar animates, flags and poses ONLY windows its harness made (Snap.OursToMove's rule).
//
// THREADING: one thread "mantle-maxfold" owns the hooks, the overlay window, the thumbnails and the frame loop
// (UnhookWinEvent only from it). It exists only while switched on; nothing ticks between plays (it blocks in
// GetMessage); while switched off there is no thread, no hook, no window, no timer.
// C# 5 only, no /unsafe.
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
  public static class MaxFold {
    // ------------------------------------------------------------ the skip reasons (lib/features/maxfold.js REASONS)
    public const string R_OFF = "switched off";
    public const string R_TEST = "a test run only animates its own test windows";
    public const string R_MANTLE = "one of Mantle's own windows";
    public const string R_FULLAPP = "a full-screen app or game is running";
    public const string R_FULLWIN = "the window is full screen";
    public const string R_TOOL = "a tool window";
    public const string R_DRAG = "the window is being dragged";
    public const string R_SMALL = "too small to animate";
    public const string R_CLOAKED = "the window is hidden or on another desktop";
    public const string R_AFFINITY = "the app hides itself from screen capture";
    public const string R_WINANIM = "Windows animates this restore itself";
    public const string R_GONE = "the window changed before the unfold could start";
    public static string R_Thumb(int hr) { return "Windows would not let Mantle draw the window (0x" + hr.ToString("X8") + ")"; }

    const string TestOnly = "maxfold.{0} is for tests only (a passive sidecar)";
    // Tap budget: 80 thumbnails at most, 24 new registrations a frame, 14 taps in one strip (A/B against the
    // old 17-25-tap build on this machine: no frame gap over 20 ms in 24 plays with up to 78 taps; 94 taps
    // gave 12-24 ms renders and 30 ms gaps).
    const int MAX_POOL = 80, GROW_PER_FRAME = 24, MAX_TAPS_PER_STRIP = 14;
    // Time guard: a frame whose taps took longer than SLOW_MS to set (DWM busy) shrinks the next frames' tap
    // budget by a third (never below MIN_BUDGET): a little less blur instead of a skipped frame.
    const double SLOW_MS = 7.0; const int MIN_BUDGET = 24;
    const double GOLDEN = 2.39996323;
    // The blur: strips sit on small steps of blur radius (STEP_PX, or STEP_REL of the radius once larger, so the
    // cubic falloff has no visible seams), taps per strip grow with the radius (TAPS_PER_PX, ~1.4 px apart, so
    // they overlap into a smooth smear instead of standing apart as copies), gaussian weights (SIGMA, in units
    // of the radius). The smear runs along the opening axis only (ASPECT_Y 0): every strip is the window's full
    // height, so a vertical shift cannot stay inside the window's frame (it would be clamped to an exact copy).
    const double STEP_PX = 1.0, STEP_REL = 0.2, TAPS_PER_PX = 1.3, ASPECT_Y = 0.0, SIGMA = 0.5;
    // The widest blur a strip draws: what MAX_TAPS_PER_STRIP taps fill at ~1.4 px spacing. A wider radius
    // with the same taps shows the copies (measured on the frames: 17 px with 14 taps read as double text).
    const double R_CAP = 9.0;
    // The veil: one more thumbnail, of a tiny cloaked window holding a per-pixel-alpha ramp of the base colour
    // (alpha 0 at the hinge -> 1 at the free edge), stretched over the opening panel at opacity darkCap-ish:
    // the darkening and indigo tint as ONE smooth gradient, drawn over the taps, instead of a step per strip.
    // The second veil (the shade) follows the blur's cubic falloff: opacity min(SHADE_CAP, SHADE_PER_S * s).
    const int VEIL_W = 256, VEIL_H = 4;
    // Owen 23:10: "barely any" tint, lighter, the window's outline visible throughout. The shade is the one
    // faint indigo hint (SHADE_MIX of the tint over black); the not-yet-open part shows the window at BEYOND.
    const double SHADE_CAP = 0.22, SHADE_PER_S = 0.55, SHADE_MIX = 0.22, BEYOND = 0.24;
    const double BEYOND_TAPS_PER_PX = 1.0; const int BEYOND_MAX_TAPS = 10;

    // ------------------------------------------------------------ settings (scratch/SPEC-LOOK.md "Config")
    sealed class Cfg {
      public int Ms = 240; public double[] Curve; public double BlurFrac = 0.012;
      public int TintR = 0x44, TintG = 0x36, TintB = 0xE8;
      public double BaseMix = 0.06, InnerDark = 0.18, DarkCap = 0.32;
      public int Strips = 24; public bool CoverLeft = true; public int HoldMs = 300;
      public bool Invisible, DryRun;
      public int TestWinAnim = -1, TestReduced = -1; // passive only: stand-ins for the two Windows settings
      /// The shade veil's colour: the only place the indigo shows, faintly, near the moving edge.
      public uint ShadeColorRef() {
        int r = Clamp((int)Math.Round(TintR * SHADE_MIX), 0, 255), g = Clamp((int)Math.Round(TintG * SHADE_MIX), 0, 255), b = Clamp((int)Math.Round(TintB * SHADE_MIX), 0, 255);
        return (uint)(r | (g << 8) | (b << 16));
      }
      public uint BaseColorRef() {
        int r = Clamp((int)Math.Round(TintR * BaseMix), 0, 255), g = Clamp((int)Math.Round(TintG * BaseMix), 0, 255), b = Clamp((int)Math.Round(TintB * BaseMix), 0, 255);
        return (uint)(r | (g << 8) | (b << 16));
      }
    }

    /// The facts one decision is made from (gathered on the thread, or given to maxfold.decide).
    public sealed class Facts {
      public bool Armed, Passive, Harness, Mantle, FullScreenApp, FullScreenWindow, Tool, Child, Dragging, Cloaked;
      public bool Restore, WinAnim, Flagged, Reduced;
      public int W, H; public uint Affinity; public int ThumbHr;
    }

    /// The PURE decision (scratch/SPEC.md "Decide"; first match wins). True = play, `mode` full | reduced.
    public static bool Decide(Facts f, out string reason, out string mode) {
      mode = null;
      if (!f.Armed) { reason = R_OFF; return false; }
      if (f.Passive && !f.Harness) { reason = R_TEST; return false; }
      if (!f.Passive && f.Mantle) { reason = R_MANTLE; return false; }
      if (f.FullScreenApp) { reason = R_FULLAPP; return false; }
      if (f.FullScreenWindow) { reason = R_FULLWIN; return false; }
      if (f.Tool || f.Child) { reason = R_TOOL; return false; }
      if (f.Dragging) { reason = R_DRAG; return false; }
      if (f.W < 240 || f.H < 160) { reason = R_SMALL; return false; }
      if (f.Cloaked) { reason = R_CLOAKED; return false; }
      if (f.Affinity != 0) { reason = R_AFFINITY; return false; }
      if (f.Restore && f.WinAnim && !f.Flagged) { reason = R_WINANIM; return false; }
      if (f.ThumbHr != 0) { reason = R_Thumb(f.ThumbHr); return false; }
      reason = null; mode = f.Reduced ? "reduced" : "full";
      return true;
    }

    // ------------------------------------------------------------ shared state (_gate)
    static readonly object _gate = new object();
    static Cfg _cfg = new Cfg();
    static Thread _thread;
    static int _tid;
    static bool _armed, _hooked;
    static string _why = R_OFF;
    static volatile bool _stop;
    static readonly Queue<Action> _q = new Queue<Action>();
    static int _plays, _doneCount, _cancelledCount, _flagsSet;
    static readonly Dictionary<string, int> _skips = new Dictionary<string, int>(StringComparer.Ordinal);
    static IDictionary _last;
    static bool _playingPub, _overlayVisPub;
    static long _overlayPub, _flaggedPub;
    static int _staleAtStart;              // restored in Register (before anyone listened): said at the first config
    static string _staleNote;
    static bool _sawConfig;

    // ------------------------------------------------------------ thread-owned state
    static IntPtr _overlay, _brush;
    static uint _brushColor = 0xFFFFFFFF;
    static IntPtr _veil;                 // the veil's source window (cloaked; shown only while a play uses it)
    static uint _veilColor = 0xFFFFFFFF, _veilShade = 0xFFFFFFFF;
    static string _veilWhy;              // null = the veil works; else why the darkening falls back to per-strip steps
    static bool _veilShown;
    static bool _overlayTop;
    static N.WinEventProc _evProc;
    static N.WndProc _wndProc;
    static bool _classMade;
    static IntPtr _hLoc, _hFg, _hObj;
    static readonly Dictionary<long, byte> _zoom = new Dictionary<long, byte>();
    static readonly Dictionary<int, bool> _harnessPid = new Dictionary<int, bool>();
    static Play _play, _pose;
    static IntPtr _flagged;
    static int _flaggedPid, _flagHr;
    static bool _flagSet, _flagPinned;
    static Timer _watchdog;
    static int _playSeq;
    static volatile int _watchSeq;
    static volatile bool _watchFired;
    static string _hookProblem;
    static int _fgHarness;               // passive: foreground events for the harness's own windows (a test asserts 0)

    const uint WM_RUN = 0x8000 + 0x4D1, WM_STOP = 0x8000 + 0x4D2, WM_KICK = 0x8000 + 0x4D3;
    static readonly double QpcMs = 1000.0 / Stopwatch.Frequency;

    sealed class Play {
      public int Seq; public IntPtr Target; public string Action; public bool Reduced; public Cfg C;
      public N.RECT WR, T; public int W, H, SrcOX, SrcOY, FrL, FrT, FrR, FrB;
      public long T0; public uint EventTick; public double QueueMs, ShowMs; public long ShownQpc;
      public int Frames; public readonly List<double> Gaps = new List<double>(); public long LastFlush;
      public ulong Missed0, Dropped0; public bool TimingOk;
      public bool Converged, LastExact; public long HoldUntil; public int MaxTaps;
      public readonly List<IntPtr> Pool = new List<IntPtr>(); public int Visible; public int GrowHr;
      public bool[] Keys; public uint LastInput; public bool Posed;
      public string Mode;
      public readonly IntPtr[] Veil = new IntPtr[2]; public int VeilAt = -1; public readonly bool[] VeilVis = new bool[2]; public int VeilHr; public int VeilRegs; public bool VeilUsed;
      public readonly List<double> RenderMs = new List<double>(); public double GrowMsMax; public int PoolMax; public int Budget = MAX_POOL; public int Sheds; public bool First;
      public readonly long[] Split = new long[6]; // first-frame stages: facts, thumbnail, taps, resize, show, paint
    }

    // ------------------------------------------------------------ registration
    public static void Register(FeatureTable t) {
      t.Add("maxfold.config", Lanes.Ui, Config);
      t.Add("maxfold.state", Lanes.Ui, State);
      t.Add("maxfold.decide", Lanes.Ui, DecideCmd);
      t.Add("maxfold.flag", Lanes.Ui, FlagCmd);
      t.Add("maxfold.pose", Lanes.Ui, PoseCmd);
      t.Add("maxfold.stall", Lanes.Ui, StallCmd);
      // A crash last run left the attribute on a window: put it back NOW (Program builds this table before
      // its ready line). A passive sidecar waits for its first config (its record is the test's own).
      if (!Program.Passive) {
        try {
          string note = RestoreStale();
          if (note != null) { lock (_gate) { _staleAtStart++; _staleNote = note; } }
        } catch (Exception ex) {
          Program.EmitLog("warn", "maxfold: could not check the window animation record (" + ex.GetType().Name + ": " + ex.Message + ")");
        }
      }
    }

    // ------------------------------------------------------------ commands
    static string Config(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", false);
      bool firstConfig;
      lock (_gate) { firstConfig = !_sawConfig; _sawConfig = true; }
      int stale = 0; string staleNote = null;
      lock (_gate) { stale = _staleAtStart; staleNote = _staleNote; _staleAtStart = 0; _staleNote = null; }
      if (firstConfig) {
        try { string n = RestoreStale(); if (n != null) { stale++; staleNote = n; } } catch (Exception ex) {
          Program.EmitLog("warn", "maxfold: could not check the window animation record (" + ex.GetType().Name + ": " + ex.Message + ")");
        }
      }
      for (int i = 0; i < stale; i++) Features.Event("maxfold", Json.Obj("kind", "restored-stale", "note", staleNote));

      if (!on) {
        StopThread(2500);
        result = ConfigAnswer();
        return null;
      }
      Cfg c = ParseCfg(req);
      lock (_gate) _cfg = c;
      Thread th;
      lock (_gate) th = _thread;
      if (th != null && th.IsAlive) {
        Post(delegate { ApplyLook(c); });
      } else {
        string err = StartThread(3000);
        if (err != null) { lock (_gate) { _armed = false; _why = err; } }
      }
      result = ConfigAnswer();
      return null;
    }

    static IDictionary ConfigAnswer() {
      bool armed, hooked, inv; string why;
      lock (_gate) { armed = _armed; hooked = _hooked; why = _armed ? null : _why; inv = _cfg.Invisible; }
      return Json.Obj("armed", armed, "hooked", hooked, "why", why, "winAnim", WinAnim(), "reduced", !ClientAnim(),
                      "passive", Program.Passive, "recordFile", RecordPath(), "invisible", inv);
    }

    static Cfg ParseCfg(Dictionary<string, object> req) {
      var c = new Cfg();
      c.Ms = Clamp(Json.GetInt(req, "ms", 240), 60, 2000);
      c.BlurFrac = Math.Max(0, Math.Min(0.027, Num(req, "blurFrac", 0.012)));
      c.BaseMix = Clamp01(Num(req, "baseMix", 0.06));
      c.InnerDark = Clamp01(Num(req, "innerDark", 0.18));
      c.DarkCap = Clamp01(Num(req, "darkCap", 0.32));
      c.Strips = Clamp(Json.GetInt(req, "strips", 24), 1, 32);
      c.HoldMs = Clamp(Json.GetInt(req, "holdMs", 300), 0, 1500);
      string cover = Json.GetString(req, "cover");
      c.CoverLeft = !string.Equals(cover, "right", StringComparison.OrdinalIgnoreCase);
      c.Invisible = Json.GetBool(req, "invisible", false);
      c.DryRun = Json.GetBool(req, "dryRun", false);
      if (Program.Passive) {
        // A test cannot change Windows' animation settings (never write real settings from a test), so a
        // passive sidecar takes stand-ins for the two reads; a live one never does.
        if (Json.HasKey(req, "testWinAnim")) c.TestWinAnim = Json.GetBool(req, "testWinAnim", true) ? 1 : 0;
        if (Json.HasKey(req, "testReduced")) c.TestReduced = Json.GetBool(req, "testReduced", false) ? 1 : 0;
      }
      object v;
      if (Json.TryGet(req, "tint", out v)) {
        var d = v as Dictionary<string, object>;
        if (d != null) { c.TintR = Clamp(Json.GetInt(d, "r", 0x44), 0, 255); c.TintG = Clamp(Json.GetInt(d, "g", 0x36), 0, 255); c.TintB = Clamp(Json.GetInt(d, "b", 0xE8), 0, 255); }
      }
      if (Json.TryGet(req, "curve", out v)) {
        var l = v as List<object>;
        if (l != null && l.Count >= 2) {
          var a = new double[l.Count]; bool ok = true;
          for (int i = 0; i < l.Count; i++) { if (!(l[i] is double) || double.IsNaN((double)l[i])) { ok = false; break; } a[i] = (double)l[i]; }
          if (ok) c.Curve = a;
        }
      }
      return c;
    }

    static string State(Dictionary<string, object> req, ref object result) {
      lock (_gate) {
        var skips = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var kv in _skips) skips[kv.Key] = kv.Value;
        bool alive = _thread != null && _thread.IsAlive;
        result = Json.Obj("armed", _armed, "hooked", _hooked, "why", _armed ? null : _why, "playing", _playingPub,
          "plays", _plays, "done", _doneCount, "cancelled", _cancelledCount, "skips", skips, "last", _last,
          "overlay", _overlayPub, "overlayVisible", _overlayVisPub,
          "flagged", _flaggedPub != 0 ? 1 : 0, "flaggedHwnd", _flaggedPub != 0 ? (object)_flaggedPub : null, "flagsSet", _flagsSet,
          "recordFile", RecordPath(), "recordExists", RecordExists(),
          "winAnim", WinAnim(), "reduced", !ClientAnim(), "invisible", _cfg.Invisible, "dryRun", _cfg.DryRun,
          "passive", Program.Passive, "thread", alive ? "running" : "ended", "hookProblem", _hookProblem, "fgHarness", _fgHarness,
          "veil", !_armed ? null : _veilWhy == null ? "on" : "off (" + _veilWhy + ")");
      }
      return null;
    }

    static string DecideCmd(Dictionary<string, object> req, ref object result) {
      object v; Dictionary<string, object> d = null;
      if (Json.TryGet(req, "facts", out v)) d = v as Dictionary<string, object>;
      if (d == null) return "maxfold.decide needs {facts:{...}}";
      var f = new Facts();
      f.Armed = Json.GetBool(d, "armed", true); f.Passive = Json.GetBool(d, "passive", false); f.Harness = Json.GetBool(d, "harness", false);
      f.Mantle = Json.GetBool(d, "mantle", false); f.FullScreenApp = Json.GetBool(d, "fullScreenApp", false);
      f.FullScreenWindow = Json.GetBool(d, "fullScreenWindow", false); f.Tool = Json.GetBool(d, "tool", false); f.Child = Json.GetBool(d, "child", false);
      f.Dragging = Json.GetBool(d, "dragging", false); f.Cloaked = Json.GetBool(d, "cloaked", false);
      f.Restore = string.Equals(Json.GetString(d, "action"), "restore", StringComparison.Ordinal);
      f.WinAnim = Json.GetBool(d, "winAnim", false); f.Flagged = Json.GetBool(d, "flagged", false); f.Reduced = Json.GetBool(d, "reduced", false);
      f.W = Json.GetInt(d, "w", 1000); f.H = Json.GetInt(d, "h", 700); f.Affinity = (uint)Math.Max(0, Json.GetInt(d, "affinity", 0));
      f.ThumbHr = (int)(long)Num(d, "thumbHr", 0);
      string reason, mode; bool play = Decide(f, out reason, out mode);
      result = Json.Obj("play", play, "reason", reason, "mode", mode);
      return null;
    }

    /// TEST ONLY: set/clear the attribute on one of the harness's own windows (the auto rule never does it for
    /// a window that is not foreground, and a test window never is).
    static string FlagCmd(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return string.Format(TestOnly, "flag");
      IntPtr h = Json.GetHwnd(req, "window");
      if (h == IntPtr.Zero || !N.IsWindow(h)) return "maxfold.flag needs {window} = a window that exists";
      int pid; N.GetWindowThreadProcessId(h, out pid);
      if (!IsHarness(pid)) return FeatureTable.PassiveRefusal + ": maxfold.flag would change a window on the live desktop (a test may only flag a window its own harness made)";
      bool on = Json.GetBool(req, "on", true), dry = Json.GetBool(req, "dryRun", false);
      object r = Invoke(delegate {
        if (on) { Unflag(); Flag(h, dry || CurCfg().DryRun, true); }
        else if (_flagged == h) Unflag();
        return Json.Obj("flagged", _flagged == h, "set", _flagged == h && _flagSet, "hr", _flagHr, "recordExists", RecordExists());
      }, 2000);
      if (r is string) return (string)r;
      result = r;
      return null;
    }

    /// TEST ONLY: one frozen frame at progress p over one of the harness's own windows, for the frame checks
    /// ({window, p, action, reduced}); {off:true} hides it. Answers the geometry that was drawn.
    static string PoseCmd(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return string.Format(TestOnly, "pose");
      bool off = Json.GetBool(req, "off", false);
      IntPtr h = Json.GetHwnd(req, "window");
      if (!off) {
        if (h == IntPtr.Zero || !N.IsWindow(h)) return "maxfold.pose needs {window} = a window that exists";
        int pid; N.GetWindowThreadProcessId(h, out pid);
        if (!IsHarness(pid)) return FeatureTable.PassiveRefusal + ": maxfold.pose would draw over a window on the live desktop (a test may only use a window its own harness made)";
      }
      double prog = Clamp01(Num(req, "p", 0));
      string action = Json.GetString(req, "action") == "restore" ? "restore" : "maximize";
      bool reduced = Json.GetBool(req, "reduced", false);
      object r = Invoke(delegate {
        if (_pose != null) { EndPose(); }
        if (off) return Json.Obj("off", true);
        if (_play != null) EndPlay(_play, true, "a test pose");
        return Pose(h, action, prog, reduced);
      }, 3000);
      if (r is string) return (string)r;
      result = r;
      return null;
    }

    /// TEST ONLY: blocks the unfold thread for {ms} as soon as the next play has started, so the watchdog's
    /// road (alpha 0 from another thread, then the hide) is driven for real.
    static string StallCmd(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return string.Format(TestOnly, "stall");
      int ms = Clamp(Json.GetInt(req, "ms", 1200), 50, 3000);
      lock (_gate) _stallNextMs = ms;
      result = Json.Obj("armed", ms);
      return null;
    }
    static int _stallNextMs;

    // ------------------------------------------------------------ the thread
    static string StartThread(int waitMs) {
      var started = new ManualResetEvent(false);
      string err = null;
      var th = new Thread(delegate () { ThreadMain(started); });
      th.IsBackground = true;
      th.Name = "mantle-maxfold";
      th.Priority = ThreadPriority.AboveNormal; // the frame loop: 15 frames, then it sleeps in GetMessage
      lock (_gate) { _thread = th; _stop = false; }
      th.Start();
      if (!started.WaitOne(waitMs)) err = "the unfold thread did not start in " + waitMs + " ms";
      started.Close();
      return err;
    }

    static void StopThread(int waitMs) {
      Thread th; int tid;
      lock (_gate) { th = _thread; tid = _tid; }
      if (th == null || !th.IsAlive) { lock (_gate) { _armed = false; _hooked = false; _why = R_OFF; } return; }
      _stop = true;
      if (tid != 0) N.PostThreadMessageW(tid, WM_STOP, IntPtr.Zero, IntPtr.Zero);
      if (!th.Join(waitMs)) Program.EmitLog("warn", "maxfold: the unfold thread did not end in " + waitMs + " ms after switching off (it ends with the sidecar)");
      lock (_gate) { _armed = false; _hooked = false; _why = R_OFF; }
    }

    static void ThreadMain(ManualResetEvent started) {
      bool signalled = false;
      try {
        N.MSG m;
        N.PeekMessageW(out m, IntPtr.Zero, 0, 0, 0); // make this thread's message queue now
        lock (_gate) _tid = (int)N.GetCurrentThreadId();
        string err = MakeOverlay();
        if (err == null) err = Hook();
        if (err != null) {
          lock (_gate) { _armed = false; _hooked = false; _why = err; }
          Program.EmitLog("warn", "maxfold: " + err);
          started.Set(); signalled = true;
          return;
        }
        SeedAll();
        WarmUp();
        _watchdog = new Timer(OnWatchdog, null, Timeout.Infinite, Timeout.Infinite);
        lock (_gate) { _armed = true; _hooked = true; _why = null; _overlayPub = _overlay.ToInt64(); }
        started.Set(); signalled = true;
        Loop();
      } catch (Exception ex) {
        string why = "the unfold stopped after an error (" + ex.GetType().Name + ": " + ex.Message + ")";
        lock (_gate) { _armed = false; _why = why; }
        Program.EmitLog("error", "maxfold: " + why);
      } finally {
        Cleanup();
        lock (_gate) { _armed = false; _hooked = false; if (_why == null) _why = R_OFF; _tid = 0; _overlayPub = 0; _playingPub = false; _overlayVisPub = false; }
        if (!signalled) { try { started.Set(); } catch (Exception) { } }
      }
    }

    static void Loop() {
      N.MSG m;
      while (!_stop) {
        Play p = _play;
        if (p == null) {
          int r = N.GetMessageW(out m, IntPtr.Zero, 0, 0);
          if (r <= 0) break;
          Handle(ref m);
          continue;
        }
        // A play: wait for the composition of what was set, take the gap, then the next frame.
        if (!p.Converged) {
          int hr = N.DwmFlush();
          long now = Stopwatch.GetTimestamp();
          if (hr != 0) N.MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, 8, 0x04FF, 0x4);
          if (p.LastFlush != 0) p.Gaps.Add((now - p.LastFlush) * QpcMs);
          p.LastFlush = now;
        } else {
          double left = (p.HoldUntil - Stopwatch.GetTimestamp()) * QpcMs;
          if (left > 0) N.MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, (uint)Math.Min(16, Math.Ceiling(left)), 0x04FF, 0x4);
        }
        while (N.PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) Handle(ref m);
        if (_stop || _play != p) continue;
        Step(p);
      }
    }

    static void Handle(ref N.MSG m) {
      if (m.hwnd == IntPtr.Zero && m.message == WM_STOP) { _stop = true; return; }
      if (m.hwnd == IntPtr.Zero && m.message == WM_RUN) { Drain(); return; }
      if (m.hwnd == IntPtr.Zero && m.message == WM_KICK) return; // a play started inside a hook callback: GetMessage returns
      N.TranslateMessage(ref m);
      N.DispatchMessageW(ref m);
    }

    static void Drain() {
      while (true) {
        Action a;
        lock (_q) { if (_q.Count == 0) return; a = _q.Dequeue(); }
        try { a(); } catch (Exception ex) { Program.EmitLog("warn", "maxfold: a request on the unfold thread failed (" + ex.GetType().Name + ": " + ex.Message + ")"); }
      }
    }

    static bool Post(Action a) {
      int tid; lock (_gate) tid = _tid;
      if (tid == 0) return false;
      lock (_q) _q.Enqueue(a);
      return N.PostThreadMessageW(tid, WM_RUN, IntPtr.Zero, IntPtr.Zero);
    }

    /// Runs `fn` on the unfold thread and waits; a string answer is an error.
    static object Invoke(Func<object> fn, int waitMs) {
      bool armed; lock (_gate) armed = _armed;
      if (!armed) return "the unfold is switched off (send maxfold.config {on:true} first)";
      object res = null; var done = new ManualResetEvent(false);
      bool posted = Post(delegate {
        try { res = fn(); } catch (Exception ex) { res = ex.GetType().Name + ": " + ex.Message; }
        try { done.Set(); } catch (Exception) { }
      });
      if (!posted) { done.Close(); return "the unfold thread did not take the request"; }
      bool ok = done.WaitOne(waitMs);
      if (!ok) return "the unfold thread did not answer in " + waitMs + " ms";
      done.Close();
      return res;
    }

    static void Cleanup() {
      try { if (_play != null) EndPlay(_play, true, "switched off"); } catch (Exception) { }
      try { if (_pose != null) EndPose(); } catch (Exception) { }
      try { Unflag(); } catch (Exception) { }
      try { DeleteRecord(); } catch (Exception) { }
      try { if (_hLoc != IntPtr.Zero) N.UnhookWinEvent(_hLoc); } catch (Exception) { }
      try { if (_hFg != IntPtr.Zero) N.UnhookWinEvent(_hFg); } catch (Exception) { }
      try { if (_hObj != IntPtr.Zero) N.UnhookWinEvent(_hObj); } catch (Exception) { }
      _hLoc = _hFg = _hObj = IntPtr.Zero;
      try { if (_watchdog != null) _watchdog.Dispose(); } catch (Exception) { }
      _watchdog = null;
      try { if (_overlay != IntPtr.Zero) N.DestroyWindow(_overlay); } catch (Exception) { }
      _overlay = IntPtr.Zero; _overlayTop = false;
      try { if (_veil != IntPtr.Zero) N.DestroyWindow(_veil); } catch (Exception) { }
      _veil = IntPtr.Zero; _veilColor = 0xFFFFFFFF; _veilShown = false;
      try { if (_brush != IntPtr.Zero) N.DeleteObject(_brush); } catch (Exception) { }
      _brush = IntPtr.Zero; _brushColor = 0xFFFFFFFF;
      _zoom.Clear(); _harnessPid.Clear();
      lock (_q) _q.Clear();
    }

    // ------------------------------------------------------------ hooks and the zoom state machine
    static string Hook() {
      _evProc = OnEvent;
      const uint flags = 0x0000 /*OUTOFCONTEXT*/ | 0x0002 /*SKIPOWNPROCESS*/;
      _hLoc = N.SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, _evProc, 0, 0, flags);   // OBJECT_LOCATIONCHANGE
      _hFg = N.SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, _evProc, 0, 0, flags);    // SYSTEM_FOREGROUND
      _hObj = N.SetWinEventHook(0x8001, 0x8002, IntPtr.Zero, _evProc, 0, 0, flags);   // OBJECT_DESTROY .. OBJECT_SHOW
      if (_hLoc == IntPtr.Zero || _hFg == IntPtr.Zero || _hObj == IntPtr.Zero) {
        int e = Marshal.GetLastWin32Error();
        return "Windows would not let Mantle watch windows move (SetWinEventHook failed, error " + e + ")";
      }
      return null;
    }

    static void SeedAll() {
      N.EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (N.IsWindowVisible(h)) _zoom[h.ToInt64()] = ZoomOf(h);
        return true;
      }, IntPtr.Zero);
    }

    /// The first play must not pay for the JIT and the P/Invoke stubs (measured: 18 ms cold to the first
    /// frame). Compile every method now and call each native once on our own hidden overlay.
    static void WarmUp() {
      var bf = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly;
      foreach (Type t in new Type[] { typeof(MaxFold), typeof(N) }) {
        foreach (var mi in t.GetMethods(bf)) {
          if (mi.IsAbstract || mi.ContainsGenericParameters) continue;
          try { System.Runtime.CompilerServices.RuntimeHelpers.PrepareMethod(mi.MethodHandle); } catch (Exception) { }
        }
      }
      try {
        N.RECT r; N.GetWindowRect(_overlay, out r); N.DwmGetWindowAttribute(_overlay, 9, out r, Marshal.SizeOf(typeof(N.RECT)));
        Geo g = Measure(_overlay); Gather(_overlay, "maximize", g, CurCfg());
        string reason, mode; Decide(new Facts(), out reason, out mode);
        IntPtr th; if (N.DwmRegisterThumbnail(_overlay, _overlay, out th) == 0) N.DwmUnregisterThumbnail(th);
        var t = new N.TNP(); N.DwmUpdateThumbnailProperties(IntPtr.Zero, ref t); N.DwmUnregisterThumbnail(IntPtr.Zero);
        N.GetWindow(_overlay, 3); N.GetForegroundWindow(); N.GetAncestor(_overlay, 2);
        N.RedrawWindow(_overlay, IntPtr.Zero, IntPtr.Zero, 0);
        ulong a, b; Timing(out a, out b);
        var li = new N.LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(N.LASTINPUTINFO)); N.GetLastInputInfo(ref li);
        N.GetAsyncKeyState(1); N.GetTickCount(); N.IsWindow(_overlay); N.IsIconic(_overlay);
        N.SetWindowPos(_overlay, IntPtr.Zero, 0, 0, 1, 1, 0x0001 | 0x0002 | 0x0004 | 0x0010);
        InMoveSize(N.GetCurrentThreadId());
        Json.Obj("warm", 1);
      } catch (Exception) { }
    }

    static byte ZoomOf(IntPtr h) { return N.IsIconic(h) ? (byte)2 : N.IsZoomed(h) ? (byte)1 : (byte)0; }

    static void OnEvent(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time) {
      try {
        if (h == IntPtr.Zero || obj != 0 || child != 0) return;
        long key = h.ToInt64();
        if (ev == 0x8001) { Forget(h); return; }
        if (N.GetAncestor(h, 2 /*GA_ROOT*/) != h) return;
        if (ev == 0x8002) {
          if (!_zoom.ContainsKey(key)) _zoom[key] = ZoomOf(h);
          // passive: learn now whether a new window is the harness's (a process snapshot), not in a first frame
          if (Program.Passive) { int spid; N.GetWindowThreadProcessId(h, out spid); IsHarness(spid); }
          return;
        }
        if (ev == 0x0003) {
          if (!_zoom.ContainsKey(key)) _zoom[key] = ZoomOf(h);
          if (Program.Passive) { int fpid; N.GetWindowThreadProcessId(h, out fpid); if (IsHarness(fpid)) lock (_gate) _fgHarness++; }
          UpdateFlag(h);
          return;
        }
        if (ev != 0x800B) return;
        long t0 = Stopwatch.GetTimestamp();
        byte z = ZoomOf(h), prev;
        bool known = _zoom.TryGetValue(key, out prev);
        if (!N.IsWindowVisible(h)) { _zoom[key] = z; return; }
        _zoom[key] = z;
        if (!known) { if (_zoom.Count > 600) Prune(); return; }
        if (prev == z) {
          if (_play != null && _play.Target == h && !_play.Posed) CheckMoved(_play);
          return;
        }
        if (prev == 0 && z == 1) Transition(h, "maximize", time, t0);
        else if (prev == 1 && z == 0) Transition(h, "restore", time, t0);
        else {
          // to or from minimized: never animated (Windows' own minimize/un-minimize animation plays).
          if (_play != null && _play.Target == h) EndPlay(_play, true, "minimized");
          if (h == _flagged && z == 2) Unflag();
        }
      } catch (Exception ex) {
        if (_hookProblem == null) {
          _hookProblem = ex.GetType().Name + ": " + ex.Message;
          Program.EmitLog("warn", "maxfold: a window event could not be handled (" + _hookProblem + "); said once");
        }
      }
    }

    static void Forget(IntPtr h) {
      _zoom.Remove(h.ToInt64());
      if (h == _flagged) {
        // The attribute died with the window: nothing to put back, the record goes.
        _flagged = IntPtr.Zero; _flagSet = false; _flagPinned = false;
        try { DeleteRecord(); } catch (Exception) { }
        Publish();
      }
      if (_play != null && _play.Target == h) EndPlay(_play, true, "closed");
      if (_pose != null && _pose.Target == h) EndPose();
    }

    static void Prune() {
      var dead = new List<long>();
      foreach (long k in _zoom.Keys) if (!N.IsWindow(new IntPtr(k))) dead.Add(k);
      foreach (long k in dead) _zoom.Remove(k);
    }

    // ------------------------------------------------------------ facts + play start
    static Cfg CurCfg() { lock (_gate) return _cfg; }

    static bool IsHarness(int pid) {
      if (pid == Program.OwnPid) return true;
      if (Program.ParentPid <= 0) return false;
      if (pid == Program.ParentPid) return true;
      bool v;
      lock (_harnessPid) { if (_harnessPid.TryGetValue(pid, out v)) return v; }
      v = ParentOf(pid) == (uint)Program.ParentPid;
      lock (_harnessPid) _harnessPid[pid] = v;
      return v;
    }

    static uint ParentOf(int pid) {
      IntPtr snap = N.CreateToolhelp32Snapshot(2, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
      try {
        var e = new N.PROCESSENTRY32W();
        e.dwSize = (uint)Marshal.SizeOf(typeof(N.PROCESSENTRY32W));
        if (!N.Process32FirstW(snap, ref e)) return 0;
        do { if (e.th32ProcessID == (uint)pid) return e.th32ParentProcessID; } while (N.Process32NextW(snap, ref e));
        return 0;
      } finally { N.CloseHandle(snap); }
    }

    sealed class Geo { public N.RECT WR, FR, T, Mon; public bool Ok; public int Style, Ex; public uint Tid; public int Pid; }

    static Geo Measure(IntPtr h) {
      var g = new Geo();
      int pid; g.Tid = N.GetWindowThreadProcessId(h, out pid); g.Pid = pid;
      g.Style = N.GetWindowLongW(h, -16); g.Ex = N.GetWindowLongW(h, -20);
      if (!N.GetWindowRect(h, out g.WR)) return g;
      if (N.DwmGetWindowAttribute(h, 9 /*EXTENDED_FRAME_BOUNDS*/, out g.FR, Marshal.SizeOf(typeof(N.RECT))) != 0) g.FR = g.WR;
      IntPtr mon = N.MonitorFromWindow(h, 2);
      var mi = new N.MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(N.MONITORINFO));
      if (mon == IntPtr.Zero || !N.GetMonitorInfoW(mon, ref mi)) return g;
      g.Mon = mi.rcMonitor;
      g.T = new N.RECT(Math.Max(g.FR.L, g.Mon.L), Math.Max(g.FR.T, g.Mon.T), Math.Min(g.FR.R, g.Mon.R), Math.Min(g.FR.B, g.Mon.B));
      g.Ok = g.T.R > g.T.L && g.T.B > g.T.T;
      return g;
    }

    static Facts Gather(IntPtr h, string action, Geo g, Cfg c) {
      var f = new Facts();
      lock (_gate) f.Armed = _armed;
      f.Passive = Program.Passive;
      f.Harness = Program.Passive && IsHarness(g.Pid);
      f.Mantle = g.Pid == Program.OwnPid || (Program.ParentPid > 0 && g.Pid == Program.ParentPid);
      int q; f.FullScreenApp = N.SHQueryUserNotificationState(out q) == 0 && (q == 2 || q == 3 || q == 4);
      bool covers = g.WR.L <= g.Mon.L && g.WR.T <= g.Mon.T && g.WR.R >= g.Mon.R && g.WR.B >= g.Mon.B;
      f.FullScreenWindow = covers && (g.Style & 0x00C00000) != 0x00C00000;
      f.Tool = (g.Ex & 0x80) != 0; f.Child = (g.Style & 0x40000000) != 0;
      f.Restore = action == "restore";
      f.Dragging = f.Restore && InMoveSize(g.Tid);
      f.W = g.T.R - g.T.L; f.H = g.T.B - g.T.T;
      int cl; f.Cloaked = N.DwmGetWindowAttributeInt(h, 14 /*CLOAKED*/, out cl, 4) == 0 && cl != 0;
      uint aff; f.Affinity = N.GetWindowDisplayAffinity(h, out aff) ? aff : 0;
      f.WinAnim = WinAnim(); f.Reduced = !ClientAnim();
      f.Flagged = h == _flagged;
      return f;
    }

    static bool InMoveSize(uint tid) {
      var gi = new N.GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(N.GUITHREADINFO));
      return N.GetGUIThreadInfo(tid, ref gi) && (gi.flags & 0x2) != 0;
    }

    static void Skip(string action, string reason) {
      lock (_gate) { int n; _skips.TryGetValue(reason, out n); _skips[reason] = n + 1; }
      Features.Event("maxfold", Json.Obj("kind", "skip", "action", action, "reason", reason));
    }

    static void Transition(IntPtr h, string action, uint eventTick, long t0) {
      if (_pose != null) return; // a test pose holds the overlay
      Cfg c = CurCfg();
      Geo g = Measure(h);
      if (_play != null) EndPlay(_play, true, _play.Target == h ? "changed again" : "another window");
      if (!g.Ok) { Skip(action, R_GONE); return; }
      Facts f = Gather(h, action, g, c);
      string reason, mode;
      if (!Decide(f, out reason, out mode)) {
        Skip(action, reason);
        if (action == "restore" && h == _flagged) Unflag();
        return;
      }
      Play p = NewPlay(h, action, g, c, mode == "reduced");
      p.T0 = t0; p.EventTick = eventTick;
      p.QueueMs = Math.Max(0, unchecked((int)(N.GetTickCount() - eventTick)));
      p.Split[0] = Stopwatch.GetTimestamp();
      IntPtr th; int hr = N.DwmRegisterThumbnail(_overlay, h, out th);
      if (hr != 0) { f.ThumbHr = hr; Decide(f, out reason, out mode); Skip(action, reason); return; }
      p.Pool.Add(th);
      p.Split[1] = Stopwatch.GetTimestamp();
      p.First = true; Render(p, 0, 0, false); p.First = false; // the first frame: two taps, nothing more
      p.Split[2] = Stopwatch.GetTimestamp();
      Show(p, g);
      p.ShownQpc = Stopwatch.GetTimestamp();
      p.ShowMs = (p.ShownQpc - p.T0) * QpcMs;
      p.TimingOk = Timing(out p.Missed0, out p.Dropped0);
      _play = p;
      // The first frame needs one tap; the next ones need many: register a batch now, after the overlay is up.
      Grow(p, 1 + GROW_PER_FRAME, false);
      // The hook callback runs INSIDE GetMessage, which would keep waiting: wake the loop for the frames.
      N.PostThreadMessageW((int)N.GetCurrentThreadId(), WM_KICK, IntPtr.Zero, IntPtr.Zero);
      _watchFired = false; _watchSeq = p.Seq;
      try { _watchdog.Change(Math.Max(c.Ms, c.HoldMs) + 400, Timeout.Infinite); } catch (Exception) { }
      lock (_gate) { _plays++; _playingPub = true; _overlayVisPub = true; }
      Features.Event("maxfold", Json.Obj("kind", "play", "action", action, "mode", p.Mode));
      // The flag: a restore's play has started, so Windows' animation may come back; a maximized foreground
      // window gets it so that ITS restore is ours.
      if (action == "restore" && h == _flagged) Unflag();
      else if (action == "maximize" && h == N.GetForegroundWindow()) UpdateFlag(h);
    }

    static Play NewPlay(IntPtr h, string action, Geo g, Cfg c, bool reduced) {
      var p = new Play();
      p.Seq = ++_playSeq; p.Target = h; p.Action = action; p.C = c; p.Reduced = reduced; p.Mode = reduced ? "reduced" : "full";
      p.WR = g.WR; p.T = g.T; p.W = g.T.R - g.T.L; p.H = g.T.B - g.T.T;
      p.SrcOX = g.T.L - g.WR.L; p.SrcOY = g.T.T - g.WR.T;
      p.FrL = g.FR.L - g.WR.L; p.FrT = g.FR.T - g.WR.T; p.FrR = g.FR.R - g.WR.L; p.FrB = g.FR.B - g.WR.T;
      return p;
    }

    // ------------------------------------------------------------ the overlay window
    static string MakeOverlay() {
      IntPtr inst = Marshal.GetHINSTANCE(typeof(MaxFold).Module);
      if (!_classMade) {
        _wndProc = OverlayProc;
        var wc = new N.WNDCLASSEX();
        wc.cbSize = (uint)Marshal.SizeOf(typeof(N.WNDCLASSEX)); wc.lpfnWndProc = _wndProc; wc.hInstance = inst;
        wc.lpszClassName = "MantleMaxFoldOverlay";
        if (N.RegisterClassExW(ref wc) == 0) {
          int e = Marshal.GetLastWin32Error();
          if (e != 1410 /*CLASS_ALREADY_EXISTS*/) return "Windows would not make the unfold's overlay (RegisterClassEx error " + e + ")";
        }
        _classMade = true;
      }
      // LAYERED | TRANSPARENT | NOACTIVATE | TOOLWINDOW; a REDIRECTED surface: it draws its own opaque base.
      _overlay = N.CreateWindowExW(0x00080000 | 0x20 | 0x08000000 | 0x80, "MantleMaxFoldOverlay", "", 0x80000000 /*WS_POPUP*/,
                                   0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
      if (_overlay == IntPtr.Zero) return "Windows would not make the unfold's overlay (CreateWindowEx error " + Marshal.GetLastWin32Error() + ")";
      int one = 1;
      N.DwmSetWindowAttribute(_overlay, 3 /*TRANSITIONS_FORCEDISABLED*/, ref one, 4);
      N.DwmSetWindowAttribute(_overlay, 12 /*EXCLUDED_FROM_PEEK*/, ref one, 4);
      _veilWhy = MakeVeil(inst);
      if (_veilWhy != null) Program.EmitLog("warn", "maxfold: the smooth darkening is off, it steps per strip instead (" + _veilWhy + ")");
      ApplyLook(CurCfg());
      return null;
    }

    /// The veil's source: a 2*VEIL_W x VEIL_H layered window, cloaked (never on screen, still composed by DWM, so
    /// a thumbnail of it draws), holding two ramps of the base colour with per-pixel alpha: [0, VEIL_W) rises
    /// 0 -> 1 (cover left: the free edge is on the right), [VEIL_W, 2*VEIL_W) falls 1 -> 0 (cover right).
    static string MakeVeil(IntPtr inst) {
      _veil = N.CreateWindowExW(0x00080000 | 0x20 | 0x08000000 | 0x80, "MantleMaxFoldOverlay", "", 0x80000000 /*WS_POPUP*/,
                                0, 0, 4 * VEIL_W, VEIL_H, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
      if (_veil == IntPtr.Zero) return "CreateWindowEx error " + Marshal.GetLastWin32Error();
      int one = 1;
      int hr = N.DwmSetWindowAttribute(_veil, 13 /*DWMWA_CLOAK*/, ref one, 4);
      if (hr != 0) { N.DestroyWindow(_veil); _veil = IntPtr.Zero; return "DWM would not cloak its source (0x" + hr.ToString("X8") + ")"; }
      N.DwmSetWindowAttribute(_veil, 3 /*TRANSITIONS_FORCEDISABLED*/, ref one, 4);
      N.DwmSetWindowAttribute(_veil, 12 /*EXCLUDED_FROM_PEEK*/, ref one, 4);
      string err = PaintVeil(CurCfg().BaseColorRef(), CurCfg().ShadeColorRef());
      if (err != null) { N.DestroyWindow(_veil); _veil = IntPtr.Zero; }
      return err;
    }

    static string PaintVeil(uint col, uint shade) {
      if (_veil == IntPtr.Zero) return "no source window";
      int w = 4 * VEIL_W, h = VEIL_H;
      int[] cr = { (int)(col & 0xFF), (int)(shade & 0xFF) }, cg = { (int)((col >> 8) & 0xFF), (int)((shade >> 8) & 0xFF) }, cb = { (int)((col >> 16) & 0xFF), (int)((shade >> 16) & 0xFF) };
      var px = new int[w * h];
      for (int x = 0; x < w; x++) {
        // sections: 0 linear rising, 1 linear falling, 2 cubic rising, 3 cubic falling
        int q = x / VEIL_W; double t = (x % VEIL_W) / (double)(VEIL_W - 1);
        if ((q & 1) == 1) t = 1 - t;
        if (q >= 2) t = t * t * t;
        int a = (int)Math.Round(t * 255);
        int z = q >= 2 ? 1 : 0; // linear ramps: the base colour; cubic ramps (the shade): the faint indigo
        int v = (a << 24) | ((cr[z] * a + 127) / 255 << 16) | ((cg[z] * a + 127) / 255 << 8) | ((cb[z] * a + 127) / 255); // premultiplied BGRA
        for (int y = 0; y < h; y++) px[y * w + x] = v;
      }
      IntPtr screen = N.GetDC(IntPtr.Zero), mem = IntPtr.Zero, bmp = IntPtr.Zero, old = IntPtr.Zero;
      try {
        mem = N.CreateCompatibleDC(screen);
        var bi = new N.BITMAPINFOHEADER();
        bi.biSize = (uint)Marshal.SizeOf(typeof(N.BITMAPINFOHEADER)); bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32;
        IntPtr bits;
        bmp = N.CreateDIBSection(mem, ref bi, 0, out bits, IntPtr.Zero, 0);
        if (bmp == IntPtr.Zero || bits == IntPtr.Zero) return "CreateDIBSection failed";
        Marshal.Copy(px, 0, bits, px.Length);
        old = N.SelectObject(mem, bmp);
        var dst = new N.POINT(); var src = new N.POINT(); var sz = new N.SIZE(); sz.cx = w; sz.cy = h;
        var bf = new N.BLENDFUNCTION(); bf.BlendOp = 0; bf.BlendFlags = 0; bf.SourceConstantAlpha = 255; bf.AlphaFormat = 1 /*AC_SRC_ALPHA*/;
        if (!N.UpdateLayeredWindow(_veil, screen, ref dst, ref sz, mem, ref src, 0, ref bf, 2 /*ULW_ALPHA*/))
          return "UpdateLayeredWindow error " + Marshal.GetLastWin32Error();
        _veilColor = col; _veilShade = shade;
        return null;
      } finally {
        if (old != IntPtr.Zero) N.SelectObject(mem, old);
        if (bmp != IntPtr.Zero) N.DeleteObject(bmp);
        if (mem != IntPtr.Zero) N.DeleteDC(mem);
        N.ReleaseDC(IntPtr.Zero, screen);
      }
    }

    /// Base colour + alpha. Alpha is 254, not 255, on purpose: occlusion trackers (Chromium's) treat a
    /// fully opaque window above them as "occluded" and stop painting; 254 keeps them painting, and what
    /// shows through (1/255) is the window itself.
    static void ApplyLook(Cfg c) {
      if (_overlay == IntPtr.Zero) return;
      uint col = c.BaseColorRef();
      if (col != _brushColor || _brush == IntPtr.Zero) {
        IntPtr nb = N.CreateSolidBrush(col);
        if (nb != IntPtr.Zero) { if (_brush != IntPtr.Zero) N.DeleteObject(_brush); _brush = nb; _brushColor = col; }
      }
      N.SetLayeredWindowAttributes(_overlay, 0, (byte)(c.Invisible ? 0 : 254), 2 /*LWA_ALPHA*/);
      if (_veil != IntPtr.Zero && _veilWhy == null && (col != _veilColor || c.ShadeColorRef() != _veilShade)) {
        string err = PaintVeil(col, c.ShadeColorRef());
        if (err != null) { _veilWhy = err; Program.EmitLog("warn", "maxfold: the smooth darkening is off, it steps per strip instead (" + err + ")"); }
      }
    }

    static IntPtr OverlayProc(IntPtr h, uint msg, IntPtr w, IntPtr l) {
      switch (msg) {
        case 0x0014: { // WM_ERASEBKGND: the base colour
          N.RECT rc; N.GetClientRect(h, out rc);
          if (_brush != IntPtr.Zero) N.FillRect(w, ref rc, _brush);
          return new IntPtr(1);
        }
        case 0x000F: { var ps = new byte[72]; N.BeginPaint(h, ps); N.EndPaint(h, ps); return IntPtr.Zero; }
        case 0x0084: return new IntPtr(-1);   // WM_NCHITTEST: HTTRANSPARENT
        case 0x0021: return new IntPtr(3);    // WM_MOUSEACTIVATE: MA_NOACTIVATE
      }
      return N.DefWindowProcW(h, msg, w, l);
    }

    static void Show(Play p, Geo g) {
      ApplyLook(p.C);
      int corner = p.Action == "maximize" ? 1 /*DONOTROUND*/ : 2 /*ROUND*/;
      N.DwmSetWindowAttribute(_overlay, 33 /*WINDOW_CORNER_PREFERENCE*/, ref corner, 4);
      bool top = (g.Ex & 0x8) != 0;
      if (top != _overlayTop) {
        N.SetWindowPos(_overlay, top ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        _overlayTop = top;
      }
      // Directly above the window (Mantle's topmost bar and menus stay above it).
      IntPtr prev = N.GetWindow(p.Target, 3 /*GW_HWNDPREV*/);
      uint zf = 0;
      IntPtr after;
      if (prev == _overlay) { after = IntPtr.Zero; zf = 0x0004; /*NOZORDER*/ }
      else if (prev == IntPtr.Zero) after = top ? new IntPtr(-1) : IntPtr.Zero /*HWND_TOP*/;
      else if (!top && (N.GetWindowLongW(prev, -20) & 0x8) != 0) after = IntPtr.Zero; // the first non-topmost: top of its band
      else after = prev;
      N.SetWindowPos(_overlay, IntPtr.Zero, p.T.L, p.T.T, p.W, p.H, 0x0010 | 0x0004 | 0x0008 /*NOACTIVATE|NOZORDER|NOREDRAW*/);
      p.Split[3] = Stopwatch.GetTimestamp();
      N.SetWindowPos(_overlay, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040 | zf /*NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW*/);
      p.Split[4] = Stopwatch.GetTimestamp();
      N.RedrawWindow(_overlay, IntPtr.Zero, IntPtr.Zero, 0x0001 | 0x0004 | 0x0100 | 0x0200 /*INVALIDATE|ERASE|UPDATENOW|ERASENOW*/);
      p.Split[5] = Stopwatch.GetTimestamp();
    }

    static void HideOverlay() {
      if (_overlay == IntPtr.Zero) return;
      N.SetWindowPos(_overlay, IntPtr.Zero, 0, 0, 0, 0, 0x0080 | 0x0001 | 0x0002 | 0x0004 | 0x0010 /*HIDE|NOSIZE|NOMOVE|NOZORDER|NOACTIVATE*/);
      // Park it at 1x1: a hidden overlay holds no full-screen surface between plays.
      N.SetWindowPos(_overlay, IntPtr.Zero, 0, 0, 1, 1, 0x0004 | 0x0010 | 0x0008);
      lock (_gate) _overlayVisPub = false;
    }

    // ------------------------------------------------------------ frames
    static double Ease(Cfg c, double p) {
      if (p <= 0) return 0;
      if (p >= 1) return c.Curve != null ? c.Curve[c.Curve.Length - 1] : 1;
      if (c.Curve == null) { double u = 1 - p; return 1 - u * u * u; }
      double x = p * (c.Curve.Length - 1); int i = (int)Math.Floor(x); if (i >= c.Curve.Length - 1) return c.Curve[c.Curve.Length - 1];
      double f = x - i; return c.Curve[i] + (c.Curve[i + 1] - c.Curve[i]) * f;
    }

    /// Sets every tap for progress `prog` (elMs = elapsed, for the reduced cross-fade). True = this frame is
    /// identical to the window (converged). `growAll` (poses) registers every tap it needs at once.
    static bool Render(Play p, double prog, double elMs, bool growAll) {
      Cfg c = p.C;
      if (p.Reduced) {
        double cov = Math.Min(1, 0.7 + 0.3 * Math.Min(1, elMs / 120.0));
        SetTap(p, 0, new N.RECT(0, 0, p.W, p.H), 0, 0, cov);
        HideFrom(p, 1);
        p.LastExact = cov >= 1; p.MaxTaps = Math.Max(p.MaxTaps, 1);
        return p.LastExact;
      }
      double e = Ease(c, prog), s = Clamp01(1 - e), v = Clamp01(e);
      if (s <= 0 && v >= 1) {
        SetTap(p, 0, new N.RECT(0, 0, p.W, p.H), 0, 0, 1.0);
        HideFrom(p, 1); VeilOff(p);
        p.LastExact = true; p.MaxTaps = Math.Max(p.MaxTaps, 1);
        return true;
      }
      int xh = p.W / 2;
      double inner = 1 - c.InnerDark * s;
      int panelMax = c.CoverLeft ? p.W - xh : xh;
      int pw = (int)Math.Round(v * panelMax);
      double R = Math.Min(R_CAP, Math.Min(c.BlurFrac, 0.027) * p.W * s); // blur radius at the free edge (px)
      double A = Math.Min(c.DarkCap, 2 * s);                      // darkening at the free edge
      bool veil = VeilUsable(p);
      // Strips. With the veil: on equal steps of radius (boundary j at d = (j/K)^(1/3), radius R*(j+.5)/K), so
      // neighbouring strips differ by <= STEP_PX of blur. Without it (fallback): K equal widths, as before, and
      // the darkening is each strip's coverage.
      // radius levels: steps of STEP_PX, or STEP_REL of the radius once that is larger (a 15 % change of a wide
      // blur is as invisible as 0.8 px of a narrow one), at most c.Strips strips
      int K; double[] lv;
      if (veil) {
        var levels = new List<double>(); levels.Add(0);
        double rr = 0;
        while (rr < R && levels.Count <= c.Strips) { rr = Math.Min(R, rr + Math.Max(STEP_PX, STEP_REL * rr)); levels.Add(rr); }
        if (levels[levels.Count - 1] < R) levels[levels.Count - 1] = R;
        lv = levels.ToArray(); K = Math.Max(1, lv.Length - 1);
        if (lv.Length < 2) lv = new double[] { 0, R };
      } else { K = Math.Max(1, c.Strips); lv = null; }
      var bx = new int[K + 1];
      for (int j = 0; j <= K; j++) bx[j] = veil ? (int)Math.Round(pw * (R <= 0 ? (double)j / K : Math.Pow(lv[j] / R, 1.0 / 3))) : (int)((long)pw * j / K);
      var n = new int[K]; var r = new double[K]; var cv = new double[K];
      int need = 0, sharpTo = 0; bool lead = veil;
      for (int i = 0; i < K; i++) {
        if (bx[i + 1] - bx[i] < 1) continue;
        double dMid = ((bx[i] + bx[i + 1]) * 0.5) / Math.Max(1, pw);
        r[i] = veil ? (lv[i] + lv[i + 1]) * 0.5 : R * dMid * dMid * dMid;
        n[i] = Clamp(1 + (int)Math.Round(r[i] * TAPS_PER_PX), 1, MAX_TAPS_PER_STRIP);
        if (r[i] < 0.5) n[i] = 1;
        cv[i] = veil ? inner : inner * (1 - A * dMid);
        // the sharp strips next to the hinge join the cover tap (same coverage when the veil does the darkening)
        if (lead && n[i] == 1) { sharpTo = bx[i + 1]; n[i] = 0; continue; }
        lead = false;
        need += n[i];
      }
      int veilSlot = veil && pw >= 1 && A * 255 >= 0.5 ? 1 : 0;
      // the not-yet-open part: the window's outline, dim, as soft as the free edge next to it (no seam)
      int beyondW = panelMax - pw, beyond = beyondW >= 1 ? (R < 0.5 || p.First ? 1 : Clamp(1 + (int)Math.Round(R * BEYOND_TAPS_PER_PX), 1, BEYOND_MAX_TAPS)) : 0;
      long g0 = Stopwatch.GetTimestamp();
      Grow(p, Math.Min(p.Budget, 1 + beyond + need), growAll);
      double gms = (Stopwatch.GetTimestamp() - g0) * QpcMs; if (gms > p.GrowMsMax) p.GrowMsMax = gms;
      int avail = Math.Min(p.Pool.Count, p.Budget) - 1 - beyond;
      while (need > avail) {
        int best = -1; for (int i = 0; i < K; i++) if (n[i] > 1 && (best < 0 || n[i] > n[best])) best = i;
        if (best < 0) break;
        n[best]--; need--;
      }
      SetTap(p, 0, c.CoverLeft ? new N.RECT(0, 0, xh + sharpTo, p.H) : new N.RECT(xh - sharpTo, 0, p.W, p.H), 0, 0, inner);
      int k = 1;
      var ox = new int[MAX_TAPS_PER_STRIP]; var oy = new int[MAX_TAPS_PER_STRIP]; var wt = new double[MAX_TAPS_PER_STRIP];
      if (beyond > 0 && p.Pool.Count > beyond) {
        var bdst = c.CoverLeft ? new N.RECT(xh + pw, 0, p.W, p.H) : new N.RECT(0, 0, xh - pw, p.H);
        int m = BlurTaps(beyond, R, ox, oy, wt);
        StackTaps(p, ref k, bdst, m, ox, oy, wt, BEYOND * inner);
      }
      for (int i = 0; i < K; i++) {
        if (n[i] == 0) continue;
        if (k + n[i] > Math.Min(p.Pool.Count, p.Budget)) break; // the pool could not grow (said in GrowHr): the base shows there
        var dst = c.CoverLeft ? new N.RECT(xh + bx[i], 0, xh + bx[i + 1], p.H) : new N.RECT(xh - bx[i + 1], 0, xh - bx[i], p.H);
        int m = BlurTaps(n[i], r[i], ox, oy, wt);
        StackTaps(p, ref k, dst, m, ox, oy, wt, cv[i]);
      }
      HideFrom(p, k);
      if (veilSlot == 1) SetVeils(p, c.CoverLeft ? new N.RECT(xh, 0, xh + pw, p.H) : new N.RECT(xh - pw, 0, xh, p.H), A, Math.Min(SHADE_CAP, SHADE_PER_S * s), c.CoverLeft);
      else VeilOff(p);
      p.MaxTaps = Math.Max(p.MaxTaps, k);
      p.LastExact = false;
      return false;
    }

    /// Weights -> stacked alphas (draw order = pool order, the last drawn on top): from the top down,
    /// alpha_k = w_k / (what is still uncovered above it), total coverage = cov.
    static void StackTaps(Play p, ref int k, N.RECT dst, int m, int[] ox, int[] oy, double[] wt, double cov) {
      double sum = 0; for (int j = 0; j < m; j++) sum += wt[j];
      double P = 1;
      var al = new double[m];
      for (int j = m - 1; j >= 0; j--) { double w = wt[j] / sum * cov; al[j] = P <= 1e-9 ? 1 : Math.Min(1, w / P); P *= 1 - al[j]; }
      for (int j = 0; j < m; j++) { SetTap(p, k, dst, ox[j], oy[j], al[j]); k++; }
    }

    /// The offsets and weights of one strip's taps: tap 0 exact; taps 1.. evenly spaced across [-r, r] along the
    /// opening axis (stratified, so neighbours are ~2r/n px apart and overlap into a smear instead of standing
    /// apart as copies), each lifted off the line by a golden-ratio sequence inside +-ASPECT_Y*r (the softness
    /// across the axis), gaussian weights by distance; taps that round to the same pixel offset are merged.
    /// Returns how many distinct taps.
    static int BlurTaps(int n, double r, int[] ox, int[] oy, double[] wt) {
      int m = 0;
      for (int j = 0; j < n; j++) {
        double fx = 0, fy = 0;
        if (j > 0) {
          // alternate sides so a budget cut (n smaller) still stays centred
          int pair = (j + 1) / 2, pairs = n / 2; bool left = (j & 1) == 1;
          fx = (left ? -1 : 1) * (pair - 0.5) / Math.Max(1, pairs); // 0..1 outward
          double g = (j * 0.6180339887) % 1.0;
          fy = (2 * g - 1);
        }
        int dx = (int)Math.Round(r * fx), dy = (int)Math.Round(r * ASPECT_Y * fy);
        double rho2 = fx * fx + fy * fy * ASPECT_Y * ASPECT_Y;
        double w = Math.Exp(-rho2 / (2 * SIGMA * SIGMA));
        int at = -1; for (int q = 0; q < m; q++) if (ox[q] == dx && oy[q] == dy) { at = q; break; }
        if (at >= 0) { wt[at] += w; continue; }
        ox[m] = dx; oy[m] = dy; wt[m] = w; m++;
      }
      return m;
    }

    static bool VeilUsable(Play p) { return _veil != IntPtr.Zero && _veilWhy == null && p.VeilHr == 0; }

    /// The two veil thumbnails over the opening panel: [0] a linear ramp at opacity = the edge darkening, [1] a
    /// cubic ramp (the blur's own falloff) that deepens the shade where the blur is widest, so what is left of
    /// the copies sits in shadow, as on the Duo. Kept the LAST registered thumbnails (drawn over every tap):
    /// both re-registered, in order, whenever the pool grew past them.
    static void SetVeils(Play p, N.RECT dst, double lin, double cub, bool rising) {
      if (p.VeilAt != p.Pool.Count) {
        for (int i = 0; i < 2; i++) if (p.Veil[i] != IntPtr.Zero) { N.DwmUnregisterThumbnail(p.Veil[i]); p.Veil[i] = IntPtr.Zero; p.VeilVis[i] = false; }
        if (!_veilShown) { N.SetWindowPos(_veil, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0040 /*NOSIZE|NOMOVE|NOZORDER|NOACTIVATE|SHOW*/); _veilShown = true; }
        for (int i = 0; i < 2; i++) {
          IntPtr th; int hr = N.DwmRegisterThumbnail(_overlay, _veil, out th);
          if (hr != 0) {
            p.VeilHr = hr;
            Program.EmitLog("warn", "maxfold: the smooth darkening is off for this play, it steps per strip instead (DwmRegisterThumbnail 0x" + hr.ToString("X8") + ")");
            for (int j = 0; j < i; j++) { N.DwmUnregisterThumbnail(p.Veil[j]); p.Veil[j] = IntPtr.Zero; }
            return;
          }
          p.Veil[i] = th; p.VeilRegs++;
        }
        p.VeilAt = p.Pool.Count;
      }
      SetVeil(p, 0, dst, lin, rising ? 0 : 1);
      SetVeil(p, 1, dst, cub, rising ? 2 : 3);
      p.VeilUsed = true;
    }

    static void SetVeil(Play p, int i, N.RECT dst, double alpha, int section) {
      byte op = (byte)Clamp((int)Math.Round(alpha * 255), 0, 255);
      var t = new N.TNP();
      if (op == 0) { if (!p.VeilVis[i]) return; t.dwFlags = 0x8; t.fVisible = 0; N.DwmUpdateThumbnailProperties(p.Veil[i], ref t); p.VeilVis[i] = false; return; }
      t.dwFlags = 0x1 | 0x2 | 0x4 | 0x8 | 0x10;
      t.rcDestination = dst;
      t.rcSource = new N.RECT(section * VEIL_W, 0, (section + 1) * VEIL_W, VEIL_H);
      t.opacity = op;
      t.fVisible = 1; t.fSourceClientAreaOnly = 0;
      N.DwmUpdateThumbnailProperties(p.Veil[i], ref t);
      p.VeilVis[i] = true;
    }

    static void VeilOff(Play p) {
      var t = new N.TNP(); t.dwFlags = 0x8; t.fVisible = 0;
      for (int i = 0; i < 2; i++) if (p.Veil[i] != IntPtr.Zero && p.VeilVis[i]) { N.DwmUpdateThumbnailProperties(p.Veil[i], ref t); p.VeilVis[i] = false; }
    }

    /// End of a play or pose: the veil thumbnail goes, its source window is hidden again (nothing at rest).
    static void DropVeil(Play p) {
      for (int i = 0; i < 2; i++) if (p.Veil[i] != IntPtr.Zero) { try { N.DwmUnregisterThumbnail(p.Veil[i]); } catch (Exception) { } p.Veil[i] = IntPtr.Zero; p.VeilVis[i] = false; }
      p.VeilAt = -1;
      if (_veilShown && _veil != IntPtr.Zero) { N.SetWindowPos(_veil, IntPtr.Zero, 0, 0, 0, 0, 0x0080 | 0x0001 | 0x0002 | 0x0004 | 0x0010); _veilShown = false; }
    }

    static void Grow(Play p, int want, bool all) {
      want = Math.Min(want, MAX_POOL);
      int budget = all ? MAX_POOL : GROW_PER_FRAME;
      while (p.Pool.Count < want && budget-- > 0) {
        IntPtr th; int hr = N.DwmRegisterThumbnail(_overlay, p.Target, out th);
        if (hr != 0) { p.GrowHr = hr; return; }
        p.Pool.Add(th);
        p.Visible = Math.Max(p.Visible, p.Pool.Count); // hidden explicitly unless this frame uses it
      }
    }

    static void SetTap(Play p, int idx, N.RECT dst, int dx, int dy, double alpha) {
      // A shift that would read outside the window's frame sideways trims the destination instead (that
      // sliver keeps the taps below it), so the offset holds: clamping it would turn the tap into a second
      // exact copy (what left the not-yet-open part sharp). Vertically every strip is full height: clamped.
      int sl0 = dst.L + p.SrcOX + dx;
      if (sl0 < p.FrL && dst.R - dst.L - (p.FrL - sl0) >= 1) { dst.L += p.FrL - sl0; }
      int sr0 = dst.R + p.SrcOX + dx;
      if (sr0 > p.FrR && dst.R - dst.L - (sr0 - p.FrR) >= 1) { dst.R -= sr0 - p.FrR; }
      int w = dst.R - dst.L, h = dst.B - dst.T;
      int sl = dst.L + p.SrcOX + dx, st = dst.T + p.SrcOY + dy;
      // the shifted source stays inside the window's visible frame
      if (sl < p.FrL) sl = p.FrL; if (sl + w > p.FrR) sl = p.FrR - w;
      if (st < p.FrT) st = p.FrT; if (st + h > p.FrB) st = p.FrB - h;
      var t = new N.TNP();
      t.dwFlags = 0x1 | 0x2 | 0x4 | 0x8 | 0x10;
      t.rcDestination = dst;
      t.rcSource = new N.RECT(sl, st, sl + w, st + h);
      t.opacity = (byte)Clamp((int)Math.Round(alpha * 255), 0, 255);
      t.fVisible = 1; t.fSourceClientAreaOnly = 0;
      N.DwmUpdateThumbnailProperties(p.Pool[idx], ref t);
      if (idx >= p.Visible) p.Visible = idx + 1;
    }

    static void HideFrom(Play p, int k) {
      if (k >= p.Visible) return;
      var t = new N.TNP(); t.dwFlags = 0x8; t.fVisible = 0;
      for (int i = k; i < p.Visible && i < p.Pool.Count; i++) N.DwmUpdateThumbnailProperties(p.Pool[i], ref t);
      p.Visible = k;
    }

    /// One frame of the loop: cancel checks, then the next frame, or the end.
    static void Step(Play p) {
      if (Program.Passive && _stallNextMs > 0) { int ms; lock (_gate) { ms = _stallNextMs; _stallNextMs = 0; } Thread.Sleep(ms); }
      long now = Stopwatch.GetTimestamp();
      double el = (now - p.T0) * QpcMs;
      if (_watchFired && _watchSeq == p.Seq) { EndPlay(p, true, "it took too long (the watchdog hid it)"); return; }
      if (!N.IsWindow(p.Target) || N.IsIconic(p.Target) || !N.IsWindowVisible(p.Target)) { EndPlay(p, true, "closed"); return; }
      if (CheckMoved(p)) return;
      if (NewPress(p, el)) { EndPlay(p, true, "input"); return; }
      if (p.Converged) {
        if (now >= p.HoldUntil) EndPlay(p, false, null);
        return;
      }
      double prog = Math.Min(1, el / p.C.Ms);
      long r0 = Stopwatch.GetTimestamp();
      bool exact = Render(p, prog, el, false);
      double rms = (Stopwatch.GetTimestamp() - r0) * QpcMs;
      p.RenderMs.Add(rms);
      if (rms > SLOW_MS && p.Budget > MIN_BUDGET) { p.Budget = Math.Max(MIN_BUDGET, p.Budget * 2 / 3); p.Sheds++; }
      p.Frames++;
      if ((p.Reduced && exact) || prog >= 1) {
        if (!exact) { Render(p, 1, 1e9, false); }
        p.Converged = true;
        bool hold = p.Action == "maximize" && WinAnim();
        p.HoldUntil = hold ? p.T0 + (long)(p.C.HoldMs / QpcMs) : now;
      }
    }

    static bool CheckMoved(Play p) {
      N.RECT r;
      if (!N.GetWindowRect(p.Target, out r)) { EndPlay(p, true, "closed"); return true; }
      if (r.L != p.WR.L || r.T != p.WR.T || r.R != p.WR.R || r.B != p.WR.B) { EndPlay(p, true, "moved"); return true; }
      return false;
    }

    /// A NEW key or mouse-button press after the gesture (presses in the first 120 ms belong to the gesture;
    /// key-ups such as letting go of Win after Win+Up, and plain mouse moves, never cancel).
    static bool NewPress(Play p, double el) {
      var li = new N.LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(N.LASTINPUTINFO));
      if (!N.GetLastInputInfo(ref li)) return false;
      if (p.Keys == null) { p.Keys = new bool[256]; for (int vk = 1; vk < 255; vk++) p.Keys[vk] = (N.GetAsyncKeyState(vk) & 0x8000) != 0; p.LastInput = li.dwTime; return false; }
      if (li.dwTime == p.LastInput) return false;
      p.LastInput = li.dwTime;
      bool fresh = false;
      for (int vk = 1; vk < 255; vk++) {
        bool down = (N.GetAsyncKeyState(vk) & 0x8000) != 0;
        if (down && !p.Keys[vk]) { if (el > 120) fresh = true; }
        p.Keys[vk] = down;
      }
      return fresh;
    }

    static void EndPlay(Play p, bool cancelled, string why) {
      if (p == null) return;
      try { _watchdog.Change(Timeout.Infinite, Timeout.Infinite); } catch (Exception) { }
      HideOverlay();
      long endQpc = Stopwatch.GetTimestamp();
      DropVeil(p);
      p.PoolMax = p.Pool.Count;
      foreach (IntPtr th in p.Pool) { try { N.DwmUnregisterThumbnail(th); } catch (Exception) { } }
      p.Pool.Clear(); p.Visible = 0;
      if (_play == p) _play = null;
      ulong m1, d1; bool tOk = Timing(out m1, out d1) && p.TimingOk;
      var gaps = new List<double>(p.Gaps); gaps.Sort();
      double med = gaps.Count == 0 ? 0 : gaps[gaps.Count / 2], max = gaps.Count == 0 ? 0 : gaps[gaps.Count - 1];
      int over20 = 0; foreach (double g in gaps) if (g > 20) over20++;
      var rms = new List<double>(p.RenderMs); rms.Sort();
      double rMed = rms.Count == 0 ? 0 : rms[rms.Count / 2], rMax = rms.Count == 0 ? 0 : rms[rms.Count - 1];
      bool sharp = !cancelled && p.LastExact;
      var last = Json.Obj("action", p.Action, "mode", p.Mode,
        "firstFrameMs", R2(p.ShowMs), "queueMs", R1(p.QueueMs),
        "frames", p.Frames, "gapMedMs", R2(med), "gapMaxMs", R2(max), "over20", over20,
        "missedDelta", tOk ? (object)(long)(m1 - p.Missed0) : null, "droppedDelta", tOk ? (object)(long)(d1 - p.Dropped0) : null,
        "totalMs", R1((endQpc - p.T0) * QpcMs), "endedSharp", sharp, "cancelled", cancelled, "cancelWhy", why,
        "maxTaps", p.MaxTaps, "pool", p.PoolMax, "renderMedMs", R2(rMed), "renderMaxMs", R2(rMax), "growMaxMs", R2(p.GrowMsMax), "sheds", p.Sheds, "budget", p.Budget,
        "veil", VeilNote(p), "veilRegs", p.VeilRegs, "growHr", p.GrowHr == 0 ? null : (object)("0x" + p.GrowHr.ToString("X8")),
        "w", p.W, "h", p.H, "shownQpc", p.ShownQpc, "t0Qpc", p.T0, "split", SplitText(p));
      lock (_gate) { _last = last; _doneCount++; if (cancelled) _cancelledCount++; _playingPub = false; }
      var ev = new Dictionary<string, object>(StringComparer.Ordinal);
      ev["kind"] = "done";
      foreach (DictionaryEntry kv in last) ev[(string)kv.Key] = kv.Value;
      Features.Event("maxfold", ev);
    }

    /// "facts/thumbnail/taps/resize/show/paint" in ms, for the first frame (tests and the log's numbers).
    static string SplitText(Play p) {
      if (p.Split[0] == 0 || p.Split[5] == 0) return null;
      var sb = new StringBuilder();
      long prev = p.T0;
      for (int i = 0; i < 6; i++) {
        if (i > 0) sb.Append('/');
        sb.Append(((p.Split[i] - prev) * QpcMs).ToString("F2", CultureInfo.InvariantCulture));
        prev = p.Split[i];
      }
      return sb.ToString();
    }

    static void OnWatchdog(object state) {
      // Another thread: only calls that never wait on the stuck one. Alpha 0 at once, hide when it pumps.
      try {
        IntPtr o = _overlay;
        if (o == IntPtr.Zero) return;
        _watchFired = true;
        N.SetLayeredWindowAttributes(o, 0, 0, 2);
        N.ShowWindowAsync(o, 0);
        Program.EmitLog("warn", "maxfold: the unfold did not end in time; its overlay was hidden by the watchdog");
      } catch (Exception) { }
    }

    static bool Timing(out ulong missed, out ulong dropped) {
      missed = 0; dropped = 0;
      var t = new N.DTI(); t.cbSize = (uint)Marshal.SizeOf(typeof(N.DTI));
      if (N.DwmGetCompositionTimingInfo(IntPtr.Zero, ref t) != 0) return false;
      missed = t.cFramesMissed; dropped = t.cFramesDropped;
      return true;
    }

    // ------------------------------------------------------------ test poses
    static object Pose(IntPtr h, string action, double prog, bool reduced) {
      Geo g = Measure(h);
      if (!g.Ok) return "the window has no rect on a monitor";
      Cfg c = CurCfg();
      Play p = NewPlay(h, action, g, c, reduced);
      p.Posed = true;
      IntPtr th; int hr = N.DwmRegisterThumbnail(_overlay, h, out th);
      if (hr != 0) return R_Thumb(hr);
      p.Pool.Add(th);
      bool exact = Render(p, prog, prog * 120.0, true);
      Show(p, g);
      _pose = p;
      lock (_gate) _overlayVisPub = true;
      N.DwmFlush();
      double e = Ease(c, prog), s = Clamp01(1 - e), v = Clamp01(e);
      int xh = p.W / 2, panelMax = c.CoverLeft ? p.W - xh : xh;
      return Json.Obj("overlay", _overlay.ToInt64(), "w", p.W, "h", p.H, "xh", xh, "pw", (int)Math.Round(v * panelMax),
        "e", R3(e), "s", R3(s), "inner", R3(1 - c.InnerDark * s), "taps", p.Visible, "exact", exact, "growHr", p.GrowHr,
        "veil", VeilNote(p), "veilOn", p.VeilVis[0], "beyond", R3(BEYOND * (1 - c.InnerDark * s)), "darkEdge", R3(Math.Min(c.DarkCap, 2 * s)), "shadeEdge", R3(Math.Min(SHADE_CAP, SHADE_PER_S * s)),
        "blurPx", R2(Math.Min(R_CAP, Math.Min(c.BlurFrac, 0.027) * p.W * s)), "base", "#" + ((c.BaseColorRef() & 0xFF).ToString("X2")) +
        (((c.BaseColorRef() >> 8) & 0xFF).ToString("X2")) + (((c.BaseColorRef() >> 16) & 0xFF).ToString("X2")));
    }

    static void EndPose() {
      Play p = _pose; _pose = null;
      if (p == null) return;
      HideOverlay();
      DropVeil(p);
      foreach (IntPtr th in p.Pool) { try { N.DwmUnregisterThumbnail(th); } catch (Exception) { } }
      p.Pool.Clear();
    }

    /// "on", or the reason the darkening steps per strip instead (no silent fallback).
    static string VeilNote(Play p) {
      if (_veilWhy != null) return "off (" + _veilWhy + ")";
      if (_veil == IntPtr.Zero) return "off (no source window)";
      if (p != null && p.VeilHr != 0) return "off (DwmRegisterThumbnail 0x" + p.VeilHr.ToString("X8") + ")";
      return "on";
    }

    // ------------------------------------------------------------ the flag (DWMWA_TRANSITIONS_FORCEDISABLED)
    static bool FlagEligible(IntPtr h) {
      if (!N.IsWindow(h) || !N.IsWindowVisible(h) || N.GetAncestor(h, 2) != h) return false;
      int pid; N.GetWindowThreadProcessId(h, out pid);
      if (Program.Passive) { if (!IsHarness(pid)) return false; }
      else if (pid == Program.OwnPid || (Program.ParentPid > 0 && pid == Program.ParentPid)) return false;
      int style = N.GetWindowLongW(h, -16), ex = N.GetWindowLongW(h, -20);
      if ((ex & 0x80) != 0 || (style & 0x40000000) != 0) return false;
      if ((style & 0x00C00000) != 0x00C00000) return false; // no caption: full-screen style, never ours to animate
      int cl; if (N.DwmGetWindowAttributeInt(h, 14, out cl, 4) == 0 && cl != 0) return false;
      uint aff; if (N.GetWindowDisplayAffinity(h, out aff) && aff != 0) return false;
      return true;
    }

    /// The foreground changed (or a foreground window maximized): flag it while it is maximized.
    static void UpdateFlag(IntPtr fg) {
      if (_flagPinned) return;               // a test flagged its own window: the auto rule leaves it alone
      bool armed; lock (_gate) armed = _armed;
      if (!armed || !WinAnim()) { Unflag(); return; }
      if (fg != N.GetForegroundWindow()) return; // stale, or an in-process activation: not the foreground now
      if (fg == _flagged) { if (!N.IsZoomed(fg)) Unflag(); return; }
      Unflag();
      if (N.IsZoomed(fg) && FlagEligible(fg)) Flag(fg, CurCfg().DryRun, false);
    }

    static void Flag(IntPtr h, bool dry, bool pinned) {
      int pid; N.GetWindowThreadProcessId(h, out pid);
      _flagHr = 0;
      if (!dry) {
        string err = WriteRecord(h, pid);
        if (err != null) { _flagHr = -1; Program.EmitLog("warn", "maxfold: " + err + "; Windows animates that window's restore itself"); return; }
        int one = 1; int hr = N.DwmSetWindowAttribute(h, 3, ref one, 4);
        if (hr != 0) { _flagHr = hr; try { DeleteRecord(); } catch (Exception) { } return; }
        lock (_gate) _flagsSet++;
      }
      _flagged = h; _flaggedPid = pid; _flagSet = !dry; _flagPinned = pinned;
      Publish();
    }

    static void Unflag() {
      if (_flagged == IntPtr.Zero) return;
      IntPtr h = _flagged; bool set = _flagSet; int want = _flaggedPid;
      _flagged = IntPtr.Zero; _flagSet = false; _flagPinned = false;
      if (set) {
        int pid = 0;
        if (N.IsWindow(h)) N.GetWindowThreadProcessId(h, out pid);
        if (pid == want && pid != 0) { int zero = 0; N.DwmSetWindowAttribute(h, 3, ref zero, 4); }
        try { DeleteRecord(); } catch (Exception) { }
      }
      Publish();
    }

    static void Publish() { lock (_gate) _flaggedPub = _flagged.ToInt64(); }

    /// Program.SafetyRestore's hook (any thread): put the attribute back and drop the record.
    public static string RestoreForExit() {
      IntPtr h = _flagged; bool set = _flagSet; int want = _flaggedPid;
      IntPtr o = _overlay;
      if (o != IntPtr.Zero) { try { N.ShowWindowAsync(o, 0); } catch (Exception) { } }
      if (h == IntPtr.Zero || !set) return "window animation: Mantle had not switched it off on any window";
      int pid = 0;
      if (N.IsWindow(h)) N.GetWindowThreadProcessId(h, out pid);
      string said;
      if (pid == want && pid != 0) {
        int zero = 0; int hr = N.DwmSetWindowAttribute(h, 3, ref zero, 4);
        said = hr == 0 ? "window animation: put back on the one window Mantle had switched it off for"
                       : "window animation: could not put it back (0x" + hr.ToString("X8") + "); the record stays for the next start";
        if (hr != 0) return said;
      } else said = "window animation: the window it was switched off for has closed";
      _flagged = IntPtr.Zero; _flagSet = false;
      try { DeleteRecord(); } catch (Exception) { }
      return said;
    }

    // ------------------------------------------------------------ the record file
    public static string RecordPath() {
      try {
        if (Program.Passive) return Path.Combine(Path.Combine(Path.GetTempPath(), "mantle-maxfold-test"), "maxfold-windows.json");
        string dir = string.IsNullOrEmpty(Program.StateFilePath) ? null : Path.GetDirectoryName(Program.StateFilePath);
        if (string.IsNullOrEmpty(dir)) dir = Path.GetTempPath();
        return Path.Combine(dir, "maxfold-windows.json");
      } catch (Exception) { return Path.Combine(Path.GetTempPath(), "maxfold-windows.json"); }
    }

    static bool RecordExists() { try { return File.Exists(RecordPath()); } catch (Exception) { return false; } }

    static string WriteRecord(IntPtr h, int pid) {
      string path = RecordPath();
      try {
        string dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, Json.Write(Json.Obj("hwnd", h.ToInt64(), "pid", pid, "set", true, "assumedOriginal", false)));
        if (File.Exists(path)) File.Delete(path);
        File.Move(tmp, path);
        return null;
      } catch (Exception ex) {
        return "could not write the window animation record (" + ex.GetType().Name + ": " + ex.Message + ")";
      }
    }

    static void DeleteRecord() { string p = RecordPath(); if (File.Exists(p)) File.Delete(p); }

    /// A record left by a run that ended without its stop(): put the attribute back. Null when there was none.
    static string RestoreStale() {
      string path = RecordPath();
      if (!File.Exists(path)) return null;
      string note;
      try {
        var d = Json.Parse(File.ReadAllText(path)) as Dictionary<string, object>;
        if (d == null) note = "the record was unreadable; deleted it";
        else if (!Json.GetBool(d, "set", false)) note = "the record said nothing was switched off";
        else {
          IntPtr h = Json.GetHwnd(d, "hwnd"); int want = Json.GetInt(d, "pid", 0);
          int pid = 0;
          if (h != IntPtr.Zero && N.IsWindow(h)) N.GetWindowThreadProcessId(h, out pid);
          if (pid == 0) note = "the window it was switched off for has closed";
          else if (pid != want) note = "that window handle now belongs to another app; left it alone";
          else if (Program.Passive && !IsHarness(pid)) note = "a test record names a window the test did not make; left it alone";
          else {
            int zero = 0; int hr = N.DwmSetWindowAttribute(h, 3, ref zero, 4);
            note = hr == 0 ? "put Windows' animation back on the window Mantle had switched it off for"
                           : "could not put Windows' animation back (0x" + hr.ToString("X8") + ")";
          }
        }
      } catch (Exception ex) { note = "the record could not be read (" + ex.GetType().Name + ")"; }
      try { File.Delete(path); } catch (Exception) { }
      Program.EmitLog("warn", "maxfold: Mantle stopped unexpectedly last time while it had switched off Windows' animation on one window: " + note);
      return note;
    }

    // ------------------------------------------------------------ Windows settings (read only)
    static bool WinAnim() {
      Cfg c = CurCfg();
      if (c.TestWinAnim >= 0) return c.TestWinAnim == 1;
      var ai = new N.ANIMATIONINFO(); ai.cbSize = (uint)Marshal.SizeOf(typeof(N.ANIMATIONINFO));
      if (!N.SystemParametersInfoW(0x0048 /*SPI_GETANIMATION*/, ai.cbSize, ref ai, 0)) return true;
      return ai.iMinAnimate != 0;
    }

    static bool ClientAnim() {
      Cfg c = CurCfg();
      if (c.TestReduced >= 0) return c.TestReduced == 0;
      int on = 1;
      if (!N.SystemParametersInfoW(0x1042 /*SPI_GETCLIENTAREAANIMATION*/, 0, ref on, 0)) return true;
      return on != 0;
    }

    // ------------------------------------------------------------ small helpers
    static int Clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
    static double Clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    static double R1(double v) { return Math.Round(v, 1); }
    static double R2(double v) { return Math.Round(v, 2); }
    static double R3(double v) { return Math.Round(v, 3); }
    static double Num(Dictionary<string, object> d, string key, double dflt) {
      object v; if (!Json.TryGet(d, key, out v)) return dflt;
      if (v is double && !double.IsNaN((double)v) && !double.IsInfinity((double)v)) return (double)v;
      return dflt;
    }

    // ------------------------------------------------------------ native
    static class N {
      public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
      public delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
      public delegate bool EnumProc(IntPtr h, IntPtr l);

      [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
      [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; public RECT(int l, int t, int r, int b) { L = l; T = t; R = r; B = b; } }
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct WNDCLASSEX {
        public uint cbSize, style; public WndProc lpfnWndProc; public int cbClsExtra, cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground;
        public string lpszMenuName, lpszClassName; public IntPtr hIconSm; }
      [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
      [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
      [StructLayout(LayoutKind.Sequential)] public struct ANIMATIONINFO { public uint cbSize; public int iMinAnimate; }
      [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
        public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
      // dwmapi.h packs its structs (pshpack1): opacity is a BYTE at offset 36, fVisible right after it.
      [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct TNP { public uint dwFlags; public RECT rcDestination, rcSource; public byte opacity; public int fVisible, fSourceClientAreaOnly; }
      [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct DTI {
        public uint cbSize; public uint rrN, rrD; public ulong qpcRefreshPeriod; public uint rcN, rcD; public ulong qpcVBlank, cRefresh; public uint cDXRefresh;
        public ulong qpcCompose, cFrame; public uint cDXPresent; public ulong cRefreshFrame, cFrameSubmitted; public uint cDXPresentSubmitted;
        public ulong cFrameConfirmed; public uint cDXPresentConfirmed; public ulong cRefreshConfirmed; public uint cDXRefreshConfirmed;
        public ulong cFramesLate; public uint cFramesOutstanding; public ulong cFrameDisplayed, qpcFrameDisplayed, cRefreshFrameDisplayed, cFrameComplete,
          qpcFrameComplete, cFramePending, qpcFramePending, cFramesDisplayed, cFramesComplete, cFramesPending, cFramesAvailable, cFramesDropped, cFramesMissed,
          cRefreshNextDisplayed, cRefreshNextPresented, cRefreshesDisplayed, cRefreshesPresented, cRefreshStarted, cPixelsReceived, cPixelsDrawn, cBuffersEmpty; }
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PROCESSENTRY32W {
        public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }

      [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
      [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
      [DllImport("user32.dll")] public static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
      [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint remove);
      [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
      [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG m);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool PostThreadMessageW(int tid, uint msg, IntPtr w, IntPtr l);
      [DllImport("user32.dll")] public static extern uint MsgWaitForMultipleObjectsEx(uint n, IntPtr handles, uint ms, uint mask, uint flags);
      [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern ushort RegisterClassExW(ref WNDCLASSEX c);
      [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
      [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
      [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
      [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
      [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
      [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr rc, IntPtr rgn, uint flags);
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
      [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
      [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
      [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
      [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
      [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
      [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int index);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
      [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
      [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFO mi);
      [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
      [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
      [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
      [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
      [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gi);
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
      [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool SystemParametersInfoW(uint action, uint param, ref ANIMATIONINFO v, uint ini);
      [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool SystemParametersInfoW(uint action, uint param, ref int v, uint ini);
      [DllImport("user32.dll")] public static extern int FillRect(IntPtr dc, ref RECT r, IntPtr brush);
      [DllImport("user32.dll")] public static extern IntPtr BeginPaint(IntPtr h, byte[] ps);
      [DllImport("user32.dll")] public static extern bool EndPaint(IntPtr h, byte[] ps);
      [DllImport("gdi32.dll")] public static extern IntPtr CreateSolidBrush(uint color);
      [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
      [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
      [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
      [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER {
        public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage;
        public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant; }
      [DllImport("user32.dll", SetLastError = true)] public static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dstDC, ref POINT dst, ref SIZE sz, IntPtr srcDC, ref POINT src, uint key, ref BLENDFUNCTION bf, uint flags);
      [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
      [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
      [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
      [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
      [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
      [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bi, uint usage, out IntPtr bits, IntPtr section, uint offset);
      [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
      [DllImport("dwmapi.dll")] public static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr thumb);
      [DllImport("dwmapi.dll")] public static extern int DwmUnregisterThumbnail(IntPtr thumb);
      [DllImport("dwmapi.dll")] public static extern int DwmUpdateThumbnailProperties(IntPtr thumb, ref TNP p);
      [DllImport("dwmapi.dll")] public static extern int DwmFlush();
      [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int cb);
      [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetWindowAttributeInt(IntPtr h, int attr, out int v, int cb);
      [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int cb);
      [DllImport("dwmapi.dll")] public static extern int DwmGetCompositionTimingInfo(IntPtr h, ref DTI t);
      [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
      [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
      [DllImport("kernel32.dll")] public static extern uint GetTickCount();
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    }
  }
}
