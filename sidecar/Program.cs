// Program.cs - the sidecar's entry point, its message loop, and the protocol.
//
// WHAT THIS PROCESS IS: Electron cannot call Win32. Mantle therefore runs ONE
// tiny .NET companion that owns every Win32 call in the product, and talks to
// the UI over stdin/stdout as JSON lines. One process, one protocol, one place
// to audit anything that touches the live shell.
//
// THREADING, which is the only subtle part:
//
//   main thread   creates a hidden message-loop window and runs Application.Run.
//                 WinEvent hooks, the low-level keyboard hook and every Forms
//                 timer MUST live here - Windows delivers hook callbacks to the
//                 thread that installed them, and a thread with no message pump
//                 simply never receives them.
//   stdin thread  blocks on ReadLine, parses, stamps the arrival time and
//                 hands each request to a LANE (Lanes.cs, since 2026-09-22):
//     ui          the loop thread again, via BeginInvoke - every command that
//                 touches hooks, windows or anything latency-critical.
//     capture     a worker for `backdrop` alone.
//     slow        a worker for icons, shortcuts, pins, launch, the tray and the
//                 Quick Settings switches.
//     audio       a worker for `volume`.
//                 (Which command goes where: Lanes._laneOf. Unlisted = ui.)
//                 A request that waits past the caller's `ttl` is answered
//                 "expired" instead of being run, and the slow Quick Settings
//                 READS never reach a lane at all (QuickSettings.cs).
//   writing       one lock, one place (Emit). Replies and events interleave on
//                 the same stream, so a half-written line would desync the
//                 reader forever.
//
// SAFETY, rewritten on 2026-09-21 after Mantle left the taskbar stuck hidden
// and cost a reboot (the story is at the top of Taskbar.cs). Two rules now:
//
//   1. The sidecar may not hold shell state that needs a LIVING process to
//      undo. Auto-hide (an OS setting) and app bars (tied to a window Windows
//      itself watches) both survive our death harmlessly. ShowWindow on the
//      taskbar and SPI_SETWORKAREA did not, and are gone.
//   2. EVERY exit path - clean quit, stdin EOF, parent death, Ctrl+C, console
//      close, unhandled exception - still funnels through SafetyRestore, and
//      --state-file leaves a note on disk so a recovery script can finish the
//      job even when no Mantle process is left to run it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Mantle {

  /// The message-loop window. Never shown, never in the taskbar, never in the
  /// window list (WS_EX_TOOLWINDOW and our own pid are both filtered out).
  public class MsgForm : Form {
    /// WM_APP+11, not WM_USER+11: the WM_USER range belongs to a window's own
    /// class and common controls reuse it, while WM_APP is reserved for the
    /// application. Posted by the keyboard hook, handled below.
    public const int WM_HOTKEY_TAP = 0x8000 + 11;

    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        cp.ExStyle |= Win32.WS_EX_TOOLWINDOW;
        return cp;
      }
    }

    // Belt and braces: nothing may ever make this window visible.
    protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }

    protected override void WndProc(ref Message m) {
      if (Program.ParkWanted) Program.ParkLoopIfAsked();   // exiting: see Program.ParkLoopForExit
      if (m.Msg == WM_HOTKEY_TAP) {
        Program.Emit(Json.Obj("ev", "hotkey", "name", "win"));
        return;
      }
      base.WndProc(ref m);
    }
  }

  static class Program {
    /// 0.2.0 (2026-09-21): added lnk, keys, foreground and traywatch, and
    /// `ping` now lists the commands it serves so a caller can feature-detect
    /// instead of guessing from a version number.
    ///
    /// 0.3.0 (2026-09-22): lanes, deadlines (`ttl`) and coalescing, and the
    /// Quick Settings reads come from a background-refreshed cache with
    /// `ageMs`. `ping` reports the lanes; `sleep` exists for the tests only.
    public const string Version = "0.3.0";

    /// Everything Run() answers, in the order a reader would want them. This is
    /// the protocol's own index: if a command is added below it belongs here,
    /// because `ping.commands` is what the Electron side checks before offering
    /// a feature.
    public static readonly string[] Commands = new string[] {
      "ping", "windows", "foreground", "focus", "minimize", "close", "toggle",
      "taskbar", "appbar", "traywatch", "edgeclip", "tbhide", "hittest", "raise",
      "glass", "corners", "place", "morph", "region",
      "workarea", "desktop", "hotkey", "keys", "volume", "icon", "lnk", "backdrop",
      "app", "pins", "launch", "wifi", "bluetooth", "brightness", "nightlight", "power", "battery",
      "wlan", "audio", "btdevices", "volwatch", "net", "qswatch",
      "tray", "trayClick", "media", "notifications", "search", "session", "sleep", "quit"
    };

    public static bool Passive;        // --passive: never touch the live shell
    public static int ParentPid;       // --parent-pid=N: whose windows to hide, whose death to follow
    public static string StateFilePath; // --state-file=PATH: where to leave the recovery note
    public static int OwnPid;

    // DPI, decided in InitDpi before anything else happens. See the comment
    // there: getting this wrong put the app bar 200 px off on the first live
    // run, because SHAppBarMessage is not DPI-virtualised.
    public static bool DpiAware;
    public static string DpiMode;      // "per-monitor-v2" | "system" | "unaware"
    public static string DpiReason;    // only when something did not go to plan
    public static IntPtr LoopHandle;   // the hidden window, for PostMessage from hooks

    const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    static MsgForm _loop;
    static Thread _loopThread;          // the thread that runs Application.Run and owns every loop-side hook
    static StreamWriter _out;
    static readonly object _writeLock = new object();
    static int _shuttingDown;
    static volatile bool _suppressEvents;   // set the instant a shutdown starts
    static Win32.ConsoleCtrlHandler _ctrlHandler;   // static: the GC must not collect it

    [STAThread]
    static int Main(string[] args) {
      // FIRST LINE OF THE PROCESS, and it has to stay first: DPI awareness can
      // only be set before any window exists and before anything has cached a
      // coordinate. See InitDpi for why it matters.
      InitDpi();

      // --taskbar-guard=<pid>: this exe as TaskbarHide's guard - a tiny process
      // with no protocol and no window that waits for that sidecar to die and
      // clears the taskbar region it may have left. Nothing below runs for it.
      foreach (string a in args)
        if (a.StartsWith("--taskbar-guard=", StringComparison.Ordinal)) return TaskbarHide.RunGuard(args);
      // --elevated <request>: this exe as the administrator step (Elevate.cs), started through a
      // UAC prompt by elevate.run. It runs ONE whitelisted action, writes its answer and exits;
      // no protocol, no window, nothing below.
      foreach (string a in args)
        if (a == "--elevated") return Elevate.RunElevated(args);

      foreach (string a in args) {
        if (a == "--passive") Passive = true;
        else if (a.StartsWith("--parent-pid=", StringComparison.Ordinal))
          int.TryParse(a.Substring("--parent-pid=".Length), NumberStyles.Integer, CultureInfo.InvariantCulture, out ParentPid);
        else if (a.StartsWith("--state-file=", StringComparison.Ordinal))
          StateFilePath = a.Substring("--state-file=".Length).Trim('"');
      }
      OwnPid = Process.GetCurrentProcess().Id;

      // UTF-8 with NO BOM, LF line endings: a BOM would be part of the first
      // line and JSON.parse on the Electron side would choke on it.
      _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
      _out.AutoFlush = false;

      // Anything that escapes a handler still restores the shell before dying.
      AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e) {
        var ex = e.ExceptionObject as Exception;
        // Same path as every other exit: restore first, speak afterwards.
        RequestShutdown(1, "unhandled error: " + (ex == null ? "unknown" : ex.Message));
      };
      // A throw on the UI thread is survivable: report it, keep serving.
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
      Application.ThreadException += delegate (object s, ThreadExceptionEventArgs e) {
        EmitLog("error", "message loop error (the sidecar is still running): " + e.Exception.Message);
      };
      _ctrlHandler = delegate (uint type) {
        // Ctrl+C, Ctrl+Break, console close, logoff, shutdown.
        RequestShutdown(0, "console control signal " + type);
        return true;
      };
      Win32.SetConsoleCtrlHandler(_ctrlHandler, true);

      _loopThread = Thread.CurrentThread;
      _loop = new MsgForm();
      LoopHandle = _loop.Handle;        // forces HWND creation; BeginInvoke needs it

      // Write down what the shell looked like BEFORE anything can change it.
      // Both reads (ABM_GETSTATE, SPI_GETWORKAREA) change nothing, so this runs
      // in --passive too: a passive run still leaves a usable recovery note.
      ShellState.Configure(StateFilePath);
      ShellState.CaptureOriginal();
      WindowList.Start();               // read-only, so it runs in passive too
      // Feature commands register their lanes now, before the first request is dispatched
      // (Lanes picks the lane before Run is ever reached).
      var featureTable = Features.Table;

      Emit(Json.Obj("ev", "ready", "pid", OwnPid, "passive", Passive, "version", Version));

      // After `ready` so that line is always first: both of these report their
      // own failures on the wire.
      ReportDpi();

      // A CURSOR CLIP SURVIVES THE PROCESS THAT SET IT (measured 2026-09-21).
      // So a Mantle-shaped clip that is already in place before this process
      // has done anything means an earlier Mantle died without its safety path
      // and the pointer has been fenced ever since - possibly across a logout.
      // Clear it at the door, and say so on BOTH channels: stderr because a
      // human running the exe by hand must see it, and the log event because
      // nothing in this sidecar is allowed to fix something silently.
      if (!Passive) {
        try {
          string stale = EdgeClip.ClearStaleAtStartup();
          if (stale != null) {
            try { Console.Error.WriteLine("mantle-sidecar: " + stale); Console.Error.Flush(); } catch (Exception) { }
            EmitLog("warn", "edgeclip: " + stale);
          }
        } catch (Exception ex) {
          EmitLog("warn", "edgeclip: the startup check for a stale cursor clip failed (" + ex.Message + ")");
        }
        // The same for the taskbar's empty window region (TaskbarHide.cs): what
        // the previous sidecar's guard did is said once, and a region a dead
        // Mantle left with no guard to clear it is cleared at the door.
        try {
          string note = TaskbarHide.TakeGuardNote(GuardNotePath());
          if (note != null) EmitLog("warn", "tbhide: " + note);
          string staleRgn = TaskbarHide.ClearStaleAtStartup();
          if (staleRgn != null) {
            try { Console.Error.WriteLine("mantle-sidecar: " + staleRgn); Console.Error.Flush(); } catch (Exception) { }
            EmitLog("warn", "tbhide: " + staleRgn);
          }
        } catch (Exception ex) {
          EmitLog("warn", "tbhide: the startup check for a stale taskbar region failed (" + ex.Message + ")");
        }
      }

      if (ShellState.Enabled) ShellState.Write();
      else EmitLog("warn", "no --state-file: a recovery script cannot know the original shell state");

      // The worker lanes exist before the first request can arrive.
      Lanes.Start(Execute);
      StartStdinReader();
      WatchParent();
      QuickSettings.WarmUp();

      Application.Run(new ApplicationContext());
      return 0;
    }

    // --------------------------------------------------------------------- DPI

    /// Make this process DPI-AWARE before it does anything else.
    ///
    /// WHY (measured 2026-09-21, after the first live run put Mantle's bar
    /// 200 px too high and 80% wide, with Explorer reserving that wrong strip):
    /// SHAppBarMessage is NOT DPI-virtualised. On this 1920x1080 @ 125% box, a
    /// DPI-UNAWARE process gets 0,1020,1920,1080 from ABM_GETTASKBARPOS
    /// (physical) but 0,816,1536,864 from GetWindowRect on Shell_TrayWnd
    /// (virtualised). So the app bar rect, built from GetMonitorInfo's
    /// virtualised 1536x864 and handed to ABM_QUERYPOS/ABM_SETPOS, was read as
    /// physical - a rect for a screen that does not exist.
    ///
    /// Being DPI-aware makes GetMonitorInfo, SPI_GETWORKAREA and
    /// SHAppBarMessage agree on one coordinate system: physical pixels. The
    /// cost is pushed to the caller, which is the right place for it - Electron
    /// is DPI-aware already and positions windows in DIPs, so it divides by the
    /// display's scale factor. `ping` tells it which world it is talking to.
    ///
    /// The only window this process owns is invisible and never painted, so
    /// WinForms' shaky per-monitor support costs us nothing.
    static void InitDpi() {
      try {
        if (Win32.SetProcessDpiAwarenessContext(Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
          DpiAware = true;
          DpiMode = "per-monitor-v2";
          return;
        }
        DpiReason = "SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) was refused (Win32 error " +
                    Marshal.GetLastWin32Error() + ")";
      } catch (Exception ex) {
        // EntryPointNotFoundException on anything older than Windows 10 1703.
        DpiReason = "SetProcessDpiAwarenessContext is not available on this Windows (" + ex.Message + ")";
      }

      try {
        if (Win32.SetProcessDPIAware()) {
          DpiAware = true;
          DpiMode = "system";
          DpiReason += "; fell back to SetProcessDPIAware: system-wide awareness, which is correct on one " +
                       "monitor but goes stale if a second monitor has a different scale factor";
          return;
        }
        DpiReason += "; SetProcessDPIAware was refused too (Win32 error " + Marshal.GetLastWin32Error() + ")";
      } catch (Exception ex) {
        DpiReason += "; SetProcessDPIAware threw (" + ex.Message + ")";
      }

      DpiAware = false;
      DpiMode = "unaware";
    }

    /// Said on the wire once the output stream exists: a fallback or a failure
    /// here changes what every rect in the protocol MEANS, so it can never be
    /// something a caller has to guess at.
    static void ReportDpi() {
      if (!DpiAware) {
        EmitLog("error", "this sidecar could not become DPI-aware, so every rect it reports is " +
                         "virtualised and the app bar will land in the wrong place: " + DpiReason);
        return;
      }
      if (DpiMode != "per-monitor-v2") EmitLog("warn", "DPI awareness: " + DpiReason);
    }

    // ------------------------------------------------------------------ output

    /// Run `a` on the message-loop thread (hooks must be installed there).
    public static void Post(Action a) {
      try { if (_loop != null && _loop.IsHandleCreated) _loop.BeginInvoke(a); } catch (Exception) { }
    }

    /// Where TaskbarHide's guard leaves its note for the next sidecar: beside the
    /// state file when there is one, else in %TEMP%.
    public static string GuardNotePath() {
      try {
        string dir = string.IsNullOrEmpty(StateFilePath) ? null : System.IO.Path.GetDirectoryName(StateFilePath);
        if (string.IsNullOrEmpty(dir)) dir = System.IO.Path.GetTempPath();
        return System.IO.Path.Combine(dir, "taskbar-guard.log");
      } catch (Exception) { return null; }
    }

    public static void Emit(object payload) {
      // Once the shutdown has started, NOTHING routine may touch stdout - see
      // RequestShutdown for the hang this prevents.
      if (_suppressEvents) return;
      WriteLine(payload, -1);
    }

    /// `lockTimeoutMs` < 0 waits for the write lock (the normal case). A
    /// positive value gives up instead, which is what the shutdown path uses:
    /// if another thread is wedged mid-write into a pipe whose reader has died,
    /// the restore must NOT queue up behind it.
    static void WriteLine(object payload, int lockTimeoutMs) {
      string line;
      try {
        line = Json.Write(payload);
      } catch (Exception) {
        return;   // never let serialising an event kill a command
      }
      bool taken = false;
      try {
        if (lockTimeoutMs < 0) { Monitor.Enter(_writeLock); taken = true; }
        else taken = Monitor.TryEnter(_writeLock, lockTimeoutMs);
        if (!taken) return;
        try {
          _out.Write(line);
          _out.Write('\n');
          _out.Flush();
        } catch (Exception) {
          // The pipe is gone; the stdin reader will notice EOF and shut us down.
        }
      } catch (Exception) {
      } finally {
        if (taken) Monitor.Exit(_writeLock);
      }
    }

    /// The channel for "a human should know this". NOTHING in this sidecar fails
    /// silently: if a fallback kicks in or a feature is unavailable, it says so
    /// here with the reason, and the Electron side surfaces it.
    public static void EmitLog(string level, string message) {
      Emit(Json.Obj("ev", "log", "level", level, "message", message));
    }

    static void FlushOut() {
      lock (_writeLock) { try { _out.Flush(); } catch (Exception) { } }
    }

    static void Reply(object id, bool ok, object result, string error) {
      Emit(ok
        ? Json.Obj("id", NormalizeId(id), "ok", true, "result", result ?? Json.Obj())
        : Json.Obj("id", NormalizeId(id), "ok", false, "error", error));
    }

    /// A command that answers LATER returns this instead of a result, and the
    /// dispatcher says nothing. Only `morph` uses it: its reply is the proof
    /// that the animation landed, so it cannot be sent before the last frame.
    public static readonly object Deferred = new object();

    /// The reply channel for a worker thread (the morph thread). Goes through
    /// the same Emit, and therefore the same single write lock, as everything
    /// else on this stream.
    public static void ReplyFromWorker(object id, bool ok, object result, string error) {
      Reply(id, ok, result, error);
    }

    /// A morph that was superseded or cancelled still OWES ITS CALLER AN
    /// ANSWER - a promise that never settles is worse than a failure. Both
    /// `error` and `reason` carry the word, so a caller that reads either one
    /// can tell this apart from a real failure.
    public static void ReplyCancelled(object id) {
      Emit(Json.Obj("id", NormalizeId(id), "ok", false, "error", "cancelled", "reason", "cancelled"));
    }

    /// Ids arrive as JSON numbers (parsed to double). Echo 3 as 3, not 3.0.
    static object NormalizeId(object id) {
      if (id is double) {
        double d = (double)id;
        if (Math.Abs(d - Math.Round(d)) < 1e-9) return (long)Math.Round(d);
      }
      return id;
    }

    // ------------------------------------------------------------------- input

    static void StartStdinReader() {
      var t = new Thread(delegate () {
        try {
          var sin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
          string line;
          while ((line = sin.ReadLine()) != null) {
            string trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            // Stamped HERE, the moment the line arrives: a request's deadline
            // runs from when the caller sent it, not from when a lane got round
            // to it. That difference is the whole point of `ttl`.
            long arrived = Stopwatch.GetTimestamp();
            if (!Route(trimmed, arrived)) return;   // the loop window is gone: shutting down
          }
        } catch (Exception ex) {
          EmitLog("error", "stdin could not be read: " + ex.Message);
        }
        // EOF. The parent closed the pipe (or died); there is nothing left to
        // serve, so restore the shell and go.
        RequestShutdown(0, "stdin closed");
      });
      t.IsBackground = true;
      t.Name = "mantle-stdin";
      t.Start();
    }

    /// If the UI process dies, the sidecar must not outlive it holding a hidden
    /// taskbar. Process.WaitForExit on a dedicated thread is the cheapest
    /// reliable watch (no polling, fires within milliseconds).
    static void WatchParent() {
      if (ParentPid <= 0) return;
      Process p;
      try {
        p = Process.GetProcessById(ParentPid);
      } catch (Exception) {
        EmitLog("warn", "parent pid " + ParentPid + " is not running; exiting rather than outliving it");
        RequestShutdown(0, "parent pid not running");
        return;
      }
      var t = new Thread(delegate () {
        try { p.WaitForExit(); } catch (Exception) { }
        RequestShutdown(0, "parent process " + ParentPid + " exited");
      });
      t.IsBackground = true;
      t.Name = "mantle-parent-watch";
      t.Start();
    }

    // ---------------------------------------------------------------- dispatch

    /// On the STDIN thread: parse, stamp, and hand the request to its lane (see
    /// Lanes.cs for which is which and why). Parsing here is safe - Json.Parse
    /// holds no state - and it has to happen here, because the lane depends on
    /// the command. A line that cannot be parsed is answered straight away:
    /// Emit is thread-safe and there is nothing to queue. Returns false only
    /// when the message loop is gone.
    static bool Route(string line, long arrivedTs) {
      object id = null;
      Dictionary<string, object> req;
      try {
        req = Json.Parse(line) as Dictionary<string, object>;
      } catch (FormatException fe) {
        Reply(null, false, null, "bad request: " + fe.Message);
        return true;
      } catch (Exception ex) {
        Reply(null, false, null, "bad request: " + ex.Message);
        return true;
      }
      if (req == null) { Reply(null, false, null, "bad request: expected one JSON object per line"); return true; }
      req.TryGetValue("id", out id);
      string cmd = Json.GetString(req, "cmd");
      if (string.IsNullOrEmpty(cmd)) { Reply(id, false, null, "bad request: no cmd field"); return true; }

      var r = new Request();
      r.Cmd = cmd;
      r.Req = req;
      r.Exempt = Lanes.IsExempt(cmd, req);
      // ttl: the caller's own timeout in ms. Absent or <= 0 means "no deadline",
      // which is what an older client (and the test harness's plain sends) get.
      int ttl = 0;
      object rawTtl;
      if (req.TryGetValue("ttl", out rawTtl) && rawTtl is double) {
        double d = (double)rawTtl;
        if (d > 0 && d < int.MaxValue) ttl = (int)d;
      }
      var w = new Waiter();
      w.Id = id;
      w.ArrivedTs = arrivedTs;
      w.TtlMs = ttl;
      r.Waiters.Add(w);

      string lane;
      try {
        lane = Lanes.For(cmd, req);
        bool anywhere;
        r.CoalesceKey = Lanes.CoalesceKey(cmd, req, out anywhere);
        r.MergeAnywhere = anywhere;
      } catch (Exception) {
        // A malformed argument (x:"abc" on a backdrop): no merging, and Run
        // on the command's own lane says what is wrong with it.
        r.CoalesceKey = null;
        try { lane = Lanes.For(cmd, req); } catch (Exception) { lane = Lanes.Ui; }
      }
      r.Lane = lane;
      Lane worker = Lanes.Worker(lane);
      if (worker != null) { worker.Post(r); return true; }

      Interlocked.Increment(ref Lanes.UiQueued);
      try {
        _loop.BeginInvoke(new Action<Request>(Execute), r);
        return true;
      } catch (Exception) {
        Interlocked.Decrement(ref Lanes.UiQueued);
        return false;
      }
    }

    /// Run one request on whatever lane it landed on, and answer every id that
    /// is waiting for it. Called on the message loop (ui) and on the two worker
    /// lanes; everything it touches for a given command belongs to that lane.
    static void Execute(Request r) {
      bool onUi = r.Lane == Lanes.Ui;
      if (onUi) {
        Interlocked.Decrement(ref Lanes.UiQueued);
        Lanes.UiBusySinceTs = Stopwatch.GetTimestamp();
        Lanes.UiBusyCmd = r.Cmd;
      }
      try {
        ExecuteCore(r);
      } finally {
        if (onUi) Lanes.UiBusyCmd = null;
      }
    }

    static void ExecuteCore(Request r) {
      // LOAD SHEDDING. A caller that has already given up gets "expired" now,
      // and the work is not done - doing it would only push every later
      // request further past ITS deadline, which is exactly how the live
      // sidecar ended up permanently behind on 2026-09-22.
      long now = Stopwatch.GetTimestamp();
      var alive = new List<Waiter>(r.Waiters.Count);
      foreach (Waiter w in r.Waiters) {
        if (!r.Exempt && w.Expired(now)) ReplyExpired(r.Cmd, w, now);
        else alive.Add(w);
      }
      if (alive.Count == 0) return;

      object id = alive[0].Id;
      object result = null;
      string err;
      try {
        err = Run(r.Cmd, r.Req, ref result);
      } catch (FormatException fe) {
        err = "bad request: " + fe.Message;
      } catch (InvalidOperationException ioe) {
        // Our own "this cannot work, and here is why" exceptions: pass the
        // wording through untouched.
        err = ioe.Message;
      } catch (Exception ex) {
        err = "command failed: " + ex.GetType().Name + ": " + ex.Message;
      }
      // `morph` answers from its own thread when the last frame lands, so the
      // dispatcher must stay quiet or the caller would get two replies to one
      // id and the correlation table would never settle. (Morph is ui-only and
      // never coalesced, so there is exactly one waiter.)
      if (err == null && ReferenceEquals(result, Deferred)) return;
      // A coalesced request: ONE execution, and every id that rode on it gets
      // the same answer.
      foreach (Waiter w in alive) {
        if (err != null) Reply(w.Id, false, null, err);
        else Reply(w.Id, true, result, null);
      }
    }

    /// `error` AND `reason` both carry the word, like ReplyCancelled, so a
    /// caller reading either can tell a skipped request from a failed one.
    static void ReplyExpired(string cmd, Waiter w, long nowTs) {
      Interlocked.Increment(ref Lanes.Expired);
      Emit(Json.Obj("id", NormalizeId(w.Id), "ok", false,
                    "error", "expired: \"" + cmd + "\" waited " + w.WaitedMs(nowTs) + " ms, past the caller's " +
                             w.TtlMs + " ms deadline, so it was skipped rather than run for nobody",
                    "reason", "expired"));
    }

    /// Returns null on success (with `result` filled), or a plain-words error.
    static string Run(string cmd, Dictionary<string, object> req, ref object result) {
      switch (cmd) {
        case "ping": {
          // dpiAware is not trivia: it says what UNIT every rect in this
          // protocol is in. true (the normal answer since 2026-09-21) means
          // PHYSICAL pixels, so a caller positioning a window in DIPs - Electron
          // does - divides by the display's scale factor. false means the calls
          // below failed and the rects are virtualised, which would put the app
          // bar in the wrong place; dpiReason then says exactly why.
          // selfHwnd is the sidecar's own hidden message-loop window, as a
          // decimal string like every other hwnd here. It exists so the test
          // harness has a window it OWNS to point `glass` at - never a window
          // belonging to anyone else.
          var ping = Json.Obj("pid", OwnPid, "passive", Passive, "version", Version,
                              "dpiAware", DpiAware, "dpiMode", DpiMode,
                              "selfHwnd", LoopHandle.ToInt64().ToString(CultureInfo.InvariantCulture),
                              "commands", Commands);
          if (!DpiAware || DpiReason != null) ping["dpiReason"] = DpiReason;
          // What each lane is doing right now, how many requests were skipped
          // for being late or merged into another, and how old each Quick
          // Settings cache is: the first thing to read when "the buttons do
          // nothing" comes back.
          ping["load"] = Lanes.Snapshot();
          ping["caches"] = QuickSettings.Snapshot();
          ping["watches"] = Json.Obj("volume", VolumeWatch.Snapshot(), "net", NetState.Snapshot());
          // Which feature commands (Features.cs) exist in this exe and which feature files failed
          // to register, with why: "the clipboard does nothing" starts here.
          ping["features"] = Features.Describe();
          result = ping;
          return null;
        }

        case "sleep": {
          // TEST ONLY: parks a lane (`lane`: ui | capture | slow) for `ms` so the
          // harness can prove the OTHER lanes still answer and that a late
          // request is skipped. Refused outside --passive: a live sidecar has
          // no reason to stall itself.
          if (!Passive) return "sleep is a test command and only runs in --passive";
          int sms = Json.GetInt(req, "ms", 0);
          if (sms < 0 || sms > 20000) return "sleep: ms must be 0..20000";
          Thread.Sleep(sms);
          result = Json.Obj("slept", sms, "lane", Lanes.For(cmd, req),
                            "thread", Thread.CurrentThread.Name ?? "ui");
          return null;
        }

        case "windows":
          result = WindowList.Build();
          return null;

        case "foreground":
          // Read-only: GetForegroundWindow, GetWindowRect, GetMonitorInfo. It
          // runs in passive because looking at the desktop changes nothing -
          // and the bar's "a game is full-screen, get out of the way" decision
          // is exactly the thing a test needs to be able to exercise.
          result = Foreground.Read();
          return null;

        case "lnk": {
          // Allowed in passive: IPersistFile::Load is opened STGM_READ and
          // nothing here can write to the user's Start menu. See Shortcuts.cs.
          object rawPaths;
          if (!Json.TryGet(req, "paths", out rawPaths))
            return "lnk needs paths: an array of .lnk paths to read";
          var list = rawPaths as IList;
          if (list == null)
            return "lnk: paths must be an ARRAY of shortcut paths, even for one";
          result = Json.Obj("items", Shortcuts.Resolve(list));
          return null;
        }

        case "keys": {
          // THE ALLOW-LIST IS CHECKED BEFORE PASSIVE, on purpose (same
          // reasoning as `taskbar`): "win+x is not a combo this command sends"
          // is true in every mode, and a caller who heard "refused: passive"
          // would go on believing it works in a live run.
          string combo = Json.GetString(req, "combo");
          if (string.IsNullOrEmpty(combo))
            return "keys needs a combo: one of win+a, win+n, win+d";
          if (!Keys.IsAllowed(combo)) return "combo not allowed";
          // And THIS is what passive is for: a test run must never type into
          // whatever the person at the machine is doing.
          if (Passive)
            return PassiveRefusal + ": keys would type " + combo.Trim().ToLowerInvariant() +
                   " into the live desktop";
          string kerr = Keys.Send(combo);
          if (kerr != null) return kerr;
          result = Json.Obj("ok", true, "combo", combo.Trim().ToLowerInvariant());
          return null;
        }

        case "hittest": {
          // Read-only, so passive runs it: this is the DIAGNOSIS for "my
          // buttons do nothing", and a test must be able to ask it.
          result = HitTest.At(Json.GetInt(req, "x", 0), Json.GetInt(req, "y", 0));
          return null;
        }

        case "raise": {
          // The hwnd is validated BEFORE the passive check, like every other
          // argument here: hwnd 0 is a malformed request in any mode.
          IntPtr rHwnd = Json.GetHwnd(req, "hwnd");
          if (rHwnd == IntPtr.Zero) return "raise: no hwnd given";
          if (!Win32.IsWindow(rHwnd)) return "raise: window " + rHwnd.ToInt64() + " no longer exists";
          // It changes a live z-order, so passive refuses it - even though the
          // window is the caller's own.
          if (Passive) return PassiveRefusal + ": raise would change a live window's z-order";
          IDictionary raised;
          string rerr3 = HitTest.Raise(rHwnd, out raised);
          if (rerr3 != null) return rerr3;
          result = raised;
          return null;
        }

        case "traywatch": {
          // NOT refused in passive, for the same reason as `glass` and `place`:
          // every call it makes that can CHANGE anything takes the caller's own
          // hwnd. It never touches the taskbar's z-order, visibility or state -
          // it only watches it. Subscribe refuses the taskbar itself outright.
          IntPtr barHwnd = Json.GetHwnd(req, "hwnd");
          bool watching;
          string twerr = TrayWatch.Subscribe(barHwnd, out watching);
          if (twerr != null) return twerr;
          result = Json.Obj("ok", true, "watching", watching);
          return null;
        }

        case "focus":
        case "minimize":
        case "close":
        case "toggle": {
          // All four move a real window on the real desktop, so passive refuses
          // them outright - a test run must never disturb whoever is at the machine.
          if (Passive) return PassiveRefusal;
          IntPtr hwnd = Json.GetHwnd(req, "hwnd");
          string err = cmd == "focus" ? WindowList.Focus(hwnd)
                     : cmd == "minimize" ? WindowList.Minimize(hwnd)
                     : cmd == "close" ? WindowList.Close(hwnd)
                     : WindowList.Toggle(hwnd);
          if (err != null) return err;
          result = Json.Obj();
          return null;
        }

        case "taskbar": {
          // FORM IS CHECKED BEFORE PASSIVE, deliberately. `taskbar {show:...}`
          // is not something passive mode is protecting the machine from - it
          // does not exist any more, in any mode, and a caller that still sends
          // it needs to hear that rather than "refused".
          if (Json.GetBool(req, "restore", false)) {
            if (Passive) return PassiveRefusal;
            bool restored, changedByUs, tbVerified;
            int tbState;
            string rerr = Taskbar.Restore(out restored, out changedByUs, out tbState, out tbVerified);
            if (rerr != null) return rerr;
            result = Json.Obj("restored", restored, "changedByUs", changedByUs,
                              "state", tbState, "verified", tbVerified);
            return null;
          }
          if (Json.GetString(req, "mode") == "autohide") {
            if (Passive) return PassiveRefusal;
            bool wasAutohide, ahVerified;
            string reason;
            string serr = Taskbar.SetAutohide(out wasAutohide, out ahVerified, out reason);
            if (serr != null) return serr;
            result = Json.Obj("autohide", true, "wasAutohide", wasAutohide, "verified", ahVerified);
            return null;
          }
          return "taskbar: unknown form; SW_HIDE was removed on 2026-09-21 after it left the taskbar stuck";
        }

        case "appbar": {
          if (Passive) return PassiveRefusal;
          IntPtr abHwnd = Json.GetHwnd(req, "hwnd");
          if (Json.GetBool(req, "remove", false)) {
            bool removed;
            string xerr = AppBars.Remove(abHwnd, out removed);
            if (xerr != null) return xerr;
            result = Json.Obj("removed", removed);
            return null;
          }
          Win32.RECT bar;
          bool isNew;
          string berr = AppBars.Reserve(abHwnd, Json.GetString(req, "edge"),
                                        Json.GetInt(req, "size", 0), out bar, out isNew);
          if (berr != null) return berr;
          // Physical pixels as a DPI-UNAWARE process sees them; see ping.
          result = Json.Obj("rect", new object[] { bar.left, bar.top, bar.right, bar.bottom });
          return null;
        }

        case "glass": {
          // NOT refused in passive, and that is deliberate: this only ever
          // touches a window the caller already owns (Mantle's bar, launcher or
          // desktop layer). It changes nothing about the shell, holds no state
          // and dies with the window, so there is nothing for passive mode to
          // protect the machine from.
          IntPtr gHwnd = Json.GetHwnd(req, "hwnd");
          bool applied;
          string usedMode;
          string gerr = Glass.Apply(gHwnd, Json.GetString(req, "mode"),
                                    Json.GetString(req, "tint"), out applied, out usedMode);
          if (gerr != null) return gerr;
          result = Json.Obj("applied", applied, "mode", usedMode);
          return null;
        }

        case "corners": {
          // Same footing as `glass`: one window, the caller's own, and the
          // attribute dies with it. Refused only for a hwnd that is not a
          // window, an unknown mode, or the taskbar.
          IntPtr cHwnd = Json.GetHwnd(req, "hwnd");
          string usedCorner, usedBorder, borderWhy;
          // `border` absent means "leave the window border alone", which is not
          // the same as "default" - so the key's presence is what decides.
          string askedBorder = Json.HasKey(req, "border") ? Json.GetString(req, "border") : null;
          string cerr = Corners.Apply(cHwnd, Json.GetString(req, "mode"), askedBorder,
                                      out usedCorner, out usedBorder, out borderWhy);
          if (cerr != null) return cerr;
          // `mode` is kept alongside `used` for the callers written against the
          // first version of this command; they are always the same value.
          var cres = Json.Obj("ok", true, "used", usedCorner, "mode", usedCorner, "border", usedBorder);
          if (borderWhy != null) cres["borderReason"] = borderWhy;
          result = cres;
          return null;
        }

        case "backdrop": {
          // Read-only: it BitBlts out of the screen DC and changes nothing, so
          // it runs in passive like `windows` and `icon`. The bar's own window
          // is excluded from the capture by main.js before it calls (window
          // affinity belongs to the window's owner, not to us).
          string bpng;
          int bw2, bh2, bscale;
          double bms;
          string bkerr = Backdrop.Capture(Json.GetInt(req, "x", 0), Json.GetInt(req, "y", 0),
                                          Json.GetInt(req, "w", 0), Json.GetInt(req, "h", 0),
                                          Json.GetInt(req, "scale", Backdrop.DefaultScale),
                                          out bpng, out bw2, out bh2, out bms, out bscale);
          if (bkerr != null) return bkerr;
          result = Json.Obj("ok", true, "png", bpng, "w", bw2, "h", bh2,
                            "scale", bscale, "ms", Math.Round(bms, 1));
          return null;
        }

        case "edgeclip": {
          int inset = Json.GetInt(req, "inset", 2);

          // dryRun is PURE ARITHMETIC - monitor rect in, clip rect out, no
          // Win32 state touched - so it answers in passive too. It is how the
          // test suite proves the geometry without confining anyone's cursor.
          if (Json.GetBool(req, "dryRun", false)) {
            Win32.RECT mon;
            int monitors;
            string perr = EdgeClip.PrimaryRect(out mon, out monitors);
            if (perr != null) return perr;
            int used;
            Win32.RECT want = EdgeClip.Compute(mon, inset, out used);
            result = Json.Obj("ok", true, "dryRun", true, "applied", false,
                              "inset", used, "monitors", monitors,
                              "monitor", new object[] { mon.left, mon.top, mon.right, mon.bottom },
                              "rect", new object[] { want.left, want.top, want.right, want.bottom },
                              "reason", monitors > 1 ? EdgeClip.MultiMonitorReason
                                                     : "dry run: this is the rect that would be clipped");
            return null;
          }

          if (!Json.HasKey(req, "on"))
            return "edgeclip needs on:true or on:false (or dryRun:true to see the rect it would set)";
          // THE ONLY COMMAND IN THIS PROTOCOL THAT CONFINES THE POINTER. A test
          // run may never do that to the person at the machine.
          if (Passive)
            return PassiveRefusal + ": edgeclip would confine the live cursor";

          bool wantOn = Json.GetBool(req, "on", false);
          if (!wantOn) {
            string offReason;
            bool released = EdgeClip.TurnOff(out offReason);
            result = Json.Obj("ok", true, "applied", false, "released", released, "reason", offReason);
            return null;
          }
          bool applied;
          string why;
          string ecerr = EdgeClip.TurnOn(inset, out applied, out why);
          if (ecerr != null) return ecerr;
          result = Json.Obj("ok", true, "applied", applied, "inset", inset < EdgeClip.MinInset ? EdgeClip.MinInset :
                                        (inset > EdgeClip.MaxInset ? EdgeClip.MaxInset : inset),
                            "reason", why);
          return null;
        }

        case "tbhide": {
          // TaskbarHide.cs: an EMPTY WINDOW REGION on the Windows taskbar, so its
          // reveals (which a foreground change triggers, cursor or not) are never
          // seen. Never ShowWindow/SetWindowPos - the 2026-09-21 rule stands.
          //
          // decide:[{kind,want,mayRelease}] is PURE (made-up window states in,
          // actions out) and status is a read, so both answer in passive: that is
          // how the suite proves the logic without touching the live taskbar.
          if (Json.HasKey(req, "decide")) {
            object rawDecide;
            Json.TryGet(req, "decide", out rawDecide);
            var list = rawDecide as List<object>;
            if (list == null) return "tbhide decide needs an array of {kind, want, mayRelease}";
            var outList = new List<object>();
            var cls = new List<string>(); var acts = new List<string>(); var oks = new List<bool>(); var whys = new List<string>();
            foreach (object o in list) {
              var d = o as Dictionary<string, object>;
              if (d == null) return "tbhide decide: every entry must be an object";
              string k = Json.GetString(d, "kind");
              int kind = k == "none" ? TaskbarHide.KindNone : k == "empty" ? TaskbarHide.KindEmpty :
                         k == "shaped" ? TaskbarHide.KindShaped : k == "gone" ? TaskbarHide.KindGone : -99;
              if (kind == -99) return "tbhide decide: kind must be none, empty, shaped or gone (got \"" + k + "\")";
              string why;
              string act = TaskbarHide.Decide(Json.GetBool(d, "want", true), kind, Json.GetBool(d, "mayRelease", false), out why);
              outList.Add(Json.Obj("action", act, "reason", why));
              cls.Add(Json.GetString(d, "class") ?? "Shell_TrayWnd");
              acts.Add(act);
              oks.Add(Json.GetBool(d, "okAfter", true));
              whys.Add(why);
            }
            string sumWhy;
            bool sumApplied = TaskbarHide.Summarize(cls, acts, oks, whys, out sumWhy);
            result = Json.Obj("decisions", outList.ToArray(), "applied", sumApplied, "reason", sumWhy);
            return null;
          }
          if (Json.GetBool(req, "status", false)) { result = TaskbarHide.Status(); return null; }
          if (!Json.HasKey(req, "on"))
            return "tbhide needs on:true or on:false (or status:true, or decide:[...] to see what it would do)";
          if (Passive) return PassiveRefusal + ": tbhide would change the live Windows taskbar";
          if (!Json.GetBool(req, "on", false)) {
            string offWhy;
            bool released = TaskbarHide.TurnOff(out offWhy);
            result = Json.Obj("ok", true, "applied", false, "released", released, "reason", offWhy);
            return null;
          }
          bool tbApplied;
          string tbWhy, tbGuard;
          string tberr = TaskbarHide.TurnOn(GuardNotePath(), out tbApplied, out tbWhy, out tbGuard);
          if (tberr != null) return tberr;
          result = Json.Obj("ok", true, "applied", tbApplied, "reason", tbWhy, "guard", tbGuard);
          return null;
        }

        case "morph": {
          // Same footing as `place`: it moves a window Mantle owns, holds no
          // shell state and dies with the window, so passive has nothing to
          // protect. Morph.Check refuses the taskbar.
          IntPtr mHwnd = Json.GetHwnd(req, "hwnd");
          if (Json.GetBool(req, "cancel", false)) {
            // Stops the animation WHERE IT IS. It deliberately does not clear
            // the region or restore the rect: cancelling is not undoing.
            result = Json.Obj("ok", true, "cancelled", Morph.Cancel(mHwnd));
            return null;
          }
          Morph.Box mFrom, mTo;
          string berr = GetBox(req, "from", out mFrom);
          if (berr != null) return berr;
          berr = GetBox(req, "to", out mTo);
          if (berr != null) return berr;
          double[] ease;
          string eerr = GetEase(req, out ease);
          if (eerr != null) return eerr;
          string merr = Morph.Start(mHwnd, mFrom, mTo, Json.GetInt(req, "ms", 180), ease,
                                    req.ContainsKey("id") ? req["id"] : null);
          if (merr != null) return merr;
          result = Deferred;   // the morph thread replies when the last frame lands
          return null;
        }

        case "region": {
          IntPtr rgHwnd = Json.GetHwnd(req, "hwnd");
          int usedR;
          string gerr2 = Morph.SetRegion(rgHwnd, Json.GetInt(req, "r", 0), out usedR);
          if (gerr2 != null) return gerr2;
          result = Json.Obj("ok", true, "r", usedR);
          return null;
        }

        case "place": {
          // Same footing as glass: it moves a window Mantle already owns, so
          // passive mode has nothing to protect. Why it exists: Electron's
          // setBounds clamps a window into the WORK AREA, and the app bar has
          // just shrunk the work area by exactly the bar's height, so Electron
          // put the bar a bar-height above its own slot every time (live,
          // 2026-09-21 14:30: window 774..818 with the work area at 820). A
          // raw SetWindowPos does not clamp; main hands us the PHYSICAL rect
          // Explorer accepted and we move the window there, no activation, no
          // z-order change.
          IntPtr pHwnd = Json.GetHwnd(req, "hwnd");
          if (pHwnd == IntPtr.Zero || !Win32.IsWindow(pHwnd)) return "place: hwnd is not a window";
          int px = Json.GetInt(req, "x", 0), py = Json.GetInt(req, "y", 0);
          int pw = Json.GetInt(req, "w", 0), ph = Json.GetInt(req, "h", 0);
          if (pw <= 0 || ph <= 0) return "place: w and h must be positive physical pixels";
          if (!Win32.SetWindowPos(pHwnd, IntPtr.Zero, px, py, pw, ph, Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE))
            return "place: SetWindowPos failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
          Win32.RECT placedRect;
          Win32.GetWindowRect(pHwnd, out placedRect);
          result = Json.Obj("rect", new object[] { placedRect.left, placedRect.top, placedRect.right, placedRect.bottom });
          return null;
        }

        case "workarea": {
          // Same reasoning as taskbar: the removed forms answer with what
          // happened to them, whatever mode we are in.
          if (Json.HasKey(req, "bottom") || Json.HasKey(req, "top"))
            return "workarea: setting the work area was removed on 2026-09-21; use appbar";
          if (!Json.GetBool(req, "reset", false))
            return "workarea needs reset:true - setting the work area was removed on 2026-09-21; use appbar";
          if (Passive) return PassiveRefusal;
          Win32.RECT r = WorkArea.Reset();
          result = Json.Obj("rect", new object[] { r.left, r.top, r.right, r.bottom });
          return null;
        }

        case "desktop": {
          if (Passive) return PassiveRefusal;
          IntPtr hwnd = Json.GetHwnd(req, "hwnd");
          if (Json.GetBool(req, "detach", false)) {
            string derr = Desktop.Detach(hwnd);
            if (derr != null) return derr;
            result = Json.Obj();
            return null;
          }
          if (Json.GetBool(req, "recheck", false)) {
            bool moved;
            string covering;
            string rerr = Desktop.Recheck(hwnd, out moved, out covering);
            if (rerr != null) return rerr;
            result = Json.Obj("moved", moved, "covering", covering);
            return null;
          }
          string mode;
          string aerr = Desktop.Attach(hwnd, out mode);
          if (aerr != null) return aerr;
          result = Json.Obj("mode", mode);
          return null;
        }

        case "hotkey": {
          // Every form lives in Hotkey.Command, next to the hook it drives:
          // {winTap, altTab, winKeys} switch features (refused in passive), and
          // the `op` forms serve the Alt+Tab switcher (AltTab.cs) and its tests.
          return Hotkey.Command(req, Passive, PassiveRefusal, out result);
        }

        // ------------------------------------------- the quick settings panel
        // Owen, at the bar's right cluster: "these buttons need to go to a
        // wrapper version of where they used to go ... some of them just go to
        // settings now". Reading state changes nothing and runs in passive;
        // every switch is refused in passive, because a test run may not turn
        // off the radio someone is using.
        //
        // THE ARGUMENT IS CHECKED BEFORE PASSIVE, as everywhere else here:
        // `wifi {on:'maybe'}` is a malformed request in every mode.

        case "wifi": {
          if (Json.HasKey(req, "on")) {
            bool want;
            string aerr = StrictBool(req, "on", out want);
            if (aerr != null) return aerr;
            if (Passive) return PassiveRefusal + ": wifi would switch the live radio";
            result = QuickSettings.SetWifi(want);      // qs lane
            return null;
          }
          result = QuickSettings.Wifi();               // ui lane, from the cache
          return null;
        }

        case "wlan": {
          // The Wi-Fi LIST behind the tile's '>' (Wlan.cs): list, scan, connect,
          // disconnect. Handed off like `search`: this lane only validates and
          // queues, a pool thread replies, so a 4 s scan or a 25 s connect
          // never holds a lane. connect/disconnect are refused in passive.
          object wres;
          string werr = Wlan.Run(req, req.ContainsKey("id") ? req["id"] : null, Passive, out wres);
          if (werr != null) return werr;
          result = wres;
          return null;
        }

        case "btdevices": {
          // The PAIRED DEVICES behind the Bluetooth tile's '>' (BtDevices.cs): list,
          // watch, connect, disconnect. Handed off like wlan: this lane only
          // validates and queues, a pool thread replies, so a connect that waits
          // 12 s for Windows' verdict never holds a lane. connect/disconnect are
          // refused in passive.
          if (Json.HasKey(req, "on")) {
            bool bon;
            string bonErr = StrictBool(req, "on", out bon);
            if (bonErr != null) return bonErr;
          }
          object bres;
          string berr = BtDevices.Run(req, req.ContainsKey("id") ? req["id"] : null, Passive, out bres);
          if (berr != null) return berr;
          result = bres;
          return null;
        }

        case "bluetooth": {
          if (Json.HasKey(req, "on")) {
            bool want;
            string aerr = StrictBool(req, "on", out want);
            if (aerr != null) return aerr;
            // dryRun:true - the switch's own read and gate, stopping short of
            // SetStateAsync (Bluetooth.Plan). It switches nothing, so passive
            // answers it: the tests' proof of the ON path (2026-09-27).
            bool dry = false;
            if (Json.HasKey(req, "dryRun")) {
              string derr = StrictBool(req, "dryRun", out dry);
              if (derr != null) return derr;
            }
            if (dry) { result = Mantle.Bluetooth.Plan(want); return null; }
            if (Passive) return PassiveRefusal + ": bluetooth would switch the live radio";
            result = QuickSettings.SetBluetooth(want); // qs lane
            return null;
          }
          result = QuickSettings.Bluetooth();          // ui lane, from the cache
          return null;
        }

        case "brightness": {
          if (Json.HasKey(req, "level")) {
            object lv;
            Json.TryGet(req, "level", out lv);
            if (!(lv is double)) return "brightness: level must be a number from 0 to 100";
            int want = (int)Math.Round((double)lv);
            if (want < 0 || want > 100) return "brightness: level must be a number from 0 to 100";
            if (Passive) return PassiveRefusal + ": brightness would dim the live display";
            result = QuickSettings.SetBrightness(want); // qs lane, coalesced
            return null;
          }
          result = QuickSettings.Brightness();          // ui lane, from the cache
          return null;
        }

        case "nightlight": {
          // A SWITCH since 2026-09-23 (it was read-only, and the tile did nothing):
          // Display.SetNightLight writes the undocumented CloudStore blob only when
          // it has exactly the layout measured on this machine, else refuses with
          // the reason. qs lane (Lanes.cs _switchArg); the read stays on ui.
          if (Json.HasKey(req, "on")) {
            bool want;
            string aerr = StrictBool(req, "on", out want);
            if (aerr != null) return aerr;
            if (Passive) return PassiveRefusal + ": nightlight would tint the live display";
            result = QuickSettings.SetNightLight(want);
            return null;
          }
          result = Display.NightLight();
          return null;
        }

        case "power": {
          if (Json.HasKey(req, "saver")) {
            // Windows has no public switch: powrprof.dll exports only the power-mode
            // overlay calls (checked 2026-09-23), so the panel opens Settings instead.
            result = Json.Obj("ok", false, "reason",
                              "Windows has no public switch for energy saver; its page in Settings has the switch");
            return null;
          }
          result = Power.Read();
          return null;
        }

        case "battery": {
          // Battery.cs: the bar's readout, read where Windows' own icon reads it,
          // and {watch:true} pushes {ev:"battery"} on change. Reading and
          // listening change nothing, so both run in passive. Unlisted in
          // Lanes, so ui: the watch's window must live on this loop thread.
          if (Json.HasKey(req, "watch")) {
            bool watch;
            string berr = StrictBool(req, "watch", out watch);
            if (berr != null) return berr;
            result = Battery.Watch(watch);
            return null;
          }
          result = Battery.Read();
          return null;
        }

        case "volwatch": {
          // VolumeWatch.cs: {ev:"volume"} pushed by CoreAudio itself on every change
          // of the level, the mute or the default device. Listening changes nothing,
          // so it runs in passive. Unlisted in Lanes: it only starts or stops a thread.
          bool von;
          string verr = StrictBool(req, "on", out von);
          if (verr != null) return verr;
          result = VolumeWatch.Set(von);
          return null;
        }

        case "net": {
          // NetState.cs: what the bar's network readout shows. get replies from a
          // pool thread; watch pushes {ev:"net"}. Both only read, so both run in
          // passive. The arguments are checked here, strictly, like every switch.
          bool nb;
          if (Json.HasKey(req, "on")) { string e1 = StrictBool(req, "on", out nb); if (e1 != null) return e1; }
          if (Json.HasKey(req, "fast")) { string e2 = StrictBool(req, "fast", out nb); if (e2 != null) return e2; }
          object nres;
          string nerr = NetState.Run(req, req.ContainsKey("id") ? req["id"] : null, Passive, out nres);
          if (nerr != null) return nerr;
          result = nres;
          return null;
        }

        case "qswatch": {
          // QuickSettings.cs, the watch: while main holds the lease (the panel is
          // open) every part is pushed as {ev:"qs", part, state} the moment it
          // changes (volume too, as the backstop to volwatch's CoreAudio callback).
          // Reads only, so it runs in passive.
          bool qon;
          string qerr = StrictBool(req, "on", out qon);
          if (qerr != null) return qerr;
          int lease = 60000;
          if (Json.HasKey(req, "leaseMs")) {
            object lv;
            Json.TryGet(req, "leaseMs", out lv);
            if (!(lv is double) || (double)lv < 1000 || (double)lv > 120000)
              return "qswatch: leaseMs must be a number from 1000 to 120000";
            lease = (int)(double)lv;
          }
          result = QuickSettings.Watch(qon, lease);
          return null;
        }

        case "volume": {
          // Reading volume changes nothing, so it works in passive too.
          int? level = Json.HasKey(req, "level") ? (int?)Json.GetInt(req, "level", 0) : null;
          bool? muted = Json.HasKey(req, "muted") ? (bool?)Json.GetBool(req, "muted", false) : null;
          int lvl; bool m;
          Volume.Apply(level, muted, out lvl, out m);
          result = Json.Obj("level", lvl, "muted", m);
          return null;
        }

        case "audio": {
          // The sound view behind the volume slider's '>' (AudioMixer.cs):
          // playback devices, the default one, and each app's level and mute.
          // Audio lane. In passive only a no-op default and the harness's own
          // session may be written; the arguments are checked first.
          object ares;
          string aerr = AudioMixer.Run(req, Passive, out ares);
          if (aerr != null) return aerr;
          result = ares;
          return null;
        }

        case "icon": {
          string path = Json.GetString(req, "path");
          if (string.IsNullOrEmpty(path)) return "icon needs a path (an .exe or .lnk)";
          result = Json.Obj("icon", Icons.ForPath(path));
          return null;
        }

        case "app": {
          // Read-only: it asks the shell what an app id is called and what it
          // looks like. An unknown id is an ANSWER (ok:false + the HRESULT),
          // not a protocol error - the caller is usually walking a pin list and
          // one dead id must not read as a broken command.
          string aumid = Json.GetString(req, "aumid");
          string appName, appPng;
          string aerr2 = Apps.Info(aumid, out appName, out appPng);
          result = aerr2 == null
            ? Json.Obj("ok", true, "aumid", aumid, "name", appName, "iconPng", appPng, "reason", null)
            : Json.Obj("ok", false, "aumid", aumid, "name", null, "iconPng", null, "reason", aerr2);
          return null;
        }

        case "pins": {
          // Read-only: the caller hands us the REG_BINARY it read; the sidecar
          // does not touch the registry itself.
          string b64 = Json.GetString(req, "blob");
          if (string.IsNullOrEmpty(b64))
            return "pins needs blob: the base64 of HKCU\\...\\Taskband\\Favorites";
          byte[] raw;
          try {
            raw = Convert.FromBase64String(b64.Trim());
          } catch (Exception) {
            return "pins: blob is not valid base64";
          }
          result = Apps.Parse(raw);
          return null;
        }

        case "launch": {
          // THE ONE COMMAND HERE THAT ACTS, so it is the one passive refuses.
          if (Passive) return PassiveRefusal + ": launch would start an app on the live desktop";
          string lerr = Apps.Launch(Json.GetString(req, "aumid"));
          result = lerr == null
            ? Json.Obj("ok", true, "reason", null)
            : Json.Obj("ok", false, "reason", lerr);
          return null;
        }

        case "tray":
          result = Tray.List();   // throws InvalidOperationException("tray unavailable: ...")
          return null;

        case "media":
          // Now-playing and transport controls (Media.cs, WinRT). Slow lane;
          // Media.cs does the WinRT work on its own MTA thread.
          return Media.Run(req, ref result);

        case "notifications":
          // Mantle's notification centre (Notifications.cs: the WinRT
          // listener + Windows' notification database, read-only). Slow lane;
          // the WinRT work runs on its own MTA thread. remove/clear/open are
          // refused in --passive except on the test-only AUMID.
          return Notifications.Run(req, ref result);

        case "trayClick": {
          // `icon`, NOT `id`: `id` is the PROTOCOL id. A caller that sent the
          // tray icon's id as `id` overwrote its own request id, so the reply
          // went out under the icon's id, the client dropped it, and the bar
          // showed a timeout for a click that had worked (found 2026-09-22).
          // A string `id` is still accepted so an old main.js clicks at all;
          // its reply is lost exactly as before.
          string id = Json.GetString(req, "icon");
          if (string.IsNullOrEmpty(id) && req.ContainsKey("id") && req["id"] is string) id = (string)req["id"];
          if (string.IsNullOrEmpty(id)) return "trayClick needs icon: the tray icon id from `tray`";
          // The argument is checked before passive, as everywhere else here.
          if (Passive) return PassiveRefusal;
          string button = Json.GetString(req, "button") ?? "left";
          string terr = Tray.Click(id, button);
          if (terr != null) return terr;
          result = Json.Obj();
          return null;
        }

        case "search": {
          // Launcher file search over the Windows Search index (Search.cs). The
          // ui lane only hands it off: Search.cs runs the query on its own
          // threads (OleDbCommand.Cancel() does not interrupt this provider and
          // blocked the caller for 16 s, so a superseded query is answered
          // `cancelled` instead) and replies when it lands.
          string qerr = Search.Enqueue(req, req.ContainsKey("id") ? req["id"] : null);
          if (qerr != null) return qerr;
          result = Deferred;
          return null;
        }

        case "session": {
          // Sleep for the launcher's power rows (Session.cs): SetSuspendState
          // has no exe to run from main, and rundll32 powrprof hibernates this
          // machine. Lock/restart/shut down/sign out run from main via exes.
          IDictionary sres;
          string sessErr = Session.Run(req, Passive, out sres);
          if (sessErr != null) return sessErr;
          result = sres;
          return null;
        }

        case "quit":
          // Answer BEFORE dying so the caller sees the ack rather than a
          // half-closed pipe, then restore the shell and exit 0.
          Reply(req.ContainsKey("id") ? req["id"] : null, true, Json.Obj(), null);
          RequestShutdown(0, "quit requested");
          return null;

        default: {
          // Feature files (Features.cs) own every "feature.verb" command not handled above.
          string ferr;
          if (Features.TryRun(cmd, req, ref result, out ferr)) return ferr;
          return "unknown command: " + cmd;
        }
      }
    }

    // ------------------------------------------------------ request helpers

    /// A switch argument must be a real JSON boolean. Json.GetBool coerces, and
    /// coercion is the wrong behaviour for a radio: `{on:"maybe"}` would become
    /// false and turn someone's Wi-Fi OFF. So this refuses anything that is not
    /// true or false, by name.
    static string StrictBool(Dictionary<string, object> req, string key, out bool value) {
      value = false;
      object v;
      if (!Json.TryGet(req, key, out v)) return key + " must be true or false";
      if (v is bool) { value = (bool)v; return null; }
      return key + " must be true or false, not " +
             (v is string ? "the string '" + (string)v + "'" : "'" + Convert.ToString(v, CultureInfo.InvariantCulture) + "'");
    }

    /// A {x,y,w,h,r} sub-object, in physical pixels. Missing fields are 0,
    /// which for r means "no rounded region" - the one default that has to be
    /// harmless, because a caller that forgets r must not get a clipped window.
    static string GetBox(Dictionary<string, object> req, string key, out Morph.Box box) {
      box = new Morph.Box();
      object v;
      if (!Json.TryGet(req, key, out v))
        return "morph needs " + key + ":{x,y,w,h,r} in physical pixels";
      var d = v as Dictionary<string, object>;
      if (d == null) return "morph: " + key + " must be an object {x,y,w,h,r}";
      box.X = Json.GetInt(d, "x", 0);
      box.Y = Json.GetInt(d, "y", 0);
      box.W = Json.GetInt(d, "w", 0);
      box.H = Json.GetInt(d, "h", 0);
      box.R = Json.GetInt(d, "r", 0);
      return null;
    }

    /// [x1,y1,x2,y2], the CSS cubic-bezier control points. Absent means the
    /// default curve; malformed is an ERROR rather than a silent fallback, or a
    /// typo in a renderer would ship an animation nobody asked for.
    static string GetEase(Dictionary<string, object> req, out double[] ease) {
      ease = null;
      object v;
      if (!Json.TryGet(req, "ease", out v)) return null;
      var list = v as IList;
      if (list == null) return "ease must be four numbers: [x1,y1,x2,y2]";
      var vals = new double[list.Count];
      for (int i = 0; i < list.Count; i++) {
        object o = list[i];
        if (o is double) { vals[i] = (double)o; continue; }
        double d;
        if (o is string && double.TryParse((string)o, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) {
          vals[i] = d;
          continue;
        }
        return "ease must be four numbers: [x1,y1,x2,y2]";
      }
      string bad = Bezier.Validate(vals);
      if (bad != null) return bad;
      ease = vals;
      return null;
    }

    // ------------------------------------------------------------------ exiting

    /// Idempotent, callable from any thread. Restores the live shell, flushes,
    /// and ends the process. Environment.Exit is deliberate: the message loop
    /// may be blocked or the loop window already gone, and the 2 s EOF deadline
    /// in the test harness is a real requirement.
    public static void RequestShutdown(int code, string reason) {
      if (Interlocked.Exchange(ref _shuttingDown, 1) != 0) return;

      // THE ORDER BELOW IS A BUG FIX (live crash test, 2026-09-21). The sidecar
      // used to log "sidecar shutting down" to stdout FIRST. When Electron is
      // killed, the read end of that pipe is dead but a handle to it can still
      // be open, so a write does not fail - it BLOCKS once the buffer fills.
      // The window watcher emits `windows` events carrying base64 icons every
      // few hundred ms, so it was usually already wedged inside the write lock
      // when the parent died. RequestShutdown then blocked on that same lock,
      // SafetyRestore never ran, and the process sat there until something
      // killed it ~15 s later - leaving the state file still saying
      // "appbars":["6358484"],"restored":false. Explorer reclaimed the app bar
      // only because the window finally died with the process.
      //
      // So now: silence stdout, arm a watchdog, do the whole restore and the
      // state-file write with NO stdout in the path, and only then try to
      // speak - with a bounded lock wait.
      _suppressEvents = true;
      ShellState.Quiet = true;
      ArmHardExit(code, HardExitMs);
      long shutdownStarted = Stopwatch.GetTimestamp();

      bool done;
      string detail = SafetyRestore(out done);

      // THE LOOP THREAD MUST NOT PUMP WHILE THE RUNTIME SHUTS DOWN (0xC000041D,
      // STATUS_FATAL_USER_CALLBACK_EXCEPTION, on ~4% of stdin-EOF exits and on
      // most of them under a burst of window events; measured 2026-09-25). Its
      // WinEvent hooks are delivered as kernel callbacks while it sits in
      // GetMessage, and they cannot be removed from here: UnhookWinEvent only
      // works on the thread that installed them. So Environment.Exit ran with
      // the hooks still live, the loop thread was called back into a runtime
      // that was being torn down, and the process died 100-300 ms later with
      // that code instead of 0. Now, AFTER every restore step (their order and
      // budgets are untouched): the loop thread takes its own hooks off and
      // parks in a wait that pumps nothing, and only then does the runtime go.
      // The brightness pop-up watch has its own pumping hook thread with
      // system-wide hooks - the same hazard - so it is ended first.
      try {
        string osd = OsdBright.EndHookThreadForExit(OsdHookEndMs);
        if (osd != null) detail += "; " + osd;
      } catch (Exception ex) { detail += "; brightness pop-up watch: could not be ended (" + ex.Message + ")"; }
      if (_loopThread != null && Thread.CurrentThread == _loopThread) {
        // `quit` runs on the ui lane, i.e. HERE. SafetyRestore's unhooks ran on
        // the right thread; hand the exit to a fresh thread and park this one.
        string ownDetail = detail + "; loop thread: hooks off, parked";
        Thread exitThread = null;
        try {
          exitThread = new Thread(delegate () { FinishExit(code, reason, done, ownDetail); });
          exitThread.IsBackground = true;
          exitThread.Name = "mantle-exit";
          exitThread.Start();
        } catch (Exception) { exitThread = null; }
        if (exitThread != null) ParkForever();
        FinishExit(code, reason, done, detail + "; loop thread: could not hand the exit to another thread, exiting from the loop");
      }
      detail += "; " + ParkLoopForExit(LoopParkBudgetMs(shutdownStarted));
      FinishExit(code, reason, done, detail);
    }

    /// The last words and the exit itself. Never returns.
    static void FinishExit(int code, string reason, bool done, string detail) {
      WriteLine(Json.Obj("ev", "log", "level", "warn", "message", "sidecar shutting down: " + reason), 250);
      WriteLine(Json.Obj("ev", "restore", "done", done, "detail", detail), 250);
      Environment.Exit(code);
    }

    /// How long the exit waits for the loop thread to park. Idle, it parks in
    /// well under 1 ms; busy (a window-list rebuild or a ui-lane command, e.g.
    /// the first icon-heavy list right after start) it parks when that call
    /// returns - tens of ms, more on a loaded box. Exiting before it parks
    /// brings the crash back, so the wait is as long as the hard exit allows:
    /// up to 1 s, minus what the restore already spent, keeping 600 ms for the
    /// two last lines (250 ms lock wait each) and the runtime's own exit. Never
    /// under 250 ms, and the hard exit bounds the whole thing regardless.
    static int LoopParkBudgetMs(long shutdownStarted) {
      long spent = (Stopwatch.GetTimestamp() - shutdownStarted) * 1000 / Stopwatch.Frequency;
      long left = HardExitMs - spent - 600;
      return (int)Math.Max(250, Math.Min(1000, left));
    }
    const int OsdHookEndMs = 200;       // its GetMessage loop answers WM_QUIT in well under 1 ms

    /// From any thread but the loop: have the loop thread remove its own
    /// window-watch hooks (only it can) and then block for good in a kernel
    /// wait that dispatches nothing - no WinEvent callback, no sent message, no
    /// timer - so nothing can call into managed code on it again. Returns the
    /// words for the `restore` detail.
    static string ParkLoopForExit(int ms) {
      MsgForm loop = _loop;
      if (loop == null || !loop.IsHandleCreated) return "loop thread: no loop window, nothing to park";
      Interlocked.Exchange(ref _park, ParkAsked);
      try {
        loop.BeginInvoke(new Action(ParkLoopIfAsked));
      } catch (Exception ex) {
        Interlocked.Exchange(ref _park, ParkCancelled);
        return "loop thread: could not be reached (" + ex.Message + "), exiting anyway";
      }
      if (!_loopParked.WaitOne(ms)) {
        // Too late is worse than never: a loop that parked in the MIDDLE of
        // Environment.Exit could stall it with no watchdog able to run. So the
        // request is withdrawn - unless the loop claimed it this very instant.
        if (Interlocked.CompareExchange(ref _park, ParkCancelled, ParkAsked) == ParkAsked)
          return "loop thread: still busy after " + ms + " ms and not parked, exiting anyway";
        _loopParked.WaitOne(ms);
      }
      return _loopHooksOff ? "loop thread: hooks off, parked"
                           : "loop thread: parked (a window hook would not come off, but a parked thread is never called back)";
    }

    const int ParkNone = 0, ParkAsked = 1, ParkClaimed = 2, ParkCancelled = 3;
    static int _park;
    static volatile bool _loopHooksOff;
    static readonly ManualResetEvent _loopParked = new ManualResetEvent(false);

    /// True while an exit is waiting for the loop thread to park. One volatile
    /// read: hook procs check it on every call.
    public static bool ParkWanted { get { return Volatile.Read(ref _park) == ParkAsked; } }

    /// On the loop thread, from every way in: the posted request above, the
    /// window watcher's WinEvent callback and timer, and the loop window's
    /// WndProc. The callbacks matter: under a burst of window events the loop
    /// thread spends its time being called back and the posted request can
    /// wait behind them for longer than the exit will (measured 2026-09-25:
    /// every crash left after the first version of this fix said "still busy").
    /// Unhooks (right thread, so it works), says so, and never returns.
    public static void ParkLoopIfAsked() {
      if (_loopThread == null || Thread.CurrentThread != _loopThread) return;
      if (Interlocked.CompareExchange(ref _park, ParkClaimed, ParkAsked) != ParkAsked) return;
      try { _loopHooksOff = WindowList.Stop(); } catch (Exception) { }
      _loopParked.Set();
      ParkForever();
    }

    [DllImport("kernel32.dll", EntryPoint = "Sleep")] static extern void KernelSleep(uint ms);

    /// Blocks this thread until the process ends. kernel32 Sleep on purpose:
    /// every CLR wait on an STA thread pumps messages, which is exactly what
    /// must not happen here.
    static void ParkForever() {
      for (;;) KernelSleep(0xFFFFFFFF);
    }

    /// How long the whole shutdown gets before the process is shot in the head.
    /// The restore itself is microseconds of Win32 plus one small file write;
    /// this only ever fires when something outside us is wedged (a pipe with no
    /// reader, an explorer that will not answer SHAppBarMessage, a hung
    /// Environment.Exit). A sidecar that hangs is the one thing that must never
    /// happen, because it is a sidecar still holding shell state.
    const int HardExitMs = 2000;

    static void ArmHardExit(int code, int ms) {
      try {
        var t = new Thread(delegate () {
          Thread.Sleep(ms);
          try { Win32.TerminateProcess(Win32.GetCurrentProcess(), (uint)code); } catch (Exception) { }
        });
        t.IsBackground = true;   // must never keep the process alive by itself
        t.Name = "mantle-hard-exit";
        t.Start();
      } catch (Exception) { }
    }

    /// Everything the sidecar could be holding that would make Windows look
    /// broken. Each step is independently guarded: ONE FAILURE MUST NEVER SKIP
    /// THE NEXT - that is what turned a bad taskbar call into a reboot on
    /// 2026-09-21. The order is deliberate: give the screen space back first,
    /// then the taskbar, then the input hook, then the bookkeeping.
    ///
    /// stdout may already be gone by the time this runs, so the closing
    /// `restore` event is genuinely best-effort; the state file is the record
    /// that survives.
    static string SafetyRestore(out bool done) {
      var detail = new List<string>();
      done = true;

      // First, so nothing keeps feeding events into a pipe nobody is reading.
      // Off the loop thread this stops the timer but cannot unhook; the loop
      // thread does that itself when RequestShutdown parks it.
      try { WindowList.Stop(); }
      catch (Exception) { detail.Add("window watcher: would not stop; it dies with the process"); }

      try { detail.Add(AppBars.RemoveAllForExit()); }
      catch (Exception ex) { done = false; detail.Add("app bars: cleanup failed (" + ex.Message + ")"); }

      // The taskbar's empty window region (TaskbarHide.cs) before its auto-hide
      // flag: invisible is the more visible way to leave Windows broken. Bounded
      // by its own 0.6 s deadline; the guard process finishes it if Explorer is hung.
      try { detail.Add(TaskbarHide.ReleaseForExit()); }
      catch (Exception ex) { done = false; detail.Add("taskbar region: release failed (" + ex.Message + "); the taskbar guard clears it when this process is gone"); }

      try { detail.Add(Taskbar.RestoreForExit()); }
      catch (Exception ex) { done = false; detail.Add("taskbar: restore failed (" + ex.Message + ")"); }

      // The cursor first: a pointer the user cannot move to the bottom of their
      // own screen is the most visible way this process could leave Windows
      // looking broken, and it costs one Win32 call.
      try { detail.Add(EdgeClip.ReleaseForExit() ? "cursor clip: released" : "cursor clip: none was held"); }
      catch (Exception ex) { done = false; detail.Add("cursor clip: release failed (" + ex.Message + "); it dies with the process"); }

      // GDI handles are process-owned, so this is tidiness rather than safety -
      // but a leaked DC is the kind of thing that only shows up as "Windows got
      // slow after a week", and one call costs nothing.
      try { Backdrop.Release(); } catch (Exception) { }

      // Animation threads first: they are the only thing left that still calls
      // SetWindowPos, and a frame landing mid-restore is pure confusion.
      try { Morph.CancelAll(); detail.Add("morphs: stopped"); }
      catch (Exception ex) { detail.Add("morphs: could not be stopped (" + ex.Message + "); they die with the process"); }

      // Before the keyboard hook and with no stdout in the way: an out-of-
      // context WinEvent hook that outlives its thread is Explorer calling into
      // a dead process on every taskbar move.
      try { TrayWatch.Stop(); detail.Add("tray watch: unhooked"); }
      catch (Exception ex) { done = false; detail.Add("tray watch: unhook failed (" + ex.Message + "); it dies with the process anyway"); }

      try { Hotkey.Uninstall(); detail.Add("keyboard hook: uninstalled"); }
      catch (Exception ex) { done = false; detail.Add("keyboard hook: uninstall failed (" + ex.Message + "); it dies with the process anyway"); }

      // The Bluetooth helper would exit on its own when our end of its stdin
      // closes; killing it here just means it never outlives us by a moment.
      try { Bluetooth.StopHost("the sidecar is shutting down"); } catch (Exception) { }

      // LAST, and SYNCHRONOUSLY ON THIS THREAD, with no stdout between here and
      // the steps above: this is the record that outlives the process, and the
      // 2026-09-21 crash test proved it is the one that must not be skipped.
      // AppBars.RemoveAllForExit has already cleared `changed.appbars`.
      try {
        if (ShellState.Enabled) {
          string werr = ShellState.MarkRestored(true);
          detail.Add(werr == null ? "state file: restored:true written" : "state file: " + werr);
        } else {
          detail.Add("state file: none was asked for (--state-file), so nothing was recorded");
        }
      } catch (Exception ex) { detail.Add("state file: could not be updated (" + ex.Message + ")"); }

      return string.Join("; ", detail.ToArray());
    }
  }
}
