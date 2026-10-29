// ProcDetails.cs - Task Manager's Details page and the Processes page's extra columns, read only
// (lane tm-details, 2026-10-28). The contract is TM-SPEC.md, sections Details and Processes.
//
//   taskmgr.details {}                         one row per process, every Select-columns field Windows
//                                              lets a non-administrator read; asked each tick ONLY while
//                                              the Details page is visible.
//   taskmgr.procextra {procs:[{pid, created}]} per pid: publisher, command line, Efficiency mode; asked each
//                                              tick for the Processes page, so it is cheap (one table read,
//                                              cached facts, one handle per readable pid).
//
// WHERE EACH NUMBER COMES FROM
//   One NtQuerySystemInformation(SystemProcessInformation) read, NO handle, gives every counter: x64
//   SYSTEM_PROCESS_INFORMATION offsets NextEntryOffset 0x00, NumberOfThreads 0x04, WorkingSetPrivateSize
//   0x08, CycleTime 0x18, CreateTime 0x20, UserTime 0x28, KernelTime 0x30, ImageName 0x38/0x40,
//   BasePriority 0x48, UniqueProcessId 0x50, HandleCount 0x60, SessionId 0x64, PageFaultCount 0x80,
//   PeakWorkingSetSize 0x88, WorkingSetSize 0x90, QuotaPagedPoolUsage 0xA0, QuotaNonPagedPoolUsage 0xB0,
//   PagefileUsage 0xB8 (= Commit size, PrivateUsage), Read/Write/OtherOperationCount 0xD0/0xD8/0xE0,
//   Read/Write/OtherTransferCount 0xE8/0xF0/0xF8; the SYSTEM_THREAD_INFORMATION array at 0x100 (stride
//   0x50, ThreadState 0x44, WaitReason 0x48) gives "Suspended" (every thread waits for reason Suspended).
//   Only the rest needs OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION), and every handle is checked
//   against the table's creation time before anything read through it is believed:
//     per tick   GetGuiResources (User / GDI objects), GetPriorityClass, ProcessPowerThrottling (Efficiency
//                mode, Power throttling), the token's TokenVirtualizationEnabled (UAC virtualization)
//     once per process run (cached pid|created): token user (LookupAccountSid, cached per SID), elevation,
//                virtualization allowed, image path, command line (ProcessCommandLineInformation), machine
//                (ProcessMachineTypeInfo; IsWow64Process2 fallback), package full name, DEP, user shadow stack
//                mitigation, enterprise (EdpGetContextForProcess)
//     once per exe path: FileVersionInfo (Description, Publisher = CompanyName), the embedded manifest's
//                supportedOS ids (Operating system context), the PE header's machine
//   A process Windows will not open (error 5: services, SYSTEM, elevated): its counters still come from the
//   table, its image path from SystemProcessIdInformation (class 88, no handle; kept only when its file
//   name matches the table's), its description/publisher/OS context/architecture from that file, and every
//   other field is null with needsAdmin:true, a plain-words `why` and `unread` (the fields it covers), so
//   the page can re-read those rows through the elevated helper.
//   Never computed here: CPU %, working set delta, PF delta (lib/features/_taskmgr-details.js does them from
//   two samples), Job object ID and Power usage (see fieldWhy below: no honest non-administrator source).
//
// SECOND HOST: the elevated helper compiles this file again. Outside dependencies, all of them:
//   Json (Obj, TryGet, GetInt, GetString)       sidecar/Json.cs
//   FeatureTable, Lanes.Slow, [MantleFeature]   sidecar/Features.cs + Lanes.cs, used ONLY in Register
//   Nothing from Program.*, TaskMgr.* or Win32.*: every P/Invoke is declared below (class D). Nothing here
//   writes to a process, so there is no passive-mode refusal to make.
// Never logged: names, paths, command lines (replies only, to the window). C# 5 (build.ps1).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class ProcDetails {
    public static void Register(FeatureTable t) {
      t.Add("taskmgr.details", Lanes.Slow, Details);      // {} -> {t, cpus, rows:[...], fieldWhy, ms, ...}
      t.Add("taskmgr.procextra", Lanes.Slow, ProcExtra);  // {procs:[{pid, created}]} -> {rows, skipped, power:null, powerWhy, ms}
    }

    static class D {
      [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
      [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetPriorityClass(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessInformation(IntPtr h, int cls, IntPtr buf, int size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsWow64Process2(IntPtr h, out ushort processMachine, out ushort nativeMachine);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessMitigationPolicy(IntPtr h, int policy, IntPtr buf, IntPtr size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessDEPPolicy(IntPtr h, out uint flags, out bool permanent);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetPackageFullName(IntPtr h, ref uint len, StringBuilder name);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint QueryDosDeviceW(string device, StringBuilder target, int max);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
      [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr h);
      [DllImport("kernel32.dll")] public static extern IntPtr FindResourceW(IntPtr h, IntPtr name, IntPtr type);
      [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr h, IntPtr res);
      [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr data);
      [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr h, IntPtr res);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
      [DllImport("advapi32.dll")] public static extern int GetLengthSid(IntPtr sid);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool LookupAccountSidW(string sys, IntPtr sid, StringBuilder name, ref int nameLen, StringBuilder domain, ref int domainLen, out int use);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
      [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
      [DllImport("kernel32.dll")] public static extern void SetLastError(uint e);
      [DllImport("user32.dll", SetLastError = true)] public static extern uint GetGuiResources(IntPtr h, uint flags);
      [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
      [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
      [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);
      [DllImport("edputil.dll")] public static extern int EdpGetContextForProcess(uint pid, out IntPtr ctx);
      [DllImport("edputil.dll")] public static extern void EdpFreeContext(IntPtr ctx);
      public delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
    }

    const uint QUERY_LIMITED = 0x1000, TOKEN_QUERY = 0x0008;
    const int ERROR_ACCESS_DENIED = 5;

    // ------------------------------------------------------------------ one table read

    sealed class Rec {
      public uint Pid; public long Created, Cpu, Cycles, Ws, WsPeak, Pws, Commit, Paged, NonPaged;
      public long IoR, IoW, IoO, IoRB, IoWB, IoOB; public int Threads, Handles, BasePri; public uint Session, Faults;
      public string Name; public bool Suspended;
    }

    static readonly object _gate = new object();
    static IntPtr _buf = IntPtr.Zero;
    static int _len = 1 << 20;
    static IntPtr _scratch = IntPtr.Zero;     // 4 KB for token / process information reads (under _gate)

    static List<Rec> ReadTable(out string why) {
      why = null;
      if (IntPtr.Size != 8) { why = "the process table is read with x64 offsets and this sidecar is 32-bit"; return null; }
      int ret = 0, st = 0;
      for (int tries = 0; tries < 5; tries++) {
        if (_buf == IntPtr.Zero) _buf = Marshal.AllocHGlobal(_len);
        st = D.NtQuerySystemInformation(5, _buf, _len, out ret);
        if (st != unchecked((int)0xC0000004)) break;   // STATUS_INFO_LENGTH_MISMATCH: grow and retry
        Marshal.FreeHGlobal(_buf); _buf = IntPtr.Zero; _len = Math.Max(_len * 2, ret + 65536);
      }
      if (st != 0) { why = "Windows did not hand over the process table (NTSTATUS 0x" + st.ToString("X8") + ")"; return null; }
      var list = new List<Rec>(400);
      long off = 0;
      while (true) {
        IntPtr p = new IntPtr(_buf.ToInt64() + off);
        var r = new Rec();
        r.Pid = (uint)Marshal.ReadInt64(p, 0x50);
        r.Threads = Marshal.ReadInt32(p, 0x04);
        r.Pws = Marshal.ReadInt64(p, 0x08);
        r.Cycles = Marshal.ReadInt64(p, 0x18);
        r.Created = Marshal.ReadInt64(p, 0x20);
        r.Cpu = Marshal.ReadInt64(p, 0x28) + Marshal.ReadInt64(p, 0x30);
        int len = Marshal.ReadInt16(p, 0x38) & 0xFFFF;
        IntPtr nb = Marshal.ReadIntPtr(p, 0x40);
        r.Name = r.Pid == 0 ? "System Idle Process" : nb == IntPtr.Zero ? "System" : Marshal.PtrToStringUni(nb, len / 2);
        r.BasePri = Marshal.ReadInt32(p, 0x48);
        r.Handles = Marshal.ReadInt32(p, 0x60);
        r.Session = (uint)Marshal.ReadInt32(p, 0x64);
        r.Faults = (uint)Marshal.ReadInt32(p, 0x80);
        r.WsPeak = Marshal.ReadInt64(p, 0x88);
        r.Ws = Marshal.ReadInt64(p, 0x90);
        r.Paged = Marshal.ReadInt64(p, 0xA0);
        r.NonPaged = Marshal.ReadInt64(p, 0xB0);
        r.Commit = Marshal.ReadInt64(p, 0xB8);
        r.IoR = Marshal.ReadInt64(p, 0xD0); r.IoW = Marshal.ReadInt64(p, 0xD8); r.IoO = Marshal.ReadInt64(p, 0xE0);
        r.IoRB = Marshal.ReadInt64(p, 0xE8); r.IoWB = Marshal.ReadInt64(p, 0xF0); r.IoOB = Marshal.ReadInt64(p, 0xF8);
        if (r.Threads > 0 && r.Pid > 4) {
          bool all = true;
          for (int ti = 0; ti < r.Threads && all; ti++) {
            IntPtr th = new IntPtr(p.ToInt64() + 0x100 + ti * 0x50);
            if (Marshal.ReadInt32(th, 0x44) != 5 || Marshal.ReadInt32(th, 0x48) != 5) all = false;
          }
          r.Suspended = all;
        }
        list.Add(r);
        int next = Marshal.ReadInt32(p, 0);
        if (next == 0) break;
        off += next;
      }
      return list;
    }

    static string Key(uint pid, long created) { return pid.ToString(CultureInfo.InvariantCulture) + "|" + created.ToString(CultureInfo.InvariantCulture); }
    static string Str(long v) { return v.ToString(CultureInfo.InvariantCulture); }

    // ------------------------------------------------------------------ facts that never change while a process runs

    sealed class Fixed {
      public bool Basic, Full;            // Basic: path, command line, publisher. Full: everything else.
      public bool Denied; public int OpenErr;
      public string Path, Cmdline, User, UserFull, Arch, Platform, Package, Dep, Shadow, Enterprise;
      public bool? Elevated; public bool? UacAllowed;
      public string TokenWhy, CmdWhy, EdpWhy, DepWhy;
      public int DepErr;
      public int TokenErr;
    }

    sealed class FileFacts { public string Path, Desc, Publisher, OsCtx, OsWhy; public ushort Machine; public bool Image; }

    static readonly Dictionary<string, Fixed> _fixed = new Dictionary<string, Fixed>(StringComparer.Ordinal);
    static readonly Dictionary<string, FileFacts> _files = new Dictionary<string, FileFacts>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, string[]> _sids = new Dictionary<string, string[]>(StringComparer.Ordinal);
    static Dictionary<string, string> _dos;   // \Device\HarddiskVolume3 -> C:
    static bool _edpMissing;
    static string[] _system;                  // localized SYSTEM account (S-1-5-18): {name, domain}

    static Fixed FixedOf(Rec r) {
      string k = Key(r.Pid, r.Created);
      Fixed f;
      if (!_fixed.TryGetValue(k, out f)) _fixed[k] = f = new Fixed();
      return f;
    }

    static void Prune(List<Rec> table) {
      if (_fixed.Count <= table.Count + 64) return;
      var live = new HashSet<string>(StringComparer.Ordinal);
      foreach (Rec r in table) live.Add(Key(r.Pid, r.Created));
      var dead = new List<string>();
      foreach (string k in _fixed.Keys) if (!live.Contains(k)) dead.Add(k);
      foreach (string k in dead) _fixed.Remove(k);
      if (_files.Count > 3000) _files.Clear();
      if (_sids.Count > 500) _sids.Clear();
    }

    /// A QUERY_LIMITED handle whose process has the table's creation time, or Zero (+ err: the Win32 error,
    /// or -1 = the pid now belongs to another process). Processes already refused are not asked again.
    static IntPtr Open(Rec r, Fixed f, out int err) {
      err = 0;
      if (r.Pid == 0) { err = 0; return IntPtr.Zero; }      // the Idle process is no program: nothing to open
      if (f.Denied) { err = f.OpenErr; return IntPtr.Zero; }
      IntPtr h = D.OpenProcess(QUERY_LIMITED, false, r.Pid);
      if (h == IntPtr.Zero) {
        err = Marshal.GetLastWin32Error();
        if (err == ERROR_ACCESS_DENIED) { f.Denied = true; f.OpenErr = err; }
        return IntPtr.Zero;
      }
      long c, x, kt, ut;
      if (!D.GetProcessTimes(h, out c, out x, out kt, out ut) || c != r.Created) { D.CloseHandle(h); err = -1; return IntPtr.Zero; }
      return h;
    }

    /// Facts are cached only when they were really read, or when Windows refused for good (access denied):
    /// a transient failure (it ended, the pid changed hands) is tried again next tick.
    static bool Settled(Rec r, Fixed f, IntPtr h) { return h != IntPtr.Zero || f.Denied || r.Pid == 0; }

    static void FillBasic(Rec r, Fixed f, IntPtr h) {
      if (f.Basic || !Settled(r, f, h)) return;
      f.Basic = true;
      if (h != IntPtr.Zero) {
        var sb = new StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        if (D.QueryFullProcessImageNameW(h, 0, sb, ref size)) f.Path = sb.ToString(0, (int)size);
        f.Cmdline = CmdlineOf(h, out f.CmdWhy);
      } else {
        f.CmdWhy = null;
      }
      if (f.Path == null && r.Pid > 4) f.Path = PathById(r);
    }

    static string CmdlineOf(IntPtr h, out string why) {
      why = null;
      int len = 8192, ret;
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        int st = D.NtQueryInformationProcess(h, 60, buf, len, out ret);   // ProcessCommandLineInformation
        if (st == unchecked((int)0xC0000004) && ret > len && ret < (1 << 20)) {
          Marshal.FreeHGlobal(buf); len = ret; buf = Marshal.AllocHGlobal(len);
          st = D.NtQueryInformationProcess(h, 60, buf, len, out ret);
        }
        if (st != 0) { why = "Windows did not give its command line (NTSTATUS 0x" + st.ToString("X8") + ")"; return null; }
        int n = Marshal.ReadInt16(buf, 0) & 0xFFFF;
        IntPtr s = Marshal.ReadIntPtr(buf, IntPtr.Size);
        return s != IntPtr.Zero && n > 0 ? Marshal.PtrToStringUni(s, n / 2) : "";
      } finally { Marshal.FreeHGlobal(buf); }
    }

    /// SystemProcessIdInformation (88): the image's NT path for any pid, no handle. Kept only when its file
    /// name is the table's name for that pid (a pid reused between the two reads is not believed).
    static string PathById(Rec r) {
      int cap = 1024;
      for (int tries = 0; tries < 2; tries++) {
        IntPtr nb = Marshal.AllocHGlobal(cap);
        IntPtr q = Marshal.AllocHGlobal(24);
        try {
          Marshal.WriteInt64(q, 0, r.Pid); Marshal.WriteInt16(q, 8, 0); Marshal.WriteInt16(q, 10, (short)cap); Marshal.WriteInt64(q, 16, nb.ToInt64());
          int ret;
          int st = D.NtQuerySystemInformation(88, q, 24, out ret);
          if (st == unchecked((int)0xC0000004)) { int want = Marshal.ReadInt16(q, 10) & 0xFFFF; if (want > cap) { cap = want; continue; } return null; }
          if (st != 0) return null;
          int n = Marshal.ReadInt16(q, 8) & 0xFFFF;
          if (n == 0) return null;
          string nt = Marshal.PtrToStringUni(nb, n / 2);
          string dos = DosPath(nt);
          if (dos == null) return null;
          return string.Equals(System.IO.Path.GetFileName(dos), r.Name, StringComparison.OrdinalIgnoreCase) ? dos : null;
        } finally { Marshal.FreeHGlobal(nb); Marshal.FreeHGlobal(q); }
      }
      return null;
    }

    static string DosPath(string nt) {
      if (!nt.StartsWith("\\Device\\", StringComparison.OrdinalIgnoreCase)) return null;
      for (int pass = 0; pass < 2; pass++) {
        if (_dos == null || pass == 1) {
          _dos = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
          var sb = new StringBuilder(512);
          for (char c = 'A'; c <= 'Z'; c++) {
            string drive = c + ":";
            if (D.QueryDosDeviceW(drive, sb, sb.Capacity) != 0) { string dev = sb.ToString(); if (!_dos.ContainsKey(dev)) _dos[dev] = drive; }
          }
        }
        foreach (KeyValuePair<string, string> kv in _dos) {
          if (nt.Length > kv.Key.Length && nt[kv.Key.Length] == '\\' && nt.StartsWith(kv.Key, StringComparison.OrdinalIgnoreCase))
            return kv.Value + nt.Substring(kv.Key.Length);
        }
      }
      return null;
    }

    /// The Details page's per-exe extras (manifest OS context, PE machine), read once per path on first need;
    /// the Processes page (procextra) never pays for them.
    static FileFacts ImageOf(string path) {
      FileFacts ff = FileOf(path);
      if (ff == null || ff.Image) return ff;
      ff.Image = true;
      ff.OsCtx = OsContextOf(ff.Path, out ff.OsWhy);
      ff.Machine = PeMachine(ff.Path);
      return ff;
    }

    static FileFacts FileOf(string path) {
      if (string.IsNullOrEmpty(path)) return null;
      FileFacts ff;
      if (_files.TryGetValue(path, out ff)) return ff;
      ff = new FileFacts();
      try {
        FileVersionInfo v = FileVersionInfo.GetVersionInfo(path);
        ff.Desc = string.IsNullOrEmpty(v.FileDescription) ? null : v.FileDescription.Trim();
        ff.Publisher = string.IsNullOrEmpty(v.CompanyName) ? null : v.CompanyName.Trim();
        if (ff.Desc == "") ff.Desc = null;
        if (ff.Publisher == "") ff.Publisher = null;
      } catch (Exception) { }
      ff.Path = path;
      _files[path] = ff;
      return ff;
    }

    // The manifest's <supportedOS Id=...> GUIDs; none = Windows Vista behaviour (what Windows gives an exe
    // without a compatibility section). An external <exe>.manifest is read when nothing is embedded.
    static readonly string[][] OsIds = {
      new[] { "8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a", "Windows 10" },
      new[] { "1f676c76-80e1-4239-95bb-83d0f6d0da78", "Windows 8.1" },
      new[] { "4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38", "Windows 8" },
      new[] { "35138b9a-5d96-4fbd-8e2d-a2440225f93a", "Windows 7" },
      new[] { "e2011457-1546-43c5-a5fe-008deee3d3f0", "Windows Vista" },
    };

    static string OsContextOf(string path, out string why) {
      why = null;
      string text = null;
      IntPtr m = D.LoadLibraryExW(path, IntPtr.Zero, 0x00000002 | 0x00000020);   // AS_DATAFILE | AS_IMAGE_RESOURCE
      if (m == IntPtr.Zero) {
        why = "its exe could not be opened to read its manifest (error " + Marshal.GetLastWin32Error() + ")";
        return null;
      }
      try {
        IntPtr res = D.FindResourceW(m, new IntPtr(1), new IntPtr(24));   // CREATEPROCESS_MANIFEST_RESOURCE_ID, RT_MANIFEST
        if (res != IntPtr.Zero) {
          uint n = D.SizeofResource(m, res);
          IntPtr data = D.LockResource(D.LoadResource(m, res));
          if (data != IntPtr.Zero && n > 0 && n < (1 << 20)) {
            var bytes = new byte[n];
            Marshal.Copy(data, bytes, 0, (int)n);
            text = n >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
          }
        }
      } finally { D.FreeLibrary(m); }
      if (text == null) { try { if (File.Exists(path + ".manifest")) text = File.ReadAllText(path + ".manifest"); } catch (Exception) { } }
      if (text == null) return "Windows Vista";
      text = text.ToLowerInvariant();
      foreach (string[] os in OsIds) if (text.IndexOf(os[0], StringComparison.Ordinal) >= 0) return os[1];
      return "Windows Vista";
    }

    static ushort PeMachine(string path) {
      try {
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
          var b = new byte[1024];
          int n = fs.Read(b, 0, b.Length);
          if (n < 0x40 || b[0] != 'M' || b[1] != 'Z') return 0;
          int pe = BitConverter.ToInt32(b, 0x3C);
          if (pe < 0 || pe + 6 > n) return 0;
          if (b[pe] != 'P' || b[pe + 1] != 'E' || b[pe + 2] != 0 || b[pe + 3] != 0) return 0;
          return BitConverter.ToUInt16(b, pe + 4);
        }
      } catch (Exception) { return 0; }
    }

    static void MachineWords(ushort m, out string arch, out string platform) {
      arch = null; platform = null;
      if (m == 0x8664) { arch = "x64"; platform = "64 bit"; }
      else if (m == 0x014C) { arch = "x86"; platform = "32 bit"; }
      else if (m == 0xAA64) { arch = "ARM64"; platform = "64 bit"; }
      else if (m == 0x01C4) { arch = "ARM"; platform = "32 bit"; }
    }

    static void FillFull(Rec r, Fixed f, IntPtr h) {
      if (f.Full || !Settled(r, f, h)) return;
      f.Full = true;
      if (r.Pid == 0 || (r.Pid == 4 && h == IntPtr.Zero)) {
        // The kernel's own two: always the SYSTEM account, 64-bit on a 64-bit Windows.
        string[] sys = SystemAccount();
        if (sys != null) { f.User = sys[0]; f.UserFull = sys[1].Length > 0 ? sys[1] + "\\" + sys[0] : sys[0]; }
        f.Arch = Environment.Is64BitOperatingSystem ? "x64" : "x86"; f.Platform = Environment.Is64BitOperatingSystem ? "64 bit" : "32 bit";
        return;
      }
      if (h == IntPtr.Zero) {
        FileFacts ff = ImageOf(f.Path);
        if (ff != null) { MachineWords(ff.Machine, out f.Arch, out f.Platform); if (f.Platform == "64 bit") f.Dep = "Enabled"; }
        return;
      }
      // Token: user, elevation, whether UAC virtualization is allowed.
      IntPtr tok;
      if (D.OpenProcessToken(h, TOKEN_QUERY, out tok)) {
        try {
          int ret;
          if (D.GetTokenInformation(tok, 1, _scratch, 4096, out ret)) {          // TokenUser
            string[] acct = Account(Marshal.ReadIntPtr(_scratch, 0));
            if (acct != null) { f.User = acct[0]; f.UserFull = acct[1].Length > 0 ? acct[1] + "\\" + acct[0] : acct[0]; }
            else f.TokenWhy = "its account could not be looked up";
          }
          if (D.GetTokenInformation(tok, 20, _scratch, 4, out ret)) f.Elevated = Marshal.ReadInt32(_scratch, 0) != 0;   // TokenElevation
          if (D.GetTokenInformation(tok, 23, _scratch, 4, out ret)) f.UacAllowed = Marshal.ReadInt32(_scratch, 0) != 0; // TokenVirtualizationAllowed
        } finally { D.CloseHandle(tok); }
      } else {
        f.TokenErr = Marshal.GetLastWin32Error();
        f.TokenWhy = f.TokenErr == ERROR_ACCESS_DENIED
          ? "Windows lets only an administrator read its access token (user name, elevation, UAC virtualization, package name)"
          : "its access token could not be opened (error " + f.TokenErr + ")";
      }
      // Machine: ProcessMachineTypeInfo (9, Windows 11), else IsWow64Process2.
      ushort machine = 0;
      Marshal.WriteInt64(_scratch, 0, 0);
      if (D.GetProcessInformation(h, 9, _scratch, 8)) machine = (ushort)Marshal.ReadInt16(_scratch, 0);
      if (machine == 0) {
        ushort pm, nm;
        if (D.IsWow64Process2(h, out pm, out nm)) machine = pm != 0 ? pm : nm;
      }
      MachineWords(machine, out f.Arch, out f.Platform);
      // DEP: always on for a 64-bit process; a 32-bit one is asked.
      if (f.Platform == "64 bit") f.Dep = "Enabled";
      else if (f.Platform == "32 bit") {
        Marshal.WriteInt64(_scratch, 0, 0);
        uint flags; bool perm;
        if (D.GetProcessMitigationPolicy(h, 0, _scratch, new IntPtr(8))) f.Dep = (Marshal.ReadInt32(_scratch, 0) & 1) != 0 ? "Enabled" : "Disabled";
        else {
          // GetProcessDEPPolicy wants PROCESS_QUERY_INFORMATION. The verified handle `h` is still held, so this
          // pid cannot have been reused: the second handle is the same process.
          IntPtr h2 = D.OpenProcess(0x0400, false, r.Pid);
          if (h2 == IntPtr.Zero) {
            int e = Marshal.GetLastWin32Error();
            f.DepWhy = e == ERROR_ACCESS_DENIED ? "Windows lets only an administrator read a 32-bit process's DEP setting" : "its DEP setting could not be read (error " + e + ")";
            f.DepErr = e;
          } else {
            try {
              if (D.GetProcessDEPPolicy(h2, out flags, out perm)) f.Dep = (flags & 1) != 0 ? "Enabled" : "Disabled";
              else { f.DepErr = Marshal.GetLastWin32Error(); f.DepWhy = "its DEP setting could not be read (error " + f.DepErr + ")"; }
            } finally { D.CloseHandle(h2); }
          }
        }
      }
      // Hardware-enforced Stack Protection: ProcessUserShadowStackPolicy (15). Task Manager's words.
      Marshal.WriteInt32(_scratch, 0, 0);
      if (D.GetProcessMitigationPolicy(h, 15, _scratch, new IntPtr(4))) {
        int ss = Marshal.ReadInt32(_scratch, 0);
        bool on = (ss & 1) != 0, audit = (ss & 2) != 0, strict = (ss & 0x10) != 0;
        f.Shadow = on ? (strict ? "All modules" : "Compatible modules only")
                 : audit ? (strict ? "All modules (audit mode)" : "Compatible modules only (audit mode)") : "Disabled";
      }
      // Package full name: "" = not a packaged app.
      uint plen = 256;
      var pn = new StringBuilder((int)plen);
      int pr = D.GetPackageFullName(h, ref plen, pn);
      if (pr == 122 && plen < 4096) { pn = new StringBuilder((int)plen); pr = D.GetPackageFullName(h, ref plen, pn); }
      f.Package = pr == 0 ? pn.ToString() : pr == 15700 ? "" : null;
      // Enterprise context (Windows Information Protection). The handle is held, so the pid is this process.
      f.Enterprise = EnterpriseOf(r.Pid, out f.EdpWhy);
    }

    static string EnterpriseOf(uint pid, out string why) {
      why = null;
      if (_edpMissing) { why = "this Windows has no enterprise data protection API (edputil.dll)"; return null; }
      IntPtr ctx = IntPtr.Zero;
      try {
        int hr = D.EdpGetContextForProcess(pid, out ctx);
        if (hr != 0) { why = "Windows did not give its enterprise context (0x" + hr.ToString("X8") + ")"; return null; }
        if (ctx == IntPtr.Zero) return "Personal";
        int states = Marshal.ReadInt32(ctx, 0);
        IntPtr id = Marshal.ReadIntPtr(ctx, 8);
        string ent = id == IntPtr.Zero ? null : Marshal.PtrToStringUni(id);
        if ((states & 1) != 0) return "Exempt";                                   // EDP_CONTEXT_IS_EXEMPT
        if (!string.IsNullOrEmpty(ent)) return ent + " (" + ((states & 2) != 0 ? "Enlightened" : "Unenlightened") + ")";
        return "Personal";
      } catch (DllNotFoundException) { _edpMissing = true; why = "this Windows has no enterprise data protection API (edputil.dll)"; return null; }
      catch (EntryPointNotFoundException) { _edpMissing = true; why = "this Windows has no enterprise data protection API (edputil.dll)"; return null; }
      finally { if (ctx != IntPtr.Zero) { try { D.EdpFreeContext(ctx); } catch (Exception) { } } }
    }

    static string[] Account(IntPtr sid) {
      int n = D.GetLengthSid(sid);
      if (n <= 0 || n > 256) return null;
      var raw = new byte[n];
      Marshal.Copy(sid, raw, 0, n);
      string k = Convert.ToBase64String(raw);
      string[] a;
      if (_sids.TryGetValue(k, out a)) return a;
      var name = new StringBuilder(256); var dom = new StringBuilder(256);
      int nl = 256, dl = 256, use;
      a = D.LookupAccountSidW(null, sid, name, ref nl, dom, ref dl, out use) ? new[] { name.ToString(), dom.ToString() } : null;
      _sids[k] = a;
      return a;
    }

    static string[] SystemAccount() {
      if (_system != null) return _system;
      IntPtr sid;
      if (!D.ConvertStringSidToSidW("S-1-5-18", out sid)) return null;
      try { _system = Account(sid); } finally { D.LocalFree(sid); }
      return _system;
    }

    // ------------------------------------------------------------------ what can change every tick

    sealed class Live { public uint Prio; public int Ctl = -1, State = -1; public long User = -1, Gdi = -1; public string Uac; public int GuiErr; }

    static Live ReadLive(IntPtr h, Fixed f, bool full) {
      var l = new Live();
      l.Prio = D.GetPriorityClass(h);
      Marshal.WriteInt32(_scratch, 0, 1);   // PROCESS_POWER_THROTTLING_CURRENT_VERSION
      Marshal.WriteInt32(_scratch, 4, 0); Marshal.WriteInt32(_scratch, 8, 0);
      if (D.GetProcessInformation(h, 4, _scratch, 12)) { l.Ctl = Marshal.ReadInt32(_scratch, 4); l.State = Marshal.ReadInt32(_scratch, 8); }
      if (!full) return l;
      D.SetLastError(0);   // GetGuiResources returns 0 for "none" and for failure; only the error tells them apart
      uint g = D.GetGuiResources(h, 0);
      int ge = g == 0 ? Marshal.GetLastWin32Error() : 0;
      uint u = D.GetGuiResources(h, 1);
      if (g == 0 && ge == ERROR_ACCESS_DENIED) l.GuiErr = ge; else { l.Gdi = g; l.User = u; }
      if (f.UacAllowed.HasValue) {
        if (!f.UacAllowed.Value) l.Uac = "Not allowed";
        else {
          IntPtr tok;
          if (D.OpenProcessToken(h, TOKEN_QUERY, out tok)) {
            int ret;
            if (D.GetTokenInformation(tok, 24, _scratch, 4, out ret)) l.Uac = Marshal.ReadInt32(_scratch, 0) != 0 ? "Enabled" : "Disabled";   // TokenVirtualizationEnabled
            D.CloseHandle(tok);
          }
        }
      }
      return l;
    }

    // Windows' words for a priority class (GetPriorityClass), or for the table's base priority when no handle.
    static string PrioWords(uint cls) {
      switch (cls) {
        case 0x100: return "Realtime"; case 0x80: return "High"; case 0x8000: return "Above normal";
        case 0x20: return "Normal"; case 0x4000: return "Below normal"; case 0x40: return "Low";
      }
      return null;
    }
    static string BaseWords(int b) {
      switch (b) { case 24: return "Realtime"; case 13: return "High"; case 10: return "Above normal"; case 8: return "Normal"; case 6: return "Below normal"; case 4: return "Low"; }
      return null;
    }

    // Efficiency mode, as Windows defines it: EcoQoS (ProcessPowerThrottling EXECUTION_SPEED controlled and on)
    // AND the Low (IDLE) priority class.
    static bool? Efficient(Live l) {
      if (l == null || l.Ctl < 0 || l.Prio == 0) return null;
      return (l.Ctl & 1) != 0 && (l.State & 1) != 0 && l.Prio == 0x40;
    }

    static HashSet<uint> _hung;
    static readonly D.EnumProc _hungCb = HungCb;
    static bool HungCb(IntPtr hwnd, IntPtr lp) {
      try {
        if (!D.IsWindowVisible(hwnd) || D.GetWindow(hwnd, 4) != IntPtr.Zero) return true;   // GW_OWNER
        if (!D.IsHungAppWindow(hwnd)) return true;
        uint pid; D.GetWindowThreadProcessId(hwnd, out pid);
        if (pid != 0) _hung.Add(pid);
      } catch (Exception) { }
      return true;
    }
    /// Pids owning a visible top-level window Windows calls hung (no message taken for 5 s): "Not responding".
    static HashSet<uint> HungPids() {
      _hung = new HashSet<uint>();
      D.EnumWindows(_hungCb, IntPtr.Zero);
      return _hung;
    }

    // ------------------------------------------------------------------ taskmgr.details

    const string AdminWhy = "Windows lets only an administrator open this process (access denied)";
    const string JobWhy = "Windows gives job object IDs only to an administrator (SystemFullProcessInformation is access denied)";
    const string PowerWhy = "Windows' Power usage comes from its energy estimation engine, which has no per-process reading for a non-administrator in Windows' Very low to Very high words (ProcessEnergyValues gives only raw energy counters); Mantle does not guess";

    static string Details(Dictionary<string, object> req, ref object result) {
      lock (_gate) {
        var sw = Stopwatch.StartNew();
        if (_scratch == IntPtr.Zero) _scratch = Marshal.AllocHGlobal(4096);
        string why;
        List<Rec> table = ReadTable(out why);
        if (table == null) return why;
        double t = DateTime.UtcNow.Ticks / 10000.0;
        long msTable = sw.ElapsedMilliseconds;
        HashSet<uint> hung = HungPids();
        long msWin = sw.ElapsedMilliseconds - msTable;
        var rows = new List<object>(table.Count);
        int readable = 0, denied = 0, raced = 0;
        foreach (Rec r in table) {
          Fixed f = FixedOf(r);
          int err;
          IntPtr h = Open(r, f, out err);
          Live l = null;
          try {
            FillBasic(r, f, h);
            FillFull(r, f, h);
            if (h != IntPtr.Zero) { l = ReadLive(h, f, true); readable++; }
            else if (err == -1) raced++;
            else denied++;
          } finally { if (h != IntPtr.Zero) D.CloseHandle(h); }
          rows.Add(Row(r, f, l, h != IntPtr.Zero, err, hung));
        }
        Prune(table);
        result = Json.Obj("t", t, "cpus", Environment.ProcessorCount, "rows", rows,
          "fieldWhy", Json.Obj("jobId", JobWhy, "power", PowerWhy),
          "needsAdminFields", new List<object> { "jobId" },
          "readable", readable, "denied", denied, "raced", raced,
          "method", "NtQuerySystemInformation(SystemProcessInformation) counters; OpenProcess(QUERY_LIMITED) for the rest",
          "msTable", msTable, "msWindows", msWin, "ms", sw.ElapsedMilliseconds);
        return null;
      }
    }

    static IDictionary Row(Rec r, Fixed f, Live l, bool opened, int err, HashSet<uint> hung) {
      FileFacts ff = ImageOf(f.Path);
      var unread = new List<object>();
      var whys = new List<string>();
      bool needsAdmin = false;
      bool kernel = r.Pid == 0;   // System Idle Process: counters only, nothing else exists to read
      if (!opened && !kernel) {
        if (err == -1) whys.Add("the pid changed hands while it was being read; it is read again next tick");
        else if (err == ERROR_ACCESS_DENIED) { whys.Add(AdminWhy); needsAdmin = true; }
        else if (err == 87) whys.Add("it ended while it was being read");
        else whys.Add("Windows would not open it (error " + err + ")");
      } else if (opened && f.TokenWhy != null) {
        whys.Add(f.TokenWhy);
        if (f.TokenErr == ERROR_ACCESS_DENIED) needsAdmin = true;
      }
      if (opened && l != null && l.GuiErr == ERROR_ACCESS_DENIED) { whys.Add("Windows did not give its GDI and User object counts (access denied)"); needsAdmin = true; }
      string status = r.Suspended ? "Suspended" : hung.Contains(r.Pid) ? "Not responding" : "Running";
      string prio = r.Pid == 0 ? "N/A" : l != null && l.Prio != 0 ? PrioWords(l.Prio) : BaseWords(r.BasePri);
      bool? eff = Efficient(l);
      string throttle = l == null || l.Ctl < 0 ? null : ((l.Ctl & 1) != 0 && (l.State & 1) == 0 ? "Disallowed" : "Allowed");
      object userObj = l != null && l.User >= 0 ? (object)l.User : null;
      object gdiObj = l != null && l.Gdi >= 0 ? (object)l.Gdi : null;
      string desc = r.Pid == 0 ? "Percentage of time the processor is idle" : r.Pid == 4 && (ff == null || ff.Desc == null) ? "NT Kernel & System" : ff != null ? ff.Desc : null;
      string osCtx = ff != null ? ff.OsCtx : null;
      string uac = l != null ? l.Uac : null;
      // Which fields are null for lack of access (the elevated path can fill them).
      if (f.User == null) unread.Add("user");
      if (f.Cmdline == null && !kernel) unread.Add("cmdline");
      if (f.Elevated == null && !kernel) unread.Add("elevated");
      if (uac == null && !kernel) unread.Add("uacVirt");
      if (userObj == null && !kernel) { unread.Add("userObjects"); unread.Add("gdiObjects"); }
      if (f.Shadow == null && !kernel) unread.Add("shadowStack");
      if (f.Enterprise == null && !kernel) unread.Add("enterprise");
      if (f.Package == null && !kernel) unread.Add("packageName");
      if (eff == null && !kernel) { unread.Add("efficiency"); unread.Add("powerThrottling"); }
      if (f.Path == null && !kernel) unread.Add("path");
      if (f.Arch == null) { unread.Add("arch"); unread.Add("platform"); }
      if (f.Dep == null && !kernel) unread.Add("dep");
      if (prio == null) unread.Add("basePriority");
      if (opened && f.CmdWhy != null) whys.Add(f.CmdWhy);
      if (opened && f.EdpWhy != null) whys.Add(f.EdpWhy);
      if (opened && f.DepWhy != null) { whys.Add(f.DepWhy); if (f.DepErr == ERROR_ACCESS_DENIED) needsAdmin = true; }
      if (f.Path != null && osCtx == null && ff != null && ff.OsWhy != null) { whys.Add(ff.OsWhy); unread.Add("osContext"); }
      if (unread.Count > 0 && whys.Count == 0 && !kernel) {
        var names = new List<string>();
        foreach (object u in unread) names.Add((string)u);
        whys.Add("Windows did not answer these reads: " + string.Join(", ", names.ToArray()));
      }
      return Json.Obj(
        "pid", (long)r.Pid, "created", Str(r.Created), "name", r.Name, "status", status,
        "user", f.User, "userFull", f.UserFull, "sessionId", (long)r.Session, "jobId", null,
        "cpuTime100ns", r.Cpu, "cycles", r.Cycles,
        "ws", r.Ws, "wsPeak", r.WsPeak, "privateWs", r.Pws, "sharedWs", Math.Max(0, r.Ws - r.Pws),
        "commit", r.Commit, "pagedPool", r.Paged, "npPool", r.NonPaged, "pageFaults", (long)r.Faults,
        "basePriority", prio, "handles", r.Handles, "threads", r.Threads, "userObjects", userObj, "gdiObjects", gdiObj,
        "ioReads", r.IoR, "ioWrites", r.IoW, "ioOther", r.IoO, "ioReadBytes", r.IoRB, "ioWriteBytes", r.IoWB, "ioOtherBytes", r.IoOB,
        "path", f.Path, "cmdline", f.Cmdline, "osContext", osCtx, "platform", f.Platform, "arch", f.Arch,
        "elevated", f.Elevated, "uacVirt", uac, "desc", desc, "dep", f.Dep, "enterprise", f.Enterprise,
        "powerThrottling", throttle, "shadowStack", f.Shadow, "packageName", f.Package, "efficiency", eff,
        "needsAdmin", needsAdmin, "why", whys.Count > 0 ? string.Join("; ", whys.ToArray()) : null,
        "unread", unread);
    }

    // ------------------------------------------------------------------ taskmgr.procextra

    static string ProcExtra(Dictionary<string, object> req, ref object result) {
      object raw;
      var asked = Json.TryGet(req, "procs", out raw) ? raw as List<object> : null;
      if (asked == null) return "procextra needs procs: [{pid, created}] from taskmgr.snapshot";
      if (asked.Count > 4096) return "refused: more than 4096 processes in one request";
      lock (_gate) {
        var sw = Stopwatch.StartNew();
        if (_scratch == IntPtr.Zero) _scratch = Marshal.AllocHGlobal(4096);
        string why;
        List<Rec> table = ReadTable(out why);
        if (table == null) return why;
        var byPid = new Dictionary<uint, Rec>(table.Count);
        foreach (Rec r in table) byPid[r.Pid] = r;
        var rows = new List<object>(asked.Count);
        var skipped = new List<object>();
        foreach (object o in asked) {
          var d = o as Dictionary<string, object>;
          int pid = d == null ? -1 : Json.GetInt(d, "pid", -1);
          string created = d == null ? null : Json.GetString(d, "created");
          Rec r;
          if (pid < 0 || !byPid.TryGetValue((uint)pid, out r)) { skipped.Add(Json.Obj("pid", pid, "why", "it is no longer running")); continue; }
          if (created != Str(r.Created)) { skipped.Add(Json.Obj("pid", pid, "why", "that pid is now a different process (Windows reused the number)")); continue; }
          Fixed f = FixedOf(r);
          int err;
          IntPtr h = Open(r, f, out err);
          Live l = null;
          try {
            FillBasic(r, f, h);
            if (h != IntPtr.Zero) l = ReadLive(h, f, false);
          } finally { if (h != IntPtr.Zero) D.CloseHandle(h); }
          FileFacts ff = FileOf(f.Path);
          bool? eff = Efficient(l);
          bool kernel = r.Pid == 0;
          bool needsAdmin = h == IntPtr.Zero && !kernel && err == ERROR_ACCESS_DENIED;
          string rowWhy = h != IntPtr.Zero ? null : kernel ? "the System Idle Process is not a program: nothing to read" : err == ERROR_ACCESS_DENIED ? AdminWhy
            : err == -1 ? "the pid changed hands while it was being read" : "Windows would not open it (error " + err + ")";
          rows.Add(Json.Obj("pid", (long)r.Pid, "created", Str(r.Created),
            "publisher", ff != null ? ff.Publisher : null, "cmdline", f.Cmdline,
            "efficiency", eff, "status", eff == true ? "Efficiency mode" : null,
            "needsAdmin", needsAdmin, "why", rowWhy));
        }
        Prune(table);
        result = Json.Obj("rows", rows, "skipped", skipped, "power", null, "powerTrend", null, "powerWhy", PowerWhy,
          "ms", sw.ElapsedMilliseconds);
        return null;
      }
    }
  }
}
