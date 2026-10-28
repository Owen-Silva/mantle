// Perf.cs - `taskmgr.perf`: the numbers behind Task Manager's Performance page and the CPU / Memory /
// Disk / Network totals in every page's header (lane tm-perf, 2026-10-28). Owen: the task manager must
// work "exactly the same as default windows task manager"; the contract is mantle-wt/TM-SPEC.md
// (Performance, model.perf). lib/features/_taskmgr-perf.js turns these samples into model.perf.
//
//   taskmgr.perf {full:bool, cores:bool}  (Lanes.Slow) -> ONE sample:
//   { cpu, mem, disks|null, nets|null, totals:{disk, net}, static|null, staticPending, why:{...}, ms }
//
// LIGHT (full:false; every tick while the window is visible, a few ms):
//   cpu.pct / kernelPct   GetSystemTimes deltas (kernel includes idle): busy = kernel - idle + user.
//                         The time-based metric the 25H2 Task Manager shows by default.
//   cpu.procs/threads/handles  GetPerformanceInfo counts; cpu.uptimeSec = SystemTimeOfDayInformation
//                         CurrentTime - BootTime (wall time since boot, sleep included, like Task Manager).
//   mem                   GetPerformanceInfo (pages x page size): total, avail, used = total - avail
//                         (the memory-load basis the Processes header uses), committed, commitLimit,
//                         pagedPool, nonPagedPool. cached = standby + modified, composition {inUse,
//                         modified, standby, free} from PDH \Memory instant counters (Standby Cache
//                         Core/Normal Priority/Reserve Bytes, Modified Page List Bytes, Free & Zero Page
//                         List Bytes). composition.inUse = total - modified - standby - free, so the bar
//                         sums to total (Resource Monitor's split).
//   totals.disk           the busiest physical disk's active time, 100 - PDH \PhysicalDisk(*)\% Idle Time.
//   totals.net            the busiest adapter's (send + recv) * 8 / link speed, as a %.
// FULL (full:true, the Performance page is visible) adds:
//   cpu.speedGHz          base x \Processor Information(_Total)\% Processor Performance / 100.
//   cpu.perCore           (cores:true) NtQuerySystemInformation class 8 per logical processor, per
//                         processor group past 64.
//   mem.compressed        working set of the Memory Compression process (TaskMgr.ReadProcs; matched by
//                         image name, never logged), refreshed every 5 s in the background. 0 when that
//                         process does not exist (compression off; the case on Owen's PC 2026-10-28, so
//                         the non-zero path is unverified here).
//   disks[]               per PDH \PhysicalDisk instance ("0 C: D:" -> "Disk 0 (C: D:)"): activePct,
//                         respMs (Avg. Disk sec/Transfer x 1000), readBps, writeBps, plus that disk's
//                         static facts (read once per disk on the thread pool, never on the lane).
//   nets[]                .NET NetworkInterface (up, not loopback/tunnel; every other type is "Ethernet",
//                         as in Task Manager) with GetIPStatistics 64-bit byte counters; Wi-Fi SSID, PHY
//                         (802.11ax...) and signal (0-100) from wlanapi WLAN_INTF_OPCODE_CURRENT_CONNECTION.
//                         sendBps/recvBps are BYTES per second (the page shows bits: x 8).
//   static                once, on a background thread, the first time full is asked (staticPending until
//                         then): CPU name (registry), base speed (CallNtPowerInformation MaxMhz),
//                         sockets/cores/logical and L1/L2/L3 (GetLogicalProcessorInformationEx, every cache
//                         instance summed), virtualization (a running hypervisor or firmware VT), memory
//                         speed/slots/form factor (SMBIOS type 17 via GetSystemFirmwareTable 'RSMB'),
//                         hardware reserved (installed - usable).
// RATES need two collections: a sample whose previous one is missing or older than 6 s answers null
// rates with why = "baseline" (the window was hidden, or this is the first call). A call under 250 ms
// after the last one repeats that interval's numbers (rates over a few ms are noise).
// THE LANE STAYS FAST (measured 2026-10-28: light ~1.5 ms, full ~2.5-5 ms once warm). Everything slow runs
// on the thread pool and is served from the last result: opening the PDH queries (0.3-0.8 s; until then
// why = "opening ..."), the adapter list + addresses + link speeds every 5 s (GetAllNetworkInterfaces,
// 50-130 ms), and while full is asked the Wi-Fi details and compressed memory every 5 s. PDH queries are
// kept open; a timer closes them 60 s after the last call. {timing:true} adds costMs per part.
// Every null field has a plain-words reason in `why` (top level, keys like "cpu.speedGHz") or in the
// item's own `why` (disks[i].why, nets[i].why, static.why). Nothing is invented.
//
// Read-only: no write, no process opened, nothing logged (no process names, paths or titles).
//
// OUTSIDE DEPENDENCIES (this file also compiles into a second, elevated exe):
//   Features.cs  FeatureTable, MantleFeatureAttribute     Lanes.cs  Lanes.Slow
//   Json.cs      Json.GetBool                              TaskMgr.cs TaskMgr.ReadProcs, TaskMgr.Proc
//   System.Management.dll (WMI: hypervisor present, disk model; background threads only)
//   Program.*:   none.
//
// C# 5 only (build.ps1): no interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class Perf {
    public static void Register(FeatureTable t) { t.Add("taskmgr.perf", Lanes.Slow, Sample); }

    const int GapMs = 6000, MinMs = 250, IdleCloseMs = 60000, NetRelistMs = 5000;
    const uint FMT = 0x8200;   // PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
    const string Baseline = "baseline";
    const string LightWhy = "not asked: this was a light sample (full:false)";

    static class N {
      [StructLayout(LayoutKind.Sequential)]
      public struct PERFINFO {
        public uint cb;
        public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache,
                       KernelTotal, KernelPaged, KernelNonpaged, PageSize;
        public uint HandleCount, ProcessCount, ThreadCount;
      }
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
      [DllImport("psapi.dll", SetLastError = true)] public static extern bool GetPerformanceInfo(ref PERFINFO pi, uint cb);
      [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
      [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformationEx(int cls, ref ushort group, int inLen, IntPtr buf, int len, out int ret);
      [DllImport("kernel32.dll")] public static extern ushort GetActiveProcessorGroupCount();
      [DllImport("kernel32.dll")] public static extern uint GetActiveProcessorCount(ushort group);
      [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhOpenQueryW(string src, IntPtr user, out IntPtr query);
      [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr counter);
      [DllImport("pdh.dll")] public static extern int PdhCollectQueryData(IntPtr q);
      [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhGetFormattedCounterArrayW(IntPtr counter, uint fmt, ref uint size, out uint count, IntPtr buf);
      [DllImport("pdh.dll")] public static extern int PdhCloseQuery(IntPtr q);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetLogicalProcessorInformationEx(int rel, IntPtr buf, ref uint len);
      [DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);
      [DllImport("powrprof.dll")] public static extern uint CallNtPowerInformation(int level, IntPtr inBuf, uint inLen, IntPtr outBuf, uint outLen);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetSystemFirmwareTable(uint provider, uint id, IntPtr buf, uint size);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetPhysicallyInstalledSystemMemory(out ulong kb);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, int inLen, IntPtr outBuf, int outLen, out int ret, IntPtr ov);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetDiskFreeSpaceExW(string root, out ulong freeToCaller, out ulong total, out ulong free);

      [StructLayout(LayoutKind.Sequential)]
      public struct DOT11_SSID { public uint uSSIDLength; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] ucSSID; }
      [StructLayout(LayoutKind.Sequential)]
      public struct WLAN_ASSOCIATION_ATTRIBUTES {
        public DOT11_SSID dot11Ssid; public uint dot11BssType;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public byte[] dot11Bssid;
        public uint dot11PhyType, uDot11PhyIndex, wlanSignalQuality, ulRxRate, ulTxRate;
      }
      /// Stops after the association attributes (PtrToStructure reads only what is declared).
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct WLAN_CONNECTION_ATTRIBUTES {
        public uint isState, wlanConnectionMode;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strProfileName;
        public WLAN_ASSOCIATION_ATTRIBUTES wlanAssociationAttributes;
      }
      [DllImport("wlanapi.dll")] public static extern uint WlanOpenHandle(uint client, IntPtr reserved, out uint negotiated, out IntPtr handle);
      [DllImport("wlanapi.dll")] public static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
      [DllImport("wlanapi.dll")] public static extern uint WlanQueryInterface(IntPtr handle, ref Guid iface, uint opcode, IntPtr reserved, out uint dataSize, out IntPtr data, IntPtr valueType);
      [DllImport("wlanapi.dll")] public static extern void WlanFreeMemory(IntPtr p);
    }

    // ------------------------------------------------------------------ state (all under _gate)

    static readonly object _gate = new object();
    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static Timer _idle;
    static long _lastCallMs = -1;

    // light PDH query: \Memory instant counters, \PhysicalDisk % Idle Time (+ queue length: instant, so
    // the disk names exist even on a baseline collection)
    static IntPtr _lq, _cStbCore, _cStbNorm, _cStbRes, _cMod, _cFree, _cIdle, _cQueue;
    static string _lqErr, _memErr, _idleErr;
    static long _lightAt = -1;
    // full PDH query
    static IntPtr _fq, _cPerf, _cResp, _cRead, _cWrite;
    static string _fqErr, _perfErr, _diskRateErr;
    static long _fullAt = -1;
    // GetSystemTimes / per-core baselines
    static long _sIdle, _sKernel, _sUser, _sysAt = -1;
    static long[] _coreIdle, _coreTotal;
    static long _coresAt = -1;
    static int _baseMhz = -1; static string _baseErr;
    // adapters
    sealed class Nic {
      public string Id, Name, Desc, Kind, V4, V6, V4Why, V6Why; public bool Wifi; public long Speed;
      public NetworkInterface Ni; public long Sent, Recv, At = -1; public double SendBps = double.NaN, RecvBps = double.NaN;
      public string RateWhy, Ssid, ConnType; public object Signal; public Dictionary<string, string> WifiWhy;
    }
    static List<Nic> _nics; static long _nicsAt = -1; static string _nicErr;
    // background pass (adapters every 5 s; Wi-Fi details + compressed memory while full is asked)
    static bool _bgBusy, _lqOpening, _fqOpening; static long _fullAskAt = -1, _bgFullAt = -1;
    static object _compressed; static string _compressedWhy;
    static IntPtr _buf = IntPtr.Zero; static int _bufLen;

    // static facts: written by background threads under _sgate
    static readonly object _sgate = new object();
    static IDictionary _static; static bool _staticStarted;
    static readonly Dictionary<string, IDictionary> _diskStatic = new Dictionary<string, IDictionary>(StringComparer.Ordinal);   // "n|C: D:" -> facts, null = reading

    // ------------------------------------------------------------------ the command

    static string Sample(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      bool full = Json.GetBool(req, "full", false), cores = Json.GetBool(req, "cores", false);
      IDictionary cost = Json.GetBool(req, "timing", false) ? new OrderedDictionaryLite() : null;   // per-part ms, for measuring
      var why = new Dictionary<string, object>();
      IDictionary cpu, mem, totals = new OrderedDictionaryLite();
      object disks = null, nets = null;
      lock (_gate) {
        long now = _clock.ElapsedMilliseconds;
        _lastCallMs = now;
        if (_idle == null) _idle = new Timer(IdleTick, null, 15000, 15000);
        long t0 = sw.ElapsedTicks;
        OpenLight();
        // A call under MinMs after the last collection re-reads that collection (same numbers): rates over
        // a few ms are noise, and GetSystemTimes moves in 15.6 ms steps.
        if (_lq == IntPtr.Zero) { _lightFail = _lqErr ?? Opening; _lightBase = true; }
        else if (_lightAt < 0 || now - _lightAt >= MinMs) {
          _lightBase = _lightAt < 0 || now - _lightAt > GapMs;
          int lrc = N.PdhCollectQueryData(_lq);
          _lightFail = lrc != 0 ? "Windows did not collect the performance counters (PDH 0x" + lrc.ToString("X8") + ")" : null;
          _lightAt = now;
        }
        string lightFail = _lightFail;
        bool lightBase = _lightBase;
        Lap(cost, "pdhLight", sw, ref t0);

        cpu = Cpu(now, full, cores, why);
        Lap(cost, "cpu", sw, ref t0);
        mem = Mem(lightFail, why);
        Lap(cost, "mem", sw, ref t0);
        if (!full) why["mem.compressed"] = LightWhy;
        else { mem["compressed"] = _compressed; if (_compressed == null) why["mem.compressed"] = _compressedWhy ?? "still reading (in the background, every 5 s)"; }
        Lap(cost, "compressed", sw, ref t0);

        // disks: names from the instant queue-length counter, active % from % Idle Time
        var diskIdle = lightFail != null ? null : ReadArray(_cIdle);
        var diskNames = lightFail != null ? null : ReadArray(_cQueue);
        double busiest = double.NaN;
        string diskWhy = lightFail ?? _idleErr ?? (lightBase ? Baseline : null);
        if (diskWhy == null && diskIdle == null) diskWhy = "Windows gave no disk counters this time";
        if (diskWhy == null) foreach (var kv in diskIdle) if (kv.Key != "_Total" && !double.IsNaN(kv.Value)) busiest = Math.Max(double.IsNaN(busiest) ? 0 : busiest, Active(kv.Value));
        if (diskWhy == null && double.IsNaN(busiest)) diskWhy = "Windows lists no physical disk counters";
        totals["disk"] = R1(busiest);
        if (diskWhy != null) why["totals.disk"] = diskWhy;

        // adapters (light too: totals.net needs the rates)
        Nets(now, full, why, totals, ref nets);
        Lap(cost, "nets", sw, ref t0);

        if (full) disks = Disks(now, lightBase, diskIdle, diskNames, lightFail, why);
        else { why["disks"] = LightWhy; why["nets"] = LightWhy; }
        Lap(cost, "disks", sw, ref t0);
      }

      IDictionary st;
      bool pending;
      lock (_sgate) {
        if (full && !_staticStarted) {
          _staticStarted = true;
          var th = new Thread(ReadStatic);
          th.IsBackground = true;
          th.Name = "taskmgr-perf-static";
          th.Priority = ThreadPriority.BelowNormal;
          th.Start();
        }
        st = _static;
        pending = _staticStarted && st == null;
      }
      if (st == null) why["static"] = pending ? "still reading (once, on a background thread, the first time the Performance page asks)" : "not read yet: the first full sample (Performance page) starts it";
      double ms = Math.Round(sw.Elapsed.TotalMilliseconds, 2);
      IDictionary res = Obj("cpu", cpu, "mem", mem, "disks", disks, "nets", nets, "totals", totals, "static", st, "staticPending", pending, "why", why, "ms", ms);
      if (cost != null) res["costMs"] = cost;
      result = res;
      return null;
    }

    /// Json.Obj without the varargs boxing cost in hot paths; any IDictionary serialises.
    sealed class OrderedDictionaryLite : System.Collections.Specialized.ListDictionary { }

    static IDictionary Obj(params object[] kv) {
      var d = new OrderedDictionaryLite();
      for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
      return d;
    }

    static void Lap(IDictionary cost, string part, Stopwatch sw, ref long t0) {
      if (cost == null) return;
      long t = sw.ElapsedTicks;
      cost[part] = Math.Round((t - t0) * 1000.0 / Stopwatch.Frequency, 2);
      t0 = t;
    }

    static object R1(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? null : (object)Math.Round(v, 1); }
    static object R2(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? null : (object)Math.Round(v, 2); }
    static object RL(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? null : (object)(long)Math.Round(v); }
    static double Clamp(double v) { return v < 0 ? 0 : v > 100 ? 100 : v; }
    static double Active(double idlePct) { return Clamp(100 - idlePct); }

    // ------------------------------------------------------------------ CPU

    static IDictionary Cpu(long now, bool full, bool cores, Dictionary<string, object> why) {
      var c = Obj("pct", null, "kernelPct", null, "speedGHz", null, "perCore", null, "procs", null, "threads", null, "handles", null, "uptimeSec", null);
      long idle, kernel, user;
      if (!N.GetSystemTimes(out idle, out kernel, out user)) {
        string w = "Windows did not report the processor times (error " + Marshal.GetLastWin32Error() + ")";
        why["cpu.pct"] = w; why["cpu.kernelPct"] = w;
      } else if (_sysAt >= 0 && now - _sysAt < MinMs) {
        c["pct"] = _cpuPct; c["kernelPct"] = _cpuKernel;   // too soon: the last interval's numbers
        if (_cpuWhy != null) { why["cpu.pct"] = _cpuWhy; why["cpu.kernelPct"] = _cpuWhy; }
      } else {
        bool fresh = _sysAt >= 0 && now - _sysAt <= GapMs;
        long dI = idle - _sIdle, dK = kernel - _sKernel, dU = user - _sUser, tot = dK + dU;
        _cpuPct = _cpuKernel = null; _cpuWhy = null;
        if (fresh && tot > 0) {
          _cpuPct = R1(Clamp(100.0 * (tot - dI) / tot));
          _cpuKernel = R1(Clamp(100.0 * (dK - dI) / tot));
        } else _cpuWhy = fresh ? "no processor time passed since the last sample" : Baseline;
        c["pct"] = _cpuPct; c["kernelPct"] = _cpuKernel;
        if (_cpuWhy != null) { why["cpu.pct"] = _cpuWhy; why["cpu.kernelPct"] = _cpuWhy; }
        _sIdle = idle; _sKernel = kernel; _sUser = user; _sysAt = now;
      }
      var pi = new N.PERFINFO();
      pi.cb = (uint)Marshal.SizeOf(typeof(N.PERFINFO));
      if (N.GetPerformanceInfo(ref pi, pi.cb)) { c["procs"] = (long)pi.ProcessCount; c["threads"] = (long)pi.ThreadCount; c["handles"] = (long)pi.HandleCount; }
      else { string w = "Windows did not report its process counts (error " + Marshal.GetLastWin32Error() + ")"; why["cpu.procs"] = w; why["cpu.threads"] = w; why["cpu.handles"] = w; }
      string uw;
      double up = Uptime(out uw);
      c["uptimeSec"] = RL(up);
      if (uw != null) why["cpu.uptimeSec"] = uw;

      if (!full) { why["cpu.speedGHz"] = LightWhy; why["cpu.perCore"] = LightWhy; return c; }
      // speed = base x % Processor Performance / 100 (Task Manager's "Speed")
      OpenFull();
      if (_fq == IntPtr.Zero) { _fullFail = _fqErr ?? Opening; _fullBase = true; }
      else if (_fullAt < 0 || now - _fullAt >= MinMs) {
        _fullBase = _fullAt < 0 || now - _fullAt > GapMs;
        int frc = N.PdhCollectQueryData(_fq);
        _fullFail = frc != 0 ? "Windows did not collect the performance counters (PDH 0x" + frc.ToString("X8") + ")" : null;
        _fullAt = now;
      }
      string fullFail = _fullFail;
      bool fullBase = _fullBase;
      int baseMhz = BaseMhz();
      string sWhy = baseMhz <= 0 ? _baseErr : fullFail ?? _perfErr ?? (fullBase ? Baseline : null);
      if (sWhy == null) {
        var pp = ReadArray(_cPerf);
        double perf = double.NaN;
        if (pp != null) foreach (var kv in pp) if (kv.Key == "_Total") perf = kv.Value;
        if (double.IsNaN(perf)) sWhy = "Windows gave no processor performance reading this time";
        else c["speedGHz"] = R2(baseMhz * perf / 100.0 / 1000.0);
      }
      if (sWhy != null) why["cpu.speedGHz"] = sWhy;
      if (!cores) why["cpu.perCore"] = "not asked (cores:false)";
      else { string pw; c["perCore"] = PerCore(now, out pw); if (pw != null) why["cpu.perCore"] = pw; }
      return c;
    }
    static string _fullFail, _lightFail, _cpuWhy; static bool _fullBase = true, _lightBase = true;
    static object _cpuPct, _cpuKernel;
    static List<object> _coreLast; static string _coreLastWhy;

    static double Uptime(out string why) {
      why = null;
      IntPtr b = Marshal.AllocHGlobal(48);
      try {
        int ret;
        int st = N.NtQuerySystemInformation(3, b, 48, out ret);   // SystemTimeOfDayInformation
        if (st != 0) { why = "Windows did not report its boot time (NTSTATUS 0x" + st.ToString("X8") + ")"; return double.NaN; }
        long boot = Marshal.ReadInt64(b, 0), cur = Marshal.ReadInt64(b, 8);
        return (cur - boot) / 1e7;
      } finally { Marshal.FreeHGlobal(b); }
    }

    static int BaseMhz() {
      if (_baseMhz >= 0) return _baseMhz;
      _baseMhz = 0;
      int n = (int)N.GetActiveProcessorCount(0xFFFF);
      if (n <= 0) n = Environment.ProcessorCount;
      int len = n * 24;   // PROCESSOR_POWER_INFORMATION: Number, MaxMhz, CurrentMhz, MhzLimit, MaxIdleState, CurrentIdleState
      IntPtr b = Marshal.AllocHGlobal(len);
      try {
        uint st = N.CallNtPowerInformation(11, IntPtr.Zero, 0, b, (uint)len);   // ProcessorInformation
        if (st != 0) { _baseErr = "Windows did not report the processor's base speed (NTSTATUS 0x" + st.ToString("X8") + ")"; return 0; }
        int max = 0;
        for (int i = 0; i < n; i++) max = Math.Max(max, Marshal.ReadInt32(b, i * 24 + 4));
        if (max <= 0) _baseErr = "Windows reported no base speed for the processor";
        _baseMhz = max;
        return max;
      } finally { Marshal.FreeHGlobal(b); }
    }

    /// Per logical processor busy % from SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION (48 bytes: Idle,
    /// Kernel (includes idle), User, Dpc, Interrupt, InterruptCount), one processor group at a time.
    static List<object> PerCore(long now, out string why) {
      if (_coresAt >= 0 && now - _coresAt < MinMs) { why = _coreLastWhy; return _coreLast; }
      why = null;
      int groups = N.GetActiveProcessorGroupCount();
      var idle = new List<long>(); var total = new List<long>();
      for (ushort g = 0; g < Math.Max(1, groups); g++) {
        int n = (int)N.GetActiveProcessorCount(g);
        if (n <= 0) n = Environment.ProcessorCount;
        int len = n * 48, ret;
        IntPtr b = Marshal.AllocHGlobal(len);
        try {
          ushort grp = g;
          int st = groups <= 1 ? N.NtQuerySystemInformation(8, b, len, out ret) : N.NtQuerySystemInformationEx(8, ref grp, 2, b, len, out ret);
          if (st != 0) { why = "Windows did not report per-processor times (NTSTATUS 0x" + st.ToString("X8") + ")"; return null; }
          int got = ret / 48;
          for (int i = 0; i < got; i++) {
            long id = Marshal.ReadInt64(b, i * 48), k = Marshal.ReadInt64(b, i * 48 + 8), u = Marshal.ReadInt64(b, i * 48 + 16);
            idle.Add(id); total.Add(k + u);
          }
        } finally { Marshal.FreeHGlobal(b); }
      }
      bool fresh = _coresAt >= 0 && now - _coresAt <= GapMs && _coreIdle != null && _coreIdle.Length == idle.Count;
      List<object> list = null;
      if (fresh) {
        list = new List<object>(idle.Count);
        for (int i = 0; i < idle.Count; i++) {
          long dT = total[i] - _coreTotal[i], dI = idle[i] - _coreIdle[i];
          list.Add(dT > 0 ? R1(Clamp(100.0 * (dT - dI) / dT)) : (object)0.0);
        }
      } else why = Baseline;
      _coreIdle = idle.ToArray(); _coreTotal = total.ToArray(); _coresAt = now;
      _coreLast = list; _coreLastWhy = why;
      return list;
    }

    // ------------------------------------------------------------------ memory

    static IDictionary Mem(string lightFail, Dictionary<string, object> why) {
      var m = Obj("total", null, "avail", null, "used", null, "committed", null, "commitLimit", null, "pagedPool", null, "nonPagedPool", null, "cached", null, "composition", null, "compressed", null);
      var pi = new N.PERFINFO();
      pi.cb = (uint)Marshal.SizeOf(typeof(N.PERFINFO));
      long total = -1;
      if (N.GetPerformanceInfo(ref pi, pi.cb)) {
        long page = (long)pi.PageSize.ToUInt64();
        total = (long)pi.PhysicalTotal.ToUInt64() * page;
        long avail = (long)pi.PhysicalAvailable.ToUInt64() * page;
        m["total"] = total; m["avail"] = avail; m["used"] = total - avail;
        m["committed"] = (long)pi.CommitTotal.ToUInt64() * page; m["commitLimit"] = (long)pi.CommitLimit.ToUInt64() * page;
        m["pagedPool"] = (long)pi.KernelPaged.ToUInt64() * page; m["nonPagedPool"] = (long)pi.KernelNonpaged.ToUInt64() * page;
      } else {
        string w = "Windows did not report its memory figures (error " + Marshal.GetLastWin32Error() + ")";
        foreach (string k in new string[] { "total", "avail", "used", "committed", "commitLimit", "pagedPool", "nonPagedPool" }) why["mem." + k] = w;
      }
      string cw = lightFail ?? _memErr;
      double sc = double.NaN, sn = double.NaN, sr = double.NaN, mod = double.NaN, free = double.NaN;
      if (cw == null) {
        sc = One(_cStbCore); sn = One(_cStbNorm); sr = One(_cStbRes); mod = One(_cMod); free = One(_cFree);
        if (double.IsNaN(sc) || double.IsNaN(sn) || double.IsNaN(sr) || double.IsNaN(mod) || double.IsNaN(free)) cw = "Windows gave no standby/modified/free page counts this time";
      }
      if (cw == null) {
        long standby = (long)(sc + sn + sr), modified = (long)mod, fr = (long)free;
        m["cached"] = standby + modified;
        if (total > 0) m["composition"] = Obj("inUse", Math.Max(0, total - modified - standby - fr), "modified", modified, "standby", standby, "free", fr);
        else why["mem.composition"] = "the total is unknown, so the in-use part cannot be worked out";
      } else { why["mem.cached"] = cw; why["mem.composition"] = cw; }
      return m;
    }

    /// Thread pool (Background, every 5 s while full is asked): the Memory Compression process's working
    /// set. A process-table read is 4-20 ms, too much for every tick on the lane.
    static object ReadCompressed(out string why) {
      why = null;
      string w;
      List<TaskMgr.Proc> procs = TaskMgr.ReadProcs(out w);
      if (procs == null) { why = w ?? "the process table could not be read"; return null; }
      foreach (TaskMgr.Proc p in procs) {
        if (p.Session == 0 && string.Equals(p.File, "Memory Compression", StringComparison.OrdinalIgnoreCase)) return p.Pws;
      }
      return 0L;   // no such process: memory compression is off, nothing is compressed
    }

    // ------------------------------------------------------------------ disks

    static List<object> Disks(long now, bool lightBase, List<KeyValuePair<string, double>> idle, List<KeyValuePair<string, double>> names, string lightFail, Dictionary<string, object> why) {
      if (lightFail != null) { why["disks"] = lightFail; return null; }
      if (names == null) { why["disks"] = _idleErr ?? "Windows gave no disk counters this time"; return null; }
      var idleBy = Map(idle);
      bool rBase = _fullBase;
      string rFail = _fullFail ?? _diskRateErr;
      var resp = rFail == null && !rBase ? Map(ReadArray(_cResp)) : null;
      var rd = rFail == null && !rBase ? Map(ReadArray(_cRead)) : null;
      var wr = rFail == null && !rBase ? Map(ReadArray(_cWrite)) : null;
      var list = new List<object>();
      var pageLetters = PageFileLetters();
      string sysDrive = (Environment.GetEnvironmentVariable("SystemDrive") ?? "").ToUpperInvariant();
      foreach (var kv in names) {
        if (kv.Key == "_Total") continue;
        string[] parts = kv.Key.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        int n;
        if (parts.Length == 0 || !int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) continue;
        var letters = new List<string>();
        for (int i = 1; i < parts.Length; i++) letters.Add(parts[i].ToUpperInvariant());
        var dw = new Dictionary<string, object>();
        var d = Obj("id", "disk" + n, "name", "Disk " + n + (letters.Count > 0 ? " (" + string.Join(" ", letters.ToArray()) + ")" : ""), "number", n, "letters", letters,
                    "activePct", null, "respMs", null, "readBps", null, "writeBps", null,
                    "model", null, "type", null, "bus", null, "removable", null, "capacity", null, "formatted", null, "systemDisk", null, "pageFile", null, "why", dw);
        double v;
        if (lightBase) dw["activePct"] = Baseline;
        else if (idleBy != null && idleBy.TryGetValue(kv.Key, out v) && !double.IsNaN(v)) d["activePct"] = R1(Active(v));
        else dw["activePct"] = "Windows gave no active-time reading for this disk this time";
        string rw = rFail ?? (rBase ? Baseline : null);
        if (rw == null && (resp == null || rd == null || wr == null)) rw = "Windows gave no transfer counters this time";
        if (rw != null) { dw["respMs"] = rw; dw["readBps"] = rw; dw["writeBps"] = rw; }
        else {
          if (resp.TryGetValue(kv.Key, out v) && !double.IsNaN(v)) d["respMs"] = R2(v * 1000.0); else dw["respMs"] = Baseline;
          if (rd.TryGetValue(kv.Key, out v) && !double.IsNaN(v)) d["readBps"] = RL(v); else dw["readBps"] = Baseline;
          if (wr.TryGetValue(kv.Key, out v) && !double.IsNaN(v)) d["writeBps"] = RL(v); else dw["writeBps"] = Baseline;
        }
        // systemDisk / pageFile are cheap: worked out every sample from the letters
        bool sys = sysDrive.Length == 2 && letters.Contains(sysDrive);
        d["systemDisk"] = sys;
        if (pageLetters == null) dw["pageFile"] = "the page-file list could not be read from the registry";
        else { bool pf = false; foreach (string l in letters) if (pageLetters.Contains(l)) pf = true; d["pageFile"] = pf; }
        MergeDiskStatic(n, letters, d, dw);
        list.Add(d);
      }
      if (list.Count == 0) why["disks"] = "Windows lists no physical disks in its performance counters";
      return list;
    }

    static Dictionary<string, double> Map(List<KeyValuePair<string, double>> l) {
      if (l == null) return null;
      var d = new Dictionary<string, double>(StringComparer.Ordinal);
      foreach (var kv in l) d[kv.Key] = kv.Value;
      return d;
    }

    static HashSet<string> PageFileLetters() {
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management")) {
          var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
          if (k == null) return null;
          string[] files = k.GetValue("ExistingPageFiles") as string[];
          if (files == null) return set;   // no page file at all
          foreach (string f in files) {
            string s = f.StartsWith(@"\??\") ? f.Substring(4) : f;
            if (s.Length >= 2 && s[1] == ':') set.Add(s.Substring(0, 2).ToUpperInvariant());
          }
          return set;
        }
      } catch (Exception) { return null; }
    }

    static void MergeDiskStatic(int n, List<string> letters, IDictionary d, Dictionary<string, object> dw) {
      string key = n + "|" + string.Join(" ", letters.ToArray());
      IDictionary f;
      bool known;
      lock (_sgate) {
        known = _diskStatic.TryGetValue(key, out f);
        if (!known) {
          _diskStatic[key] = null;
          string[] ls = letters.ToArray();
          ThreadPool.QueueUserWorkItem(delegate (object o) {
            IDictionary facts;
            try { facts = ReadDisk(n, ls); }
            catch (Exception ex) { facts = Obj("why", Obj("model", "reading this disk's facts failed (" + ex.GetType().Name + ")")); }
            lock (_sgate) _diskStatic[key] = facts;
          });
        }
      }
      string[] keys = { "model", "type", "bus", "removable", "capacity", "formatted" };
      if (f == null) { foreach (string k in keys) dw[k] = "still reading this disk's facts (once, in the background)"; return; }
      var fw = f["why"] as IDictionary;
      foreach (string k in keys) {
        object v = f.Contains(k) ? f[k] : null;
        d[k] = v;
        if (v == null) dw[k] = fw != null && fw.Contains(k) ? fw[k] : "Windows did not say";
      }
    }

    /// One disk's facts, on the thread pool: \\.\PhysicalDriveN opened with NO access (enough for these
    /// queries without admin), the WMI model (Device Manager's name), and the formatted size of its volumes.
    static IDictionary ReadDisk(int n, string[] letters) {
      var f = Obj("model", null, "type", null, "bus", null, "removable", null, "capacity", null, "formatted", null);
      var w = new OrderedDictionaryLite();
      f["why"] = w;
      string descModel = null;
      IntPtr h = N.CreateFileW(@"\\.\PhysicalDrive" + n, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);   // share read|write, OPEN_EXISTING
      if (h == new IntPtr(-1)) {
        string e = "Windows would not open disk " + n + " to read its facts (error " + Marshal.GetLastWin32Error() + ")";
        w["type"] = e; w["bus"] = e; w["removable"] = e; w["capacity"] = e;
      } else {
        IntPtr q = Marshal.AllocHGlobal(12), o = Marshal.AllocHGlobal(1024);
        try {
          int ret;
          // StorageDeviceProperty -> STORAGE_DEVICE_DESCRIPTOR
          Marshal.WriteInt32(q, 0, 0); Marshal.WriteInt32(q, 4, 0); Marshal.WriteInt32(q, 8, 0);
          // {Version, Size, DeviceType, DeviceTypeModifier, RemovableMedia, CommandQueueing, VendorIdOffset 12,
          //  ProductIdOffset 16, ProductRevisionOffset 20, SerialNumberOffset 24, BusType 28, ...}
          if (N.DeviceIoControl(h, 0x2D1400, q, 12, o, 1024, out ret, IntPtr.Zero) && ret >= 32) {
            f["removable"] = Marshal.ReadByte(o, 10) != 0;
            int bus = Marshal.ReadInt32(o, 28);
            string bn = BusName(bus);
            if (bn != null) f["bus"] = bn; else w["bus"] = "Windows reports bus type " + bus + ", which has no name here";
            string vendor = DescString(o, Marshal.ReadInt32(o, 12), ret), product = DescString(o, Marshal.ReadInt32(o, 16), ret);
            descModel = ((vendor ?? "") + " " + (product ?? "")).Trim();
            if (descModel.Length == 0) descModel = null;
          } else { string e = "Windows did not describe disk " + n + " (error " + Marshal.GetLastWin32Error() + ")"; w["bus"] = e; w["removable"] = e; }
          // StorageDeviceSeekPenaltyProperty -> IncursSeekPenalty: spinning = HDD
          Marshal.WriteInt32(q, 0, 7);
          if (N.DeviceIoControl(h, 0x2D1400, q, 12, o, 1024, out ret, IntPtr.Zero) && ret >= 9) f["type"] = Marshal.ReadByte(o, 8) != 0 ? "HDD" : "SSD";
          else w["type"] = "the disk did not say whether it has a seek penalty (SSD or HDD) (error " + Marshal.GetLastWin32Error() + ")";
          // IOCTL_DISK_GET_DRIVE_GEOMETRY_EX (FILE_ANY_ACCESS): DiskSize after the 24-byte DISK_GEOMETRY
          if (N.DeviceIoControl(h, 0x700A0, IntPtr.Zero, 0, o, 1024, out ret, IntPtr.Zero) && ret >= 32) f["capacity"] = Marshal.ReadInt64(o, 24);
          else w["capacity"] = "Windows did not report the disk's size (error " + Marshal.GetLastWin32Error() + ")";
        } finally { Marshal.FreeHGlobal(q); Marshal.FreeHGlobal(o); N.CloseHandle(h); }
      }
      string we;
      object model = Wmi("SELECT Model FROM Win32_DiskDrive WHERE Index = " + n, "Model", out we);
      string ms = model as string;
      if (!string.IsNullOrEmpty(ms)) f["model"] = ms.Trim();
      else if (descModel != null) f["model"] = descModel;
      else w["model"] = we ?? "Windows gave no model name for this disk";
      if (letters.Length == 0) w["formatted"] = "the disk has no volume with a drive letter";
      else {
        long sum = 0; string fe = null;
        foreach (string l in letters) {
          ulong a, t, fr;
          if (N.GetDiskFreeSpaceExW(l + "\\", out a, out t, out fr)) sum += (long)t;
          else { fe = "Windows did not report the size of " + l + " (error " + Marshal.GetLastWin32Error() + ")"; break; }
        }
        if (fe == null) f["formatted"] = sum; else w["formatted"] = fe;
      }
      return f;
    }

    static string DescString(IntPtr o, int off, int len) {
      if (off <= 0 || off >= len) return null;
      string s = Marshal.PtrToStringAnsi(new IntPtr(o.ToInt64() + off));
      return s == null ? null : s.Trim();
    }

    static string BusName(int b) {
      switch (b) {
        case 1: return "SCSI"; case 2: return "ATAPI"; case 3: return "ATA"; case 4: return "IEEE 1394"; case 6: return "Fibre Channel";
        case 7: return "USB"; case 8: return "RAID"; case 9: return "iSCSI"; case 10: return "SAS"; case 11: return "SATA";
        case 12: return "SD"; case 13: return "MMC"; case 14: return "Virtual"; case 15: return "File-backed virtual";
        case 16: return "Storage Spaces"; case 17: return "NVMe"; case 18: return "SCM"; case 19: return "UFS";
        default: return null;
      }
    }

    // ------------------------------------------------------------------ network

    /// The lane reads only each adapter's byte counters (GetIPStatistics, well under 1 ms). The adapter list,
    /// addresses and link speeds (every 5 s) and, while the Performance page asks, the Wi-Fi details and
    /// compressed memory are read on the thread pool (Background): measured 2026-10-28,
    /// GetAllNetworkInterfaces took 50-130 ms and one WlanQueryInterface ~15 ms, too long for the Slow lane.
    static void Nets(long now, bool full, Dictionary<string, object> why, IDictionary totals, ref object nets) {
      if (full) _fullAskAt = now;
      bool fullDue = full && (_bgFullAt < 0 || now - _bgFullAt >= NetRelistMs);
      if (!_bgBusy && (_nics == null || now - _nicsAt >= NetRelistMs || fullDue)) {
        _bgBusy = true;
        bool withFull = _fullAskAt >= 0 && now - _fullAskAt <= GapMs;
        ThreadPool.QueueUserWorkItem(delegate (object o) { Background(withFull); });
      }
      double busiest = double.NaN;
      bool anyLink = false, anyBase = false;
      if (_nics != null) {
        foreach (Nic n in _nics) {
          if (n.At >= 0 && now - n.At < MinMs) { /* too soon: keep the last interval's rates */ }
          else {
            long s = 0, r = 0;
            bool ok = true;
            try { IPInterfaceStatistics st = n.Ni.GetIPStatistics(); s = st.BytesSent; r = st.BytesReceived; }
            catch (Exception ex) { ok = false; n.SendBps = n.RecvBps = double.NaN; n.RateWhy = "Windows did not report this adapter's byte counts (" + ex.GetType().Name + ")"; n.At = -1; }
            if (ok) {
              bool fresh = n.At >= 0 && now - n.At <= GapMs;
              if (fresh && s >= n.Sent && r >= n.Recv) {
                double dt = (now - n.At) / 1000.0;
                n.SendBps = (s - n.Sent) / dt; n.RecvBps = (r - n.Recv) / dt; n.RateWhy = null;
              } else { n.SendBps = n.RecvBps = double.NaN; n.RateWhy = fresh ? "the adapter's counters went backwards (it was reset)" : Baseline; }
              n.Sent = s; n.Recv = r; n.At = now;
            }
          }
          if (n.Speed > 0) {
            anyLink = true;
            if (!double.IsNaN(n.SendBps)) busiest = Math.Max(double.IsNaN(busiest) ? 0 : busiest, Clamp((n.SendBps + n.RecvBps) * 8 * 100.0 / n.Speed));
            else anyBase = true;
          }
        }
      }
      string netWhy = null;
      if (_nics == null) netWhy = _nicErr ?? Baseline;   // the first list is still being read
      else if (_nics.Count == 0) netWhy = "no network adapter is connected";
      else if (!anyLink) netWhy = "no connected adapter reports a link speed";
      else if (double.IsNaN(busiest)) netWhy = anyBase ? Baseline : "no adapter rates this time";
      totals["net"] = R1(busiest);
      if (netWhy != null) why["totals.net"] = netWhy;
      if (!full) return;
      if (_nics == null) { why["nets"] = _nicErr ?? "still listing the network adapters (in the background)"; return; }
      var list = new List<object>();
      foreach (Nic n in _nics) {
        var w = new Dictionary<string, object>();
        var d = Obj("id", n.Id, "name", n.Name, "adapter", n.Desc, "kind", n.Kind, "sendBps", RL(n.SendBps), "recvBps", RL(n.RecvBps),
                    "ssid", null, "connType", null, "ipv4", n.V4, "ipv6", n.V6, "signal", null, "linkBps", n.Speed > 0 ? (object)n.Speed : null, "why", w);
        if (n.RateWhy != null) { w["sendBps"] = n.RateWhy; w["recvBps"] = n.RateWhy; }
        if (n.V4 == null) w["ipv4"] = n.V4Why;
        if (n.V6 == null) w["ipv6"] = n.V6Why;
        if (n.Speed <= 0) w["linkBps"] = "the adapter reports no link speed";
        if (n.Wifi) {
          d["ssid"] = n.Ssid; d["connType"] = n.ConnType; d["signal"] = n.Signal;
          foreach (string k in WifiKeys) {
            if (d[k] != null) continue;
            string ww;
            w[k] = n.WifiWhy != null && n.WifiWhy.TryGetValue(k, out ww) ? ww : "still reading the Wi-Fi details (in the background)";
          }
        } else {
          string wired = "this adapter is not Wi-Fi, so it has no Wi-Fi name or signal";
          w["ssid"] = wired; w["signal"] = wired;
          if (n.Kind == "Ethernet") d["connType"] = "Ethernet"; else w["connType"] = "Windows names no connection type for a " + n.Kind + " adapter";
        }
        list.Add(d);
      }
      nets = list;
    }

    static readonly string[] WifiKeys = { "ssid", "connType", "signal" };

    /// Thread pool: re-list the adapters (and with withFull the Wi-Fi details and compressed memory), then
    /// swap them in under _gate, carrying each adapter's counters over so its rates continue.
    static void Background(bool withFull) {
      List<Nic> fresh = null;
      string err = null, compWhy = null;
      object comp = null;
      try {
        fresh = ListAdapters(out err);
        if (withFull && fresh != null) WifiPass(fresh);
        if (withFull) comp = ReadCompressed(out compWhy);
      } catch (Exception ex) { if (err == null) err = "the adapter list could not be read (" + ex.GetType().Name + ")"; }
      lock (_gate) {
        long now = _clock.ElapsedMilliseconds;
        if (fresh != null) {
          var old = new Dictionary<string, Nic>(StringComparer.OrdinalIgnoreCase);
          if (_nics != null) foreach (Nic n in _nics) old[n.Id] = n;
          foreach (Nic n in fresh) {
            Nic o;
            if (!old.TryGetValue(n.Id, out o)) continue;
            n.Sent = o.Sent; n.Recv = o.Recv; n.At = o.At; n.SendBps = o.SendBps; n.RecvBps = o.RecvBps; n.RateWhy = o.RateWhy;
            if (!withFull) { n.Ssid = o.Ssid; n.ConnType = o.ConnType; n.Signal = o.Signal; n.WifiWhy = o.WifiWhy; }
          }
          _nics = fresh; _nicErr = null;
        } else if (_nics == null) _nicErr = err ?? "the adapter list could not be read";
        _nicsAt = now;
        if (withFull) { _compressed = comp; _compressedWhy = compWhy; _bgFullAt = now; }
        _bgBusy = false;
      }
    }

    static List<Nic> ListAdapters(out string err) {
      err = null;
      NetworkInterface[] all;
      try { all = NetworkInterface.GetAllNetworkInterfaces(); }
      catch (Exception ex) { err = "Windows did not list the network adapters (" + ex.GetType().Name + ")"; return null; }
      var list = new List<Nic>();
      foreach (NetworkInterface ni in all) {
        try {
          if (ni.OperationalStatus != OperationalStatus.Up) continue;
          NetworkInterfaceType t = ni.NetworkInterfaceType;
          if (t == NetworkInterfaceType.Loopback || t == NetworkInterfaceType.Tunnel) continue;
          var n = new Nic();
          n.Id = ni.Id; n.Ni = ni; n.Name = ni.Name; n.Desc = ni.Description; n.Kind = KindOf(t); n.Wifi = t == NetworkInterfaceType.Wireless80211;
          try { n.Speed = ni.Speed; } catch (Exception) { n.Speed = -1; }
          n.V4Why = "the adapter has no IPv4 address"; n.V6Why = "the adapter has no IPv6 address";
          try {
            string g = null, gTemp = null, ll = null;
            foreach (UnicastIPAddressInformation u in ni.GetIPProperties().UnicastAddresses) {
              IPAddress a = u.Address;
              if (a.AddressFamily == AddressFamily.InterNetwork) { if (n.V4 == null) n.V4 = a.ToString(); }
              else if (a.AddressFamily == AddressFamily.InterNetworkV6) {
                string s = a.ToString(); int pc = s.IndexOf('%'); if (pc > 0) s = s.Substring(0, pc);
                if (a.IsIPv6LinkLocal) { if (ll == null) ll = s; }
                else if (u.SuffixOrigin == SuffixOrigin.Random) { if (gTemp == null) gTemp = s; }
                else if (g == null) g = s;
              }
            }
            n.V6 = g ?? gTemp ?? ll;   // a global address first, then a temporary one, then link-local
          } catch (Exception ex) { n.V4Why = n.V6Why = "Windows did not list this adapter's addresses (" + ex.GetType().Name + ")"; }
          list.Add(n);
        } catch (Exception) { /* an adapter that vanished mid-list */ }
      }
      return list;
    }

    static string KindOf(NetworkInterfaceType t) {
      switch (t) {
        case NetworkInterfaceType.Wireless80211: return "Wi-Fi";
        case NetworkInterfaceType.Wwanpp: case NetworkInterfaceType.Wwanpp2: return "Cellular";
        default: return "Ethernet";   // Task Manager files every other adapter (VPN, virtual switch, tunnel) under Ethernet
      }
    }

    /// Thread pool: SSID, PHY type and signal of every Wi-Fi adapter in `list`, through one short-lived
    /// wlanapi handle. Error 5 = Windows hides the connection from apps without location access.
    static void WifiPass(List<Nic> list) {
      bool any = false;
      foreach (Nic n in list) if (n.Wifi) any = true;
      if (!any) return;
      IntPtr h;
      uint neg;
      uint orc = N.WlanOpenHandle(2, IntPtr.Zero, out neg, out h);
      if (orc != 0) {
        string e = "the Wi-Fi service did not answer (error " + orc + ")";
        foreach (Nic n in list) if (n.Wifi) n.WifiWhy = AllWifi(e);
        return;
      }
      try {
        foreach (Nic n in list) {
          if (!n.Wifi) continue;
          var w = new Dictionary<string, string>();
          n.WifiWhy = w;
          Guid g;
          try { g = new Guid(n.Id); } catch (Exception) { n.WifiWhy = AllWifi("Windows gave no id for this Wi-Fi adapter"); continue; }
          IntPtr data = IntPtr.Zero;
          try {
            uint size;
            uint rc = N.WlanQueryInterface(h, ref g, 7, IntPtr.Zero, out size, out data, IntPtr.Zero);   // WLAN_INTF_OPCODE_CURRENT_CONNECTION
            if (rc == 5) { n.WifiWhy = AllWifi("hidden by Windows: " + LocationWhy()); continue; }
            if (rc == 0x0000139F) { n.WifiWhy = AllWifi("the Wi-Fi adapter is not connected"); continue; }   // ERROR_INVALID_STATE
            if (rc != 0 || data == IntPtr.Zero) { n.WifiWhy = AllWifi("Windows would not say (error " + rc + ")"); continue; }
            var c = (N.WLAN_CONNECTION_ATTRIBUTES)Marshal.PtrToStructure(data, typeof(N.WLAN_CONNECTION_ATTRIBUTES));
            var a = c.wlanAssociationAttributes;
            int len = (int)a.dot11Ssid.uSSIDLength;
            if (a.dot11Ssid.ucSSID != null && len > 0 && len <= 32) n.Ssid = Encoding.UTF8.GetString(a.dot11Ssid.ucSSID, 0, len);
            else w["ssid"] = "hidden by Windows: " + LocationWhy();
            n.ConnType = Phy(a.dot11PhyType);
            if (n.ConnType == null) w["connType"] = "Windows reports Wi-Fi PHY type " + a.dot11PhyType + ", which has no 802.11 name here";
            n.Signal = (long)Math.Min(100u, a.wlanSignalQuality);   // already 0-100
          } catch (Exception ex) {
            n.WifiWhy = AllWifi("the Wi-Fi details could not be read (" + ex.GetType().Name + ")");
          } finally { if (data != IntPtr.Zero) N.WlanFreeMemory(data); }
        }
      } finally { N.WlanCloseHandle(h, IntPtr.Zero); }
    }

    static Dictionary<string, string> AllWifi(string why) {
      var d = new Dictionary<string, string>();
      foreach (string k in WifiKeys) d[k] = why;
      return d;
    }

    static string Phy(uint t) {
      switch (t) {
        case 4: return "802.11a"; case 5: return "802.11b"; case 6: return "802.11g"; case 7: return "802.11n";
        case 8: return "802.11ac"; case 9: return "802.11ad"; case 10: return "802.11ax"; case 11: return "802.11be";
        default: return null;
      }
    }

    static string LocationWhy() {
      const string K = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location";
      string machine = RegStr(Registry.LocalMachine, K), user = RegStr(Registry.CurrentUser, K), desktop = RegStr(Registry.CurrentUser, K + @"\NonPackaged");
      if (machine != null && machine != "Allow") return "location services are off for this PC (Settings > Privacy & security > Location)";
      if (user != null && user != "Allow") return "Location access is off for your account (Settings > Privacy & security > Location)";
      if (desktop != null && desktop != "Allow") return "Location access is off for desktop apps (Settings > Privacy & security > Location > Let desktop apps access your location)";
      return "Windows shares Wi-Fi details only with apps allowed to see your location";
    }

    static string RegStr(RegistryKey hive, string path) {
      try { using (RegistryKey k = hive.OpenSubKey(path)) return k == null ? null : k.GetValue("Value") as string; }
      catch (Exception) { return null; }
    }

    // ------------------------------------------------------------------ PDH

    const string Opening = "opening Windows' performance counters (in the background; the first sample after a pause has none)";

    /// Opens the light query on the thread pool (adding wildcard counters took ~0.3-0.8 s when measured;
    /// the Slow lane is shared). Until it is open the sample answers null with why = Opening.
    static void OpenLight() {
      if (_lq != IntPtr.Zero || _lqOpening) return;
      _lqOpening = true;
      ThreadPool.QueueUserWorkItem(delegate (object o) {
        IntPtr q, a = IntPtr.Zero, b = IntPtr.Zero, c = IntPtr.Zero, d = IntPtr.Zero, e = IntPtr.Zero, f = IntPtr.Zero, g = IntPtr.Zero;
        string qErr = null, memErr = null, idleErr = null;
        int rc = N.PdhOpenQueryW(null, IntPtr.Zero, out q);
        if (rc != 0) { q = IntPtr.Zero; qErr = "Windows would not open a performance-counter query (PDH 0x" + rc.ToString("X8") + ")"; }
        else {
          memErr = Add(q, "\\Memory\\Standby Cache Core Bytes", out a) ?? Add(q, "\\Memory\\Standby Cache Normal Priority Bytes", out b)
                ?? Add(q, "\\Memory\\Standby Cache Reserve Bytes", out c) ?? Add(q, "\\Memory\\Modified Page List Bytes", out d)
                ?? Add(q, "\\Memory\\Free & Zero Page List Bytes", out e);
          idleErr = Add(q, "\\PhysicalDisk(*)\\% Idle Time", out f) ?? Add(q, "\\PhysicalDisk(*)\\Current Disk Queue Length", out g);
        }
        lock (_gate) {
          _lqOpening = false;
          if (q == IntPtr.Zero) { _lqErr = qErr; return; }
          if (Abandoned()) { N.PdhCloseQuery(q); return; }
          _lq = q; _cStbCore = a; _cStbNorm = b; _cStbRes = c; _cMod = d; _cFree = e; _cIdle = f; _cQueue = g;
          _lqErr = null; _memErr = memErr; _idleErr = idleErr; _lightAt = -1;
        }
      });
    }

    static void OpenFull() {
      if (_fq != IntPtr.Zero || _fqOpening) return;
      _fqOpening = true;
      ThreadPool.QueueUserWorkItem(delegate (object o) {
        IntPtr q, a = IntPtr.Zero, b = IntPtr.Zero, c = IntPtr.Zero, d = IntPtr.Zero;
        string qErr = null, perfErr = null, diskErr = null;
        int rc = N.PdhOpenQueryW(null, IntPtr.Zero, out q);
        if (rc != 0) { q = IntPtr.Zero; qErr = "Windows would not open a performance-counter query (PDH 0x" + rc.ToString("X8") + ")"; }
        else {
          perfErr = Add(q, "\\Processor Information(_Total)\\% Processor Performance", out a);
          diskErr = Add(q, "\\PhysicalDisk(*)\\Avg. Disk sec/Transfer", out b) ?? Add(q, "\\PhysicalDisk(*)\\Disk Read Bytes/sec", out c)
                 ?? Add(q, "\\PhysicalDisk(*)\\Disk Write Bytes/sec", out d);
        }
        lock (_gate) {
          _fqOpening = false;
          if (q == IntPtr.Zero) { _fqErr = qErr; return; }
          if (Abandoned()) { N.PdhCloseQuery(q); return; }
          _fq = q; _cPerf = a; _cResp = b; _cRead = c; _cWrite = d;
          _fqErr = null; _perfErr = perfErr; _diskRateErr = diskErr; _fullAt = -1;
        }
      });
    }

    /// True when nobody has asked for a minute (the idle timer already closed everything): an open that
    /// finishes then is closed at once instead of being kept with no timer to close it.
    static bool Abandoned() { return _lastCallMs >= 0 && _clock.ElapsedMilliseconds - _lastCallMs >= IdleCloseMs; }

    static string Add(IntPtr q, string path, out IntPtr c) {
      int rc = N.PdhAddEnglishCounterW(q, path, IntPtr.Zero, out c);
      if (rc == 0) return null;
      c = IntPtr.Zero;
      return "Windows has no " + path + " counter here (PDH 0x" + rc.ToString("X8") + "), so this cannot be measured";
    }

    /// The single value of a counter (the first instance), NaN when unreadable.
    static double One(IntPtr c) {
      var l = ReadArray(c);
      return l == null || l.Count == 0 ? double.NaN : l[0].Value;
    }

    /// name -> value for a counter; an instance whose value is not valid this time is NaN (kept, so the
    /// instance list is whole). Null when the read failed.
    static List<KeyValuePair<string, double>> ReadArray(IntPtr c) {
      if (c == IntPtr.Zero) return null;
      uint size = 0, count;
      int rc = N.PdhGetFormattedCounterArrayW(c, FMT, ref size, out count, IntPtr.Zero);
      if (size == 0) return rc == 0 ? new List<KeyValuePair<string, double>>() : null;
      if (size > _bufLen) { if (_buf != IntPtr.Zero) Marshal.FreeHGlobal(_buf); _bufLen = (int)size * 2; _buf = Marshal.AllocHGlobal(_bufLen); }
      size = (uint)_bufLen;
      rc = N.PdhGetFormattedCounterArrayW(c, FMT, ref size, out count, _buf);
      if (rc != 0) return null;
      var list = new List<KeyValuePair<string, double>>((int)count);
      int stride = IntPtr.Size == 8 ? 24 : 16;   // {LPWSTR name; {DWORD status; double value}}
      int voff = IntPtr.Size == 8 ? 16 : 8;
      for (int i = 0; i < count; i++) {
        IntPtr at = new IntPtr(_buf.ToInt64() + (long)i * stride);
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(at)) ?? "";
        int status = Marshal.ReadInt32(at, IntPtr.Size);
        double v = status == 0 || status == 1 ? BitConverter.Int64BitsToDouble(Marshal.ReadInt64(at, voff)) : double.NaN;   // VALID_DATA / NEW_DATA
        list.Add(new KeyValuePair<string, double>(name, v));
      }
      return list;
    }

    static void IdleTick(object state) {
      lock (_gate) {
        if (_lastCallMs < 0 || _clock.ElapsedMilliseconds - _lastCallMs < IdleCloseMs) return;
        if (_lq != IntPtr.Zero) N.PdhCloseQuery(_lq);
        if (_fq != IntPtr.Zero) N.PdhCloseQuery(_fq);
        _lq = _fq = IntPtr.Zero;
        _cStbCore = _cStbNorm = _cStbRes = _cMod = _cFree = _cIdle = _cQueue = _cPerf = _cResp = _cRead = _cWrite = IntPtr.Zero;
        _lightAt = _fullAt = _sysAt = _coresAt = -1;
        _nics = null; _nicsAt = -1; _bgFullAt = _fullAskAt = -1; _compressed = null; _compressedWhy = null;
        if (_buf != IntPtr.Zero) { Marshal.FreeHGlobal(_buf); _buf = IntPtr.Zero; _bufLen = 0; }
        if (_idle != null) { _idle.Dispose(); _idle = null; }
      }
    }

    // ------------------------------------------------------------------ static facts (background thread)

    static void ReadStatic() {
      IDictionary st;
      try { st = StaticFacts(); }
      catch (Exception ex) {
        string w = "reading the hardware facts failed (" + ex.GetType().Name + ")";
        st = Obj("cpu", Obj(), "mem", Obj(), "why", Obj("cpu", w, "mem", w));
      }
      lock (_sgate) _static = st;
    }

    static IDictionary StaticFacts() {
      var why = new OrderedDictionaryLite();
      var cpu = Obj("name", null, "baseGHz", null, "sockets", null, "cores", null, "logical", null, "l1KB", null, "l2KB", null, "l3KB", null, "virtualization", null);
      var mem = Obj("speedMTs", null, "slotsUsed", null, "slotsTotal", null, "formFactor", null, "hardwareReserved", null);

      string name = null;
      try { using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0")) name = k == null ? null : k.GetValue("ProcessorNameString") as string; }
      catch (Exception) { name = null; }
      if (!string.IsNullOrEmpty(name)) cpu["name"] = System.Text.RegularExpressions.Regex.Replace(name.Trim(), "\\s+", " ");
      else why["cpu.name"] = "Windows has no processor name in the registry";

      int mhz;
      lock (_gate) mhz = BaseMhz();
      if (mhz > 0) cpu["baseGHz"] = Math.Round(mhz / 1000.0, 2); else why["cpu.baseGHz"] = _baseErr ?? "Windows reported no base speed";

      Topology(cpu, why);

      // virtualization: a running hypervisor (Hyper-V, WSL 2, memory integrity) means Enabled; the
      // firmware switch hides behind it, so the firmware flag is asked only when none is running
      string we;
      object hv = Wmi("SELECT HypervisorPresent FROM Win32_ComputerSystem", "HypervisorPresent", out we);
      bool fw = N.IsProcessorFeaturePresent(21);   // PF_VIRT_FIRMWARE_ENABLED
      if (hv is bool && (bool)hv || fw) cpu["virtualization"] = "Enabled";
      else if (hv is bool) cpu["virtualization"] = "Disabled";
      else why["cpu.virtualization"] = "could not ask Windows whether a hypervisor is running (" + (we ?? "no answer") + "), and the firmware flag alone cannot say Disabled";

      Smbios(mem, why);

      ulong kb;
      var pi = new N.PERFINFO();
      pi.cb = (uint)Marshal.SizeOf(typeof(N.PERFINFO));
      if (N.GetPhysicallyInstalledSystemMemory(out kb) && N.GetPerformanceInfo(ref pi, pi.cb)) {
        long usable = (long)pi.PhysicalTotal.ToUInt64() * (long)pi.PageSize.ToUInt64();
        mem["hardwareReserved"] = Math.Max(0L, (long)kb * 1024 - usable);
      } else why["mem.hardwareReserved"] = "Windows did not report the installed memory (error " + Marshal.GetLastWin32Error() + ")";
      return Obj("cpu", cpu, "mem", mem, "why", why);
    }

    static void Topology(IDictionary cpu, IDictionary why) {
      uint len = 0;
      N.GetLogicalProcessorInformationEx(0xFFFF, IntPtr.Zero, ref len);
      if (len == 0) { string w = "Windows did not describe the processor layout (error " + Marshal.GetLastWin32Error() + ")"; foreach (string k in new string[] { "sockets", "cores", "logical", "l1KB", "l2KB", "l3KB" }) why["cpu." + k] = w; return; }
      IntPtr b = Marshal.AllocHGlobal((int)len);
      try {
        if (!N.GetLogicalProcessorInformationEx(0xFFFF, b, ref len)) { string w = "Windows did not describe the processor layout (error " + Marshal.GetLastWin32Error() + ")"; foreach (string k in new string[] { "sockets", "cores", "logical", "l1KB", "l2KB", "l3KB" }) why["cpu." + k] = w; return; }
        int sockets = 0, cores = 0, logical = 0;
        long l1 = 0, l2 = 0, l3 = 0;
        long off = 0;
        int maskStride = IntPtr.Size + 8;   // GROUP_AFFINITY {KAFFINITY Mask; WORD Group; WORD Reserved[3]}
        while (off + 8 <= len) {
          IntPtr p = new IntPtr(b.ToInt64() + off);
          int rel = Marshal.ReadInt32(p, 0), size = Marshal.ReadInt32(p, 4);
          if (size <= 0) break;
          if (rel == 0) {   // RelationProcessorCore: PROCESSOR_RELATIONSHIP {Flags, EfficiencyClass, Reserved[20], GroupCount, GroupMask[]}
            cores++;
            int gc = Marshal.ReadInt16(p, 8 + 22);
            for (int gi = 0; gi < gc; gi++) {
              long mask = IntPtr.Size == 8 ? Marshal.ReadInt64(p, 8 + 24 + gi * maskStride) : Marshal.ReadInt32(p, 8 + 24 + gi * maskStride);
              for (; mask != 0; mask &= mask - 1) logical++;
            }
          } else if (rel == 3) sockets++;   // RelationProcessorPackage
          else if (rel == 2) {              // RelationCache: CACHE_RELATIONSHIP {Level, Associativity, LineSize, CacheSize, Type...}
            int level = Marshal.ReadByte(p, 8);
            long sz = (uint)Marshal.ReadInt32(p, 12);
            if (level == 1) l1 += sz; else if (level == 2) l2 += sz; else if (level == 3) l3 += sz;
          }
          off += size;
        }
        cpu["sockets"] = sockets; cpu["cores"] = cores; cpu["logical"] = logical;
        if (l1 > 0) cpu["l1KB"] = l1 / 1024; else why["cpu.l1KB"] = "the processor reports no L1 cache";
        if (l2 > 0) cpu["l2KB"] = l2 / 1024; else why["cpu.l2KB"] = "the processor reports no L2 cache";
        if (l3 > 0) cpu["l3KB"] = l3 / 1024; else why["cpu.l3KB"] = "the processor reports no L3 cache";
      } finally { Marshal.FreeHGlobal(b); }
    }

    /// SMBIOS type 17 (Memory Device): Size 0x0C (0 = empty slot, 0x7FFF = see 0x1C), Form Factor 0x0E,
    /// Speed 0x15, Configured Memory Speed 0x20 (the speed it runs at; preferred), extended speeds 0x54/0x58.
    static void Smbios(IDictionary mem, IDictionary why) {
      const uint RSMB = 0x52534D42;
      uint size = N.GetSystemFirmwareTable(RSMB, 0, IntPtr.Zero, 0);
      string[] keys = { "speedMTs", "slotsUsed", "slotsTotal", "formFactor" };
      if (size == 0) { string w = "Windows did not hand over the firmware's memory table (error " + Marshal.GetLastWin32Error() + ")"; foreach (string k in keys) why["mem." + k] = w; return; }
      IntPtr b = Marshal.AllocHGlobal((int)size);
      byte[] t;
      try {
        uint got = N.GetSystemFirmwareTable(RSMB, 0, b, size);
        if (got == 0 || got > size) { string w = "Windows did not hand over the firmware's memory table (error " + Marshal.GetLastWin32Error() + ")"; foreach (string k in keys) why["mem." + k] = w; return; }
        t = new byte[got];
        Marshal.Copy(b, t, 0, (int)got);
      } finally { Marshal.FreeHGlobal(b); }
      if (t.Length < 8) { foreach (string k in keys) why["mem." + k] = "the firmware's memory table is empty"; return; }
      int end = Math.Min(t.Length, 8 + BitConverter.ToInt32(t, 4));
      int pos = 8, slots = 0, used = 0, speed = 0, ff = -1;
      while (pos + 4 <= end) {
        int type = t[pos], flen = t[pos + 1];
        if (flen < 4 || pos + flen > end) break;
        if (type == 17) {
          slots++;
          int sz = flen > 0x0D ? BitConverter.ToUInt16(t, pos + 0x0C) : 0xFFFF;
          if (sz != 0) {
            used++;
            if (ff < 0 && flen > 0x0E) ff = t[pos + 0x0E];
            int sp = 0;
            if (flen > 0x21) { sp = BitConverter.ToUInt16(t, pos + 0x20); if (sp == 0xFFFF && flen > 0x5B) sp = BitConverter.ToInt32(t, pos + 0x58); }
            if ((sp == 0 || sp == 0xFFFF) && flen > 0x16) { sp = BitConverter.ToUInt16(t, pos + 0x15); if (sp == 0xFFFF && flen > 0x57) sp = BitConverter.ToInt32(t, pos + 0x54); }
            if (sp > 0 && sp != 0xFFFF && sp > speed) speed = sp;
          }
        }
        if (type == 127) break;   // end-of-table
        int q = pos + flen;
        while (q + 1 < end && !(t[q] == 0 && t[q + 1] == 0)) q++;
        pos = q + 2;
      }
      if (slots == 0) { foreach (string k in keys) why["mem." + k] = "the firmware lists no memory devices"; return; }
      mem["slotsTotal"] = slots; mem["slotsUsed"] = used;
      if (speed > 0) mem["speedMTs"] = speed; else why["mem.speedMTs"] = "the firmware does not report the memory speed";
      string fname = FormFactor(ff);
      if (fname != null) mem["formFactor"] = fname; else why["mem.formFactor"] = ff < 0 ? "the firmware does not report the form factor" : "the firmware reports form factor " + ff + ", which has no name here";
    }

    static string FormFactor(int f) {
      switch (f) {
        case 1: return "Other"; case 3: return "SIMM"; case 4: return "SIP"; case 5: return "Chip"; case 6: return "DIP"; case 7: return "ZIP";
        case 8: return "Proprietary card"; case 9: return "DIMM"; case 10: return "TSOP"; case 11: return "Row of chips"; case 12: return "RIMM";
        case 13: return "SODIMM"; case 14: return "SRIMM"; case 15: return "FB-DIMM"; case 16: return "Die"; case 17: return "CAMM";
        case 18: return "CUDIMM"; case 19: return "CSODIMM";
        default: return null;   // 2 = Unknown
      }
    }

    static object Wmi(string query, string prop, out string err) {
      err = null;
      try {
        var opt = new System.Management.EnumerationOptions();
        opt.Timeout = TimeSpan.FromSeconds(10);
        opt.ReturnImmediately = true;
        opt.Rewindable = false;
        using (var s = new System.Management.ManagementObjectSearcher(new System.Management.ManagementScope(@"root\cimv2"), new System.Management.ObjectQuery(query), opt))
        using (System.Management.ManagementObjectCollection rows = s.Get()) {
          foreach (System.Management.ManagementBaseObject o in rows) { using (o) return o[prop]; }
        }
        err = "WMI had no answer";
        return null;
      } catch (Exception ex) { err = "WMI did not answer (" + ex.GetType().Name + ")"; return null; }
    }
  }
}
