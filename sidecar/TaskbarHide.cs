// TaskbarHide.cs - `tbhide`: make the Windows taskbar INVISIBLE while Mantle
// runs, without hiding it, moving it or touching its auto-hide state.
//
// WHY IT KEPT SHOWING UP (measured 2026-09-25, a read-only WinEvent probe on
// explorer's pid, 10 minutes of Owen using the PC normally): 7 reveals, and
// EVERY ONE began 35-50 ms after a FOREGROUND CHANGE - 6 of the 7 right after
// Mantle's own bar opened an app ("bar.open Terminal: focus ... done" in
// mantle.log at the same byte offset). The auto-hidden taskbar slid fully up
// (0,1020,1920,1080) for ~1 s with the cursor NOT at the bottom edge (y 1006 to
// 1034, over Mantle's bar; once at y 27), and the edge clip was already gone:
// Windows drops every cursor clip on a foreground change, which is the same
// moment Explorer decides to reveal. One of the 7 also had an HSHELL_FLASH (a
// refused SetForegroundWindow flashes the button, and a flash reveals an
// auto-hidden taskbar). The Win key, Win+T/B, toasts and a restarting explorer
// reveal it the same way. None of those go through the cursor, so no cursor
// clip can stop them - Explorer's reveal cannot be prevented from outside.
//
// SO THE REVEAL IS LET HAPPEN, INVISIBLY. An EMPTY WINDOW REGION on
// Shell_TrayWnd / Shell_SecondaryTrayWnd (SetWindowRgn with a 0x0 region):
//
//   * DWM draws nothing of the window and hit-testing skips it, so a revealed
//     taskbar is neither seen nor clickable - clicks fall through to the app.
//   * The window is NOT hidden, NOT moved, NOT re-ordered, and its auto-hide
//     state is never touched. IsWindowVisible stays true and its rectangle stays
//     Explorer's, so Explorer's own show/hide state machine keeps running exactly
//     as before. THAT is what 2026-09-21 broke (ShowWindow(SW_HIDE) wedged it -
//     see Taskbar.cs); a region is not part of that machine at all.
//   * The tray (Tray.cs: Shell_NotifyIconGetRect; TrayUia.cs: UI Automation
//     BoundingRectangle + Invoke) reads Explorer's LAYOUT, which a region does
//     not change. Jump lists (JumpList.cs) never look at the taskbar window.
//     Win+number is Explorer's own hotkey on a still-visible window.
//   * Mantle already does this to windows it does not own: Morph.cs rounds the
//     Electron bar (another process, DirectComposition content) with
//     SetWindowRgn - the cross-process call and the DComp clipping are proven.
//
// Rejected, and why: ShowWindow(SW_HIDE) and SetWindowPos off-screen are banned
// (Taskbar.cs, the 2026-09-21 incident) and both fight Explorer's animation; a
// layered alpha of 0 rewrites Explorer's extended style, keeps the window
// hit-testable (an invisible strip eating clicks at the bottom of the screen)
// and is shaky on a WS_EX_NOREDIRECTIONBITMAP window; cloaking is refused for
// another process's window; stopping the triggers is impossible (above).
//
// THE PRICE, AND HOW IT IS PAID. A region OUTLIVES ITS PROCESS: a Mantle that
// dies holding one leaves an invisible (still working) taskbar. So:
//
//   1. Recognised BY SHAPE, like the edge clip: an EMPTY region on a taskbar
//      window is only ever Mantle's. Any Mantle can take one over or clear it.
//   2. Every exit road of this process releases it (SafetyRestore, before the
//      old taskbar step, on its own thread with a deadline so a hung Explorer
//      cannot stall the rest of the restore).
//   3. A GUARD PROCESS - this same exe with --taskbar-guard=<pid> - is started
//      BEFORE the first region is set, and no region is set without one. It
//      waits on this sidecar's process handle and clears the region the moment
//      the sidecar dies, however it dies (TerminateProcess, Electron's job
//      closing, a crash). It breaks away from Electron's job object so the job
//      that kills the sidecar does not take it too, and it leaves a note that
//      the next sidecar reports.
//   4. A new sidecar clears a stale one at startup (non-passive, and only when
//      no other live sidecar is holding it).
//   5. tools/restore-windows.ps1 clears it with no Mantle running, and
//      restarting Explorer clears it too (a new window has no region). Never a
//      reboot.
//
// Passive (test) sidecars never set, take over or clear a region: `tbhide on`
// and `off` are refused, the startup clear is skipped, and the decision logic
// is exercised with made-up window states through `tbhide {decide:[...]}`.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  static class TaskbarHide {
    // ------------------------------------------------------- what we can see
    /// GetWindowRgn's answer, folded to what the decision needs.
    public const int KindGone = -1;   // the window no longer exists
    public const int KindNone = 0;    // ERROR: no region at all - Explorer's normal state
    public const int KindEmpty = 1;   // NULLREGION: empty - MANTLE'S SHAPE
    public const int KindShaped = 2;  // SIMPLE/COMPLEX: some other program shaped the taskbar

    public const string ActApply = "apply", ActKeep = "keep", ActRelease = "release",
                        ActLeave = "leave", ActYield = "yield";

    static readonly string[] Classes = { "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };

    // ------------------------------------------------------- the pure logic

    /// THE WHOLE DECISION for one taskbar window. No Win32, no state: `tbhide
    /// {decide:[...]}` hands it made-up windows so the test suite proves it
    /// without anybody's taskbar being touched.
    ///   want        hiding is wanted right now
    ///   kind        KindGone / KindNone / KindEmpty / KindShaped
    ///   mayRelease  (want=false only) this caller may clear an empty region:
    ///               the process that set it, the guard of a dead one, or the
    ///               startup/recovery clear when no other Mantle holds it
    public static string Decide(bool want, int kind, bool mayRelease, out string reason) {
      if (kind == KindGone) {
        reason = "the window is gone (Explorer restarting or a monitor removed); its replacement is checked on the next pass";
        return ActLeave;
      }
      if (want) {
        if (kind == KindNone) {
          reason = "no window region yet, so an empty one is set: Explorer keeps running the taskbar, nobody sees it";
          return ActApply;
        }
        if (kind == KindEmpty) {
          reason = "already invisible (an empty window region, Mantle's shape, is in place)";
          return ActKeep;
        }
        reason = "another program has given the taskbar its own window region, so Mantle leaves it alone rather than fight it";
        return ActYield;
      }
      if (kind == KindEmpty) {
        if (mayRelease) {
          reason = "the empty window region is cleared, so the taskbar draws again";
          return ActRelease;
        }
        reason = "an empty window region is in place but another live Mantle holds it, so it is left to that one";
        return ActLeave;
      }
      if (kind == KindNone) {
        reason = "no window region, so there is nothing to undo";
        return ActLeave;
      }
      reason = "the taskbar has a region that is not Mantle's shape, so it is never cleared here";
      return ActLeave;
    }

    /// One wire line for a whole pass: invisible only if EVERY taskbar window is,
    /// and the reason names what is not.
    public static bool Summarize(IList<string> classes, IList<string> actions, IList<bool> okAfter,
                                 IList<string> reasons, out string reason) {
      if (classes.Count == 0) {
        reason = "there is no taskbar window right now (Explorer is not running the shell); it is hidden as soon as one appears";
        return false;
      }
      int hidden = 0;
      string firstBad = null;
      for (int i = 0; i < classes.Count; i++) {
        bool good = (actions[i] == ActApply || actions[i] == ActKeep) && okAfter[i];
        if (good) { hidden++; continue; }
        if (firstBad != null) continue;
        firstBad = classes[i] + ": " + (actions[i] == ActApply
          ? "Windows did not take the empty window region (SetWindowRgn was refused or did not stick)"
          : reasons[i]);
      }
      if (hidden == classes.Count) {
        reason = "the Windows taskbar is invisible (an empty window region on " + hidden +
                 (hidden == 1 ? " taskbar window" : " taskbar windows") +
                 "); it still runs underneath, so the tray and Win+number keep working";
        return true;
      }
      reason = "the Windows taskbar can still show: " + firstBad;
      return false;
    }

    // --------------------------------------------------------- Win32 (local)
    static class Api {
      [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr hrgn);
      [DllImport("user32.dll", SetLastError = true)] public static extern int SetWindowRgn(IntPtr hwnd, IntPtr hrgn, bool redraw);
      [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
      [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);

      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
      }
      [StructLayout(LayoutKind.Sequential)]
      public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
                                               uint flags, IntPtr env, string dir, ref STARTUPINFO si,
                                               out PROCESS_INFORMATION pi);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
      public const uint CREATE_NO_WINDOW = 0x08000000, CREATE_BREAKAWAY_FROM_JOB = 0x01000000,
                        BELOW_NORMAL_PRIORITY_CLASS = 0x00004000;
    }

    const uint WM_NULL = 0x0000, SMTO_ABORTIFHUNG = 0x0002;

    /// MANTLE_TBHIDE_TEST_CLASS=<class>: TEST ONLY (sidecar/test-tbhide.js). Every
    /// lookup then sees ONLY windows of that class - a stand-in the test owns - so
    /// the live path (region, guard, kill, stale clear) runs end to end without the
    /// real taskbar ever being a candidate. A Shell_* name is refused outright
    /// (nothing is found), never "helpfully" widened back to the real classes.
    static string[] ClassesNow() {
      string t = Environment.GetEnvironmentVariable("MANTLE_TBHIDE_TEST_CLASS");
      if (string.IsNullOrEmpty(t)) return Classes;
      if (t.StartsWith("Shell_", StringComparison.OrdinalIgnoreCase)) return new string[0];
      return new string[] { t };
    }

    public static List<IntPtr> TrayWindows() {
      var list = new List<IntPtr>();
      foreach (string c in ClassesNow()) {
        IntPtr h = IntPtr.Zero;
        int guard = 0;
        while ((h = Win32.FindWindowExW(IntPtr.Zero, h, c, null)) != IntPtr.Zero && guard++ < 16) list.Add(h);
      }
      return list;
    }

    public static int KindOf(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return KindGone;
      IntPtr probe = Api.CreateRectRgn(0, 0, 0, 0);
      if (probe == IntPtr.Zero) return KindNone;
      try {
        int t = Api.GetWindowRgn(hwnd, probe);
        if (t == 1) return KindEmpty;      // NULLREGION
        if (t == 2 || t == 3) return KindShaped;
        return Win32.IsWindow(hwnd) ? KindNone : KindGone;
      } finally { Api.DeleteObject(probe); }
    }

    static string KindName(int k) {
      return k == KindEmpty ? "empty" : k == KindShaped ? "shaped" : k == KindNone ? "none" : "gone";
    }

    /// Explorer answers at all? SetWindowRgn on another thread's window SENDS it
    /// messages, so a hung Explorer would hang the caller. This costs at most
    /// `ms` and says no instead.
    static bool Answers(IntPtr hwnd, uint ms) {
      IntPtr ignored;
      return Win32.SendMessageTimeoutW(hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, ms, out ignored) != IntPtr.Zero;
    }

    static bool SetEmpty(IntPtr hwnd) {
      IntPtr rgn = Api.CreateRectRgn(0, 0, 0, 0);
      if (rgn == IntPtr.Zero) return false;
      if (Api.SetWindowRgn(hwnd, rgn, true) == 0) {
        // Only on FAILURE is the region still ours to free (Morph.cs, same rule).
        Api.DeleteObject(rgn);
        return false;
      }
      return KindOf(hwnd) == KindEmpty;
    }

    static bool Clear(IntPtr hwnd) {
      Api.SetWindowRgn(hwnd, IntPtr.Zero, true);
      int k = KindOf(hwnd);
      return k == KindNone || k == KindGone;
    }

    // ------------------------------------------------------------ live state
    static readonly object _lock = new object();
    static volatile bool _on;
    static bool _everOn;           // only a process that set a region may release on its way out
    static bool _applied;
    static string _reason = "";
    static int _windows;
    static Thread _worker;
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static readonly ManualResetEvent _passDone = new ManualResetEvent(false);
    static Win32.WinEventProc _proc;   // static: the GC must never collect a live hook proc
    static IntPtr _hook = IntPtr.Zero;
    static int _hookPid;
    static EventWaitHandle _holder;    // "a live Mantle holds the taskbar region": Local\Mantle.TaskbarHide.Holder.<pid>
    static Process _guard;
    static string _guardState = "not started";

    public static bool On { get { return _on; } }
    public static bool Applied { get { lock (_lock) return _applied; } }
    public static string Reason { get { lock (_lock) return _reason; } }
    public static string GuardState { get { lock (_lock) return _guardState; } }

    const string HolderPrefix = "Local\\Mantle.TaskbarHide.Holder.";
    const string GuardPrefix = "Local\\Mantle.TaskbarGuard.";
    const int BackstopMs = 1000;
    const uint AnswerMs = 500;

    /// True when process `pid` is a taskbar guard (same exe name as a sidecar, so
    /// every "is another sidecar running?" check must ask this first).
    public static bool IsGuard(int pid) {
      EventWaitHandle h;
      if (EventWaitHandle.TryOpenExisting(GuardPrefix + pid.ToString(CultureInfo.InvariantCulture), out h)) {
        h.Dispose();
        return true;
      }
      return false;
    }

    /// Another live, non-guard sidecar that is holding the region right now.
    public static int OtherHolder(int exceptPid) {
      int me = Program.OwnPid > 0 ? Program.OwnPid : Process.GetCurrentProcess().Id;
      try {
        foreach (var p in Process.GetProcessesByName("Mantle.Sidecar")) {
          using (p) {
            if (p.Id == me || p.Id == exceptPid) continue;
            EventWaitHandle h;
            if (EventWaitHandle.TryOpenExisting(HolderPrefix + p.Id.ToString(CultureInfo.InvariantCulture), out h)) {
              h.Dispose();
              return p.Id;
            }
          }
        }
      } catch (Exception) { }
      return 0;
    }

    // ------------------------------------------------------------- the verbs

    /// Turn it on. Runs on the ui lane (the message-loop thread), which is where
    /// the WinEvent hook must live. Every region call happens on the worker
    /// thread, so a hung Explorer can never stall the loop (and the keyboard
    /// hook on it). Waits up to ~2 s for the first pass so the answer is the truth.
    public static string TurnOn(string guardNote, out bool applied, out string reason, out string guard) {
      // No region without a guard: a sidecar killed mid-run must not be able to
      // leave the taskbar invisible.
      string gerr = EnsureGuard(guardNote);
      if (gerr != null) {
        lock (_lock) { _guardState = gerr; }
        applied = false;
        reason = "the Windows taskbar was NOT made invisible: " + gerr;
        guard = gerr;
        Say(false, reason);
        return null;
      }
      _on = true;
      _everOn = true;
      try {
        if (_holder == null)
          _holder = new EventWaitHandle(false, EventResetMode.ManualReset,
                                        HolderPrefix + Program.OwnPid.ToString(CultureInfo.InvariantCulture));
      } catch (Exception ex) {
        Program.EmitLog("warn", "tbhide: the holder marker could not be created (" + ex.Message +
                                "), so a second Mantle cannot tell this one is holding the taskbar region");
      }
      ShellState.SetTaskbarRegion(true);
      HookExplorer();
      _passDone.Reset();
      StartWorker();
      _wake.Set();
      bool finished = _passDone.WaitOne(2000);
      lock (_lock) {
        applied = _applied;
        reason = finished ? _reason
          : "Explorer has not answered within 2 s; the taskbar is made invisible as soon as it does";
        guard = _guardState;
      }
      return null;
    }

    /// Turn it off by request: stop watching and clear OUR region.
    public static bool TurnOff(out string reason) {
      _on = false;
      Unhook();
      bool released = ReleaseAll(true, out reason);
      DropHolder();
      ShellState.SetTaskbarRegion(false);
      Say(false, "Mantle let the Windows taskbar draw again: " + reason);
      return released;
    }

    /// The shutdown path: NO STDOUT, never throws, never waits more than ~0.6 s
    /// on Explorer (on its own thread: a hung Explorer must not skip the steps
    /// after this one). Only a process that set a region releases here - the same
    /// rule as the edge clip, so a passive test sidecar exiting never makes the
    /// live one's taskbar visible.
    public static string ReleaseForExit() {
      _on = false;
      try { Unhook(); } catch (Exception) { }
      if (!_everOn) return "taskbar region: none was set by this process";
      string result = null;
      var t = new Thread(delegate () {
        string why;
        try { ReleaseAll(true, out why); } catch (Exception ex) { why = "threw (" + ex.Message + ")"; }
        result = why;
      });
      t.IsBackground = true;
      t.Name = "mantle-tbhide-exit";
      t.Start();
      bool joined = t.Join(600);
      DropHolder();
      try { ShellState.SetTaskbarRegion(!joined); } catch (Exception) { }
      if (!joined)
        return "taskbar region: Explorer did not answer within 0.6 s; the taskbar guard clears it the moment this process is gone";
      return "taskbar region: " + result;
    }

    /// Non-passive startup: an empty region on a taskbar window before this
    /// process did anything is a stale one from a Mantle that died without its
    /// guard (or with it killed too). Clear it, unless another live sidecar holds it.
    public static string ClearStaleAtStartup() {
      int stale = 0;
      foreach (IntPtr h in TrayWindows()) if (KindOf(h) == KindEmpty) stale++;
      if (stale == 0) return null;
      int holder = OtherHolder(0);
      if (holder != 0) return null;   // the live Mantle's, not stale
      string why;
      bool ok = ReleaseAll(true, out why);
      return (ok ? "cleared a stale empty window region on " : "FAILED to clear a stale empty window region on ") +
             stale + (stale == 1 ? " taskbar window" : " taskbar windows") +
             " left by an earlier Mantle that died with its guard (" + why + ")";
    }

    /// What the previous sidecar's guard did, said once by the next sidecar.
    public static string TakeGuardNote(string guardNote) {
      try {
        if (string.IsNullOrEmpty(guardNote) || !File.Exists(guardNote)) return null;
        string text = File.ReadAllText(guardNote).Trim();
        File.Delete(guardNote);
        return text.Length == 0 ? null : text.Replace("\r", "").Replace("\n", " | ");
      } catch (Exception ex) {
        return "the taskbar guard's note could not be read (" + ex.Message + ")";
      }
    }

    // ----------------------------------------------------------- the keeping

    static void StartWorker() {
      if (_worker != null && _worker.IsAlive) return;
      _worker = new Thread(WorkerLoop);
      _worker.IsBackground = true;   // never keeps the process alive by itself
      _worker.Name = "mantle-tbhide";
      _worker.Start();
    }

    static void WorkerLoop() {
      while (true) {
        _wake.WaitOne(BackstopMs);
        if (!_on) { _passDone.Set(); continue; }
        try { Pass(); }
        catch (Exception ex) { Say(false, "the Windows taskbar check failed (" + ex.Message + "); it is retried in 1 s"); }
        _passDone.Set();
      }
    }

    /// One pass over every taskbar window: decide, act, verify, say.
    static void Pass() {
      // The guard is what makes a region safe to hold. If it died (someone
      // killed it), start another; if that fails, give the taskbar back.
      if (!GuardAlive()) {
        string gerr = EnsureGuard(null);
        if (gerr != null) {
          string why;
          ReleaseAll(true, out why);
          lock (_lock) { _guardState = gerr; }
          Say(false, "the taskbar guard is gone and could not be restarted, so the Windows taskbar was made visible again: " + gerr);
          return;
        }
        Program.EmitLog("warn", "tbhide: the taskbar guard had exited; a new one was started (" + GuardState + ")");
      }
      var classes = new List<string>();
      var actions = new List<string>();
      var oks = new List<bool>();
      var reasons = new List<string>();
      int trayPid = 0;
      foreach (IntPtr h in TrayWindows()) {
        string cls = Win32.GetClassName(h);
        int kind = KindOf(h);
        string why;
        string act = Decide(true, kind, false, out why);
        bool ok = true;
        if (act == ActApply) {
          if (!Answers(h, AnswerMs)) { act = ActLeave; ok = false; why = "Explorer is not answering, so the region is set once it does"; }
          else ok = SetEmpty(h);
        }
        if (cls == "Shell_TrayWnd") Win32.GetWindowThreadProcessId(h, out trayPid);
        classes.Add(cls); actions.Add(act); oks.Add(ok); reasons.Add(why);
      }
      if (trayPid != 0 && trayPid != _hookPid) Program.Post(delegate () { HookExplorer(); });
      string reason;
      bool applied = Summarize(classes, actions, oks, reasons, out reason);
      lock (_lock) { _windows = classes.Count; }
      Say(applied, reason);
    }

    /// Clear every Mantle-shaped (empty) region. `mayRelease` is the caller's
    /// right to (see Decide). Returns true when nothing empty is left.
    static bool ReleaseAll(bool mayRelease, out string reason) {
      int cleared = 0, failed = 0, left = 0;
      foreach (IntPtr h in TrayWindows()) {
        string why;
        string act = Decide(false, KindOf(h), mayRelease, out why);
        if (act != ActRelease) { if (KindOf(h) == KindEmpty) left++; continue; }
        if (Clear(h)) cleared++; else failed++;
      }
      if (cleared == 0 && failed == 0 && left == 0) { reason = "none was set, nothing to clear"; return true; }
      reason = cleared + " cleared" + (failed > 0 ? ", " + failed + " FAILED (restart Explorer, or run tools\\restore-windows.ps1)" : "") +
               (left > 0 ? ", " + left + " left to the Mantle holding it" : "");
      return failed == 0;
    }

    static void DropHolder() {
      try { if (_holder != null) _holder.Dispose(); } catch (Exception) { }
      _holder = null;
    }

    /// Explorer shows a NEW taskbar window on a restart or a new monitor: hook its
    /// process so that window gets its region within one event, not one backstop.
    static void HookExplorer() {
      IntPtr tray = Win32.FindWindowW("Shell_TrayWnd", null);
      if (tray == IntPtr.Zero) return;
      int pid;
      Win32.GetWindowThreadProcessId(tray, out pid);
      if (pid == 0 || (pid == _hookPid && _hook != IntPtr.Zero)) return;
      Unhook();
      _proc = OnExplorerEvent;
      _hook = Win32.SetWinEventHook(Win32.EVENT_OBJECT_CREATE, Win32.EVENT_OBJECT_SHOW, IntPtr.Zero, _proc,
                                    (uint)pid, 0, Win32.WINEVENT_OUTOFCONTEXT);
      _hookPid = _hook != IntPtr.Zero ? pid : 0;
      if (_hook == IntPtr.Zero)
        Program.EmitLog("warn", "tbhide: the Explorer event hook could not be installed, so a new taskbar window " +
                                "(Explorer restart, new monitor) is only caught by the 1 s check");
    }

    static void Unhook() {
      try { if (_hook != IntPtr.Zero) Win32.UnhookWinEvent(_hook); } catch (Exception) { }
      _hook = IntPtr.Zero;
      _hookPid = 0;
    }

    static void OnExplorerEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (!_on || idObject != 0 || hwnd == IntPtr.Zero) return;
      string cls = Win32.GetClassName(hwnd);
      if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") _wake.Set();
    }

    /// One line per CHANGE, never per tick (the worker runs every second).
    static void Say(bool applied, string reason) {
      lock (_lock) {
        if (applied == _applied && reason == _reason) return;
        _applied = applied;
        _reason = reason;
      }
      Program.Emit(Json.Obj("ev", "tbhide", "applied", applied, "reason", reason,
                            "windows", _windows, "guard", GuardState));
    }

    // -------------------------------------------------------------- the guard

    static bool GuardAlive() {
      try { return _guard != null && !_guard.HasExited; } catch (Exception) { return false; }
    }

    /// Start the guard if there is none, and CONFIRM it is armed (it creates
    /// GuardPrefix+<its pid> only after it holds a handle to this process).
    /// Returns null when armed, else the reason in plain words.
    static string EnsureGuard(string guardNote) {
      if (GuardAlive()) return null;
      if (guardNote == null) guardNote = _lastNote;
      _lastNote = guardNote;
      string exe;
      try { exe = Process.GetCurrentProcess().MainModule.FileName; }
      catch (Exception ex) { return "the taskbar guard could not be started: this exe's own path is unreadable (" + ex.Message + ")"; }
      string args = "\"" + exe + "\" --taskbar-guard=" + Program.OwnPid.ToString(CultureInfo.InvariantCulture) +
                    (string.IsNullOrEmpty(guardNote) ? "" : " \"--guard-note=" + guardNote + "\"");
      var si = new Api.STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(Api.STARTUPINFO));
      Api.PROCESS_INFORMATION pi;
      uint baseFlags = Api.CREATE_NO_WINDOW | Api.BELOW_NORMAL_PRIORITY_CLASS;
      bool inJob = false;
      // Break away from Electron's job object: node puts the sidecar in a job that
      // kills everything in it when Electron dies - the very death this guards.
      bool ok = Api.CreateProcessW(exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, false,
                                   baseFlags | Api.CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref si, out pi);
      int err = ok ? 0 : Marshal.GetLastWin32Error();
      if (!ok && err == 5) {   // ERROR_ACCESS_DENIED: a job that does not allow breakaway
        ok = Api.CreateProcessW(exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, false,
                                baseFlags, IntPtr.Zero, null, ref si, out pi);
        err = ok ? 0 : Marshal.GetLastWin32Error();
        inJob = ok;
      }
      if (!ok) return "the taskbar guard could not be started (CreateProcess error " + err + ")";
      Process p = null;
      try { p = Process.GetProcessById(pi.dwProcessId); } catch (Exception) { }
      Api.CloseHandle(pi.hThread);
      Api.CloseHandle(pi.hProcess);
      if (p == null) return "the taskbar guard exited as soon as it started";
      // Armed = its marker exists. ~100-300 ms for a .NET start on this machine.
      var sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < 3000) {
        if (IsGuard(p.Id)) {
          _guard = p;
          lock (_lock) {
            _guardState = "armed (pid " + p.Id + (inJob
              ? "; inside Mantle's job object because breakaway was refused, so killing that whole job takes the guard too"
              : "; outside Electron's job, so it outlives a killed Mantle") + ")";
          }
          return null;
        }
        bool exited;
        try { exited = p.HasExited; } catch (Exception) { exited = true; }
        if (exited) {
          int code = -1;
          try { code = p.ExitCode; } catch (Exception) { }
          p.Dispose();
          return "the taskbar guard exited before it was armed (exit code " + code + ")";
        }
        Thread.Sleep(25);
      }
      try { p.Kill(); } catch (Exception) { }
      p.Dispose();
      return "the taskbar guard did not arm within 3 s, so it was stopped";
    }
    static string _lastNote;

    /// `Mantle.Sidecar.exe --taskbar-guard=<pid> [--guard-note=<file>] [--guard-dry-run]`.
    /// Its whole life: wait for that sidecar to die, then clear the empty region
    /// it may have left - unless another live Mantle is holding it. No stdout
    /// protocol, no message loop; exit codes: 0 done, 2 bad arguments / nothing
    /// to watch. --guard-dry-run (tests) decides and writes the note but never
    /// calls SetWindowRgn.
    public static int RunGuard(string[] args) {
      int watch = 0;
      string note = null;
      bool dry = false;
      foreach (string a in args) {
        if (a.StartsWith("--taskbar-guard=", StringComparison.Ordinal))
          int.TryParse(a.Substring("--taskbar-guard=".Length), NumberStyles.Integer, CultureInfo.InvariantCulture, out watch);
        else if (a.StartsWith("--guard-note=", StringComparison.Ordinal)) note = a.Substring("--guard-note=".Length).Trim('"');
        else if (a == "--guard-dry-run") dry = true;
      }
      if (watch <= 0) { GuardSay(note, "taskbar guard: no --taskbar-guard=<pid> to watch, so it exited"); return 2; }
      Process target;
      try { target = Process.GetProcessById(watch); }
      catch (Exception) { GuardSay(note, "taskbar guard: sidecar " + watch + " was not running, so there was nothing to guard"); return 2; }
      int me = Process.GetCurrentProcess().Id;
      EventWaitHandle marker = null;
      try {
        marker = new EventWaitHandle(false, EventResetMode.ManualReset, GuardPrefix + me.ToString(CultureInfo.InvariantCulture));
        target.WaitForExit();
        string code = "unknown";
        try { code = target.ExitCode.ToString(CultureInfo.InvariantCulture); } catch (Exception) { }
        int empty = 0;
        foreach (IntPtr h in TrayWindows()) if (KindOf(h) == KindEmpty) empty++;
        if (empty == 0) {
          // The sidecar cleaned up after itself (or never set one): the normal quit.
          if (dry) GuardSay(note, "taskbar guard (dry run): sidecar " + watch + " exited (code " + code + "); no empty region was left, nothing to do");
          return 0;
        }
        int holder = OtherHolder(watch);
        if (holder != 0) {
          GuardSay(note, "taskbar guard: sidecar " + watch + " exited (code " + code + "); the empty taskbar region belongs to live sidecar " +
                         holder + " now, so it was left alone");
          return 0;
        }
        if (dry) {
          GuardSay(note, "taskbar guard (dry run): sidecar " + watch + " exited (code " + code + "); would clear " + empty +
                         " empty taskbar region(s)");
          return 0;
        }
        string why;
        bool ok = ReleaseAll(true, out why);
        GuardSay(note, "taskbar guard: sidecar " + watch + " exited (code " + code + ") and the taskbar's empty window region was still there with no live Mantle holding it," +
                       " so the guard cleared it: " + why + (ok ? "; the Windows taskbar is back the way Owen had it" : ""));
        return 0;
      } catch (Exception ex) {
        GuardSay(note, "taskbar guard: failed (" + ex.Message + "); run tools\\restore-windows.ps1 or restart Explorer if the taskbar is invisible");
        return 1;
      } finally {
        if (marker != null) marker.Dispose();
        target.Dispose();
      }
    }

    static void GuardSay(string note, string line) {
      string stamped = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + line;
      try { Console.Error.WriteLine("mantle-sidecar: " + stamped); } catch (Exception) { }
      if (string.IsNullOrEmpty(note)) return;
      try {
        string dir = Path.GetDirectoryName(note);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        File.AppendAllText(note, stamped + Environment.NewLine, new UTF8Encoding(false));
      } catch (Exception) { }
    }

    /// For `tbhide {status:true}` and ping: read-only, runs in passive.
    public static object Status() {
      var wins = new List<object>();
      foreach (IntPtr h in TrayWindows())
        wins.Add(Json.Obj("class", Win32.GetClassName(h), "hwnd", h.ToInt64().ToString(CultureInfo.InvariantCulture),
                          "region", KindName(KindOf(h))));
      int holder = OtherHolder(0);
      return Json.Obj("on", _on, "applied", Applied, "reason", Reason, "guard", GuardState,
                      "windows", wins.ToArray(), "otherHolder", holder);
    }
  }
}
