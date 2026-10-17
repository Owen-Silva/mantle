// Supervisor.cs - `Mantle.Sidecar.exe --supervise=<mainPid> --supervise-dir=<userData> [--supervise-test]`:
// the tiny process that brings Mantle's MAIN process back after a crash (lane mantle-supervisor, 2026-10-15).
//
// WHY: on 10-14 at 20:11 Mantle's main process crashed (0xc000041d) and nothing brought it back for
// 14 minutes, until a reboot. The logon task's RestartOnFailure never fired: Task Scheduler only retries
// a task that FAILED TO START, not one whose program later exits with an error. And the JS crash path
// (main.js uncaughtException -> arrangeRestart) cannot help with a NATIVE crash or a kill: the process
// that would arrange the restart is the one that died.
//
// WHO OUTLIVES WHOM:
//   Task Scheduler -> electron.exe main --+-> Mantle.Sidecar.exe (the sidecar; exits when main dies)
//                                         |      +-> --taskbar-guard (clears the taskbar region)
//                                         +-> launcher --supervise-detach (exits at once)
//                                                +-> THIS (no handles from main, not in libuv's
//                                                    kill-on-close job, parent gone: it lives on
//                                                    when main dies, even by a process-tree kill)
//   It owns no window, no hook and no shell state: it only waits on main's process handle. Explorer
//   restarting does not touch it. When main dies it decides, in this order:
//     1. main wrote supervisor-main.json {pid: <that pid>, standDown: {...}} first = a DELIBERATE quit
//        (Quit Mantle, the kill switch, Restore Windows taskbar, `electron . --quit` = golive,
//        Restart Mantle, Windows ending the session): it exits without starting anything;
//     2. Windows is signing out / shutting down (SM_SHUTTINGDOWN): exits;
//     3. otherwise a CRASH: the 3rd crash inside 2 minutes = a crash loop -> stop retrying, put the
//        Windows taskbar back (tools\restore-windows.ps1 -NoKill) and say why in a dialog;
//        before that, start main again with the SAME exe, arguments and folder, once the dead
//        main's sidecar has gone and Explorer's taskbar exists. It then watches the NEW main itself
//        (MANTLE_SUPERVISOR_PID tells that main it is already watched), so a main that dies while
//        it is still starting is caught too.
//   main watches this process in turn and starts a new one if it ever goes away (lib/supervisor.js).
//
// FILES in <userData> (one writer each, so the two processes never race on a file):
//   supervisor-main.json   written by main only: pid, exe, args, cwd, root, standDown, crashNote, told
//   supervisor-state.json  written by this only: crashes[], last{...}, gaveUp{...}, banners{at, result, skipped}
//   supervisor.log         this process's own lines (also appended to main's --log file when it has one)
//   notif-banners.json     written by main only (lib/features/_toasts-owner.js); READ here, see BannersBack
//
// WINDOWS' OWN NOTIFICATION BANNERS (BannersBack, lane mantle-notif-safety 2026-10-17): Mantle turns
// Windows' banner off per app while it draws its own, and Owen's rule is that a Windows surface Mantle
// replaces comes back when Mantle crashes or closes. On EVERY death of the watched main (crash, stand-
// down, Windows shutting down) this puts the originals back FIRST, before it waits, restarts or gives
// up (a restarted main applies them again itself). It never fights a running Mantle: when the record's
// pid or supervisor-main.json's pid is another LIVE main, it leaves them and says why.
//
// OUT OF MAIN'S TREE (--supervise-detach): main spawns this with --supervise-detach; it starts a copy of
// itself with no inherited handles (breaking away from any job that allows it) and exits after ONE
// stdout line, {"supervisor":<pid>,"detached":true}. The copy's parent is then a process that is gone,
// so "End process tree" / taskkill /F /T on main cannot reach it. A copy that cannot be started:
// {"supervisor":<own pid>,"detached":false,"why":"..."} and this process supervises from inside the tree.
//
// --supervise-test (a --test instance): never shows a dialog and never runs the restore script; the
// restore command is written into the state file instead, so a test can read what would have run. The
// banners ARE put back, but only for app ids starting with ToastBanners.TestPrefix, and
// --supervise-banners-key=<HKCU-relative key> (honoured ONLY with --supervise-test) points them at a
// scratch key (lib/supervisor-banners.test.js).
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

  static class Supervisor {
    public const int WindowMs = 120000;   // 3 crashes inside 2 minutes = a crash loop
    public const int MaxCrashes = 3;

    static string _dir;
    static string _mainLog;               // main's --log=<file>, from the record (live has one)
    static bool _test;
    static int _me;
    static string _bannersKey = ToastBanners.SettingsKey;   // a scratch key only with --supervise-test
    static IDictionary _banners;          // the latest BannersBack, for WriteState: {at, result, skipped}
    static int _skipSaidFor;              // the owner pid a skip was last said for (said once, not per death)
    const string BannersFile = "notif-banners.json";

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmdLine, IntPtr procAttr, IntPtr threadAttr, bool inheritHandles,
                                      uint flags, IntPtr env, string cwd, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);

    const uint SYNCHRONIZE = 0x00100000, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint WAIT_OBJECT_0 = 0, INFINITE = 0xFFFFFFFF;
    const uint DETACHED_PROCESS = 0x8, CREATE_NEW_PROCESS_GROUP = 0x200, CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const int ERROR_ACCESS_DENIED = 5;
    const uint STILL_ACTIVE = 259;
    const int SM_SHUTTINGDOWN = 0x2000;
    const uint MB_YESNO = 0x4, MB_ICONWARNING = 0x30, MB_TOPMOST = 0x40000, MB_SETFOREGROUND = 0x10000;
    const int IDYES = 6;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W {
      public uint dwSize, cntUsage, th32ProcessID;
      public IntPtr th32DefaultHeapID;
      public uint th32ModuleID, cntThreads, th32ParentProcessID;
      public int pcPriClassBase;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFOW {
      public int cb;
      public IntPtr lpReserved, lpDesktop, lpTitle;
      public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2;
      public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
      public IntPtr hProcess, hThread;
      public int dwProcessId, dwThreadId;
    }

    public static int Run(string[] args) {
      int mainPid = 0;
      bool detach = false;
      string keyArg = null;
      foreach (string a in args) {
        if (a.StartsWith("--supervise=", StringComparison.Ordinal))
          int.TryParse(a.Substring("--supervise=".Length), NumberStyles.Integer, CultureInfo.InvariantCulture, out mainPid);
        else if (a.StartsWith("--supervise-dir=", StringComparison.Ordinal)) _dir = a.Substring("--supervise-dir=".Length).Trim('"');
        else if (a == "--supervise-test") _test = true;
        else if (a == "--supervise-detach") detach = true;
        else if (a.StartsWith("--supervise-banners-key=", StringComparison.Ordinal)) keyArg = a.Substring("--supervise-banners-key=".Length).Trim('"');
      }
      // A scratch registry key for the banners is a TEST-only switch: a live supervisor always uses
      // Windows' own key, whatever its command line says.
      if (_test && !string.IsNullOrEmpty(keyArg)) _bannersKey = keyArg;
      _me = Process.GetCurrentProcess().Id;
      if (mainPid <= 0 || string.IsNullOrEmpty(_dir) || !Directory.Exists(_dir)) {
        Console.Error.WriteLine("mantle-sidecar: supervisor: needs --supervise=<pid> and an existing --supervise-dir=<folder>");
        return 2;
      }
      Dictionary<string, object> rec0 = ReadJson(MainFile());
      _mainLog = LogArg(rec0);

      if (detach) {
        // Out of main's process tree, so "End process tree" on main cannot take the supervisor with it.
        string whyNot;
        int copy = Detach(args, out whyNot);
        if (copy > 0) {
          StdoutLine("{\"supervisor\":" + copy.ToString(CultureInfo.InvariantCulture) + ",\"detached\":true}");
          return 0;
        }
        StdoutLine("{\"supervisor\":" + _me.ToString(CultureInfo.InvariantCulture) + ",\"detached\":false,\"why\":" + Json.Write(whyNot) + "}");
        Say("supervisor: it could not move out of Mantle's process tree (" + whyNot + "), so it watches from inside it; " +
            "ending Mantle's whole process tree ends the supervisor too");
      }
      // Nothing below ever writes to stdout: main reads one line at most and then closes its end.
      try { Console.SetOut(TextWriter.Null); } catch (Exception) { }

      IntPtr h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, mainPid);
      if (h == IntPtr.Zero) {
        Say("supervisor: Mantle's main process " + mainPid + " was not running when the supervisor started, so there is nothing to watch");
        return 2;
      }
      // A supervisor that replaces one that went away carries its crash history on.
      List<long> crashes = PriorCrashes();
      Say("supervisor: watching Mantle's main process " + mainPid + " (supervisor pid " + _me + "); a crash brings it back, " +
          MaxCrashes + " crashes inside " + (WindowMs / 60000) + " minutes stop the retries");

      for (;;) {
        WaitForSingleObject(h, INFINITE);
        uint raw = 0;
        bool haveCode = GetExitCodeProcess(h, out raw);
        CloseHandle(h);
        h = IntPtr.Zero;
        long diedAt = NowMs();
        string codeHex = haveCode ? "0x" + raw.ToString("X8", CultureInfo.InvariantCulture) : "unknown";

        Dictionary<string, object> rec = ReadJson(MainFile());
        _mainLog = LogArg(rec) ?? _mainLog;
        bool recIsHis = rec != null && Json.GetInt(rec, "pid", 0) == mainPid;
        // FIRST, whatever the reason main is gone (and before any wait, restart or give-up): Windows'
        // own notification banners back. A main restarted below turns them off again itself.
        BannersBack(mainPid);
        object sd;
        if (recIsHis && Json.TryGet(rec, "standDown", out sd) && sd is Dictionary<string, object>) {
          string why = Json.GetString((Dictionary<string, object>)sd, "why") ?? "no reason was given";
          Say("supervisor: Mantle " + mainPid + " quit on purpose (" + why + "), exit code " + codeHex + "; it is not started again");
          // A clean quit ends the story: the next Mantle's supervisor starts with no crashes counted.
          WriteState(new List<long>(), null, null);
          return 0;
        }
        if (GetSystemMetrics(SM_SHUTTINGDOWN) != 0) {
          Say("supervisor: Mantle " + mainPid + " ended while Windows is signing out or shutting down (exit code " + codeHex + "); it is not started again");
          WriteState(crashes, null, null);   // keeps last/gaveUp; records what BannersBack did
          return 0;
        }

        string what = null;
        object cn;
        if (recIsHis && Json.TryGet(rec, "crashNote", out cn) && cn is Dictionary<string, object>)
          what = Json.GetString((Dictionary<string, object>)cn, "what");
        crashes.RemoveAll(t => diedAt - t >= WindowMs || t > diedAt);
        crashes.Add(diedAt);
        string words = ExitWords(haveCode ? (long)raw : -1, what);
        Say("supervisor: Mantle " + mainPid + " stopped unexpectedly: " + words + " (exit code " + codeHex + "); crash " +
            crashes.Count + " of " + MaxCrashes + " inside " + (WindowMs / 60000) + " minutes");

        if (crashes.Count >= MaxCrashes) {
          bool again = GiveUp(crashes.Count, mainPid, codeHex, words, what, diedAt);
          if (!again) return 0;
          crashes.Clear();
        }

        Dictionary<string, object> spec = recIsHis ? rec : (rec ?? rec0);
        // Let the dead main's own sidecar finish (its hook, app bars, taskbar region) before a new one starts.
        int left = WaitForChildren(mainPid, 10000);
        if (left > 0) Say("supervisor: " + left + " of the old main's helper process(es) were still running after 10 s; starting Mantle anyway");
        bool waitedForShell = WaitForTaskbar(30000);
        long minGap = 1000 - (NowMs() - diedAt);
        if (minGap > 0) Thread.Sleep((int)minGap);
        if (GetSystemMetrics(SM_SHUTTINGDOWN) != 0) {
          Say("supervisor: Windows started signing out or shutting down before Mantle was started again; it is not started");
          return 0;
        }

        string why2;
        int newPid = Launch(spec, out why2);
        long backAt = NowMs();
        var last = Json.Obj("at", diedAt, "oldPid", mainPid, "code", haveCode ? (object)(long)raw : null, "codeHex", codeHex,
                            "words", words, "what", what, "restarted", newPid > 0, "newPid", newPid > 0 ? (object)newPid : null,
                            "startedInMs", backAt - diedAt, "waitedForTaskbar", waitedForShell, "failed", newPid > 0 ? null : why2);
        WriteState(crashes, last, null);
        if (newPid <= 0) {
          Say("supervisor: Mantle could NOT be started again: " + why2);
          GiveUpNoStart(mainPid, codeHex, words, why2);
          return 1;
        }
        Say("supervisor: started Mantle again as pid " + newPid + ", " + (backAt - diedAt) + " ms after it stopped" +
            (waitedForShell ? " (it waited for the Windows taskbar to come back first)" : ""));
        h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, newPid);
        if (h == IntPtr.Zero) {
          Say("supervisor: the new Mantle " + newPid + " could not be watched (it may have stopped at once); the supervisor exits");
          return 1;
        }
        mainPid = newPid;
      }
    }

    /// The crash loop: no more retries, the Windows taskbar back, and why. True = Owen asked to try again.
    static bool GiveUp(int count, int pid, string codeHex, string words, string what, long at) {
      string restore = RestoreCommand();
      string restoreResult;
      if (_test) restoreResult = "not run (test instance)";
      else restoreResult = RunRestore(restore);
      var gave = Json.Obj("at", at, "count", count, "windowMs", WindowMs, "pid", pid, "codeHex", codeHex, "words", words, "what", what,
                          "restore", Json.Obj("command", restore, "dryRun", _test, "result", restoreResult));
      WriteState(new List<long>(), null, gave);
      Say("supervisor: Mantle stopped unexpectedly " + count + " times inside " + (WindowMs / 60000) + " minutes, so it was NOT started again; " +
          "the Windows taskbar was put back: " + restoreResult);
      if (_test) return false;
      string text = "Mantle stopped unexpectedly " + count + " times in " + (WindowMs / 60000) + " minutes, so it was not started again.\n\n" +
                    "The Windows taskbar is back.\n\nThe last time: " + words + ".\n\nStart Mantle again now?";
      int answer = MessageBoxW(IntPtr.Zero, text, "Mantle stopped", MB_YESNO | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND);
      if (answer == IDYES) {
        Say("supervisor: Owen chose to start Mantle again after the crash loop; the crash count starts over");
        return true;
      }
      Say("supervisor: Mantle stays stopped (Owen said no)");
      return false;
    }

    /// The start itself failed: the same taskbar-back road, with that reason.
    static void GiveUpNoStart(int pid, string codeHex, string words, string why) {
      string restore = RestoreCommand();
      string result = _test ? "not run (test instance)" : RunRestore(restore);
      var gave = Json.Obj("at", NowMs(), "count", 0, "windowMs", WindowMs, "pid", pid, "codeHex", codeHex, "words", words,
                          "startFailed", why, "restore", Json.Obj("command", restore, "dryRun", _test, "result", result));
      WriteState(new List<long>(), null, gave);
      if (_test) return;
      MessageBoxW(IntPtr.Zero, "Mantle stopped unexpectedly and could not be started again (" + why + ").\n\nThe Windows taskbar is back.",
                  "Mantle stopped", MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND);
    }

    static string RestoreCommand() {
      Dictionary<string, object> rec = ReadJson(MainFile());
      string root = rec != null ? Json.GetString(rec, "root") : null;
      string script = string.IsNullOrEmpty(root) ? "tools\\restore-windows.ps1" : Path.Combine(root, "tools", "restore-windows.ps1");
      return "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script +
             "\" -NoKill -StateFile \"" + Path.Combine(_dir, "shell-state.json") + "\"";
    }

    static string RunRestore(string command) {
      try {
        int sp = command.IndexOf(' ');
        var psi = new ProcessStartInfo(command.Substring(0, sp), command.Substring(sp + 1)) {
          UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
        };
        using (Process p = Process.Start(psi)) {
          string outText = p.StandardOutput.ReadToEnd();
          if (!p.WaitForExit(60000)) return "the restore script did not finish in 60 s";
          bool verified = outText.IndexOf("verified", StringComparison.OrdinalIgnoreCase) >= 0;
          return p.ExitCode == 0 ? (verified ? "done and verified" : "done") : "the restore script reported a problem (exit " + p.ExitCode + ")";
        }
      } catch (Exception ex) {
        return "the restore script would not run (" + ex.Message + ")";
      }
    }

    /// Windows' own notification banners back after main <deadPid> is gone (every death: crash, stand-down,
    /// Windows shutting down). Same rule as the sidecar's exit (ToastBanners.RestoreFrom): an original goes
    /// back ONLY where the value is still Mantle's 0. Quiet when there is nothing to put back; skipped (said
    /// once) while another live Mantle main owns them. Records {at, result, skipped} for WriteState.
    static void BannersBack(int deadPid) {
      string record = Path.Combine(_dir, BannersFile);
      long at = NowMs();
      try {
        if (!File.Exists(record)) { _banners = Json.Obj("at", at, "result", "nothing to put back (no record)", "skipped", false); return; }
        Dictionary<string, object> top = ReadJson(record);
        object o;
        Dictionary<string, object> owned = top != null && Json.TryGet(top, "owned", out o) ? o as Dictionary<string, object> : null;
        if (top != null && (owned == null || owned.Count == 0)) { _banners = Json.Obj("at", at, "result", "nothing to put back (none owned)", "skipped", false); return; }
        // An unreadable record (top == null) still goes to RestoreFrom, which says so in its own words.
        int owner;
        string other = OtherOwner(deadPid, out owner);
        if (other == null) other = OtherOwner(deadPid, out owner);   // re-checked right before the write
        if (other != null) {
          _banners = Json.Obj("at", at, "result", other, "skipped", true);
          if (_skipSaidFor != owner) {
            _skipSaidFor = owner;
            Say("supervisor: Windows' own notification banners were left to Mantle: " + other + " and owns them now");
          }
          return;
        }
        string result = ToastBanners.RestoreFrom(record, _bannersKey, _test);
        _banners = Json.Obj("at", at, "result", result, "skipped", false);
        Say("supervisor: Mantle " + deadPid + " is gone; Windows' own " + result.Replace("tools\\restore-banners.ps1", "the restore-banners script") +
            (_test ? " (test instance: test app ids only)" : ""));
      } catch (Exception ex) {
        // never in the way of the restart below
        _banners = Json.Obj("at", at, "result", "the put-back failed (" + ex.GetType().Name + ")", "skipped", false);
        Say("supervisor: putting Windows' own notification banners back failed (" + ex.GetType().Name + "); the restore-banners script finishes it");
      }
    }

    /// Another LIVE Mantle main that owns the banners now -> the words for it (and its pid), or null.
    /// The record's own pid (the main that saved it last) first, then supervisor-main.json's (a newer main
    /// from Restart Mantle or golive). A pid Windows has since given to a process started AFTER that file
    /// was written is not Mantle, so it does not count.
    static string OtherOwner(int deadPid, out int pid) {
      Dictionary<string, object> b = ReadJson(Path.Combine(_dir, BannersFile));
      pid = b != null ? Json.GetInt(b, "pid", 0) : 0;
      if (pid > 0 && pid != deadPid && pid != _me && AliveSince(pid, GetLong(b, "at")))
        return "the Mantle that saved the banner record (pid " + pid + ") is still running";
      Dictionary<string, object> m = ReadJson(MainFile());
      pid = m != null ? Json.GetInt(m, "pid", 0) : 0;
      if (pid > 0 && pid != deadPid && pid != _me && AliveSince(pid, GetLong(m, "at")))
        return "a newer Mantle (pid " + pid + ") is running";
      pid = 0;
      return null;
    }

    /// pid is running and was started no later than atMs (+5 s of slack; 0 = not checked).
    static bool AliveSince(int pid, long atMs) {
      IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;   // there, but not ours to open: assume Mantle
      try {
        uint code;
        if (GetExitCodeProcess(h, out code) && code != STILL_ACTIVE) return false;   // exited, its handle still held somewhere
        long created, ex, k, u;
        if (atMs > 0 && GetProcessTimes(h, out created, out ex, out k, out u) && created > 0) {
          long createdMs = (long)(DateTime.FromFileTimeUtc(created) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
          if (createdMs > atMs + 5000) return false;   // a later process that got the same pid
        }
        return true;
      } finally { CloseHandle(h); }
    }

    static long GetLong(Dictionary<string, object> d, string key) {
      object v;
      if (d == null || !Json.TryGet(d, key, out v) || !(v is double)) return 0;
      double x = (double)v;
      return x > 0 && x < 9e15 ? (long)x : 0;
    }

    /// --supervise-detach: a copy of this process OUTSIDE main's tree. No handle is inherited (it must not
    /// hold node's stdout pipe open), no console, its own process group, and out of any job that lets it
    /// break away (one that does not: the copy stays in that job, which is still better than main's tree).
    /// Same arguments minus --supervise-detach. -> the copy's pid, or 0 with the reason.
    static int Detach(string[] args, out string why) {
      why = null;
      string exe;
      try { exe = Process.GetCurrentProcess().MainModule.FileName; }
      catch (Exception ex) { why = "it could not read its own program file (" + ex.GetType().Name + ")"; return 0; }
      var sb = new StringBuilder(QuoteArg(exe));
      foreach (string a in args) {
        if (a == "--supervise-detach") continue;
        sb.Append(' ');
        sb.Append(QuoteArg(a));
      }
      string line = sb.ToString();
      uint flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
      int err = 0;
      for (int attempt = 0; attempt < 2; attempt++) {
        bool breakaway = attempt == 0;
        var si = new STARTUPINFOW();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
        PROCESS_INFORMATION pi;
        var cmd = new StringBuilder(line, line.Length + 1);   // CreateProcessW may write into its command line
        if (CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, flags | (breakaway ? CREATE_BREAKAWAY_FROM_JOB : 0u),
                           IntPtr.Zero, null, ref si, out pi)) {
          if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
          if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
          return pi.dwProcessId;
        }
        err = Marshal.GetLastWin32Error();
        if (!(breakaway && err == ERROR_ACCESS_DENIED)) break;   // a job that forbids breakaway: once more without
      }
      why = "Windows would not start a copy of it outside Mantle's process tree (error " + err.ToString(CultureInfo.InvariantCulture) + ")";
      return 0;
    }

    /// The one line main reads from a --supervise-detach start. Never throws.
    static void StdoutLine(string line) {
      try {
        TextWriter w = Console.Out;
        w.Write(line + "\n");
        w.Flush();
      } catch (Exception) { }
    }

    /// Start main again exactly as it was started. -> new pid, or 0 with the reason.
    static int Launch(Dictionary<string, object> spec, out string why) {
      why = null;
      string exe = spec != null ? Json.GetString(spec, "exe") : null;
      string cwd = spec != null ? Json.GetString(spec, "cwd") : null;
      object argsObj = null;
      if (spec != null) Json.TryGet(spec, "args", out argsObj);
      if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) { why = "the record of how Mantle was started has no program that exists"; return 0; }
      if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd)) { why = "the folder Mantle was started in is gone"; return 0; }
      var sb = new StringBuilder();
      IList list = argsObj as IList;
      if (list != null) foreach (object o in list) { if (o == null) continue; if (sb.Length > 0) sb.Append(' '); sb.Append(QuoteArg(Convert.ToString(o, CultureInfo.InvariantCulture))); }
      try {
        var psi = new ProcessStartInfo(exe, sb.ToString()) { UseShellExecute = false, WorkingDirectory = cwd, CreateNoWindow = true };
        psi.EnvironmentVariables["MANTLE_SUPERVISOR_PID"] = _me.ToString(CultureInfo.InvariantCulture);
        if (psi.EnvironmentVariables.ContainsKey("ELECTRON_RUN_AS_NODE")) psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        using (Process p = Process.Start(psi)) {
          if (p == null) { why = "Windows did not start it"; return 0; }
          return p.Id;
        }
      } catch (Exception ex) {
        why = "Windows would not start it (" + ex.Message + ")";
        return 0;
      }
    }

    /// CommandLineToArgvW's rules, so every argument arrives exactly as it was.
    public static string QuoteArg(string a) {
      if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
      var sb = new StringBuilder("\"");
      int slashes = 0;
      foreach (char c in a) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
        sb.Append('\\', slashes); slashes = 0; sb.Append(c);
      }
      sb.Append('\\', slashes * 2);
      sb.Append('"');
      return sb.ToString();
    }

    /// The dead main's Mantle.Sidecar.exe children (never this process): wait for them. -> how many are left.
    static int WaitForChildren(int parentPid, int ms) {
      var pids = new List<int>();
      IntPtr snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
      try {
        var e = new PROCESSENTRY32W();
        e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
        if (Process32FirstW(snap, ref e)) {
          do {
            if (e.th32ParentProcessID == (uint)parentPid && e.th32ProcessID != (uint)_me &&
                string.Equals(e.szExeFile, "Mantle.Sidecar.exe", StringComparison.OrdinalIgnoreCase))
              pids.Add((int)e.th32ProcessID);
          } while (Process32NextW(snap, ref e));
        }
      } finally { CloseHandle(snap); }
      long end = NowMs() + ms;
      int left = 0;
      foreach (int pid in pids) {
        IntPtr ph = OpenProcess(SYNCHRONIZE, false, pid);
        if (ph == IntPtr.Zero) continue;
        long rest = Math.Max(0, end - NowMs());
        if (WaitForSingleObject(ph, (uint)rest) != WAIT_OBJECT_0) left++;
        CloseHandle(ph);
      }
      return left;
    }

    /// Mantle reads the taskbar when it starts: wait (bounded) for Explorer's taskbar. -> true when it had to wait.
    static bool WaitForTaskbar(int ms) {
      if (FindWindowW("Shell_TrayWnd", null) != IntPtr.Zero) return false;
      Say("supervisor: the Windows taskbar is not there (Explorer is restarting?); waiting up to " + (ms / 1000) + " s for it before starting Mantle");
      long end = NowMs() + ms;
      while (NowMs() < end) {
        Thread.Sleep(250);
        if (FindWindowW("Shell_TrayWnd", null) != IntPtr.Zero) { Thread.Sleep(3000); return true; }
      }
      Say("supervisor: the Windows taskbar did not come back in " + (ms / 1000) + " s; starting Mantle anyway");
      return true;
    }

    /// Plain words for how main stopped. Same table as lib/supervisor.js exitWords (lib/supervisor.test.js checks they agree).
    public static string ExitWords(long code, string what) {
      if (!string.IsNullOrEmpty(what)) return "an error in Mantle's own code";
      switch (code) {
        case 0xC000041D: return "it crashed while Windows was calling into one of its windows";
        case 0xC0000005: return "it crashed reading memory it did not own";
        case 0x80000003: return "it stopped on an internal check that failed";
        case 0xC0000409: return "it stopped itself on a safety check";
        case 0xC00000FD: return "it ran out of stack space";
        case 0xE0000008: return "it ran out of memory";
        case 0xC0000017: return "it ran out of memory";
        case 1: return "it was ended by another program (or Task Manager) or stopped with an error";
        default: return "it stopped unexpectedly";
      }
    }

    static List<long> PriorCrashes() {
      var list = new List<long>();
      Dictionary<string, object> st = ReadJson(StateFile());
      object c;
      if (st != null && Json.TryGet(st, "crashes", out c) && c is IList) {
        long now = NowMs();
        foreach (object o in (IList)c) {
          try { long t = Convert.ToInt64(o, CultureInfo.InvariantCulture); if (now - t < WindowMs && t <= now) list.Add(t); } catch (Exception) { }
        }
      }
      return list;
    }

    static void WriteState(List<long> crashes, IDictionary last, IDictionary gaveUp) {
      Dictionary<string, object> prev = ReadJson(StateFile());
      object keepLast = null, keepGave = null, keepBanners = null;
      if (prev != null) { Json.TryGet(prev, "last", out keepLast); Json.TryGet(prev, "gaveUp", out keepGave); Json.TryGet(prev, "banners", out keepBanners); }
      var arr = new List<object>();
      foreach (long t in crashes) arr.Add(t);
      var st = Json.Obj("v", 1, "supervisorPid", _me, "at", NowMs(), "crashes", arr,
                        "last", last != null ? (object)last : keepLast, "gaveUp", gaveUp != null ? (object)gaveUp : keepGave,
                        "banners", _banners != null ? (object)_banners : keepBanners);
      WriteAtomic(StateFile(), Json.Write(st));
    }

    static void WriteAtomic(string file, string text) {
      string tmp = file + ".tmp-" + _me;
      try {
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(tmp, file, null);
        else File.Move(tmp, file);
      } catch (Exception) {
        try { File.WriteAllText(file, text, new UTF8Encoding(false)); } catch (Exception) { }
        try { if (File.Exists(tmp)) File.Delete(tmp); } catch (Exception) { }
      }
    }

    static Dictionary<string, object> ReadJson(string file) {
      try {
        if (!File.Exists(file)) return null;
        string text;
        using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var r = new StreamReader(fs, Encoding.UTF8)) text = r.ReadToEnd();
        return Json.Parse(text) as Dictionary<string, object>;
      } catch (Exception) { return null; }
    }

    static string LogArg(Dictionary<string, object> rec) {
      object a;
      if (rec == null || !Json.TryGet(rec, "args", out a) || !(a is IList)) return null;
      foreach (object o in (IList)a) {
        string s = o as string;
        if (s != null && s.StartsWith("--log=", StringComparison.Ordinal)) return s.Substring("--log=".Length).Trim('"');
      }
      return null;
    }

    static string MainFile() { return Path.Combine(_dir, "supervisor-main.json"); }
    static string StateFile() { return Path.Combine(_dir, "supervisor-state.json"); }
    static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

    /// One line, stamped like main's log ("HH:mm:ss.fff mantle: ..."). No paths ever go in it.
    static void Say(string line) {
      string stamped = DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " mantle: " + line + Environment.NewLine;
      Append(Path.Combine(_dir ?? ".", "supervisor.log"), stamped, true);
      if (!string.IsNullOrEmpty(_mainLog)) Append(_mainLog, stamped, false);
    }

    static void Append(string file, string text, bool cap) {
      try {
        if (cap && File.Exists(file) && new FileInfo(file).Length > 512 * 1024) {
          string old = file + ".old";
          if (File.Exists(old)) File.Delete(old);
          File.Move(file, old);
        }
        // Shared read AND write: main's log tee holds its file open for appending.
        using (var fs = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
          byte[] b = new UTF8Encoding(false).GetBytes(text);
          fs.Write(b, 0, b.Length);
        }
      } catch (Exception) { }
    }
  }
}
