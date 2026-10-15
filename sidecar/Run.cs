// Run.cs - Win+R's launch, its lookup and Windows' Run history (lane keysrun, 2026-10-15).
//
// WHY: Owen uses Win+R for %appdata% and his .minecraft folders, perfmon /report, a curl install
// line and the like, and Mantle now takes Win+R (lib/features/run.js, the launcher's Run mode).
// Windows' Run box hands what it parsed to ShellExecuteEx, so this does the same: one call, the
// program (or document, or protocol) in lpFile, the typed arguments VERBATIM in lpParameters,
// "runas" for Ctrl+Shift+Enter (Windows' own UAC prompt), the profile folder as the working folder.
// NEVER a shell: nothing here builds a command line for cmd.exe or PowerShell, and lpFile is never
// split or joined with lpParameters. Main (lib/run-line.js) has already expanded %VARS% and split
// the line; this side refuses control characters and anything over the documented sizes.
//
//   run.exec    {file, params?, verb:'open'|'runas', dir?, owner?, dryRun?}
//               -> {ok, code, message, pid, ms} when Windows answered within ExecWaitMs, else
//                  {pending:true, ticket} and the outcome later as the `run` event {ticket, ok, ...}
//                  (a UAC prompt waits for Owen: the slow lane is never held for it). ok:false with
//                  code (Win32 error) is an ANSWER, not a protocol failure: main words it.
//               --passive: refused (PassiveRefusal) unless dryRun, which answers what it would do.
//   run.resolve {file} -> {found, via:'path'|'apppaths'|'search'|null, dir} - the lookup
//               ShellExecuteEx makes (a path; App Paths in HKCU then HKLM; System32, Windows and
//               PATH with PATHEXT). Read-only, allowed in --passive.
//   run.mru     {} -> {items:[...]} - HKCU\...\Explorer\RunMRU in MRUList order, the trailing "\1"
//               dropped. READ-ONLY: Mantle keeps its own history; Windows' list is never written.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class RunBox {
    const int ExecWaitMs = 300;           // under R4's 0.5 s per request; a normal start answers in 20-150 ms
    const int FileMax = 4096, ParamsMax = 32000;   // CreateProcess' command line is 32767 chars in all
    static int _tickets;

    public static void Register(FeatureTable t) {
      t.Add("run.exec", Lanes.Slow, Exec);
      t.Add("run.resolve", Lanes.Slow, Resolve);
      t.Add("run.mru", Lanes.Ui, Mru);    // one small registry read
    }

    static string Bad(string s, string what) {
      if (s == null) return null;
      foreach (char c in s) if (c < 0x20 && c != '\t') return what + " has a line break or a control character in it";
      return null;
    }

    sealed class Flight {
      public string Ticket;
      public bool Done, Pending;
      public IDictionary Outcome;
      public readonly ManualResetEvent Signal = new ManualResetEvent(false);
    }

    static string Exec(Dictionary<string, object> req, ref object result) {
      string file = Json.GetString(req, "file");
      string args = Json.GetString(req, "params") ?? "";
      string verb = Json.GetString(req, "verb") ?? "open";
      string dir = Json.GetString(req, "dir");
      bool dry = Json.GetBool(req, "dryRun", false);
      IntPtr owner = Json.GetHwnd(req, "owner");
      if (file == null || file.Trim().Length == 0) return "there is nothing to run";
      if (file.Length > FileMax) return "the program name is longer than Windows allows";
      if (args.Length > ParamsMax) return "the arguments are longer than Windows allows";
      string why = Bad(file, "the program name") ?? Bad(args, "the arguments") ?? Bad(dir, "the working folder");
      if (why != null) return why;
      if (verb != "open" && verb != "runas") return "run.exec only opens or runs as administrator (verb open or runas)";
      if (string.IsNullOrEmpty(dir) || !Path.IsPathRooted(dir) || !Directory.Exists(dir))
        dir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "verb", verb, "file", file, "params", args, "dir", dir, "found", ResolveCore(file));
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": would have asked Windows to " + (verb == "runas" ? "run as administrator " : "open ") + file;

      var f = new Flight { Ticket = "r" + Interlocked.Increment(ref _tickets) };
      var sw = Stopwatch.StartNew();
      var th = new Thread(delegate () { Launch(f, file, args, verb, dir, owner, sw); });
      th.IsBackground = true;
      th.Name = "run " + f.Ticket;
      th.SetApartmentState(ApartmentState.STA);   // ShellExecuteEx wants COM, apartment-threaded
      th.Start();
      f.Signal.WaitOne(ExecWaitMs);
      lock (f) {
        if (f.Done) { result = f.Outcome; return null; }
        f.Pending = true;
      }
      result = Json.Obj("pending", true, "ticket", f.Ticket, "verb", verb);
      return null;
    }

    static void Launch(Flight f, string file, string args, string verb, string dir, IntPtr owner, Stopwatch sw) {
      int err = 0, pid = 0;
      try {
        var sei = new SHELLEXECUTEINFO();
        sei.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
        sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
        sei.hwnd = owner != IntPtr.Zero && IsWindow(owner) ? owner : IntPtr.Zero;
        sei.lpVerb = verb;
        sei.lpFile = file;
        sei.lpParameters = args.Length > 0 ? args : null;
        sei.lpDirectory = dir;
        sei.nShow = 1;   // SW_SHOWNORMAL, as the Run box
        if (!ShellExecuteExW(ref sei)) err = Marshal.GetLastWin32Error();
        else if (sei.hProcess != IntPtr.Zero) {
          pid = (int)GetProcessId(sei.hProcess);
          // Main handed this process its foreground right (lib/fg-grant.js); pass it on, so the
          // new window comes up in front instead of flashing in the taskbar.
          if (pid > 0) AllowSetForegroundWindow((uint)pid);
          CloseHandle(sei.hProcess);
        }
      } catch (Exception ex) {
        err = -1;
        Program.EmitLog("warn", "run: ShellExecuteEx threw " + ex.GetType().Name + ": " + ex.Message);
      }
      string msg = err == 0 ? null : err == -1 ? "the launch threw inside Mantle's helper" : new Win32Exception(err).Message;
      IDictionary outcome = Json.Obj("ok", err == 0, "code", err, "message", msg, "pid", pid, "ms", sw.ElapsedMilliseconds,
                                     "verb", verb, "ticket", f.Ticket);
      bool emit;
      lock (f) { f.Done = true; f.Outcome = outcome; emit = f.Pending; }
      f.Signal.Set();
      if (emit) Features.Event("run", outcome);
    }

    static string Resolve(Dictionary<string, object> req, ref object result) {
      string file = Json.GetString(req, "file");
      if (file == null || file.Trim().Length == 0) return "there is nothing to look up";
      if (file.Length > FileMax) return "the program name is longer than Windows allows";
      string why = Bad(file, "the program name");
      if (why != null) return why;
      result = ResolveCore(file);
      return null;
    }

    static string[] PathExt() {
      string pe = Environment.GetEnvironmentVariable("PATHEXT");
      if (string.IsNullOrEmpty(pe)) pe = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
      var list = new List<string>();
      foreach (string e in pe.Split(';')) if (e.Trim().StartsWith(".")) list.Add(e.Trim());
      return list.ToArray();
    }

    static IDictionary Found(string path, string via) {
      bool isDir = false;
      try { isDir = Directory.Exists(path); } catch (Exception) { /* a file */ }
      return Json.Obj("found", path, "via", via, "dir", isDir);
    }

    static string WithExt(string candidate, string[] exts) {
      try {
        if (Path.HasExtension(candidate) && File.Exists(candidate)) return candidate;
        foreach (string e in exts) if (File.Exists(candidate + e)) return candidate + e;
      } catch (Exception) { /* bad characters: not found */ }
      return null;
    }

    /// The lookup ShellExecuteEx makes for lpFile, as far as it matters to the Run box.
    static IDictionary ResolveCore(string raw) {
      string f = raw.Trim();
      if (f.Length > 1 && f[0] == '"' && f[f.Length - 1] == '"') f = f.Substring(1, f.Length - 2);
      string[] exts = PathExt();
      try {
        if (f.IndexOfAny(new[] { '\\', '/', ':' }) >= 0) {
          if (Directory.Exists(f)) return Found(f, "path");
          string p = WithExt(f, exts);
          return p != null ? Found(p, "path") : Json.Obj("found", null, "via", null, "dir", false);
        }
        foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
          foreach (string name in Path.HasExtension(f) ? new[] { f } : new[] { f, f + ".exe" }) {
            using (var k = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + name)) {
              string v = k == null ? null : k.GetValue(null) as string;
              if (string.IsNullOrEmpty(v)) continue;
              v = Environment.ExpandEnvironmentVariables(v).Trim().Trim('"');
              if (File.Exists(v)) return Found(v, "apppaths");
            }
          }
        }
        var dirs = new List<string> { Environment.SystemDirectory, Environment.GetFolderPath(Environment.SpecialFolder.Windows) };
        foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
          string e = Environment.ExpandEnvironmentVariables(d.Trim().Trim('"'));
          if (e.Length > 0) dirs.Add(e);
        }
        foreach (string d in dirs) {
          string p;
          try { p = WithExt(Path.Combine(d, f), exts); } catch (Exception) { continue; }
          if (p != null) return Found(p, "search");
        }
      } catch (Exception) { /* bad characters in the name: not found */ }
      return Json.Obj("found", null, "via", null, "dir", false);
    }

    static string Mru(Dictionary<string, object> req, ref object result) {
      var items = new List<object>();
      using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU")) {
        string order = k == null ? null : k.GetValue("MRUList") as string;
        if (order != null) {
          foreach (char c in order) {
            string v = k.GetValue(c.ToString()) as string;
            if (string.IsNullOrEmpty(v)) continue;
            if (v.EndsWith("\\1")) v = v.Substring(0, v.Length - 2);
            if (v.Trim().Length > 0) items.Add(v);
          }
        }
      }
      result = Json.Obj("items", items);
      return null;
    }

    const uint SEE_MASK_NOCLOSEPROCESS = 0x40, SEE_MASK_NOASYNC = 0x100, SEE_MASK_FLAG_NO_UI = 0x400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHELLEXECUTEINFO {
      public int cbSize;
      public uint fMask;
      public IntPtr hwnd;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;
      public int nShow;
      public IntPtr hInstApp;
      public IntPtr lpIDList;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;
      public IntPtr hkeyClass;
      public uint dwHotKey;
      public IntPtr hIcon;
      public IntPtr hProcess;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool AllowSetForegroundWindow(uint pid);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hwnd);
  }
}
