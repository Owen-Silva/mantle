// PerfGpu.cs - the Task Manager's GPU numbers (lane tm-gpu, 2026-10-28): the Processes page's GPU and
// "GPU engine" columns (+ the GPU % over the header) and the Performance page's GPU cards.
//
// `taskmgr.gpu {full?:bool, reuseMs?:int}` (Lanes.Slow) ->
//   { byPid: {"<pid>": {pct, engine}}, totals: {gpu}, gpus: [...]|null, why: {field: reason}, ms, engMs,
//     ageMs, repeated }
//   - byPid: every process with a GPU context on a hardware adapter. pct = its busiest engine (0-100,
//     summed over its contexts on that engine), engine = Windows' "GPU engine" column text, 'GPU 0 - 3D'
//     (adapter number = DXGI enumeration order of the hardware adapters), null while it did no work
//     (Windows leaves the column blank then; why['byPid.engine'] says so).
//   - totals.gpu: the busiest hardware adapter (an adapter's % = its busiest engine, Task Manager's rule).
//   - full:true (Performance visible) adds gpus: [{ id (PDH luid string 'luid_0x00000000_0x00010E7D'),
//     kind 'gpu'|'npu', index, name, pct, engines: [{eng, phys, name, pct}], dedicatedUsed, sharedUsed,
//     dedicatedTotal, sharedTotal, driverVersion, driverDate ('yyyy-MM-dd'), directX ('12 (FL 12.1)'),
//     location ('PCI bus 0, device 2, function 0'), reserved, why: {field: reason} }]. NPUs (compute-only
//     adapters DXGI does not list) are added only when one shows up in the GPU counters.
//   - reuseMs > 0: when the last reply (light, or full when full is asked) is younger than reuseMs it is
//     answered again with ageMs and repeated:true instead of reading the counters (the cadence knob for a
//     costly GPU Engine read).
//
// HOW (all read only):
//   - \GPU Engine(*)\Utilization Percentage, one wildcard PDH query (instances pid_<pid>_luid_<hi>_<lo>_
//     phys_<n>_eng_<n>_engtype_<name>). It is a rate: the first collection after opening, or after a gap
//     of more than BaselineGapMs, is a starting point only and every % in that reply is null with a why.
//     \GPU Adapter Memory(*)\Dedicated Usage + Shared Usage: a second query, opened by the first full call.
//     Both queries close after IdleCloseMs without a call (a timer, under the gate).
//   - Static facts, read once and cached: DXGI (CreateDXGIFactory1 / EnumAdapters1 / GetDesc1; software
//     adapters, Flags & 2, are skipped), D3DKMT (OpenAdapterFromLuid; QueryAdapterInfo 6 = PCI address,
//     25 = per-engine metadata), SetupAPI (the PCI device at that address: DriverVersion, DriverDate,
//     LocationInfo), HKLM\SOFTWARE\Microsoft\DirectX\{adapter} (Windows' DXGI adapter cache:
//     MaxD3D12FeatureLevel / MaxD3D11FeatureLevel, DriverVersion as a fallback).
//   - Engine names follow taskmgr.exe's own string table (en-US mui: 3D, Video Decode, Video Encode,
//     Video Processing, Scene Assembly, Copy, Legacy Overlay, Crypto, and "Engine %u" for the rest).
//
// OUTSIDE DEPENDENCIES (everything this file uses that it does not define): Json.Obj / GetBool / GetInt;
// MantleFeature, FeatureTable.Add, FeatureCommand, Lanes.Slow (Register only). Nothing from Program.cs,
// so it compiles unchanged into a second (elevated) exe.
//
// Logs nothing. C# 5 only (build.ps1): no interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class PerfGpu {
    public static void Register(FeatureTable t) {
      t.Add("taskmgr.gpu", Lanes.Slow, Cmd);
    }

    const long BaselineGapMs = 6000;    // a longer gap makes the next rate an average over the gap: a new baseline
    const long IdleCloseMs = 60000;     // queries close after this long without a call
    const uint PDH_FMT_DOUBLE = 0x00000200, PDH_FMT_NOCAP100 = 0x00008000;
    const string EngPath = "\\GPU Engine(*)\\Utilization Percentage";

    // ------------------------------------------------------------------ native
    static class N {
      [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhOpenQueryW(string src, IntPtr user, out IntPtr query);
      [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr counter);
      [DllImport("pdh.dll")] public static extern int PdhCollectQueryData(IntPtr q);
      [DllImport("pdh.dll", CharSet = CharSet.Unicode)] public static extern int PdhGetFormattedCounterArrayW(IntPtr counter, uint fmt, ref uint size, out uint count, IntPtr buf);
      [DllImport("pdh.dll")] public static extern int PdhCloseQuery(IntPtr q);

      [DllImport("gdi32.dll")] public static extern int D3DKMTOpenAdapterFromLuid(ref OPENADAPTERFROMLUID a);
      [DllImport("gdi32.dll")] public static extern int D3DKMTQueryAdapterInfo(ref QUERYADAPTERINFO q);
      [DllImport("gdi32.dll")] public static extern int D3DKMTCloseAdapter(ref CLOSEADAPTER c);

      [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IDXGIFactory1 factory);

      [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SetupDiGetClassDevsW(IntPtr classGuid, string enumerator, IntPtr hwnd, uint flags);
      [DllImport("setupapi.dll", SetLastError = true)] public static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref SP_DEVINFO_DATA data);
      [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetupDiGetDevicePropertyW(IntPtr set, ref SP_DEVINFO_DATA data, ref DEVPROPKEY key, out uint type, byte[] buf, uint size, out uint required, uint flags);
      [DllImport("setupapi.dll")] public static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    }
    [StructLayout(LayoutKind.Sequential)] struct OPENADAPTERFROMLUID { public uint LuidLow; public int LuidHigh; public uint hAdapter; }
    [StructLayout(LayoutKind.Sequential)] struct QUERYADAPTERINFO { public uint hAdapter; public int Type; public IntPtr pData; public uint DataSize; }
    [StructLayout(LayoutKind.Sequential)] struct CLOSEADAPTER { public uint hAdapter; }
    [StructLayout(LayoutKind.Sequential)] struct SP_DEVINFO_DATA { public uint cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
    [StructLayout(LayoutKind.Sequential)] struct DEVPROPKEY { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DXGI_ADAPTER_DESC1 {
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
      public uint VendorId, DeviceId, SubSysId, Revision;
      public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
      public uint LuidLow; public int LuidHigh; public uint Flags;
    }
    // vtable order matters, names of the unused slots do not (they are never called)
    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIAdapter1 {
      void SetPrivateData_(); void SetPrivateDataInterface_(); void GetPrivateData_(); void GetParent_();
      void EnumOutputs_(); void GetDesc_(); void CheckInterfaceSupport_();
      [PreserveSig] int GetDesc1(out DXGI_ADAPTER_DESC1 desc);
    }
    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIFactory1 {
      void SetPrivateData_(); void SetPrivateDataInterface_(); void GetPrivateData_(); void GetParent_();
      void EnumAdapters_(); void MakeWindowAssociation_(); void GetWindowAssociation_(); void CreateSwapChain_(); void CreateSoftwareAdapter_();
      [PreserveSig] int EnumAdapters1(uint index, [MarshalAs(UnmanagedType.Interface)] out IDXGIAdapter1 adapter);
    }

    const int KMTQAITYPE_GETSEGMENTSIZE = 3, KMTQAITYPE_ADAPTERADDRESS = 6, KMTQAITYPE_ADAPTERREGISTRYINFO = 8,
              KMTQAITYPE_ADAPTERTYPE = 15, KMTQAITYPE_NODEMETADATA = 25;
    static readonly Guid DevpDriver = new Guid("a8b865dd-2e3d-4094-ad97-e593a70c75d6");   // DEVPKEY_Device_DriverDate 2, DriverVersion 3
    static readonly Guid DevpDevice = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");   // HardwareIds 3, LocationInfo 15, BusNumber 23, Address 30
    static readonly Guid ClassDisplay = new Guid("4d36e968-e325-11ce-bfc1-08002be10318");

    // ------------------------------------------------------------------ state (all under _gate)
    static readonly object _gate = new object();
    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static long Now() { return _clock.ElapsedMilliseconds; }

    static IntPtr _eq = IntPtr.Zero, _engCtr = IntPtr.Zero;                          // GPU Engine query
    static IntPtr _mq = IntPtr.Zero, _dedCtr = IntPtr.Zero, _shrCtr = IntPtr.Zero;   // GPU Adapter Memory query
    static long _engAt = -1;          // Now() of the last engine collection; -1 = the query is fresh
    static long _lastCall;
    static Timer _idle;
    static IDictionary _last; static bool _lastFull; static long _lastAt;
    static IntPtr _buf = IntPtr.Zero; static int _bufLen;

    sealed class Engine { public int Ord, Type = -1; public string Friendly, Name; }
    sealed class Adapter {
      public string Id, Kind = "gpu", Name; public int Index; public uint LuidLow; public int LuidHigh;
      public uint VendorId, DeviceId;
      public object DedicatedTotal, SharedTotal;
      public List<Engine> Engines = new List<Engine>(); public string EnginesWhy;
      public int Bus = -1, Dev = -1, Fn = -1; public string AddressWhy;
      public bool FullRead; public string DriverVersion, DriverDate, DirectX, Location;
      public Dictionary<string, string> Why = new Dictionary<string, string>();   // static nulls: field -> reason
    }
    static List<Adapter> _gpus; static string _gpusWhy; static long _gpusAt;
    static readonly HashSet<string> _software = new HashSet<string>();
    static readonly Dictionary<string, Adapter> _byLuid = new Dictionary<string, Adapter>();
    static readonly Dictionary<string, Adapter> _npuSeen = new Dictionary<string, Adapter>();   // luid -> NPU, or null = not one

    static string LuidKey(uint low, int high) { return "luid_0x" + unchecked((uint)high).ToString("X8") + "_0x" + low.ToString("X8"); }
    static string LuidKey(string hiHex, string loHex) {
      return "luid_0x" + uint.Parse(hiHex, NumberStyles.HexNumber, CultureInfo.InvariantCulture).ToString("X8")
           + "_0x" + uint.Parse(loHex, NumberStyles.HexNumber, CultureInfo.InvariantCulture).ToString("X8");
    }

    // ------------------------------------------------------------------ the command
    static string Cmd(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      bool full = Json.GetBool(req, "full", false);
      int reuseMs = Json.GetInt(req, "reuseMs", 0);
      lock (_gate) {
        long now = Now();
        _lastCall = now;
        if (_idle == null) _idle = new Timer(IdleTick, null, 15000, 15000);
        if (reuseMs > 0 && _last != null && (_lastFull || !full) && now - _lastAt < reuseMs && _engAt >= 0) {
          var again = Json.Obj("byPid", _last["byPid"], "totals", _last["totals"], "gpus", full ? _last["gpus"] : null,
                               "why", full ? _last["why"] : LightWhy((IDictionary)_last["why"]), "ms", Ms(sw), "engMs", 0.0,
                               "ageMs", now - _lastAt, "repeated", true);
          result = again;
          return null;
        }
        var why = new SortedDictionary<string, object>(StringComparer.Ordinal);
        LoadAdapters();
        var byPid = Json.Obj();
        object total = null;
        double engMs = 0;
        EngRead er = null;
        if (_gpus == null || _gpus.Count == 0) {
          string w = _gpusWhy ?? "Windows lists no hardware graphics adapter on this PC";
          why["totals.gpu"] = w; why["byPid"] = w;
        } else {
          var es = Stopwatch.StartNew();
          er = ReadEngines(now);
          engMs = Ms(es);
          if (er.Why != null) { why["totals.gpu"] = er.Why; why["byPid"] = er.Why; }
          else {
            double busiest = 0; bool any = false;
            foreach (var kv in er.PerEngine) {
              if (!_byLuid.ContainsKey(kv.Key.Substring(0, kv.Key.IndexOf('|')))) continue;   // hardware only
              any = true; busiest = Math.Max(busiest, kv.Value);
            }
            total = any ? (object)R1(Clamp(busiest)) : 0.0;
            bool idleRow = false;
            foreach (var kv in er.PidBest) {
              double v = er.PidPct[kv.Key];
              string text = v > 0 ? EngineText(kv.Value) : null;
              if (text == null) idleRow = true;
              byPid[kv.Key.ToString(CultureInfo.InvariantCulture)] = Json.Obj("pct", R1(Clamp(v)), "engine", text);
            }
            if (idleRow) why["byPid.engine"] = "no engine did any work for this process in the last interval (Windows leaves the GPU engine column blank then)";
          }
        }
        object gpus = null;
        if (!full) why["gpus"] = "not asked (full:false): only the Performance page reads the GPU cards";
        else if (_gpus == null || _gpus.Count == 0) why["gpus"] = _gpusWhy ?? "Windows lists no hardware graphics adapter on this PC";
        else gpus = Cards(er, why);
        var whyObj = Json.Obj();
        foreach (var kv in why) whyObj[kv.Key] = kv.Value;
        var reply = Json.Obj("byPid", byPid, "totals", Json.Obj("gpu", total), "gpus", gpus, "why", whyObj,
                             "ms", Ms(sw), "engMs", engMs, "ageMs", 0, "repeated", false);
        _last = reply; _lastFull = full; _lastAt = now;
        result = reply;
        return null;
      }
    }

    static IDictionary LightWhy(IDictionary w) {
      var o = Json.Obj();
      foreach (DictionaryEntry kv in w) { string k = (string)kv.Key; if (k != "gpus" && !k.StartsWith("gpus.", StringComparison.Ordinal)) o[k] = kv.Value; }
      o["gpus"] = "not asked (full:false): only the Performance page reads the GPU cards";
      return o;
    }

    static double Ms(Stopwatch sw) { return Math.Round(sw.Elapsed.TotalMilliseconds, 1); }
    static double R1(double v) { return Math.Round(v, 1); }
    static double Clamp(double v) { return v < 0 ? 0 : v > 100 ? 100 : v; }

    static void IdleTick(object state) {
      lock (_gate) {
        if (Now() - _lastCall < IdleCloseMs) return;
        CloseQueries();
        if (_idle != null) { _idle.Dispose(); _idle = null; }
      }
    }

    static void CloseQueries() {
      if (_eq != IntPtr.Zero) N.PdhCloseQuery(_eq);
      if (_mq != IntPtr.Zero) N.PdhCloseQuery(_mq);
      _eq = _engCtr = _mq = _dedCtr = _shrCtr = IntPtr.Zero;
      _engAt = -1;
      _last = null;
      if (_buf != IntPtr.Zero) { Marshal.FreeHGlobal(_buf); _buf = IntPtr.Zero; _bufLen = 0; }
    }

    // ------------------------------------------------------------------ GPU Engine read
    static readonly Regex EngInst = new Regex("^pid_(\\d+)_luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)_phys_(\\d+)_eng_(\\d+)_engtype_(.*)$", RegexOptions.Compiled);
    static readonly Regex MemInst = new Regex("^luid_0x([0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)_phys_(\\d+)$", RegexOptions.Compiled);

    sealed class EngRead {
      public string Why;                                                                  // non-null: no %s this time
      public Dictionary<string, double> PerEngine = new Dictionary<string, double>();     // "luid|phys|eng" -> summed over processes
      public Dictionary<string, string> PdhType = new Dictionary<string, string>();       // "luid|phys|eng" -> PDH engtype
      public Dictionary<int, string> PidBest = new Dictionary<int, string>();             // pid -> "luid|phys|eng" of its busiest engine
      public Dictionary<int, double> PidPct = new Dictionary<int, double>();
    }

    static EngRead ReadEngines(long now) {
      var r = new EngRead();
      if (_eq == IntPtr.Zero) {
        int orc = N.PdhOpenQueryW(null, IntPtr.Zero, out _eq);
        if (orc != 0) { _eq = IntPtr.Zero; r.Why = "Windows would not open a performance-counter query (PDH 0x" + orc.ToString("X8") + ")"; return r; }
        int arc = N.PdhAddEnglishCounterW(_eq, EngPath, IntPtr.Zero, out _engCtr);
        if (arc != 0) {
          N.PdhCloseQuery(_eq); _eq = _engCtr = IntPtr.Zero;
          r.Why = "Windows has no GPU engine counters here (PDH 0x" + arc.ToString("X8") + "), so GPU use cannot be measured";
          return r;
        }
        _engAt = -1;
      }
      string baseWhy = _engAt < 0
        ? "first reading since the GPU counters were opened: Windows measures GPU use between two readings, so this one is only the starting point"
        : now - _engAt > BaselineGapMs
          ? "more than 6 s since the last reading: this one is a new starting point (a % over the gap would not be current)"
          : null;
      int rc = N.PdhCollectQueryData(_eq);
      _engAt = now;
      if (rc != 0) { r.Why = "Windows did not answer the GPU engine counters this time (PDH 0x" + rc.ToString("X8") + ")"; return r; }
      if (baseWhy != null) { r.Why = baseWhy; return r; }
      List<KeyValuePair<string, double>> rows = Read(_engCtr, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100);
      if (rows == null) { r.Why = "the GPU engine counters could not be read this time"; return r; }
      var perPidEng = new Dictionary<string, double>();   // "pid|luid|phys|eng" -> summed over the process's contexts
      foreach (var kv in rows) {
        Match m = EngInst.Match(kv.Key);
        if (!m.Success) continue;
        string luid = LuidKey(m.Groups[2].Value, m.Groups[3].Value);
        if (_software.Contains(luid)) continue;
        string key = luid + "|" + m.Groups[4].Value + "|" + m.Groups[5].Value;
        string pt = m.Groups[6].Value;
        int hash = pt.IndexOf('#'); if (hash >= 0) pt = pt.Substring(0, hash);
        r.PdhType[key] = pt;
        double v = kv.Value < 0 ? 0 : kv.Value;
        double ev; r.PerEngine.TryGetValue(key, out ev); r.PerEngine[key] = ev + v;
        string pk = m.Groups[1].Value + "|" + key;
        double pv; perPidEng.TryGetValue(pk, out pv); perPidEng[pk] = pv + v;
      }
      foreach (var kv in perPidEng) {
        int bar = kv.Key.IndexOf('|');
        int pid = int.Parse(kv.Key.Substring(0, bar), CultureInfo.InvariantCulture);
        string key = kv.Key.Substring(bar + 1);
        if (!_byLuid.ContainsKey(key.Substring(0, key.IndexOf('|')))) { CheckNpu(key.Substring(0, key.IndexOf('|'))); continue; }
        double best;
        if (!r.PidPct.TryGetValue(pid, out best) || kv.Value > best) { r.PidPct[pid] = kv.Value; r.PidBest[pid] = key; }
      }
      // NPUs: luids that are neither DXGI hardware nor software adapters (engine rows of idle NPUs too)
      foreach (var k in r.PerEngine.Keys) { string l = k.Substring(0, k.IndexOf('|')); if (!_byLuid.ContainsKey(l)) CheckNpu(l); }
      return r;
    }

    /// 'GPU 0 - 3D' for "luid|phys|eng" (Task Manager's GPU engine column).
    static string EngineText(string key) {
      string[] p = key.Split('|');
      Adapter a; if (!_byLuid.TryGetValue(p[0], out a) || a.Kind != "gpu") return null;
      int phys = int.Parse(p[1], CultureInfo.InvariantCulture), ord = int.Parse(p[2], CultureInfo.InvariantCulture);
      return "GPU " + a.Index + (phys > 0 ? " (Link " + phys + ")" : "") + " - " + EngineName(a, ord, null);
    }

    static string EngineName(Adapter a, int ord, string pdhType) {
      foreach (var e in a.Engines) if (e.Ord == ord) return e.Name;
      return PdhName(pdhType, ord);
    }

    /// The counters' engtype (taskmgr's names without spaces, or the driver's) when the metadata is missing.
    static string PdhName(string pdhType, int ord) {
      switch (pdhType ?? "") {
        case "": return "Engine " + ord;
        case "VideoDecode": return "Video Decode";
        case "VideoEncode": return "Video Encode";
        case "VideoProcessing": return "Video Processing";
        case "SceneAssembly": return "Scene Assembly";
        case "LegacyOverlay": return "Legacy Overlay";
      }
      return pdhType;
    }

    /// Task Manager's name for an engine: its type from taskmgr's own string table, else the driver's
    /// name for it, else "Engine <ordinal>".
    static string NameOf(int type, string friendly, int ord) {
      switch (type) {
        case 1: return "3D";
        case 2: return "Video Decode";
        case 3: return "Video Encode";
        case 4: return "Video Processing";
        case 5: return "Scene Assembly";
        case 6: return "Copy";
        case 7: return "Legacy Overlay";
        case 8: return "Crypto";
      }
      if (!string.IsNullOrEmpty(friendly)) return friendly;
      return "Engine " + ord;
    }

    // ------------------------------------------------------------------ the Performance cards
    static List<object> Cards(EngRead er, SortedDictionary<string, object> why) {
      var mem = ReadMemory();
      var list = new List<object>();
      var all = new List<Adapter>(_gpus);
      foreach (var kv in _npuSeen) if (kv.Value != null) all.Add(kv.Value);
      foreach (var a in all) {
        if (!a.FullRead) ReadFull(a);
        var w = new SortedDictionary<string, object>(StringComparer.Ordinal);
        foreach (var kv in a.Why) w[kv.Key] = kv.Value;
        string pctWhy = er == null ? "the GPU engine counters were not read" : er.Why;
        // engines: the metadata list, plus any PDH engine the metadata did not name
        var engKeys = new List<KeyValuePair<int, int>>();   // (phys, ord)
        foreach (var e in a.Engines) engKeys.Add(new KeyValuePair<int, int>(0, e.Ord));   // metadata is read for physical adapter 0
        if (er != null) {
          var extra = new List<KeyValuePair<int, int>>();
          foreach (var k in er.PdhType.Keys) {
            string[] p = k.Split('|');
            if (p[0] != a.Id) continue;
            var pe = new KeyValuePair<int, int>(int.Parse(p[1], CultureInfo.InvariantCulture), int.Parse(p[2], CultureInfo.InvariantCulture));
            if (!engKeys.Contains(pe) && !extra.Contains(pe)) extra.Add(pe);
          }
          extra.Sort(delegate(KeyValuePair<int, int> x, KeyValuePair<int, int> y) { return x.Key != y.Key ? x.Key.CompareTo(y.Key) : x.Value.CompareTo(y.Value); });
          engKeys.AddRange(extra);
        }
        var engines = new List<object>();
        double busiest = 0;
        foreach (var pe in engKeys) {
          string key = a.Id + "|" + pe.Key + "|" + pe.Value;
          string pdhType = null; if (er != null) er.PdhType.TryGetValue(key, out pdhType);
          string name = EngineName(a, pe.Value, pdhType);
          if (pe.Key > 0) name += " (Link " + pe.Key + ")";
          object pct = null;
          if (pctWhy == null) { double v; er.PerEngine.TryGetValue(key, out v); v = Clamp(v); busiest = Math.Max(busiest, v); pct = R1(v); }
          engines.Add(Json.Obj("eng", pe.Value, "phys", pe.Key, "name", name, "pct", pct));
        }
        if (pctWhy != null) { w["pct"] = pctWhy; w["engines.pct"] = pctWhy; }
        if (a.Engines.Count == 0 && a.EnginesWhy != null) w["engines.name"] = a.EnginesWhy;
        object ded = null, shr = null;
        if (mem.Why != null) { w["dedicatedUsed"] = mem.Why; w["sharedUsed"] = mem.Why; }
        else {
          double dv, sv;
          if (mem.Ded.TryGetValue(a.Id, out dv)) ded = (long)dv; else w["dedicatedUsed"] = "Windows reports no dedicated memory use for this adapter";
          if (mem.Shr.TryGetValue(a.Id, out sv)) shr = (long)sv; else w["sharedUsed"] = "Windows reports no shared memory use for this adapter";
        }
        var whyObj = Json.Obj();
        foreach (var kv in w) whyObj[kv.Key] = kv.Value;
        list.Add(Json.Obj("id", a.Id, "kind", a.Kind, "index", a.Index, "name", a.Name, "pct", pctWhy == null ? (object)R1(busiest) : null,
                          "engines", engines, "dedicatedUsed", ded, "sharedUsed", shr, "dedicatedTotal", a.DedicatedTotal, "sharedTotal", a.SharedTotal,
                          "driverVersion", a.DriverVersion, "driverDate", a.DriverDate, "directX", a.DirectX, "location", a.Location,
                          "reserved", null, "why", whyObj));
      }
      return list;
    }

    sealed class MemRead { public string Why; public Dictionary<string, double> Ded = new Dictionary<string, double>(), Shr = new Dictionary<string, double>(); }

    static MemRead ReadMemory() {
      var r = new MemRead();
      if (_mq == IntPtr.Zero) {
        int orc = N.PdhOpenQueryW(null, IntPtr.Zero, out _mq);
        if (orc != 0) { _mq = IntPtr.Zero; r.Why = "Windows would not open a performance-counter query (PDH 0x" + orc.ToString("X8") + ")"; return r; }
        int a1 = N.PdhAddEnglishCounterW(_mq, "\\GPU Adapter Memory(*)\\Dedicated Usage", IntPtr.Zero, out _dedCtr);
        int a2 = a1 != 0 ? a1 : N.PdhAddEnglishCounterW(_mq, "\\GPU Adapter Memory(*)\\Shared Usage", IntPtr.Zero, out _shrCtr);
        if (a1 != 0 || a2 != 0) {
          N.PdhCloseQuery(_mq); _mq = _dedCtr = _shrCtr = IntPtr.Zero;
          r.Why = "Windows has no GPU adapter memory counters here (PDH 0x" + (a1 != 0 ? a1 : a2).ToString("X8") + ")";
          return r;
        }
      }
      int rc = N.PdhCollectQueryData(_mq);   // instantaneous values: one collection is enough
      if (rc != 0) { r.Why = "Windows did not answer the GPU adapter memory counters this time (PDH 0x" + rc.ToString("X8") + ")"; return r; }
      if (!SumMem(Read(_dedCtr, PDH_FMT_DOUBLE), r.Ded) || !SumMem(Read(_shrCtr, PDH_FMT_DOUBLE), r.Shr))
        r.Why = "the GPU adapter memory counters could not be read this time";
      return r;
    }

    static bool SumMem(List<KeyValuePair<string, double>> rows, Dictionary<string, double> into) {
      if (rows == null) return false;
      foreach (var kv in rows) {
        Match m = MemInst.Match(kv.Key);
        if (!m.Success) continue;
        string luid = LuidKey(m.Groups[1].Value, m.Groups[2].Value);
        double v; into.TryGetValue(luid, out v); into[luid] = v + kv.Value;
      }
      return true;
    }

    /// name -> value for a wildcard counter, or null when the read failed (TopbarStats.Read's pattern).
    static List<KeyValuePair<string, double>> Read(IntPtr c, uint fmt) {
      if (c == IntPtr.Zero) return null;
      uint size = 0, count;
      int rc = N.PdhGetFormattedCounterArrayW(c, fmt, ref size, out count, IntPtr.Zero);
      if (size == 0) return rc == 0 ? new List<KeyValuePair<string, double>>() : null;
      if (size > _bufLen) { if (_buf != IntPtr.Zero) Marshal.FreeHGlobal(_buf); _bufLen = (int)size * 2; _buf = Marshal.AllocHGlobal(_bufLen); }
      size = (uint)_bufLen;
      rc = N.PdhGetFormattedCounterArrayW(c, fmt, ref size, out count, _buf);
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

    // ------------------------------------------------------------------ static facts (read once)
    /// DXGI's hardware adapters, in enumeration order, with their engine names and PCI address. A failed
    /// enumeration is retried after a minute; a good one is kept.
    static void LoadAdapters() {
      if (_gpus != null && (_gpus.Count > 0 || Now() - _gpusAt < 60000)) return;
      var list = new List<Adapter>();
      string why = null;
      IDXGIFactory1 f = null;
      try {
        Guid iid = typeof(IDXGIFactory1).GUID;
        int hr = N.CreateDXGIFactory1(ref iid, out f);
        if (hr != 0 || f == null) why = "Windows did not list the graphics adapters (DXGI 0x" + hr.ToString("X8") + ")";
        else {
          for (uint i = 0; i < 32; i++) {
            IDXGIAdapter1 ad;
            if (f.EnumAdapters1(i, out ad) != 0 || ad == null) break;   // DXGI_ERROR_NOT_FOUND ends the list
            try {
              DXGI_ADAPTER_DESC1 d;
              if (ad.GetDesc1(out d) != 0) continue;
              string luid = LuidKey(d.LuidLow, d.LuidHigh);
              if ((d.Flags & 2) != 0) { _software.Add(luid); continue; }   // DXGI_ADAPTER_FLAG_SOFTWARE
              var a = new Adapter();
              a.Id = luid; a.Index = list.Count; a.Name = (d.Description ?? "").Trim();
              a.LuidLow = d.LuidLow; a.LuidHigh = d.LuidHigh; a.VendorId = d.VendorId; a.DeviceId = d.DeviceId;
              a.DedicatedTotal = (long)d.DedicatedVideoMemory.ToUInt64();
              a.SharedTotal = (long)d.SharedSystemMemory.ToUInt64();
              ReadKmt(a);
              list.Add(a);
            } finally { Marshal.ReleaseComObject(ad); }
          }
        }
      } catch (Exception ex) {
        why = "Windows did not list the graphics adapters (" + ex.GetType().Name + ")";
      } finally { if (f != null) Marshal.ReleaseComObject(f); }
      _gpus = list; _gpusAt = Now();
      _gpusWhy = why ?? (list.Count == 0 ? "Windows lists no hardware graphics adapter on this PC" : null);
      foreach (var a in list) _byLuid[a.Id] = a;
    }

    /// D3DKMT facts for one adapter: per-engine metadata (names) and the PCI address.
    static void ReadKmt(Adapter a) {
      var o = new OPENADAPTERFROMLUID(); o.LuidLow = a.LuidLow; o.LuidHigh = a.LuidHigh;
      int st = N.D3DKMTOpenAdapterFromLuid(ref o);
      if (st != 0) {
        a.EnginesWhy = "Windows would not open the adapter to read its engine names (NTSTATUS 0x" + unchecked((uint)st).ToString("X8") + "); the counters' own names are used";
        a.AddressWhy = "Windows would not open the adapter to read its PCI address (NTSTATUS 0x" + unchecked((uint)st).ToString("X8") + ")";
        return;
      }
      IntPtr buf = Marshal.AllocHGlobal(1088);
      try {
        Zero(buf, 12);
        if (Query(o.hAdapter, KMTQAITYPE_ADAPTERADDRESS, buf, 12) == 0) { a.Bus = Marshal.ReadInt32(buf, 0); a.Dev = Marshal.ReadInt32(buf, 4); a.Fn = Marshal.ReadInt32(buf, 8); }
        else a.AddressWhy = "Windows did not give this adapter's PCI address (it may not be a PCI device)";
        int size = 0;
        for (int ord = 0; ord < 64; ord++) {
          // D3DKMT_NODEMETADATA {UINT ordinal; {UINT EngineType; WCHAR FriendlyName[32]; UINT Flags; BOOLEAN
          // GpuMmu, IoMmu}}: Windows wants the PACKED size, 78 (measured 10-28; 80 = STATUS_INVALID_PARAMETER),
          // with every byte past the ordinal zeroed. Older layouts are tried after it.
          int[] sizes = size == 0 ? new int[] { 78, 80, 76, 72 } : new int[] { size };
          bool ok = false;
          foreach (int s in sizes) {
            Zero(buf, 1088);
            Marshal.WriteInt32(buf, 0, ord);   // NodeOrdinalAndAdapterIndex: node ordinal, physical adapter 0
            if (Query(o.hAdapter, KMTQAITYPE_NODEMETADATA, buf, s) == 0) { size = s; ok = true; break; }
          }
          if (!ok) break;
          var e = new Engine();
          e.Ord = ord; e.Type = Marshal.ReadInt32(buf, 4);
          string fr = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 8), 32);
          int z = fr.IndexOf('\0'); if (z >= 0) fr = fr.Substring(0, z);
          e.Friendly = fr.Trim();
          e.Name = NameOf(e.Type, e.Friendly, ord);
          a.Engines.Add(e);
        }
        if (a.Engines.Count == 0) a.EnginesWhy = "Windows did not give this adapter's engine list; the counters' own names are used";
      } finally {
        Marshal.FreeHGlobal(buf);
        var c = new CLOSEADAPTER(); c.hAdapter = o.hAdapter; N.D3DKMTCloseAdapter(ref c);
      }
    }

    static int Query(uint h, int type, IntPtr data, int size) {
      var q = new QUERYADAPTERINFO(); q.hAdapter = h; q.Type = type; q.pData = data; q.DataSize = (uint)size;
      return N.D3DKMTQueryAdapterInfo(ref q);
    }

    static void Zero(IntPtr p, int n) { for (int i = 0; i < n; i += 4) Marshal.WriteInt32(p, i, 0); }

    /// A luid in the GPU counters that DXGI did not list: an NPU (compute-only, not software) gets a card.
    static void CheckNpu(string luid) {
      if (_npuSeen.ContainsKey(luid) || _software.Contains(luid)) return;
      _npuSeen[luid] = null;
      Match m = Regex.Match(luid, "^luid_0x([0-9A-F]{8})_0x([0-9A-F]{8})$");
      if (!m.Success) return;
      var o = new OPENADAPTERFROMLUID();
      o.LuidHigh = unchecked((int)uint.Parse(m.Groups[1].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
      o.LuidLow = uint.Parse(m.Groups[2].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
      if (N.D3DKMTOpenAdapterFromLuid(ref o) != 0) return;
      IntPtr buf = Marshal.AllocHGlobal(2080);
      Adapter a = null;
      try {
        Zero(buf, 4);
        if (Query(o.hAdapter, KMTQAITYPE_ADAPTERTYPE, buf, 4) != 0) return;
        int flags = Marshal.ReadInt32(buf, 0);
        if ((flags & (1 << 2)) != 0) { _software.Add(luid); return; }   // SoftwareDevice
        if ((flags & (1 << 11)) == 0) return;                            // not ComputeOnly: not an NPU
        a = new Adapter();
        a.Id = luid; a.Kind = "npu"; a.LuidLow = o.LuidLow; a.LuidHigh = o.LuidHigh;
        int n = 0; foreach (var kv in _npuSeen) if (kv.Value != null) n++;
        a.Index = n;
        Zero(buf, 2080);
        if (Query(o.hAdapter, KMTQAITYPE_ADAPTERREGISTRYINFO, buf, 2080) == 0) {
          string s = Marshal.PtrToStringUni(buf, 260); int z = s.IndexOf('\0'); if (z >= 0) s = s.Substring(0, z);
          a.Name = s.Trim();
        }
        if (string.IsNullOrEmpty(a.Name)) { a.Name = null; a.Why["name"] = "Windows did not give this NPU's name"; }
        Zero(buf, 24);
        if (Query(o.hAdapter, KMTQAITYPE_GETSEGMENTSIZE, buf, 24) == 0) { a.DedicatedTotal = Marshal.ReadInt64(buf, 0); a.SharedTotal = Marshal.ReadInt64(buf, 16); }
        else { a.Why["dedicatedTotal"] = a.Why["sharedTotal"] = "Windows did not give this NPU's memory sizes"; }
      } finally {
        Marshal.FreeHGlobal(buf);
        var c = new CLOSEADAPTER(); c.hAdapter = o.hAdapter; N.D3DKMTCloseAdapter(ref c);
      }
      if (a == null) return;
      ReadKmt(a);   // engine names + PCI address through the shared path (once per NPU)
      _npuSeen[luid] = a;
    }

    /// Full-page static facts, once per adapter: driver version/date and location (SetupAPI, the PCI device
    /// at the adapter's address), DirectX (Windows' DXGI adapter cache in the registry).
    static void ReadFull(Adapter a) {
      a.FullRead = true;
      if (a.Bus >= 0) a.Location = "PCI bus " + a.Bus + ", device " + a.Dev + ", function " + a.Fn;
      string devWhy = SetupFacts(a);
      if (a.DriverVersion == null || a.DirectX == null) RegistryFacts(a);
      if (a.Location == null) a.Why["location"] = a.AddressWhy ?? devWhy ?? "Windows did not give this adapter's location";
      if (a.DriverVersion == null) a.Why["driverVersion"] = devWhy ?? "Windows did not give this adapter's driver version";
      if (a.DriverDate == null) a.Why["driverDate"] = devWhy ?? "Windows did not give this adapter's driver date";
      if (a.DirectX == null && !a.Why.ContainsKey("directX"))
        a.Why["directX"] = a.Kind == "npu" ? "an NPU has no DirectX version" : "Windows' DirectX adapter cache has no entry for this adapter";
      a.Why["reserved"] = "Windows publishes no documented source for a GPU's hardware-reserved memory that Mantle can read";
      if (a.DedicatedTotal == null && !a.Why.ContainsKey("dedicatedTotal")) a.Why["dedicatedTotal"] = "Windows did not give this adapter's memory sizes";
      if (a.SharedTotal == null && !a.Why.ContainsKey("sharedTotal")) a.Why["sharedTotal"] = "Windows did not give this adapter's memory sizes";
    }

    /// The PCI device at the adapter's bus/address (else the one display device with its vendor/device id).
    static string SetupFacts(Adapter a) {
      IntPtr set = N.SetupDiGetClassDevsW(IntPtr.Zero, "PCI", IntPtr.Zero, 0x2 | 0x4);   // DIGCF_PRESENT | DIGCF_ALLCLASSES
      if (set == IntPtr.Zero || set == new IntPtr(-1)) return "Windows did not list the PCI devices (Win32 " + Marshal.GetLastWin32Error() + ")";
      try {
        var d = new SP_DEVINFO_DATA(); d.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
        int match = -1, idMatches = 0, idMatch = -1;
        string ven = "VEN_" + a.VendorId.ToString("X4") + "&DEV_" + a.DeviceId.ToString("X4");
        for (uint i = 0; i < 4096 && N.SetupDiEnumDeviceInfo(set, i, ref d); i++) {
          if (a.Bus >= 0) {
            object bus = PropU32(set, ref d, DevpDevice, 23), adr = PropU32(set, ref d, DevpDevice, 30);
            if (bus != null && adr != null && (uint)bus == (uint)a.Bus && (uint)adr == (uint)((a.Dev << 16) | a.Fn)) { match = (int)i; break; }
          } else if (d.ClassGuid == ClassDisplay) {
            string ids = PropString(set, ref d, DevpDevice, 3);
            if (ids != null && ids.ToUpperInvariant().Contains(ven)) { idMatches++; idMatch = (int)i; }
          }
        }
        if (match < 0 && idMatches == 1) match = idMatch;
        if (match < 0) return a.Bus >= 0 ? "no PCI device answered at this adapter's address" : "this adapter's PCI device could not be told apart from the others";
        if (!N.SetupDiEnumDeviceInfo(set, (uint)match, ref d)) return "Windows did not read this adapter's PCI device";
        a.DriverVersion = PropString(set, ref d, DevpDriver, 3);
        byte[] ft = Prop(set, ref d, DevpDriver, 2);
        if (ft != null && ft.Length >= 8) {
          long v = BitConverter.ToInt64(ft, 0);
          if (v > 0) a.DriverDate = DateTime.FromFileTimeUtc(v).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        if (a.Location == null) a.Location = PropString(set, ref d, DevpDevice, 15);
        return null;
      } finally { N.SetupDiDestroyDeviceInfoList(set); }
    }

    static byte[] Prop(IntPtr set, ref SP_DEVINFO_DATA d, Guid fmt, uint pid) {
      var key = new DEVPROPKEY(); key.fmtid = fmt; key.pid = pid;
      uint type, need;
      var buf = new byte[256];
      if (!N.SetupDiGetDevicePropertyW(set, ref d, ref key, out type, buf, (uint)buf.Length, out need, 0)) {
        if (need <= buf.Length || need > 65536) return null;
        buf = new byte[need];
        if (!N.SetupDiGetDevicePropertyW(set, ref d, ref key, out type, buf, (uint)buf.Length, out need, 0)) return null;
      }
      if (need < buf.Length) Array.Resize(ref buf, (int)need);
      return buf;
    }

    static object PropU32(IntPtr set, ref SP_DEVINFO_DATA d, Guid fmt, uint pid) {
      byte[] b = Prop(set, ref d, fmt, pid);
      return b != null && b.Length >= 4 ? (object)BitConverter.ToUInt32(b, 0) : null;
    }

    static string PropString(IntPtr set, ref SP_DEVINFO_DATA d, Guid fmt, uint pid) {
      byte[] b = Prop(set, ref d, fmt, pid);
      if (b == null || b.Length < 2) return null;
      string s = System.Text.Encoding.Unicode.GetString(b).Replace('\0', ' ').Trim();   // multi-sz: the strings, space-joined
      return s.Length == 0 ? null : s;
    }

    /// HKLM\SOFTWARE\Microsoft\DirectX\{...}: the DXGI adapter cache Windows keeps per adapter (AdapterLuid,
    /// MaxD3D12FeatureLevel, MaxD3D11FeatureLevel, DriverVersion as a.b.c.d in 16-bit parts).
    static void RegistryFacts(Adapter a) {
      long want = ((long)unchecked((uint)a.LuidHigh) << 32) | a.LuidLow;
      try {
        using (RegistryKey hk = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey dx = hk.OpenSubKey("SOFTWARE\\Microsoft\\DirectX")) {
          if (dx == null) { a.Why["directX"] = "Windows keeps no DirectX adapter cache on this PC"; return; }
          foreach (string sub in dx.GetSubKeyNames()) {
            using (RegistryKey k = dx.OpenSubKey(sub)) {
              if (k == null) continue;
              object l = k.GetValue("AdapterLuid");
              if (!(l is long) || (long)l != want) continue;
              if (a.DirectX == null && a.Kind == "gpu") {
                int fl12 = ToInt(k.GetValue("MaxD3D12FeatureLevel")), fl11 = ToInt(k.GetValue("MaxD3D11FeatureLevel"));
                if (fl12 > 0) a.DirectX = "12 (FL " + ((fl12 >> 12) & 0xF) + "." + ((fl12 >> 8) & 0xF) + ")";
                else if (fl11 > 0) a.DirectX = "11 (FL " + ((fl11 >> 12) & 0xF) + "." + ((fl11 >> 8) & 0xF) + ")";
                else a.Why["directX"] = "Windows' DirectX adapter cache gives no feature level for this adapter";
              }
              if (a.DriverVersion == null) {
                object dv = k.GetValue("DriverVersion");
                if (dv is long) {
                  ulong v = unchecked((ulong)(long)dv);
                  a.DriverVersion = (v >> 48) + "." + ((v >> 32) & 0xFFFF) + "." + ((v >> 16) & 0xFFFF) + "." + (v & 0xFFFF);
                }
              }
              return;
            }
          }
        }
      } catch (Exception ex) {
        a.Why["directX"] = "Windows' DirectX adapter cache could not be read (" + ex.GetType().Name + ")";
      }
    }

    static int ToInt(object v) { return v is int ? (int)v : v is long ? (int)(long)v : 0; }
  }
}
