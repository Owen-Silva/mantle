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
    public const string Version = "0.1.0";

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
        EmitLog("error", "sidecar is exiting on an unhandled error: " + (ex == null ? "unknown" : ex.Message));
        SafetyRestore();
        FlushOut();
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
      string line;
      try {
        line = Json.Write(payload);
      } catch (Exception) {
        return;   // never let serialising an event kill a command
      }
      lock (_writeLock) {
        try {
          _out.Write(line);
          _out.Write('\n');
          _out.Flush();
        } catch (Exception) {
          // The pipe is gone; the stdin reader will notice EOF and shut us down.
        }
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
          var ping = Json.Obj("pid", OwnPid, "passive", Passive, "version", Version,
                              "dpiAware", DpiAware, "dpiMode", DpiMode);
          if (!DpiAware || DpiReason != null) ping["dpiReason"] = DpiReason;
          result = ping;
          return null;
        }

        case "windows":
          result = WindowList.Build();
          return null;

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

    // ------------------------------------------------------------------ exiting

    /// Idempotent, callable from any thread. Restores the live shell, flushes,
    /// and ends the process. Environment.Exit is deliberate: the message loop
    /// may be blocked or the loop window already gone, and the 2 s EOF deadline
    /// in the test harness is a real requirement.
    public static void RequestShutdown(int code, string reason) {
      if (Interlocked.Exchange(ref _shuttingDown, 1) != 0) return;
      try { EmitLog("warn", "sidecar shutting down: " + reason); } catch (Exception) { }
      SafetyRestore();
      FlushOut();
      Environment.Exit(code);
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
    static void SafetyRestore() {
      var detail = new List<string>();
      bool done = true;

      try { detail.Add(AppBars.RemoveAllForExit()); }
      catch (Exception ex) { done = false; detail.Add("app bars: cleanup failed (" + ex.Message + ")"); }

      try { detail.Add(Taskbar.RestoreForExit()); }
      catch (Exception ex) { done = false; detail.Add("taskbar: restore failed (" + ex.Message + ")"); }

      try { Hotkey.Uninstall(); detail.Add("keyboard hook: uninstalled"); }
      catch (Exception ex) { done = false; detail.Add("keyboard hook: uninstall failed (" + ex.Message + "); it dies with the process anyway"); }

      try { WindowList.Stop(); }
      catch (Exception) { detail.Add("window watcher: would not stop; it dies with the process"); }

      // The state file records that the restore ran. A failure to write it is
      // bookkeeping, not shell state, so it is reported but does not make the
      // restore itself "not done".
      try {
        if (ShellState.Enabled) {
          string werr = ShellState.MarkRestored(true);
          detail.Add(werr == null ? "state file: restored:true written" : "state file: " + werr);
        }
      } catch (Exception ex) { detail.Add("state file: could not be updated (" + ex.Message + ")"); }

      try {
        Emit(Json.Obj("ev", "restore", "done", done, "detail", string.Join("; ", detail.ToArray())));
      } catch (Exception) { }
    }
  }
}
