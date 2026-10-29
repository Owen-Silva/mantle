// ProcOps.cs - Windows Task Manager's one-process commands for Mantle's Task Manager (lane tm-ops, 2026-10-28).
//
// WHAT: the row-menu items of the stock Windows 11 Task Manager that act on ONE process, plus Run new task,
// Restart (Windows Explorer) and Properties. TM-SPEC.md is the contract.
//   taskmgr.efficiency      {pid, created, on, dryRun?}      Efficiency mode (EcoQoS + Low priority, as Windows does)
//   taskmgr.priority        {pid, created, cls, dryRun?}     Set priority (realtime|high|abovenormal|normal|belownormal|low)
//   taskmgr.affinity        {pid, created, mask, dryRun?}    Set affinity (mask: decimal string, "0x.." hex string or number)
//   taskmgr.affinityget     {pid, created}                   the Set affinity dialog's current state (read only)
//   taskmgr.dump            {pid, created, dryRun?}          Create memory dump file (%TEMP%\<exe name>.DMP)
//   taskmgr.waitchain       {pid, created}                   Analyze wait chain (read only, WCT)
//   taskmgr.uacvirt         {pid, created, on, dryRun?}      UAC virtualization
//   taskmgr.restartexplorer {dryRun?}                        Restart, on the Windows Explorer row
//   taskmgr.runtask         {line, admin?, dryRun?}          Run new task (ShellExecuteEx, runas when admin); `line`
//                                                            because `cmd` is the wire's command-name field
//   taskmgr.properties      {path, dryRun?}                  Properties (the shell's Properties sheet of a file)
// Every reply: {ok, reason (null when ok), needsAdmin (true only when Windows answered access denied, or
// Realtime silently became High), dryRun, ...command fields}.
//
// THE RULES (mantle-wt/tm-data-bin/LANE-RULES.md, "Safety"):
//   - A process is named by pid AND creation time. TaskMgr.TakeAs checks both against one process-table read
//     and holds a handle for the whole action, so the number cannot be reused under us. Guard policy, like
//     Windows' Task Manager (coordinator, 10-28; TaskMgr.cs "the three guard policies"):
//       writes (efficiency, priority, affinity, uacvirt, dump): GUARD_USER. Any process, but a critical,
//         Windows or Mantle process needs confirmed:true; without it the reply is ok:false, needsConfirm:true,
//         kind, confirm (Windows' own warning, TaskMgr.ConfirmText) and nothing is touched. Efficiency mode
//         on a CRITICAL process is refused outright (Windows greys the item out for those).
//       reads (waitchain, affinityget): GUARD_READ, no guard (Windows analyses any process).
//     The same policy holds in an elevated host.
//   - The action's own handle is then opened with exactly the rights the action needs, ALSO in a dry run, so
//     "would be denied" is an honest answer; it is checked against the same creation time.
//   - dryRun answers what would be done and touches nothing. A passive (test) host refuses every real write
//     with the passive-refusal words before reading anything.
//   - Access denied (Win32 5) -> ok:false, needsAdmin:true, plain words: lib's one seam retries those
//     through the elevated helper. Never a silent no-op.
//   - Restart (Windows Explorer) cannot go through the guard (explorer IS on its list); it has its own
//     verification: same session as this host, image path exactly %WINDIR%\explorer.exe, creation time
//     checked on the held handle, never this host or its parent.
//   - Nothing here is logged. Names and paths travel only in replies, to the window.
//
// OUTSIDE DEPENDENCIES (this file also compiles into the elevated helper, lane tm-elevate):
//   Program.Passive, Program.OwnPid, Program.ParentPid, FeatureTable.PassiveRefusal: read ONLY through the
//     host seam below (Passive / OwnPid / ParentPid / Refusal). Register() hands Program's over; a second
//     host calls ProcOps.UseHost(...) itself. Until a host is set, Passive is TRUE (fails closed).
//   FeatureTable.Add, Lanes.Slow, [MantleFeature], FeatureCommand (Features.cs, Lanes.cs): Register only.
//   TaskMgr.TakeAs / GUARD_USER / GUARD_READ / SensitiveKind / Release / ReadProcs / PathOf / Proc / Held / Str /
//     DryRun / QUERY_LIMITED / SYNCHRONIZE / STILL_ACTIVE (TaskMgr.cs). TaskMgr.SensitiveKind and Refuse read
//     Program.OwnPid / ParentPid themselves (TaskMgr.cs's own
//     dependency: an elevated host must set those to Mantle's pids for "Mantle itself" to hold).
//   Json.GetInt / GetString / GetBool / HasKey / TryGet (Json.cs).
//   Win32 (declared here, class N): kernel32, advapi32 (tokens, WCT), dbghelp (MiniDumpWriteDump), shell32
//     (ShellExecuteExW, SHObjectProperties), psapi (GetProcessMemoryInfo), user32 (GetShellWindow).
//
// C# 5 only (build.ps1): no interpolation, no nameof, no out var, no ?. operator.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Mantle {
  [MantleFeature]
  static class ProcOps {
    // ------------------------------------------------------------------ the host seam (the only door to Program)

    static Func<bool> _passive;
    static Func<int> _ownPid, _parentPid;
    static string _refusal;

    /// The host's globals. Program's sidecar passes its own in Register; the elevated helper passes its own.
    internal static void UseHost(Func<bool> passive, Func<int> ownPid, Func<int> parentPid, string passiveRefusal) {
      _passive = passive; _ownPid = ownPid; _parentPid = parentPid; _refusal = passiveRefusal;
    }
    static bool Passive { get { return _passive == null || _passive(); } }      // no host yet: refuse writes
    static uint OwnPid { get { return _ownPid == null ? (uint)Process.GetCurrentProcess().Id : (uint)_ownPid(); } }
    static uint ParentPid { get { int p = _parentPid == null ? 0 : _parentPid(); return p > 0 ? (uint)p : 0; } }
    static string Refusal { get { return _refusal ?? "refused: sidecar is passive (test mode)"; } }

    public static void Register(FeatureTable t) {
      UseHost(delegate { return Program.Passive; }, delegate { return Program.OwnPid; },
              delegate { return Program.ParentPid; }, FeatureTable.PassiveRefusal);
      t.Add("taskmgr.efficiency", Lanes.Slow, Efficiency);
      t.Add("taskmgr.priority", Lanes.Slow, Priority);
      t.Add("taskmgr.affinity", Lanes.Slow, Affinity);
      t.Add("taskmgr.affinityget", Lanes.Slow, AffinityGet);
      t.Add("taskmgr.dump", Lanes.Slow, Dump);
      t.Add("taskmgr.waitchain", Lanes.Slow, WaitChain);
      t.Add("taskmgr.uacvirt", Lanes.Slow, UacVirt);
      t.Add("taskmgr.restartexplorer", Lanes.Slow, RestartExplorer);
      t.Add("taskmgr.runtask", Lanes.Slow, RunTask);
      t.Add("taskmgr.properties", Lanes.Slow, Properties);
    }

    // ------------------------------------------------------------------ Win32

    static class N {
      [StructLayout(LayoutKind.Sequential)]
      public struct THROTTLE { public uint Version, ControlMask, StateMask; }
      [StructLayout(LayoutKind.Sequential)]
      public struct PMC_EX {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
                       QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
      }
      [StructLayout(LayoutKind.Sequential)]
      public struct THREADENTRY32 { public uint dwSize, cntUsage, th32ThreadID, th32OwnerProcessID; public int tpBasePri, tpDeltaPri; public uint dwFlags; }
      [StructLayout(LayoutKind.Sequential)]
      public struct LUID { public uint Low; public int High; }
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct SHELLEXECUTEINFO {
        public int cbSize; public uint fMask; public IntPtr hwnd;
        public string lpVerb, lpFile, lpParameters, lpDirectory;
        public int nShow; public IntPtr hInstApp, lpIDList; public string lpClass; public IntPtr hkeyClass;
        public uint dwHotKey; public IntPtr hIconOrMonitor, hProcess;
      }
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetPriorityClass(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetPriorityClass(IntPtr h, uint cls);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessInformation(IntPtr h, int cls, ref THROTTLE info, uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr h, int cls, ref THROTTLE info, uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessCritical(IntPtr h, out bool critical);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessAffinityMask(IntPtr h, out UIntPtr procMask, out UIntPtr sysMask);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessAffinityMask(IntPtr h, UIntPtr mask);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetDiskFreeSpaceExW(string dir, out ulong availToCaller, out ulong total, out ulong free);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool Thread32First(IntPtr snap, ref THREADENTRY32 te);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool Thread32Next(IntPtr snap, ref THREADENTRY32 te);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetProcessId(IntPtr h);
      [DllImport("psapi.dll", SetLastError = true)] public static extern bool GetProcessMemoryInfo(IntPtr h, ref PMC_EX c, uint size);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out uint info, int len, out int ret);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr info, int len, out int ret);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr tok, int cls, ref uint info, int len);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool LookupPrivilegeValueW(string system, string name, out LUID luid);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern IntPtr OpenThreadWaitChainSession(uint flags, IntPtr callback);
      [DllImport("advapi32.dll")] public static extern void CloseThreadWaitChainSession(IntPtr wct);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetThreadWaitChain(IntPtr wct, IntPtr context, uint flags, uint tid, ref uint count, IntPtr nodes, out int isCycle);
      [DllImport("dbghelp.dll", SetLastError = true)] public static extern bool MiniDumpWriteDump(IntPtr h, uint pid, SafeFileHandle file, uint type, IntPtr exc, IntPtr user, IntPtr cb);
      [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO sei);
      [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SHObjectProperties(IntPtr hwnd, uint type, string name, string page);
      [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    }

    const uint PROCESS_TERMINATE = 0x0001, PROCESS_VM_READ = 0x0010, PROCESS_SET_INFORMATION = 0x0200,
               PROCESS_QUERY_INFORMATION = 0x0400, TOKEN_QUERY = 0x0008, TOKEN_ADJUST_DEFAULT = 0x0080;
    const uint IDLE = 0x40, NORMAL = 0x20, HIGH = 0x80, REALTIME = 0x100;
    const int ProcessPowerThrottling = 4, TokenPrivileges = 3, TokenVirtualizationAllowed = 23, TokenVirtualizationEnabled = 24;
    const uint MiniDumpWithFullMemory = 0x2;
    const long MinFreeAfterDump = 2L * 1024 * 1024 * 1024;

    // ------------------------------------------------------------------ shared: reply, verify, open

    static Dictionary<string, object> NewReply(bool dry) {
      var r = new Dictionary<string, object>();
      r["ok"] = false; r["reason"] = null; r["needsAdmin"] = false; r["dryRun"] = dry;
      return r;
    }

    static void Fail(Dictionary<string, object> r, string why) { r["ok"] = false; r["reason"] = why; }

    /// A Win32 failure in plain words; error 5 is the one the elevated seam retries.
    static void ApiFail(Dictionary<string, object> r, int e, string doing) {
      if (e == 5) { r["needsAdmin"] = true; Fail(r, "access denied: Windows needs administrator rights to " + doing + " (it runs as administrator, as another user, or is protected)"); }
      else Fail(r, "Windows could not " + doing + " (error " + e + ")");
    }

    sealed class Target { public List<TaskMgr.Held> Held; public IntPtr H; public uint Pid; public TaskMgr.Proc P; }

    static void Close(Target t) {
      if (t == null) return;
      if (t.H != IntPtr.Zero) N.CloseHandle(t.H);
      TaskMgr.Release(t.Held);
    }

    const string GreyedEfficiency = "refused: a critical Windows process; Windows' Task Manager greys Efficiency mode out for it, and so does Mantle";

    /// {pid, created} -> TaskMgr.TakeAs with `guard` (GUARD_USER for writes, op = the ConfirmText op;
    /// GUARD_READ for reads): table + creation time + a held QUERY_LIMITED|SYNCHRONIZE handle, then the
    /// action's own handle with exactly `access` (always includes QUERY_LIMITED), checked against the same
    /// creation time. req.confirmed is passed through to the GUARD_USER gate. Null + a filled reply when
    /// refused, unconfirmed (needsConfirm, kind, confirm) or denied (needsAdmin).
    static Target Open(Dictionary<string, object> req, uint access, Dictionary<string, object> r, string doing, int guard, string op) {
      int pid = Json.GetInt(req, "pid", 0);
      string created = Json.GetString(req, "created");
      if (pid <= 0 || string.IsNullOrEmpty(created)) { Fail(r, "needs pid and created (the creation time taskmgr.snapshot gave)"); return null; }
      r["pid"] = pid;
      var one = new Dictionary<string, object>(); one["pid"] = (double)pid; one["created"] = created;
      var synth = new Dictionary<string, object>();
      synth["procs"] = new List<object> { one };
      synth["confirmed"] = Json.GetBool(req, "confirmed", false);
      var refused = new List<object>();
      Dictionary<uint, TaskMgr.Proc> byPid;
      string err;
      List<TaskMgr.Held> held = TaskMgr.TakeAs(synth, TaskMgr.QUERY_LIMITED | TaskMgr.SYNCHRONIZE, refused, out byPid, out err, guard, op);
      if (held == null) { Fail(r, err ?? "the process table could not be read"); return null; }
      if (held.Count == 0) {
        var d = refused.Count > 0 ? refused[0] as IDictionary : null;
        string why = d == null ? null : d["why"] as string;
        TaskMgr.Proc tp;
        if (op == "efficiency" && byPid != null && byPid.TryGetValue((uint)pid, out tp) && created == TaskMgr.Str(tp.Created) &&
            TaskMgr.SensitiveKind(tp, byPid) == "critical") { r["unavailable"] = true; Fail(r, GreyedEfficiency); return null; }
        if (d != null && d.Contains("needsConfirm") && d["needsConfirm"] is bool && (bool)d["needsConfirm"]) {
          if (op == "efficiency" && (d["kind"] as string) == "critical") { r["unavailable"] = true; Fail(r, GreyedEfficiency); return null; }
          r["needsConfirm"] = true; r["kind"] = d["kind"]; r["confirm"] = d["confirm"];
          Fail(r, why ?? "needs confirmation");
          return null;
        }
        if (why != null && why.StartsWith("access denied", StringComparison.Ordinal)) {
          r["needsAdmin"] = true;
          Fail(r, "access denied: Windows needs administrator rights to " + doing + " (it runs as administrator, as another user, or is protected)");
          return null;
        }
        Fail(r, why ?? "Windows would not open it");
        return null;
      }
      var t = new Target(); t.Held = held; t.Pid = held[0].Pid; t.P = held[0].P;
      // Confirmed or not sensitive: Efficiency mode is still unavailable on a critical process (Windows greys it).
      if (op == "efficiency" && TaskMgr.SensitiveKind(t.P, byPid) == "critical") { Close(t); r["unavailable"] = true; Fail(r, GreyedEfficiency); return null; }
      IntPtr h = N.OpenProcess(access | TaskMgr.QUERY_LIMITED, false, t.Pid);
      if (h == IntPtr.Zero) { int e = Marshal.GetLastWin32Error(); Close(t); ApiFail(r, e, doing); return null; }
      t.H = h;
      long c, x, k, u;
      if (!N.GetProcessTimes(h, out c, out x, out k, out u) || c != t.P.Created) { Close(t); Fail(r, "it exited while Mantle was checking it"); return null; }
      return t;
    }

    static string Hex(ulong v) { return "0x" + v.ToString("X", CultureInfo.InvariantCulture); }
    static string Dec(ulong v) { return v.ToString(CultureInfo.InvariantCulture); }

    // ------------------------------------------------------------------ priority + efficiency

    static readonly string[] ClsNames = { "realtime", "high", "abovenormal", "normal", "belownormal", "low" };
    static readonly uint[] ClsValues = { REALTIME, HIGH, 0x8000, NORMAL, 0x4000, IDLE };

    static string ClsName(uint v) {
      for (int i = 0; i < ClsValues.Length; i++) if (ClsValues[i] == v) return ClsNames[i];
      return null;
    }

    /// Whether this host's token holds SeIncreaseBasePriorityPrivilege (enabled or not): SetPriorityClass
    /// enables it for the call itself; without it Windows sets High instead of Realtime and says nothing.
    static bool HasRealtimePrivilege() {
      N.LUID want;
      if (!N.LookupPrivilegeValueW(null, "SeIncreaseBasePriorityPrivilege", out want)) return false;
      IntPtr tok;
      if (!N.OpenProcessToken(N.GetCurrentProcess(), TOKEN_QUERY, out tok)) return false;
      IntPtr buf = IntPtr.Zero;
      try {
        int len;
        N.GetTokenInformation(tok, TokenPrivileges, IntPtr.Zero, 0, out len);
        if (len <= 0) return false;
        buf = Marshal.AllocHGlobal(len);
        if (!N.GetTokenInformation(tok, TokenPrivileges, buf, len, out len)) return false;
        int n = Marshal.ReadInt32(buf, 0);
        for (int i = 0; i < n; i++) {
          int off = 4 + i * 12;    // LUID_AND_ATTRIBUTES: Low, High, Attributes
          if ((uint)Marshal.ReadInt32(buf, off) == want.Low && Marshal.ReadInt32(buf, off + 4) == want.High)
            return ((uint)Marshal.ReadInt32(buf, off + 8) & 0x4) == 0;   // SE_PRIVILEGE_REMOVED
        }
        return false;
      } finally { if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf); N.CloseHandle(tok); }
    }

    /// The process's efficiency state as Windows' Task Manager shows it: power throttling
    /// (EXECUTION_SPEED controlled AND on) plus Low (Idle) priority.
    static Dictionary<string, object> EffState(IntPtr h) {
      var s = new Dictionary<string, object>();
      var th = new N.THROTTLE(); th.Version = 1;
      bool got = N.GetProcessInformation(h, ProcessPowerThrottling, ref th, 12);
      int e = got ? 0 : Marshal.GetLastWin32Error();
      uint pc = N.GetPriorityClass(h);
      object throttled = got ? (object)((th.ControlMask & 1) != 0 && (th.StateMask & 1) != 0) : null;
      s["throttled"] = throttled;
      s["throttleControl"] = got ? (object)th.ControlMask : null;
      s["throttleState"] = got ? (object)th.StateMask : null;
      s["throttleWhy"] = got ? null : "Windows did not say (error " + e + ")";
      s["priority"] = pc == 0 ? null : ClsName(pc);
      s["efficiency"] = got && pc != 0 ? (object)(((bool)throttled) && pc == IDLE) : null;
      return s;
    }

    static string Efficiency(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      if (!Json.HasKey(req, "on")) { Fail(r, "needs on: true or false"); return null; }
      bool on = Json.GetBool(req, "on", false);
      r["on"] = on;
      Target t = Open(req, PROCESS_SET_INFORMATION, r, "change Efficiency mode for this process", TaskMgr.GUARD_USER, "efficiency");
      if (t == null) return null;
      try {
        r["before"] = EffState(t.H);
        if (dry) {
          r["ok"] = true;
          r["would"] = on ? "power throttling EXECUTION_SPEED on, then priority Low (Idle)" : "power throttling EXECUTION_SPEED off, then priority Normal";
          return null;
        }
        var th = new N.THROTTLE(); th.Version = 1; th.ControlMask = 1; th.StateMask = on ? 1u : 0u;
        if (!N.SetProcessInformation(t.H, ProcessPowerThrottling, ref th, 12)) { ApiFail(r, Marshal.GetLastWin32Error(), "change power throttling for this process"); r["state"] = EffState(t.H); return null; }
        if (!N.SetPriorityClass(t.H, on ? IDLE : NORMAL)) {
          int e = Marshal.GetLastWin32Error();
          ApiFail(r, e, "change this process's priority");
          r["reason"] = "power throttling changed, the priority did not: " + (string)r["reason"];
          r["state"] = EffState(t.H);
          return null;
        }
        var st = EffState(t.H);
        r["state"] = st;
        bool now = st["efficiency"] is bool && (bool)st["efficiency"];
        if (now == on) r["ok"] = true;
        else Fail(r, "Windows accepted the change but reads back a different state");
        return null;
      } finally { Close(t); }
    }

    static string Priority(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      string cls = (Json.GetString(req, "cls") ?? "").Trim().ToLowerInvariant().Replace(" ", "");
      int idx = Array.IndexOf(ClsNames, cls);
      if (idx < 0) { Fail(r, "cls must be one of realtime, high, abovenormal, normal, belownormal, low"); return null; }
      uint want = ClsValues[idx];
      r["cls"] = cls;
      Target t = Open(req, PROCESS_SET_INFORMATION, r, "change this process's priority", TaskMgr.GUARD_USER, "priority");
      if (t == null) return null;
      try {
        uint before = N.GetPriorityClass(t.H);
        r["before"] = before == 0 ? null : ClsName(before);
        bool rtOk = want != REALTIME || HasRealtimePrivilege();
        if (dry) {
          if (!rtOk) {
            r["wouldBecome"] = "high"; r["needsAdmin"] = true;
            Fail(r, "Windows would set High instead: Realtime needs administrator rights (the Increase scheduling priority privilege), which Mantle does not have");
          } else { r["ok"] = true; r["wouldBecome"] = cls; }
          return null;
        }
        if (!N.SetPriorityClass(t.H, want)) { ApiFail(r, Marshal.GetLastWin32Error(), "change this process's priority"); return null; }
        uint now = N.GetPriorityClass(t.H);
        r["applied"] = now == 0 ? null : ClsName(now);
        if (now == want) r["ok"] = true;
        else if (want == REALTIME && now == HIGH) {
          r["needsAdmin"] = true;
          Fail(r, "Windows set High instead of Realtime: Realtime needs administrator rights (the Increase scheduling priority privilege)");
        } else Fail(r, "Windows accepted the change but reads back " + (ClsName(now) ?? "nothing"));
        return null;
      } finally { Close(t); }
    }

    // ------------------------------------------------------------------ affinity

    static bool ParseMask(Dictionary<string, object> req, out ulong mask) {
      mask = 0;
      object v;
      if (!Json.TryGet(req, "mask", out v)) return false;
      if (v is double) {
        double d = (double)v;
        if (d <= 0 || d > 9007199254740991.0 || Math.Floor(d) != d) return false;
        mask = (ulong)d; return true;
      }
      string s = (v as string ?? "").Trim();
      if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        return ulong.TryParse(s.Substring(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out mask);
      return ulong.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out mask);
    }

    static List<object> Cpus(ulong m) {
      var l = new List<object>();
      for (int i = 0; i < 64; i++) if ((m & (1UL << i)) != 0) l.Add(i);
      return l;
    }

    static int Bits(ulong m) { int n = 0; while (m != 0) { n += (int)(m & 1); m >>= 1; } return n; }

    /// Reads the masks into r (mask, systemMask, logical, cpus). False + reason when Windows did not say.
    static bool ReadMasks(IntPtr h, Dictionary<string, object> r, string prefix) {
      UIntPtr pm, sm;
      if (!N.GetProcessAffinityMask(h, out pm, out sm)) { ApiFail(r, Marshal.GetLastWin32Error(), "read this process's affinity"); return false; }
      ulong p = pm.ToUInt64(), s = sm.ToUInt64();
      r[prefix] = p == 0 ? null : Dec(p);
      if (p == 0) r[prefix + "Why"] = "the process runs on more than one processor group; Windows reports no single mask";
      r["systemMask"] = Dec(s);
      r["logical"] = Bits(s);
      if (prefix == "mask") r["cpus"] = Cpus(p);
      return true;
    }

    static string AffinityGet(Dictionary<string, object> req, ref object result) {
      var r = NewReply(false); result = r;
      r.Remove("dryRun");
      Target t = Open(req, 0, r, "read this process's affinity", TaskMgr.GUARD_READ, null);
      if (t == null) return null;
      try { if (ReadMasks(t.H, r, "mask")) r["ok"] = true; return null; }
      finally { Close(t); }
    }

    static string Affinity(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      ulong mask;
      if (!ParseMask(req, out mask)) { Fail(r, "needs mask: the logical processors as a decimal string, a 0x hex string or a number"); return null; }
      if (mask == 0) { Fail(r, "the mask has no processor in it; a process needs at least one (Windows says the same)"); return null; }
      Target t = Open(req, PROCESS_SET_INFORMATION, r, "change this process's affinity", TaskMgr.GUARD_USER, "affinity");
      if (t == null) return null;
      try {
        if (!ReadMasks(t.H, r, "before")) return null;
        ulong sys = ulong.Parse((string)r["systemMask"], CultureInfo.InvariantCulture);
        r["asked"] = Dec(mask);
        if ((mask & ~sys) != 0) { Fail(r, "the mask names processors this PC does not have (it has " + Bits(sys) + ", mask " + Hex(sys) + ")"); return null; }
        if (dry) { r["ok"] = true; r["cpus"] = Cpus(mask); return null; }
        if (!N.SetProcessAffinityMask(t.H, new UIntPtr(mask))) { ApiFail(r, Marshal.GetLastWin32Error(), "change this process's affinity"); return null; }
        if (!ReadMasks(t.H, r, "mask")) return null;
        if ((string)r["mask"] == Dec(mask)) r["ok"] = true;
        else Fail(r, "Windows accepted the change but reads back a different mask");
        return null;
      } finally { Close(t); }
    }

    // ------------------------------------------------------------------ memory dump

    static string Dump(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      Target t = Open(req, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, r, "read this process's memory for a dump", TaskMgr.GUARD_USER, "dump");
      if (t == null) return null;
      try {
        // Windows: %LOCALAPPDATA%\Temp\<exe name>.DMP. Here %TEMP% (the same folder for a normal account); a
        // name already taken gets " (2)", " (3)"... so an older dump is never overwritten.
        string dir = Environment.GetEnvironmentVariable("TEMP");
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) dir = Path.GetTempPath();
        string stem = Path.GetFileNameWithoutExtension(t.P.File ?? "");
        if (stem.Length == 0) stem = "process" + t.Pid.ToString(CultureInfo.InvariantCulture);
        foreach (char ch in Path.GetInvalidFileNameChars()) stem = stem.Replace(ch, '_');
        string path = Path.Combine(dir, stem + ".DMP");
        for (int i = 2; File.Exists(path) && i < 1000; i++) path = Path.Combine(dir, stem + " (" + i + ").DMP");
        r["path"] = path;
        ulong avail, total, free;
        object freeBytes = null, privBytes = null;
        if (N.GetDiskFreeSpaceExW(dir, out avail, out total, out free)) freeBytes = (long)avail;
        else r["freeWhy"] = "Windows did not say how much space is free (error " + Marshal.GetLastWin32Error() + ")";
        var pmc = new N.PMC_EX(); pmc.cb = (uint)Marshal.SizeOf(typeof(N.PMC_EX));
        if (N.GetProcessMemoryInfo(t.H, ref pmc, pmc.cb)) privBytes = (long)pmc.PrivateUsage.ToUInt64();
        else r["privateWhy"] = "Windows did not say how much private memory it has (error " + Marshal.GetLastWin32Error() + ")";
        r["freeBytes"] = freeBytes; r["privateBytes"] = privBytes; r["minFreeAfter"] = MinFreeAfterDump;
        if (freeBytes == null || privBytes == null) { Fail(r, "refused: the free disk space or the process's size could not be read, so Mantle cannot promise the dump leaves 2 GB free"); return null; }
        if ((long)freeBytes - (long)privBytes < MinFreeAfterDump) {
          Fail(r, "refused: the dump (about " + ((long)privBytes / 1048576) + " MB) would leave less than 2 GB free on the drive of " + dir);
          return null;
        }
        if (dry) { r["ok"] = true; r["would"] = "MiniDumpWriteDump(MiniDumpWithFullMemory) into the path"; return null; }
        bool ok; int e = 0; long bytes = 0;
        using (var fs = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)) {
          ok = N.MiniDumpWriteDump(t.H, t.Pid, fs.SafeFileHandle, MiniDumpWithFullMemory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
          if (!ok) e = Marshal.GetLastWin32Error(); else bytes = fs.Length;
        }
        if (!ok) {
          try { File.Delete(path); } catch (Exception) { }
          r["path"] = null;
          ApiFail(r, e & 0xFFFF, "write the memory dump");
          return null;
        }
        r["bytes"] = bytes; r["ok"] = true;
        return null;
      } finally { Close(t); }
    }

    // ------------------------------------------------------------------ wait chain

    static readonly string[] WctTypes = { null, "criticalSection", "sendMessage", "mutex", "alpc", "com", "threadWait",
                                          "processWait", "thread", "comActivation", "unknown", "socketIo", "smbIo" };
    static readonly string[] WctStatus = { null, "noAccess", "running", "blocked", "pidOnly", "pidOnlyRpcss", "owned",
                                           "notOwned", "abandoned", "unknown", "error" };
    const int NodeSize = 280, MaxNodes = 16;    // sizeof(WAITCHAIN_NODE_INFO), WCT_MAX_NODE_COUNT

    static List<uint> ThreadsOf(uint pid, out string why) {
      why = null;
      var l = new List<uint>();
      IntPtr snap = N.CreateToolhelp32Snapshot(0x4, 0);    // TH32CS_SNAPTHREAD
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) { why = "Windows did not list the threads (error " + Marshal.GetLastWin32Error() + ")"; return null; }
      try {
        var te = new N.THREADENTRY32(); te.dwSize = (uint)Marshal.SizeOf(typeof(N.THREADENTRY32));
        if (!N.Thread32First(snap, ref te)) return l;
        do { if (te.th32OwnerProcessID == pid) l.Add(te.th32ThreadID); te.dwSize = (uint)Marshal.SizeOf(typeof(N.THREADENTRY32)); }
        while (N.Thread32Next(snap, ref te));
      } finally { N.CloseHandle(snap); }
      return l;
    }

    static string WaitChain(Dictionary<string, object> req, ref object result) {
      var r = NewReply(false); result = r;
      r.Remove("dryRun");
      Target t = Open(req, 0, r, "analyze this process's wait chain", TaskMgr.GUARD_READ, null);
      if (t == null) return null;
      IntPtr wct = IntPtr.Zero, buf = IntPtr.Zero;
      try {
        string why;
        List<uint> tids = ThreadsOf(t.Pid, out why);
        if (tids == null) { Fail(r, why); return null; }
        wct = N.OpenThreadWaitChainSession(0, IntPtr.Zero);   // synchronous session
        if (wct == IntPtr.Zero) { Fail(r, "Windows did not open a wait chain session (error " + Marshal.GetLastWin32Error() + ")"); return null; }
        buf = Marshal.AllocHGlobal(NodeSize * MaxNodes);
        var threads = new List<object>();
        int denied = 0, blocked = 0, failed = 0, cycles = 0;
        int cap = Math.Min(tids.Count, 512);
        for (int i = 0; i < cap; i++) {
          uint tid = tids[i];
          uint count = MaxNodes; int cyc;
          var th = new Dictionary<string, object>();
          th["tid"] = tid;
          // WCT_OUT_OF_PROC_FLAG | WCT_OUT_OF_PROC_CS_FLAG (COM needs a registered callback; not asked).
          if (!N.GetThreadWaitChain(wct, IntPtr.Zero, 0x1 | 0x4, tid, ref count, buf, out cyc)) {
            int e = Marshal.GetLastWin32Error();
            if (e == 5) denied++;
            failed++;
            th["chain"] = new List<object>(); th["deadlock"] = false;
            th["error"] = e == 5 ? "access denied" : e == 87 ? "the thread ended" : "error " + e;
            threads.Add(th);
            continue;
          }
          var chain = new List<object>();
          for (int n = 0; n < (int)count && n < MaxNodes; n++) {
            IntPtr node = new IntPtr(buf.ToInt64() + n * NodeSize);
            int type = Marshal.ReadInt32(node, 0), status = Marshal.ReadInt32(node, 4);
            var nd = new Dictionary<string, object>();
            nd["type"] = type > 0 && type < WctTypes.Length ? WctTypes[type] : "type" + type;
            nd["status"] = status > 0 && status < WctStatus.Length ? WctStatus[status] : "status" + status;
            if (type == 8) {   // WctThreadType: ThreadObject {ProcessId, ThreadId, WaitTime, ContextSwitches}
              nd["pid"] = (uint)Marshal.ReadInt32(node, 8);
              nd["tid"] = (uint)Marshal.ReadInt32(node, 12);
              nd["waitTime"] = (uint)Marshal.ReadInt32(node, 16);
            } else {           // LockObject {ObjectName[128], Timeout, Alertable}
              string name = Marshal.PtrToStringUni(new IntPtr(node.ToInt64() + 8), 128);
              int z = name.IndexOf('\0'); if (z >= 0) name = name.Substring(0, z);
              if (name.Length > 0) nd["name"] = name;
            }
            chain.Add(nd);
          }
          bool isBlocked = chain.Count > 1 || (chain.Count == 1 && (string)((Dictionary<string, object>)chain[0])["status"] == "blocked");
          if (isBlocked) blocked++;
          if (cyc != 0) cycles++;
          th["chain"] = chain; th["deadlock"] = cyc != 0; th["waiting"] = isBlocked;
          threads.Add(th);
        }
        r["threads"] = threads;
        r["threadCount"] = tids.Count;
        r["truncated"] = tids.Count > cap;
        r["blocked"] = blocked; r["deadlocks"] = cycles;
        if (cap > 0 && denied == cap) { r["needsAdmin"] = true; Fail(r, "access denied: Windows needs administrator rights to analyze this process's wait chain"); return null; }
        if (cap > 0 && failed == cap) { Fail(r, "Windows answered no thread's wait chain"); return null; }
        r["ok"] = true;
        return null;
      } finally {
        if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        if (wct != IntPtr.Zero) N.CloseThreadWaitChainSession(wct);
        Close(t);
      }
    }

    // ------------------------------------------------------------------ UAC virtualization

    static string UacVirt(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      if (!Json.HasKey(req, "on")) { Fail(r, "needs on: true or false"); return null; }
      bool on = Json.GetBool(req, "on", false);
      r["on"] = on;
      Target t = Open(req, 0, r, "change UAC virtualization for this process", TaskMgr.GUARD_USER, "uacvirt");
      if (t == null) return null;
      IntPtr tok = IntPtr.Zero;
      try {
        if (!N.OpenProcessToken(t.H, TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out tok)) { tok = IntPtr.Zero; ApiFail(r, Marshal.GetLastWin32Error(), "change UAC virtualization for this process"); return null; }
        uint allowed, enabled; int ret;
        if (!N.GetTokenInformation(tok, TokenVirtualizationAllowed, out allowed, 4, out ret)) { ApiFail(r, Marshal.GetLastWin32Error(), "read UAC virtualization for this process"); return null; }
        if (!N.GetTokenInformation(tok, TokenVirtualizationEnabled, out enabled, 4, out ret)) { ApiFail(r, Marshal.GetLastWin32Error(), "read UAC virtualization for this process"); return null; }
        r["allowed"] = allowed != 0;
        r["before"] = allowed == 0 ? "Not allowed" : enabled != 0 ? "Enabled" : "Disabled";
        if (allowed == 0) { r["state"] = "Not allowed"; Fail(r, "Not allowed: Windows does not allow UAC virtualization for this process"); return null; }
        if (dry) { r["ok"] = true; r["state"] = r["before"]; return null; }
        uint v = on ? 1u : 0u;
        if (!N.SetTokenInformation(tok, TokenVirtualizationEnabled, ref v, 4)) { ApiFail(r, Marshal.GetLastWin32Error(), "change UAC virtualization for this process"); return null; }
        uint now;
        if (!N.GetTokenInformation(tok, TokenVirtualizationEnabled, out now, 4, out ret)) { ApiFail(r, Marshal.GetLastWin32Error(), "read UAC virtualization back"); return null; }
        r["state"] = now != 0 ? "Enabled" : "Disabled";
        if ((now != 0) == on) r["ok"] = true;
        else Fail(r, "Windows accepted the change but reads back " + (string)r["state"]);
        return null;
      } finally { if (tok != IntPtr.Zero) N.CloseHandle(tok); Close(t); }
    }

    // ------------------------------------------------------------------ Restart (Windows Explorer)

    static string ImageOf(IntPtr h) {
      var sb = new StringBuilder(1024);
      uint size = (uint)sb.Capacity;
      return N.QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
    }

    /// Explorer of THIS session started after `since` (FILETIME) whose path is `exe`, or 0.
    static uint NewShell(uint session, long since, string exe, HashSet<uint> ended) {
      IntPtr sw = N.GetShellWindow();
      if (sw != IntPtr.Zero) { uint sp; N.GetWindowThreadProcessId(sw, out sp); if (sp != 0 && !ended.Contains(sp)) return sp; }
      string why;
      List<TaskMgr.Proc> table = TaskMgr.ReadProcs(out why);
      if (table == null) return 0;
      foreach (TaskMgr.Proc p in table)
        if (p.Session == session && p.Created > since && !ended.Contains(p.Pid) &&
            string.Equals(p.File, "explorer.exe", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(TaskMgr.PathOf(p.Pid), exe, StringComparison.OrdinalIgnoreCase)) return p.Pid;
      return 0;
    }

    static string RestartExplorer(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      string exe = Path.Combine(win, "explorer.exe");
      string why;
      List<TaskMgr.Proc> table = TaskMgr.ReadProcs(out why);
      if (table == null) { Fail(r, why); return null; }
      uint own = OwnPid, parent = ParentPid, session;
      if (!N.ProcessIdToSessionId(own, out session)) { Fail(r, "Windows did not say which session Mantle runs in (error " + Marshal.GetLastWin32Error() + ")"); return null; }
      uint shellPid = 0;
      IntPtr sw = N.GetShellWindow();
      if (sw != IntPtr.Zero) N.GetWindowThreadProcessId(sw, out shellPid);
      var held = new List<IntPtr>();
      var pids = new List<object>();
      var skipped = new List<object>();
      var ended = new HashSet<uint>();
      bool denied = false;
      try {
        foreach (TaskMgr.Proc p in table) {
          if (!string.Equals(p.File, "explorer.exe", StringComparison.OrdinalIgnoreCase)) continue;
          if (p.Session != session) { skipped.Add(Json.Obj("pid", p.Pid, "why", "another session (another signed-in user)")); continue; }
          if (p.Pid == own || (parent > 0 && p.Pid == parent)) { skipped.Add(Json.Obj("pid", p.Pid, "why", "Mantle itself")); continue; }
          IntPtr h = N.OpenProcess(PROCESS_TERMINATE | TaskMgr.QUERY_LIMITED | TaskMgr.SYNCHRONIZE, false, p.Pid);
          if (h == IntPtr.Zero) {
            int e = Marshal.GetLastWin32Error();
            if (e == 5) denied = true;
            skipped.Add(Json.Obj("pid", p.Pid, "why", e == 5 ? "access denied" : "Windows would not open it (error " + e + ")"));
            continue;
          }
          long c, x, k, u; uint code;
          string img = ImageOf(h);
          if (!N.GetProcessTimes(h, out c, out x, out k, out u) || c != p.Created || !N.GetExitCodeProcess(h, out code) || code != TaskMgr.STILL_ACTIVE) {
            N.CloseHandle(h); skipped.Add(Json.Obj("pid", p.Pid, "why", "it exited or its pid was reused while Mantle was checking it")); continue;
          }
          if (!string.Equals(img, exe, StringComparison.OrdinalIgnoreCase)) {
            N.CloseHandle(h); skipped.Add(Json.Obj("pid", p.Pid, "why", "not " + exe + " (a different program with the same name)")); continue;
          }
          held.Add(h); ended.Add(p.Pid);
          pids.Add(Json.Obj("pid", p.Pid, "created", TaskMgr.Str(p.Created), "shell", p.Pid == shellPid));
        }
        r["pids"] = pids; r["skipped"] = skipped; r["shellPid"] = shellPid == 0 ? null : (object)shellPid; r["exe"] = exe;
        var steps = new List<object>();
        foreach (object o in pids) steps.Add("end explorer.exe pid " + ((IDictionary)o)["pid"] + " (TerminateProcess, exit code 1), holding its handle");
        steps.Add("wait up to 5 s for them to exit and for Windows (winlogon) to start a new shell by itself");
        steps.Add("if no new Explorer of this session appeared by then, start " + exe + " once");
        r["steps"] = steps;
        if (pids.Count == 0) {
          if (denied) { r["needsAdmin"] = true; Fail(r, "access denied: Windows needs administrator rights to end Windows Explorer here"); }
          else Fail(r, "no Windows Explorer of this session is running (" + exe + ")");
          return null;
        }
        if (dry) {
          r["ok"] = true;
          if (denied) r["note"] = "some Explorer processes of this session would be skipped: access denied";
          return null;
        }
        // REAL: never run by a test (passive refuses above).
        long killedAt = DateTime.UtcNow.ToFileTimeUtc();
        var ends = new List<object>();
        for (int i = 0; i < held.Count; i++) {
          bool ok = N.TerminateProcess(held[i], 1);
          ends.Add(Json.Obj("pid", ((IDictionary)pids[i])["pid"], "ended", ok, "error", ok ? 0 : Marshal.GetLastWin32Error()));
        }
        r["ends"] = ends;
        var sw5 = Stopwatch.StartNew();
        foreach (IntPtr h in held) {
          long left = 5000 - sw5.ElapsedMilliseconds;
          if (left > 0) N.WaitForSingleObject(h, (uint)left);
        }
        uint back = 0;
        while (back == 0 && sw5.ElapsedMilliseconds < 5000) {
          back = NewShell(session, killedAt, exe, ended);
          if (back == 0) Thread.Sleep(250);
        }
        if (back == 0) back = NewShell(session, killedAt, exe, ended);
        if (back != 0) { r["restartedBy"] = "windows"; r["newPid"] = back; r["ok"] = true; return null; }
        try {
          var psi = new ProcessStartInfo(exe); psi.UseShellExecute = false; psi.WorkingDirectory = win;
          using (Process np = Process.Start(psi)) { r["newPid"] = np == null ? null : (object)np.Id; }
          r["restartedBy"] = "mantle"; r["ok"] = true;
        } catch (Exception ex) {
          Fail(r, "Explorer was ended but Mantle could not start it again (" + ex.GetType().Name + "); press Ctrl+Shift+Esc > Run new task > explorer");
        }
        return null;
      } finally { foreach (IntPtr h in held) N.CloseHandle(h); }
    }

    // ------------------------------------------------------------------ Run new task

    static readonly string[] Schemes = { "http:", "https:", "ftp:", "mailto:", "shell:", "ms-settings:", "file:" };

    /// Resolve a bare name the way ShellExecute does: the Windows folder, System32, PATH (with PATHEXT
    /// when there is no extension), then the App Paths key. A rooted path: it exists (PATHEXT tried too).
    static bool Resolve(string name, out string full, out string kind) {
      full = null; kind = null;
      if (string.IsNullOrEmpty(name)) return false;
      var exts = new List<string>();
      if (Path.HasExtension(name)) exts.Add("");
      foreach (string e in (Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").Split(';'))
        if (e.Trim().Length > 0) exts.Add(e.Trim());
      bool hasSep = name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0;
      try {
        if (hasSep) {
          if (!Path.IsPathRooted(name)) return false;
          if (Directory.Exists(name)) { full = Path.GetFullPath(name); kind = "folder"; return true; }
          foreach (string e in exts) if (File.Exists(name + e)) { full = Path.GetFullPath(name + e); kind = "file"; return true; }
          return false;
        }
        var dirs = new List<string>();
        string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        dirs.Add(win); dirs.Add(Path.Combine(win, "System32"));
        foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
          string dd = Environment.ExpandEnvironmentVariables(d.Trim().Trim('"'));
          if (dd.Length > 0) dirs.Add(dd);
        }
        foreach (string d in dirs)
          foreach (string e in exts) {
            string c;
            try { c = Path.Combine(d, name + e); } catch (ArgumentException) { continue; }
            if (File.Exists(c)) { full = c; kind = "file"; return true; }
          }
        string key = Path.HasExtension(name) ? name : name + ".exe";
        foreach (RegistryKey root in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
          using (RegistryKey k = root.OpenSubKey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + key)) {
            if (k == null) continue;
            string v = k.GetValue("") as string;
            if (string.IsNullOrEmpty(v)) continue;
            v = Environment.ExpandEnvironmentVariables(v).Trim().Trim('"');
            if (File.Exists(v)) { full = v; kind = "file"; return true; }
          }
        }
        if (Directory.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), name))) {
          full = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), name); kind = "folder"; return true;
        }
      } catch (Exception) { return false; }
      return false;
    }

    /// The Run dialog's split: env vars expanded; a quoted file; a URL or shell: name; else the LONGEST
    /// space-separated prefix that is an existing path (C:\Program Files\x\y.exe -a works unquoted), else
    /// the first word.
    internal static void SplitCmd(string cmd, out string file, out string args, out bool resolved, out string full, out string kind) {
      string s = Environment.ExpandEnvironmentVariables((cmd ?? "").Trim());
      file = s; args = ""; resolved = false; full = null; kind = null;
      if (s.StartsWith("\"", StringComparison.Ordinal)) {
        int q = s.IndexOf('"', 1);
        file = q < 0 ? s.Substring(1) : s.Substring(1, q - 1);
        args = q < 0 ? "" : s.Substring(q + 1).Trim();
        resolved = Resolve(file, out full, out kind);
        return;
      }
      int colon = s.IndexOf(':');
      foreach (string sc in Schemes)
        if (s.StartsWith(sc, StringComparison.OrdinalIgnoreCase) || (colon > 1 && s.IndexOf("://", StringComparison.Ordinal) == colon)) {
          int sp = s.IndexOf(' ');
          file = sp < 0 ? s : s.Substring(0, sp); args = sp < 0 ? "" : s.Substring(sp + 1).Trim();
          kind = "url";
          string scheme = file.Substring(0, Math.Max(0, file.IndexOf(':')));
          using (RegistryKey k = scheme.Length > 0 ? Registry.ClassesRoot.OpenSubKey(scheme) : null) resolved = k != null || sc == "shell:";
          full = resolved ? file : null;
          return;
        }
      string[] parts = s.Split(' ');
      for (int n = parts.Length; n >= 1; n--) {
        string cand = string.Join(" ", parts, 0, n);
        if (n > 1 && cand.IndexOf('\\') < 0 && cand.IndexOf('/') < 0) continue;   // only a path may hold spaces
        string f, k;
        if (Resolve(cand, out f, out k)) {
          file = cand; args = n < parts.Length ? string.Join(" ", parts, n, parts.Length - n).Trim() : "";
          resolved = true; full = f; kind = k;
          return;
        }
      }
      file = parts[0]; args = parts.Length > 1 ? string.Join(" ", parts, 1, parts.Length - 1).Trim() : "";
    }

    /// COM-using shell calls on a short-lived STA thread (ShellExecuteEx and SHObjectProperties want one).
    static void OnSta(ThreadStart work) {
      var th = new Thread(work);
      th.SetApartmentState(ApartmentState.STA);
      th.IsBackground = true;
      th.Start();
      th.Join();
    }

    static string RunTask(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      // `line`, not `cmd`: on the sidecar wire `cmd` IS the command name (lib's runTask {cmd} maps to {line}).
      string cmd = Json.GetString(req, "line") ?? Json.GetString(req, "command");
      if (string.IsNullOrEmpty(cmd) || cmd.Trim().Length == 0) { Fail(r, "type the name of a program, folder, document or internet resource"); return null; }
      bool admin = Json.GetBool(req, "admin", false);
      string file, args, full, kind; bool resolved;
      SplitCmd(cmd, out file, out args, out resolved, out full, out kind);
      string verb = admin ? "runas" : "open";
      string dir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      r["file"] = file; r["args"] = args; r["verb"] = verb; r["resolved"] = resolved; r["resolvedPath"] = full; r["kind"] = kind; r["directory"] = dir;
      if (dry) {
        r["ok"] = true;
        if (!resolved) r["note"] = "Mantle did not find it; Windows would still try (it may answer that it cannot find it)";
        return null;
      }
      bool ok = false; int e = 0; uint newPid = 0;
      OnSta(delegate {
        var sei = new N.SHELLEXECUTEINFO();
        sei.cbSize = Marshal.SizeOf(typeof(N.SHELLEXECUTEINFO));
        sei.fMask = 0x40 | 0x100 | 0x400;   // NOCLOSEPROCESS | NOASYNC | FLAG_NO_UI (the reason goes back to the window)
        sei.lpVerb = verb; sei.lpFile = file; sei.lpParameters = args.Length > 0 ? args : null; sei.lpDirectory = dir; sei.nShow = 1;
        ok = N.ShellExecuteExW(ref sei);
        if (!ok) e = Marshal.GetLastWin32Error();
        if (sei.hProcess != IntPtr.Zero) { newPid = N.GetProcessId(sei.hProcess); N.CloseHandle(sei.hProcess); }
      });
      if (ok) { r["ok"] = true; r["newPid"] = newPid == 0 ? null : (object)newPid; return null; }
      if (e == 1223) Fail(r, "the administrator prompt was cancelled");
      else if (e == 2 || e == 3 || (e == 1155 && !resolved)) Fail(r, "Windows cannot find '" + file + "'. Make sure you typed the name correctly, and then try again.");
      else if (e == 1155) Fail(r, "no app is set to open this kind of file");
      else if (e == 5) { r["needsAdmin"] = true; Fail(r, "access denied: Windows needs administrator rights to open it; tick 'Create this task with administrative privileges'"); }
      else Fail(r, "Windows could not start it (error " + e + ")");
      return null;
    }

    // ------------------------------------------------------------------ Properties

    static string Properties(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && Passive) return Refusal;
      var r = NewReply(dry); result = r;
      string path = Json.GetString(req, "path");
      r["path"] = path;
      bool exists = false;
      try { exists = !string.IsNullOrEmpty(path) && Path.IsPathRooted(path) && File.Exists(path); } catch (Exception) { exists = false; }
      if (!exists) { Fail(r, string.IsNullOrEmpty(path) ? "needs path: the file's full path" : "refused: that is not an existing file (it may have moved, or Windows did not let Mantle read its path)"); return null; }
      if (dry) { r["ok"] = true; r["would"] = "SHObjectProperties(SHOP_FILEPATH) on the path"; return null; }
      bool ok = false; int e = 0;
      OnSta(delegate { ok = N.SHObjectProperties(IntPtr.Zero, 0x2, path, null); if (!ok) e = Marshal.GetLastWin32Error(); });
      if (ok) r["ok"] = true;
      else Fail(r, "Windows did not open the Properties sheet (error " + e + ")");
      return null;
    }
  }
}
