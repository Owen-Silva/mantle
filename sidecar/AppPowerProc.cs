// AppPowerProc.cs - the process side of App power (sidecar/AppPower.cs; lane mantle-power-sidecar,
// 2026-10-14): ONE cheap process list read, and what never changes while a process runs - its exe
// path and whether Mantle may change it - cached per RUN of a process (pid + start time), so it is
// looked up once per process, not once a second. TopbarStats' top entries read the same cache.
//
// ACCESS (the contract's words, section 3):
//   ok        OpenProcess(SET_INFORMATION | SET_QUOTA | QUERY_LIMITED) works
//   admin     denied, and the process runs elevated (or its token can't be opened from here)
//   system    another session than Owen's (session 0 = Windows services)
//   protected a protected process, the NEVER list, this sidecar, Mantle's own electron
//   game      a game or anti-cheat (GameMode.GamePrefixes): never opened for more than reading its
//             path, exactly like game mode, so a click can never get Owen flagged
//   unknown   denied for another reason
// The access probe opens the process and closes it at once; nothing is changed.
//
// PRIVACY: nothing here logs a name or a path. C# 5 (see build.ps1).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  static partial class AppPower {
    internal static class N {
      [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetPriorityClass(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetPriorityClass(IntPtr h, uint cls);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessInformation(IntPtr h, int cls, ref THROTTLE info, uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr h, int cls, ref THROTTLE info, uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessInformation(IntPtr h, int cls, ref uint info, uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr h, int cls, ref uint info, uint size);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out int info, int len, out int ret);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, out uint ret);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
      [DllImport("psapi.dll", SetLastError = true)] public static extern bool EmptyWorkingSet(IntPtr h);
      [DllImport("gdi32.dll")] public static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr h, int prio);
      [DllImport("gdi32.dll")] public static extern int D3DKMTGetProcessSchedulingPriorityClass(IntPtr h, out int prio);
    }
    [StructLayout(LayoutKind.Sequential)] internal struct THROTTLE { public uint Version, ControlMask, StateMask; }

    internal const uint P_TERMINATE = 0x0001, P_DUP_HANDLE = 0x0040, P_SET_QUOTA = 0x0100, P_SET_INFORMATION = 0x0200,
                        P_QUERY_INFORMATION = 0x0400, P_QUERY_LIMITED = 0x1000;
    /// The rights every App power write needs (the contract's "ok" test).
    internal const uint BASE_ACCESS = P_SET_INFORMATION | P_SET_QUOTA | P_QUERY_LIMITED;
    const int ERROR_INVALID_PARAMETER = 87;          // OpenProcess on a pid that is gone

    /// Never touched, whatever Node sends (contract section 2, DEFENCE IN DEPTH). Exe names without ".exe".
    static readonly HashSet<string> Never = new HashSet<string>(new string[] {
      "System", "Idle", "Registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost",
      "dwm", "fontdrvhost", "audiodg", "MsMpEng", "NisSrv", "MpDefenderCoreService", "SecurityHealthService", "SgrmBroker",
      "Memory Compression", "Secure System", "explorer", "sihost", "ctfmon", "LogonUI", "Mantle.Sidecar",
    }, StringComparer.OrdinalIgnoreCase);

    internal static string ExeOf(string name) {
      if (string.IsNullOrEmpty(name)) return "";
      return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
    }
    internal static bool IsNever(string exe) { return Never.Contains(ExeOf(exe)); }
    internal static bool IsGameish(string exe) {
      string e = ExeOf(exe);
      foreach (string p in GameMode.GamePrefixes) if (e.StartsWith(p, StringComparison.OrdinalIgnoreCase)) return true;
      return false;
    }

    static uint _ownSession = uint.MaxValue;
    internal static uint OwnSession {
      get {
        if (_ownSession == uint.MaxValue) { uint s; _ownSession = N.ProcessIdToSessionId((uint)Program.OwnPid, out s) ? s : 1; }
        return _ownSession;
      }
    }

    // ================================================================ THE PROCESS LIST
    internal sealed class PInfo {
      public uint Pid, Ppid, Session; public long Created, Cpu100ns, WorkingSet; public string Name;   // Name as Windows reports it (".exe" kept)
    }
    static readonly object _snapLock = new object();
    static IntPtr _sbuf = IntPtr.Zero;
    static int _slen = 1 << 20;

    /// One NtQuerySystemInformation(SystemProcessInformation) read - no handle opened on any process.
    /// x64 SYSTEM_PROCESS_INFORMATION: NextEntryOffset 0x00, CreateTime 0x20, UserTime 0x28, KernelTime
    /// 0x30, ImageName 0x38 (Length) / 0x40 (Buffer), UniqueProcessId 0x50, InheritedFromUniqueProcessId
    /// 0x58, HandleCount 0x60, SessionId 0x64, WorkingSetSize 0x90 (sidecar/test-apppower.js checks the
    /// session and the working set against what PowerShell reports for the same pid).
    internal static List<PInfo> Snap(out string err) {
      err = null;
      var list = new List<PInfo>(400);
      if (IntPtr.Size != 8) { err = "App power needs the 64-bit sidecar"; return list; }
      lock (_snapLock) {
        int ret = 0, st = 0;
        for (int tries = 0; tries < 4; tries++) {
          if (_sbuf == IntPtr.Zero) _sbuf = Marshal.AllocHGlobal(_slen);
          st = N.NtQuerySystemInformation(5, _sbuf, _slen, out ret);
          if (st != unchecked((int)0xC0000004)) break;   // STATUS_INFO_LENGTH_MISMATCH
          Marshal.FreeHGlobal(_sbuf); _sbuf = IntPtr.Zero; _slen = Math.Max(_slen * 2, ret + 65536);
        }
        if (st != 0) { err = "Windows would not list the processes (status 0x" + st.ToString("X8") + ")"; return list; }
        long off = 0;
        for (int n = 0; n < 65536; n++) {
          IntPtr p = new IntPtr(_sbuf.ToInt64() + off);
          var pi = new PInfo();
          pi.Pid = (uint)Marshal.ReadInt64(p, 0x50);
          pi.Ppid = (uint)Marshal.ReadInt64(p, 0x58);
          pi.Created = Marshal.ReadInt64(p, 0x20);
          pi.Cpu100ns = Marshal.ReadInt64(p, 0x28) + Marshal.ReadInt64(p, 0x30);
          pi.Session = (uint)Marshal.ReadInt32(p, 0x64);
          pi.WorkingSet = Marshal.ReadInt64(p, 0x90);
          int len = Marshal.ReadInt16(p, 0x38) & 0xFFFF;
          IntPtr nb = Marshal.ReadIntPtr(p, 0x40);
          pi.Name = len > 0 && nb != IntPtr.Zero ? Marshal.PtrToStringUni(nb, len / 2) : pi.Pid == 0 ? "Idle" : "System";
          list.Add(pi);
          int next = Marshal.ReadInt32(p, 0);
          if (next <= 0) break;
          off += next;
        }
      }
      return list;
    }

    // ================================================================ THE PER-RUN CACHE
    sealed class Known { public long Created; public string Exe; public bool PathDone; public string Path; public string Access; public int Seen; }
    static readonly object _knownLock = new object();
    static Dictionary<uint, Known> _known = new Dictionary<uint, Known>();

    static Known KnownOf(uint pid, long created, string name) {
      string exe = ExeOf(name);
      lock (_knownLock) {
        Known k;
        if (!_known.TryGetValue(pid, out k) || k.Created != created || !string.Equals(k.Exe, exe, StringComparison.OrdinalIgnoreCase)) {
          if (_known.Count >= 4096) PruneKnown();
          k = new Known { Created = created, Exe = exe };
          _known[pid] = k;
        }
        k.Seen = Environment.TickCount;
        return k;
      }
    }
    // under _knownLock: drop what nobody asked about for 10 minutes (dead runs, mostly)
    static void PruneKnown() {
      int now = Environment.TickCount;
      var drop = new List<uint>();
      foreach (var kv in _known) if (unchecked(now - kv.Value.Seen) > 600000) drop.Add(kv.Key);
      foreach (uint p in drop) _known.Remove(p);
      if (_known.Count >= 4096) _known.Clear();
    }

    /// The full image path of one run of a process, looked up ONCE (one QUERY_LIMITED open), or null.
    /// A game or anti-cheat is never opened (its path stays null).
    internal static string PathOf(uint pid, long created, string name) {
      Known k = KnownOf(pid, created, name);
      lock (_knownLock) if (k.PathDone) return k.Path;
      string path = null;
      if (pid > 4 && !IsGameish(name)) {
        IntPtr h = N.OpenProcess(P_QUERY_LIMITED, false, pid);
        if (h != IntPtr.Zero) {
          try { var sb = new StringBuilder(1024); uint size = 1024; if (N.QueryFullProcessImageNameW(h, 0, sb, ref size)) path = sb.ToString(0, (int)size); }
          finally { N.CloseHandle(h); }
        }
      }
      lock (_knownLock) { k.Path = path; k.PathDone = true; }
      return path;
    }

    /// Whether Mantle may change this run of a process (the codes above), probed ONCE per run.
    internal static string AccessOf(uint pid, long created, string name, uint session) {
      Known k = KnownOf(pid, created, name);
      lock (_knownLock) if (k.Access != null) return k.Access;
      string a = Classify(pid, name, session);
      if (a != "gone") lock (_knownLock) k.Access = a;
      return a;
    }

    static string Classify(uint pid, string name, uint session) {
      if (pid <= 4 || IsNever(name) || pid == (uint)Program.OwnPid || (Program.ParentPid > 0 && pid == (uint)Program.ParentPid)) return "protected";
      if (IsGameish(name)) return "game";
      if (session != OwnSession) return "system";
      IntPtr h = N.OpenProcess(BASE_ACCESS, false, pid);
      if (h != IntPtr.Zero) { N.CloseHandle(h); return "ok"; }
      if (Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER) return "gone";
      IntPtr q = N.OpenProcess(P_QUERY_LIMITED, false, pid);
      if (q == IntPtr.Zero) return Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER ? "gone" : "protected";
      try {
        uint lvl = 0;
        if (N.GetProcessInformation(q, 7 /* ProcessProtectionLevelInfo */, ref lvl, 4) && lvl != 0xFFFFFFFE /* PROTECTION_LEVEL_NONE */) return "protected";
        IntPtr tok;
        if (!N.OpenProcessToken(q, 0x0008 /* TOKEN_QUERY */, out tok)) return "admin";
        try { int el, ret; if (N.GetTokenInformation(tok, 20 /* TokenElevation */, out el, 4, out ret) && el != 0) return "admin"; }
        finally { N.CloseHandle(tok); }
        return "unknown";
      } finally { N.CloseHandle(q); }
    }

    /// The test burner, and only it, may be WRITTEN by a passive (--test) sidecar: an exe that lives
    /// under %TEMP% AND is named mpburn-* (sidecar/apppower-burner.js) or MANTLE_APPPOWER_TEST_EXE.
    internal static bool IsTestTarget(PInfo p) {
      string path = PathOf(p.Pid, p.Created, p.Name);
      if (path == null) return false;
      string temp;
      try { temp = System.IO.Path.GetFullPath(System.IO.Path.GetTempPath()); } catch (Exception) { return false; }
      if (!path.StartsWith(temp, StringComparison.OrdinalIgnoreCase)) return false;
      string file = ExeOf(System.IO.Path.GetFileName(path));
      if (file.StartsWith("mpburn-", StringComparison.OrdinalIgnoreCase)) return true;
      string env = ExeOf(Environment.GetEnvironmentVariable("MANTLE_APPPOWER_TEST_EXE") ?? "");
      return env.Length > 0 && string.Equals(file, env, StringComparison.OrdinalIgnoreCase);
    }
  }
}
