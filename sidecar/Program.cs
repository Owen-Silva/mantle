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
//   stdin thread  blocks on ReadLine and marshals each request onto the loop
//                 thread with BeginInvoke, so command handlers run where the
//                 hooks live and no Win32 state is touched from two threads.
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
    public const string Version = "0.2.0";

    /// Everything Run() answers, in the order a reader would want them. This is
    /// the protocol's own index: if a command is added below it belongs here,
    /// because `ping.commands` is what the Electron side checks before offering
    /// a feature.
    public static readonly string[] Commands = new string[] {
      "ping", "windows", "foreground", "focus", "minimize", "close", "toggle",
      "taskbar", "appbar", "traywatch", "edgeclip", "hittest", "raise",
      "glass", "corners", "place", "morph", "region",
      "workarea", "desktop", "hotkey", "keys", "volume", "icon", "lnk", "backdrop",
      "app", "pins", "launch", "wifi", "bluetooth", "brightness", "nightlight", "power",
      "tray", "trayClick", "quit"
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

      _loop = new MsgForm();
      LoopHandle = _loop.Handle;        // forces HWND creation; BeginInvoke needs it

      // Write down what the shell looked like BEFORE anything can change it.
      // Both reads (ABM_GETSTATE, SPI_GETWORKAREA) change nothing, so this runs
      // in --passive too: a passive run still leaves a usable recovery note.
      ShellState.Configure(StateFilePath);
      ShellState.CaptureOriginal();
      WindowList.Start();               // read-only, so it runs in passive too

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
      }

      if (ShellState.Enabled) ShellState.Write();
      else EmitLog("warn", "no --state-file: a recovery script cannot know the original shell state");

      StartStdinReader();
      WatchParent();

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
            try {
              _loop.BeginInvoke(new Action<string>(HandleLine), trimmed);
            } catch (Exception) {
              return;   // the loop window is gone: we are already shutting down
            }
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

    static void HandleLine(string line) {
      object id = null;
      try {
        var req = Json.Parse(line) as Dictionary<string, object>;
        if (req == null) { Reply(null, false, null, "bad request: expected one JSON object per line"); return; }
        req.TryGetValue("id", out id);
        string cmd = Json.GetString(req, "cmd");
        if (string.IsNullOrEmpty(cmd)) { Reply(id, false, null, "bad request: no cmd field"); return; }

        object result = null;
        string err = Run(cmd, req, ref result);
        if (err != null) Reply(id, false, null, err);
        // `morph` answers from its own thread when the last frame lands, so the
        // dispatcher must stay quiet or the caller would get two replies to one
        // id and the correlation table would never settle.
        else if (ReferenceEquals(result, Deferred)) { }
        else Reply(id, true, result, null);
      } catch (FormatException fe) {
        Reply(id, false, null, "bad request: " + fe.Message);
      } catch (InvalidOperationException ioe) {
        // Our own "this cannot work, and here is why" exceptions: pass the
        // wording through untouched.
        Reply(id, false, null, ioe.Message);
      } catch (Exception ex) {
        Reply(id, false, null, "command failed: " + ex.GetType().Name + ": " + ex.Message);
      }
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
          result = ping;
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
          string mode;
          string aerr = Desktop.Attach(hwnd, out mode);
          if (aerr != null) return aerr;
          result = Json.Obj("mode", mode);
          return null;
        }

        case "hotkey": {
          if (Passive) return PassiveRefusal;
          if (!Json.HasKey(req, "winTap")) return "hotkey needs winTap:true or winTap:false";
          bool installed;
          string herr = Hotkey.Install(Json.GetBool(req, "winTap", false), out installed);
          if (herr != null) return herr;
          result = Json.Obj("installed", installed);
          return null;
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
            result = Network.Set(want);
            return null;
          }
          result = Network.Read();
          return null;
        }

        case "bluetooth": {
          if (Json.HasKey(req, "on")) {
            bool want;
            string aerr = StrictBool(req, "on", out want);
            if (aerr != null) return aerr;
            if (Passive) return PassiveRefusal + ": bluetooth would switch the live radio";
            result = Bluetooth.Set(want);
            return null;
          }
          result = Bluetooth.Read();
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
            result = Display.SetBrightness(want);
            return null;
          }
          result = Display.Brightness();
          return null;
        }

        case "nightlight": {
          // Read-only on purpose - see Display.cs: the state is an undocumented
          // CloudStore blob, and writing it wrongly leaves the display stuck.
          if (Json.HasKey(req, "on")) {
            result = Json.Obj("ok", false, "present", true, "on", false,
                              "reason", "not available yet: Mantle can read night light but cannot switch it, " +
                                        "because Windows has no API for it and its state is an undocumented blob");
            return null;
          }
          result = Display.NightLight();
          return null;
        }

        case "power": {
          if (Json.HasKey(req, "saver")) {
            result = Json.Obj("ok", false, "reason",
                              "not available yet: Mantle can report battery saver but cannot switch it");
            return null;
          }
          result = Power.Read();
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

        case "trayClick": {
          if (Passive) return PassiveRefusal;
          string id = Json.GetString(req, "id");
          string button = Json.GetString(req, "button") ?? "left";
          string terr = Tray.Click(id, button);
          if (terr != null) return terr;
          result = Json.Obj();
          return null;
        }

        case "quit":
          // Answer BEFORE dying so the caller sees the ack rather than a
          // half-closed pipe, then restore the shell and exit 0.
          Reply(req.ContainsKey("id") ? req["id"] : null, true, Json.Obj(), null);
          RequestShutdown(0, "quit requested");
          return null;

        default:
          return "unknown command: " + cmd;
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

      bool done;
      string detail = SafetyRestore(out done);

      WriteLine(Json.Obj("ev", "log", "level", "warn", "message", "sidecar shutting down: " + reason), 250);
      WriteLine(Json.Obj("ev", "restore", "done", done, "detail", detail), 250);
      Environment.Exit(code);
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
      try { WindowList.Stop(); }
      catch (Exception) { detail.Add("window watcher: would not stop; it dies with the process"); }

      try { detail.Add(AppBars.RemoveAllForExit()); }
      catch (Exception ex) { done = false; detail.Add("app bars: cleanup failed (" + ex.Message + ")"); }

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
