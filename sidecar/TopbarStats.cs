// TopbarStats.cs - `topbar.stats`: the live system numbers on the right of the top bar
// (wave 3, 2026-09-24). Owen: "i also want the top bar to show stats about my computer like ram
// cpu gpu etc." and "i want it to update every 1 sec".
//
// WHY HERE and not lib/sys-stats.js: that file reads CPU from os.cpus() deltas held in ONE
// module-level "previous" sample, so a second caller at a different rate would corrupt the
// desktop tile's number, and Node has no GPU or network counters at all. So: ONE sampler thread
// in the sidecar, ONE sample a second, pushed as an event (never polled per stat), every number
// from the same instant so they move together.
//
// SOURCES, all long-lived (opened once, collected once a second; no process spawned, no WMI):
//   CPU   PDH \Processor Information(*)\% Processor Utility - the counter Task Manager shows
//         (it can pass 100 on turbo; clamped, as Task Manager does). Per core from the same query.
//   RAM   GlobalMemoryStatusEx: in use = total - available, and commit.
//   GPU   PDH \GPU Engine(*)\Utilization Percentage, Task Manager's method: sum each engine
//         over processes, the adapter is its busiest engine. \GPU Adapter Memory(*)\Dedicated
//         and Shared Usage for memory. This machine (2026-09-24) has one Intel UHD (integrated),
//         so dedicated memory is small and shared is the real figure; both are shown.
//   NET   PDH \Network Interface(*)\Bytes Received/sec and Bytes Sent/sec, summed.
//   PING  sidecar/TopbarPing.cs: one ICMP echo every 2 s (1 s timeout) to 1.1.1.1, 8.8.8.8 as the
//         fallback, started from this thread's tick and answered on the thread pool (lane
//         topbar-ping, 2026-10-09). It pauses with everything else here.
//   TOP 5 (only while a stat's dropdown is open, 10 s after the last ask): one
//         NtQuerySystemInformation(SystemProcessInformation) snapshot - every process's CPU time
//         and private working set in a single call, no handle opened on any process.
// NO TEMPERATURES: there is no real sensor source on this machine (no NVIDIA card for NVML; the
// ACPI thermal zone needs admin and reports a fixed value on many laptops). Nothing is invented.
//
// PAUSED while nobody can see it: the page turns it off when the bar is hidden (a full-screen
// app), and a hidden window here listens for the session lock and the display turning off.
//
// C# 5 (see build.ps1).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Mantle {
  static class StatsNative {
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhOpenQueryW(string src, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] public static extern int PdhCollectQueryData(IntPtr q);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhGetFormattedCounterArrayW(IntPtr counter, uint fmt, ref uint size, out uint count, IntPtr buf);
    [DllImport("pdh.dll")] public static extern int PdhCloseQuery(IntPtr q);
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
    [DllImport("kernel32.dll")] public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);
    [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll")] public static extern bool GetThreadTimes(IntPtr t, out long create, out long exit, out long kernel, out long user);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public int StateFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevicesW(string dev, uint i, ref DISPLAY_DEVICE dd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr RegisterPowerSettingNotification(IntPtr h, ref Guid g, int flags);
    [DllImport("wtsapi32.dll")] public static extern bool WTSRegisterSessionNotification(IntPtr h, int flags);
  }

  [MantleFeature]
  static class TopbarStats {
    public static void Register(FeatureTable t) {
      t.Add("topbar.stats", Lanes.Ui, StatsCmd);   // on:bool [, detail:"cpu"|"mem"|"gpu"|"net"]
    }

    const int PeriodMs = 1000;
    // THE GPU EVERY 2 S (lane mantle-idlefix-stats, 2026-10-17): \GPU Engine(*) has one instance per process
    // per engine (hundreds), the costliest counter here to collect and parse, so it is its own query,
    // collected every GpuEveryMs (every tick while a dropdown's detail is asked: its top processes stay 1 s).
    // The figure keeps its meaning: Utilization Percentage is a rate between two collections, so a 2 s
    // collection is the same busiest-engine utilization, averaged over 2 s; the tick between repeats it
    // (gpu.at says when it was read). Its memory (GPU Adapter Memory, a few instances) stays every second.
    const int GpuEveryMs = 2000;
    const uint PDH_FMT_DOUBLE = 0x200, PDH_FMT_NOCAP100 = 0x8000;
    static readonly object _gate = new object();
    static Thread _thread;
    static volatile bool _on;
    static bool _wasOn;
    static volatile bool _locked, _displayOff;
    static long _detailUntil;        // Environment.TickCount64-ish: DateTime ticks
    static string _detailKind;
    static AutoResetEvent _wake = new AutoResetEvent(false);
    static WatchWindow _watch;

    static string StatsCmd(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      string detail = Json.GetString(req, "detail");
      if (!string.IsNullOrEmpty(detail) && detail != "ping") {   // the ping has no top processes
        _detailKind = detail;
        Interlocked.Exchange(ref _detailUntil, DateTime.UtcNow.AddSeconds(10).Ticks);
        _wake.Set();   // a sample with the top processes now, not up to a second from now
      }
      if (on && _watch == null) _watch = WatchWindow.Create();   // this is the ui lane: the window's messages arrive here
      bool existed;
      lock (_gate) {
        _on = on;
        existed = _thread != null;
        if (on && _thread == null) {
          _thread = new Thread(Loop);
          _thread.IsBackground = true;
          _thread.Name = "topbar-stats";
          // Normal, not BelowNormal: measured 2026-09-24, a BelowNormal sampler under a busy CPU
          // missed whole seconds (a 3 s gap). The work itself is a few ms a second.
          _thread.Priority = ThreadPriority.Normal;
          _thread.Start();
        }
      }
      if (on && existed && !_wasOn) _wake.Set();   // resume a paused loop; a new one samples at once by itself
      _wasOn = on;
      result = Json.Obj("on", on, "periodMs", PeriodMs, "gpuEveryMs", GpuEveryMs, "pingEveryMs", TopbarPing.EveryMs, "watch", _watch != null ? _watch.Why : "no watch window");
      return null;
    }

    // ------------------------------------------------------------------ the sampler thread

    sealed class Query {
      public IntPtr Q, GQ, CpuAll, Gpu, GpuDed, GpuShr, NetRx, NetTx;   // GQ: the GPU engines' own query (GpuEveryMs)
      public string CpuErr, GpuErr, GpuMemErr, NetErr;
    }

    static Query Open() {
      var q = new Query();
      int rc = StatsNative.PdhOpenQueryW(null, IntPtr.Zero, out q.Q);
      if (rc != 0) { q.CpuErr = q.GpuErr = q.NetErr = "Windows would not open a performance-counter query (PDH 0x" + rc.ToString("X8") + ")"; return q; }
      q.CpuErr = Add(q.Q, "\\Processor Information(*)\\% Processor Utility", out q.CpuAll);
      int grc = StatsNative.PdhOpenQueryW(null, IntPtr.Zero, out q.GQ);
      if (grc != 0) { q.GQ = IntPtr.Zero; q.GpuErr = "Windows would not open the GPU's performance-counter query (PDH 0x" + grc.ToString("X8") + ")"; }
      else { q.GpuErr = Add(q.GQ, "\\GPU Engine(*)\\Utilization Percentage", out q.Gpu); StatsNative.PdhCollectQueryData(q.GQ); }   // its baseline
      q.GpuMemErr = Add(q.Q, "\\GPU Adapter Memory(*)\\Dedicated Usage", out q.GpuDed) ?? Add(q.Q, "\\GPU Adapter Memory(*)\\Shared Usage", out q.GpuShr);
      q.NetErr = Add(q.Q, "\\Network Interface(*)\\Bytes Received/sec", out q.NetRx) ?? Add(q.Q, "\\Network Interface(*)\\Bytes Sent/sec", out q.NetTx);
      StatsNative.PdhCollectQueryData(q.Q);   // rates need two collections; the first is the baseline
      return q;
    }

    static string Add(IntPtr q, string path, out IntPtr c) {
      int rc = StatsNative.PdhAddEnglishCounterW(q, path, IntPtr.Zero, out c);
      if (rc == 0) return null;
      c = IntPtr.Zero;
      return "Windows has no " + path + " counter here (PDH 0x" + rc.ToString("X8") + "), so this cannot be measured";
    }

    static IntPtr _buf = IntPtr.Zero;
    static int _bufLen;

    /// name -> value for a wildcard counter, or null when the read failed.
    static List<KeyValuePair<string, double>> Read(IntPtr c, uint fmt) {
      if (c == IntPtr.Zero) return null;
      uint size = 0, count;
      int rc = StatsNative.PdhGetFormattedCounterArrayW(c, fmt, ref size, out count, IntPtr.Zero);
      if (size == 0) return rc == 0 ? new List<KeyValuePair<string, double>>() : null;
      if (size > _bufLen) { if (_buf != IntPtr.Zero) Marshal.FreeHGlobal(_buf); _bufLen = (int)size * 2; _buf = Marshal.AllocHGlobal(_bufLen); }
      size = (uint)_bufLen;
      rc = StatsNative.PdhGetFormattedCounterArrayW(c, fmt, ref size, out count, _buf);
      if (rc != 0) return null;
      var list = new List<KeyValuePair<string, double>>((int)count);
      int stride = IntPtr.Size == 8 ? 24 : 16;   // {LPWSTR name; {DWORD status; double value}}
      int voff = IntPtr.Size == 8 ? 16 : 8;
      for (int i = 0; i < count; i++) {
        IntPtr at = new IntPtr(_buf.ToInt64() + (long)i * stride);
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(at));
        int status = Marshal.ReadInt32(at, IntPtr.Size);
        if (status != 0 && status != 1) continue;   // PDH_CSTATUS_VALID_DATA / NEW_DATA
        list.Add(new KeyValuePair<string, double>(name ?? "", BitConverter.Int64BitsToDouble(Marshal.ReadInt64(at, voff))));
      }
      return list;
    }

    static void Loop() {
      Query q = null;
      var clock = Stopwatch.StartNew();
      long next = 0;
      bool wasPaused = false;
      try {
        q = Open();
        next = clock.ElapsedMilliseconds;   // opening the counters takes ~1 s the first time: the grid starts after it
        while (true) {
          if (!_on) { TopbarPing.Reset(); _wake.WaitOne(); next = clock.ElapsedMilliseconds; continue; }
          string pause = _locked ? "the session is locked" : _displayOff ? "the screen is off" : null;
          if (pause != null) {
            if (!wasPaused) { TopbarPing.Reset(); Features.Event("topbarstats", Json.Obj("paused", true, "reason", pause)); }
            wasPaused = true;
            _wake.WaitOne(PeriodMs);
            next = clock.ElapsedMilliseconds;
            continue;
          }
          wasPaused = false;
          long wait = next - clock.ElapsedMilliseconds;
          bool early = false;
          if (wait > 0) { early = _wake.WaitOne((int)wait); if (!_on) continue; }
          long at0 = clock.ElapsedMilliseconds;
          // a 1 s grid; a late tick never bunches up, and an early one (a detail ask) restarts the grid
          next = early ? at0 + PeriodMs : Math.Max(next + PeriodMs, at0);
          long k0, u0, x, y;
          StatsNative.GetThreadTimes(StatsNative.GetCurrentThread(), out x, out y, out k0, out u0);
          var sw = Stopwatch.StartNew();
          IDictionary sample = Sample(q, at0);
          sample["ping"] = TopbarPing.Step(clock.ElapsedMilliseconds);   // starts an echo every 2 s; the reply lands off this thread
          long k1, u1;
          StatsNative.GetThreadTimes(StatsNative.GetCurrentThread(), out x, out y, out k1, out u1);
          sample["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 2);
          sample["at"] = clock.ElapsedMilliseconds;   // the sidecar's own clock, for spacing checks
          sample["costMs"] = Math.Round(((k1 - k0) + (u1 - u0)) / 10000.0, 2);   // this thread's CPU time for the tick
          Features.Event("topbarstats", sample);
        }
      } catch (Exception ex) {
        Features.Event("topbarstats", Json.Obj("paused", true, "reason", "the stats sampler stopped: " + ex.GetType().Name + ": " + ex.Message));
        lock (_gate) _thread = null;
      }
    }

    static readonly Regex GpuInst = new Regex("^pid_(\\d+)_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_(\\d+)_eng_(\\d+)_engtype_(.*)$", RegexOptions.Compiled);
    static string _gpuName;

    // the last GPU engine read (GpuEveryMs): repeated on the tick between two reads
    sealed class GpuRead { public object Pct; public List<object> Engines; public Dictionary<int, double> PerPid; public string Reason; public long At; }
    static GpuRead _gpuLast;

    /// True when the GPU engines are read this tick: none read yet, a detail asked (its top processes are
    /// per tick), or GpuEveryMs since the last read (half a period of slack: a 1 s grid tick that lands
    /// a few ms early still reads every 2nd tick, not every 3rd).
    static bool GpuDue(GpuRead last, bool detail, long nowMs) {
      return last == null || detail || nowMs - last.At >= GpuEveryMs - PeriodMs / 2;
    }

    static GpuRead ReadGpu(Query q, long nowMs) {
      var g = new GpuRead();
      g.At = nowMs;
      int grc = q.GQ == IntPtr.Zero ? -1 : StatsNative.PdhCollectQueryData(q.GQ);
      List<KeyValuePair<string, double>> ge = grc == 0 ? Read(q.Gpu, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100) : null;
      if (ge == null) { g.Reason = q.GpuErr ?? "the GPU counters could not be read this time"; return g; }
      var engine = new Dictionary<string, double>();     // luid|phys|eng -> summed over processes
      var engType = new Dictionary<string, string>();
      var perPid = new Dictionary<int, double>();
      foreach (var kv in ge) {
        Match mm = GpuInst.Match(kv.Key);
        if (!mm.Success) continue;
        string key = mm.Groups[2].Value + "|" + mm.Groups[3].Value + "|" + mm.Groups[4].Value;
        double v; engine.TryGetValue(key, out v); engine[key] = v + kv.Value;
        engType[key] = mm.Groups[5].Value;
        int pid = int.Parse(mm.Groups[1].Value, CultureInfo.InvariantCulture);
        double pv; perPid.TryGetValue(pid, out pv); perPid[pid] = Math.Max(pv, kv.Value);
      }
      double busiest = 0;
      var byType = new Dictionary<string, double>();
      foreach (var kv in engine) {
        busiest = Math.Max(busiest, kv.Value);
        string ty = engType[kv.Key];
        double tv; byType.TryGetValue(ty, out tv); byType[ty] = Math.Max(tv, kv.Value);
      }
      var engs = new List<object>();
      foreach (var kv in byType) if (kv.Value >= 0.05 || kv.Key == "3D") engs.Add(Json.Obj("type", kv.Key, "pct", Math.Round(Clamp(kv.Value), 1)));
      g.Pct = engine.Count == 0 ? null : (object)Math.Round(Clamp(busiest), 1);
      g.Engines = engs;
      g.PerPid = perPid;
      g.Reason = engine.Count == 0 ? "no GPU engine reported any work in the last reading" : null;
      return g;
    }

    static IDictionary Sample(Query q, long nowMs) {
      int rc = StatsNative.PdhCollectQueryData(q.Q);
      bool detail = DateTime.UtcNow.Ticks < Interlocked.Read(ref _detailUntil);
      Dictionary<int, double> cpuByPid = null;
      Dictionary<int, long> memByPid = null;
      Dictionary<int, string> names = null;
      if (detail) Processes(out cpuByPid, out memByPid, out names);

      // CPU
      IDictionary cpu;
      List<KeyValuePair<string, double>> cp = rc == 0 ? Read(q.CpuAll, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100) : null;
      if (cp == null) cpu = Json.Obj("pct", null, "reason", q.CpuErr ?? "the CPU counters could not be read this second");
      else {
        double total = double.NaN;
        var cores = new List<KeyValuePair<string, double>>();
        foreach (var kv in cp) {
          if (kv.Key == "_Total") total = kv.Value;
          else if (kv.Key.IndexOf("_Total", StringComparison.Ordinal) < 0) cores.Add(kv);
        }
        cores.Sort(delegate (KeyValuePair<string, double> a, KeyValuePair<string, double> b) { return CoreKey(a.Key).CompareTo(CoreKey(b.Key)); });
        var cl = new List<object>();
        foreach (var kv in cores) cl.Add(Math.Round(Clamp(kv.Value), 1));
        cpu = Json.Obj("pct", double.IsNaN(total) ? null : (object)Math.Round(Clamp(total), 1), "cores", cl,
                       "top", cpuByPid == null ? null : Top(cpuByPid, names, 5, true));
      }

      // RAM
      var m = new StatsNative.MEMORYSTATUSEX();
      m.dwLength = (uint)Marshal.SizeOf(typeof(StatsNative.MEMORYSTATUSEX));
      IDictionary mem = StatsNative.GlobalMemoryStatusEx(ref m)
        ? Json.Obj("used", (double)(m.ullTotalPhys - m.ullAvailPhys), "total", (double)m.ullTotalPhys,
                   "commit", (double)(m.ullTotalPageFile - m.ullAvailPageFile), "commitLimit", (double)m.ullTotalPageFile,
                   "top", memByPid == null ? null : TopBytes(memByPid, names, 5))
        : Json.Obj("used", null, "reason", "Windows did not answer GlobalMemoryStatusEx");

      // GPU (Task Manager's method)
      IDictionary gpu;
      if (GpuDue(_gpuLast, detail, nowMs)) _gpuLast = ReadGpu(q, nowMs);
      GpuRead gr = _gpuLast;
      if (gr.Engines == null) gpu = Json.Obj("pct", null, "reason", gr.Reason, "at", gr.At, "everyMs", GpuEveryMs);
      else {
        double ded = SumAll(rc == 0 ? Read(q.GpuDed, PDH_FMT_DOUBLE) : null), shr = SumAll(rc == 0 ? Read(q.GpuShr, PDH_FMT_DOUBLE) : null);
        gpu = Json.Obj("pct", gr.Pct, "name", GpuName(), "engines", gr.Engines,
                       "dedicated", double.IsNaN(ded) ? null : (object)ded, "shared", double.IsNaN(shr) ? null : (object)shr,
                       "top", names == null ? null : Top(gr.PerPid, names, 5, false),
                       "reason", gr.Reason ?? q.GpuMemErr, "at", gr.At, "everyMs", GpuEveryMs);
      }

      // NET
      IDictionary net;
      List<KeyValuePair<string, double>> rx = rc == 0 ? Read(q.NetRx, PDH_FMT_DOUBLE) : null, tx = rc == 0 ? Read(q.NetTx, PDH_FMT_DOUBLE) : null;
      if (rx == null || tx == null) net = Json.Obj("down", null, "reason", q.NetErr ?? "the network counters could not be read this second");
      else {
        var ad = new List<object>();
        double down = 0, up = 0;
        foreach (var kv in rx) {
          double u = 0;
          foreach (var t in tx) if (t.Key == kv.Key) { u = t.Value; break; }
          down += kv.Value; up += u;
          if (kv.Value + u > 0 || ad.Count < 3) ad.Add(Json.Obj("name", kv.Key, "down", Math.Round(kv.Value), "up", Math.Round(u)));
        }
        net = Json.Obj("down", Math.Round(down), "up", Math.Round(up), "adapters", ad);
      }
      return Json.Obj("cpu", cpu, "mem", mem, "gpu", gpu, "net", net, "detail", detail ? _detailKind : null);
    }

    static double Clamp(double v) { return v < 0 ? 0 : v > 100 ? 100 : v; }
    static double SumAll(List<KeyValuePair<string, double>> l) { if (l == null) return double.NaN; double s = 0; foreach (var kv in l) s += kv.Value; return s; }
    static int CoreKey(string n) { int c = n.LastIndexOf(','); int v; return int.TryParse(c >= 0 ? n.Substring(c + 1) : n, out v) ? v : 999; }

    static string GpuName() {
      if (_gpuName != null) return _gpuName;
      var dd = new StatsNative.DISPLAY_DEVICE();
      dd.cb = Marshal.SizeOf(typeof(StatsNative.DISPLAY_DEVICE));
      string first = "";
      for (uint i = 0; StatsNative.EnumDisplayDevicesW(null, i, ref dd, 0); i++) {
        if (first.Length == 0) first = dd.DeviceString ?? "";
        if ((dd.StateFlags & 0x4) != 0) { first = dd.DeviceString ?? first; break; }   // DISPLAY_DEVICE_PRIMARY_DEVICE
        dd.cb = Marshal.SizeOf(typeof(StatsNative.DISPLAY_DEVICE));
      }
      _gpuName = first;
      return _gpuName;
    }

    // ------------------------------------------------------------------ processes (detail only)

    static IntPtr _pbuf = IntPtr.Zero;
    static int _plen = 1 << 20;
    static Dictionary<int, long> _prevCpu = new Dictionary<int, long>();
    static long _prevAt;

    // Per pid, from the same snapshot: start time and session, for the App power fields of the top
    // entries (the per-run cache in sidecar/AppPowerProc.cs is keyed by pid + start time).
    static Dictionary<int, long> _pCreated = new Dictionary<int, long>();
    static Dictionary<int, uint> _pSession = new Dictionary<int, uint>();

    /// One NtQuerySystemInformation(SystemProcessInformation) snapshot. x64 offsets of
    /// SYSTEM_PROCESS_INFORMATION: WorkingSetPrivateSize 0x08, CreateTime 0x20, UserTime 0x28, KernelTime 0x30,
    /// ImageName 0x38 (Length) / 0x40 (Buffer), UniqueProcessId 0x50, SessionId 0x64.
    static void Processes(out Dictionary<int, double> cpu, out Dictionary<int, long> mem, out Dictionary<int, string> names) {
      cpu = new Dictionary<int, double>();
      mem = new Dictionary<int, long>();
      names = new Dictionary<int, string>();
      _pCreated = new Dictionary<int, long>();
      _pSession = new Dictionary<int, uint>();
      if (IntPtr.Size != 8) return;
      int ret = 0, st = 0;
      for (int tries = 0; tries < 4; tries++) {
        if (_pbuf == IntPtr.Zero) _pbuf = Marshal.AllocHGlobal(_plen);
        st = StatsNative.NtQuerySystemInformation(5, _pbuf, _plen, out ret);
        if (st != unchecked((int)0xC0000004)) break;   // STATUS_INFO_LENGTH_MISMATCH
        Marshal.FreeHGlobal(_pbuf); _pbuf = IntPtr.Zero; _plen = Math.Max(_plen * 2, ret + 65536);
      }
      if (st != 0) return;
      long now = DateTime.UtcNow.Ticks;
      double span = _prevAt == 0 ? 0 : (now - _prevAt) * (double)Environment.ProcessorCount;
      var cur = new Dictionary<int, long>();
      long off = 0;
      while (true) {
        IntPtr p = new IntPtr(_pbuf.ToInt64() + off);
        int pid = (int)Marshal.ReadInt64(p, 0x50);
        long t = Marshal.ReadInt64(p, 0x28) + Marshal.ReadInt64(p, 0x30);
        if (pid != 0) {
          int len = Marshal.ReadInt16(p, 0x38) & 0xFFFF;
          IntPtr nb = Marshal.ReadIntPtr(p, 0x40);
          string n = nb == IntPtr.Zero ? "System" : Marshal.PtrToStringUni(nb, len / 2);
          if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
          names[pid] = n;
          _pCreated[pid] = Marshal.ReadInt64(p, 0x20);
          _pSession[pid] = (uint)Marshal.ReadInt32(p, 0x64);
          mem[pid] = Marshal.ReadInt64(p, 0x08);
          cur[pid] = t;
          long pt;
          if (span > 0 && _prevCpu.TryGetValue(pid, out pt) && t >= pt) cpu[pid] = 100.0 * (t - pt) / span;
        }
        int next = Marshal.ReadInt32(p, 0);
        if (next == 0) break;
        off += next;
      }
      _prevCpu = cur;
      _prevAt = now;
    }

    /// Top n by NAME (Task Manager groups chrome's 20 processes as one app; so does this), EXCEPT the
    /// generic hosts, grouped by name + full path: Mantle's electron, Helm's and a test instance's are
    /// separate rows (lane mantle-power-sidecar, 2026-10-14, the App power contract section 1). Every
    /// row also carries exe (the name as Windows reports it, no ".exe"), n (processes in the group),
    /// path (the group's full image path, or null) and access (sidecar/AppPowerProc.cs: "ok" when
    /// Mantle can change at least one of its processes). The path and the access are looked up once
    /// per run of a process (cached by pid + start time) and only for the generic hosts' processes
    /// and the processes of the rows returned, so a detail second stays cheap.
    static readonly HashSet<string> Generic = new HashSet<string>(
      new string[] { "electron", "node", "python", "pythonw", "py", "java", "javaw", "dotnet" }, StringComparer.OrdinalIgnoreCase);

    sealed class Grp { public string Exe, Path; public double V; public List<int> Pids = new List<int>(4); }

    static List<object> Top(Dictionary<int, double> byPid, Dictionary<int, string> names, int n, bool clampSum) {
      return Groups(byPid, names, n, false, true);
    }

    static List<object> TopBytes(Dictionary<int, long> byPid, Dictionary<int, string> names, int n) {
      var d = new Dictionary<int, double>();
      foreach (var kv in byPid) d[kv.Key] = kv.Value;
      return Groups(d, names, n, true, false);
    }

    static List<object> Groups(Dictionary<int, double> byPid, Dictionary<int, string> names, int n, bool bytes, bool unnamedToo) {
      var groups = new Dictionary<string, Grp>(StringComparer.OrdinalIgnoreCase);
      foreach (var kv in byPid) {
        string nm;
        bool named = names != null && names.TryGetValue(kv.Key, out nm);
        if (!named) { if (!unnamedToo) continue; nm = "pid " + kv.Key; }
        else nm = names[kv.Key];
        if (nm == "Idle") continue;
        string key = nm, path = null;
        if (named && Generic.Contains(nm)) {
          path = AppPower.PathOf((uint)kv.Key, CreatedOf(kv.Key), nm);
          key = nm + "|" + (path ?? "");
        }
        Grp g;
        if (!groups.TryGetValue(key, out g)) { g = new Grp { Exe = named ? nm : null, Path = path }; groups[key] = g; }
        g.V += kv.Value;
        g.Pids.Add(kv.Key);
      }
      var list = new List<Grp>(groups.Values);
      list.Sort(delegate (Grp a, Grp b) { return b.V.CompareTo(a.V); });
      var o = new List<object>();
      for (int i = 0; i < list.Count && i < n; i++) {
        Grp g = list[i];
        string label = (g.Exe ?? ("pid " + g.Pids[0])) + (g.Pids.Count > 1 ? " (" + g.Pids.Count + ")" : "");
        if (g.Exe != null && g.Path == null && !Generic.Contains(g.Exe))
          for (int k = 0; k < g.Pids.Count && k < 3 && g.Path == null; k++) g.Path = AppPower.PathOf((uint)g.Pids[k], CreatedOf(g.Pids[k]), g.Exe);
        string access = g.Exe == null ? "unknown" : GroupAccess(g);
        o.Add(Json.Obj("name", label, bytes ? "bytes" : "pct", bytes ? (object)g.V : Math.Round(Clamp(g.V), 1),
                       "exe", g.Exe, "n", g.Pids.Count, "path", g.Path, "access", access));
      }
      return o;
    }

    static long CreatedOf(int pid) { long c; return _pCreated.TryGetValue(pid, out c) ? c : 0; }

    /// "ok" when Mantle can change at least one process of the group; a group holding Mantle itself
    /// (this sidecar or its electron) is "protected"; otherwise the strongest reason it can't.
    static string GroupAccess(Grp g) {
      int own = Program.OwnPid, parent = Program.ParentPid;
      foreach (int pid in g.Pids) if (pid == own || (parent > 0 && pid == parent)) return "protected";
      string best = null;
      foreach (int pid in g.Pids) {
        uint s; if (!_pSession.TryGetValue(pid, out s)) s = uint.MaxValue;
        string a = AppPower.AccessOf((uint)pid, CreatedOf(pid), g.Exe, s);
        if (a == "ok") return "ok";
        if (a != "gone" && Rank(a) > Rank(best)) best = a;
      }
      return best ?? "unknown";
    }
    static int Rank(string a) {
      switch (a) { case "protected": return 5; case "game": return 4; case "system": return 3; case "admin": return 2; case "unknown": return 1; }
      return 0;
    }

    // ------------------------------------------------------------------ lock / display-off watch

    /// A hidden window on the ui thread that hears the session lock (WTS) and the display state
    /// (GUID_CONSOLE_DISPLAY_STATE). Registering for both changes nothing on the machine.
    sealed class WatchWindow : System.Windows.Forms.NativeWindow {
      public string Why = "watching the lock and the display";
      static Guid DisplayState = new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");
      public static WatchWindow Create() {
        var w = new WatchWindow();
        try {
          var cp = new System.Windows.Forms.CreateParams();
          cp.Caption = "Mantle topbar stats watch";
          w.CreateHandle(cp);
          bool wts = StatsNative.WTSRegisterSessionNotification(w.Handle, 0);
          bool pwr = StatsNative.RegisterPowerSettingNotification(w.Handle, ref DisplayState, 0) != IntPtr.Zero;
          if (!wts || !pwr) w.Why = "stats keep running while " + (!wts ? "the session is locked" : "the screen is off") + ": Windows refused the notification";
        } catch (Exception ex) {
          w.Why = "stats keep running while locked or dark: the watch window failed (" + ex.Message + ")";
        }
        return w;
      }
      protected override void WndProc(ref System.Windows.Forms.Message m) {
        if (m.Msg == 0x02B1) {                                   // WM_WTSSESSION_CHANGE
          int code = m.WParam.ToInt32();
          if (code == 7) _locked = true; else if (code == 8 && _locked) { _locked = false; _wake.Set(); }
        } else if (m.Msg == 0x0218 && m.WParam.ToInt32() == 0x8013) {   // WM_POWERBROADCAST / PBT_POWERSETTINGCHANGE
          int data = Marshal.ReadInt32(m.LParam, 20);            // POWERBROADCAST_SETTING: Guid(16) DataLength(4) Data
          bool wasOff = _displayOff;
          _displayOff = data == 0;
          if (!_displayOff && wasOff) _wake.Set();   // Windows sends the CURRENT state on registration: not a wake
        }
        base.WndProc(ref m);
      }
    }
  }
}
