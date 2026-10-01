// AutoPause.cs - `autopause.peaks`: how loud every app's audio is RIGHT NOW, and which process
// tree it comes from. The read behind Spotify auto-pause (lib/features/autopause.js, r5-autopause
// lane, 2026-09-30), which ports Owen's standalone PowerShell bridge (~/spotify-autopause) into
// Mantle.
//
//   {cmd:"autopause.peaks"} -> {ok, readMs, devices, sessions:[{pid, sys, active, peak,
//                               chain:[{pid, exe, pkg}, ...]}], reason}
//
// READ ONLY. Nothing here writes a volume, a mute or a process; there is no write op at all, so a
// --passive sidecar answers it like a live one.
//
// WHY THE CHAIN (measured on the bridge, 2026-09-10): LessonPlayer is a Store app, LessonPlayerApp.exe, and
// its sound comes from a GRANDCHILD: LessonPlayerApp.exe -> msedgewebview2.exe -> msedgewebview2.exe.
// Metering the app's own pid reads 0.0000 for ever. So every session comes back with its process
// and up to 8 ancestors (the bridge's hop limit), each with its exe name and, for a packaged app, its
// package family ("Contoso.LessonPlayer_8wekyb3d8bbwe" = the part of the media session's
// AUMID before the '!'), and main matches a media session to a session here by either.
//
// WHY EVERY ACTIVE OUTPUT, not only the default: a headset that is not the default still plays the
// lesson. Up to 8 devices x 256 sessions.
//
// PEAK = IAudioMeterInformation::GetPeakValue on the session: 0..1, the loudest sample since the last
// read. The bridge's threshold is 0.0008 (measured: a real lesson's quietest beat was 0.000846), so
// peaks are sent with 6 decimals.
//
// COST: one Toolhelp snapshot (cached 1 s) + one COM walk. The page asks only while Spotify plays or
// a hold is held (every 250 ms then, the bridge's pollMs); otherwise never.
//
// PRIVACY: exe names and package families travel to main (it needs them to match); main never logs
// them (counts and peaks only).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class AutoPauseMeter {
    const int eRender = 0;
    const int DEVICE_STATE_ACTIVE = 1;
    const int CLSCTX_ALL = 23;
    const int AudioSessionStateActive = 1, AudioSessionStateExpired = 2;
    const int S_OK = 0;
    const int MaxHops = 8;
    const uint TH32CS_SNAPPROCESS = 0x2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);
    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    public static void Register(FeatureTable t) {
      t.Add("autopause.peaks", Lanes.Audio, Peaks);   // {} -> every audio session's peak + its process chain, read only
    }

    // ------------------------------------------------------------ interop (vtable order is the ABI)

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
      [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
      [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
      [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
      [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
      [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
      [PreserveSig] int GetCount(out uint count);
      [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
      [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
      [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
      [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
      [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
      [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr audioVolume);
      [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
      [PreserveSig] int RegisterSessionNotification(IntPtr notification);
      [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
      [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
      [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
      [PreserveSig] int GetCount(out int count);
      [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    /// IAudioSessionControl's nine methods, then IAudioSessionControl2's five.
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
      [PreserveSig] int GetState(out int state);
      [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
      [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
      [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
      [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
      [PreserveSig] int GetGroupingParam(out Guid grouping);
      [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
      [PreserveSig] int RegisterAudioSessionNotification(IntPtr notifications);
      [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notifications);
      [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetProcessId(out uint pid);
      [PreserveSig] int IsSystemSoundsSession();
      [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation {
      [PreserveSig] int GetPeakValue(out float peak);
      [PreserveSig] int GetMeteringChannelCount(out uint count);
      [PreserveSig] int GetChannelsPeakValues(uint count, IntPtr peaks);
      [PreserveSig] int QueryHardwareSupport(out uint mask);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32 {
      public uint dwSize;
      public uint cntUsage;
      public uint th32ProcessID;
      public IntPtr th32DefaultHeapID;
      public uint th32ModuleID;
      public uint cntThreads;
      public uint th32ParentProcessID;
      public int pcPriClassBase;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    static class Native {
      [DllImport("kernel32.dll", SetLastError = true)]
      public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
      [DllImport("kernel32.dll", SetLastError = true)]
      public static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
      [DllImport("kernel32.dll", SetLastError = true)]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
      public static extern int GetPackageFamilyName(IntPtr hProcess, ref uint length, StringBuilder name);
    }

    // ------------------------------------------------------------ the process map (cached 1 s)

    sealed class Proc { public uint Parent; public string Exe; }

    static readonly object _gate = new object();
    static Dictionary<uint, Proc> _procs;            // under _gate
    static long _procsAt;                            // Environment.TickCount64 is not in .NET 4: Stopwatch ms
    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static readonly Dictionary<uint, string> _pkg = new Dictionary<uint, string>();   // pid -> family ("" = none), under _gate
    static long _pkgAt;

    static Dictionary<uint, Proc> ProcessMap(out string why) {
      why = null;
      lock (_gate) {
        long now = _clock.ElapsedMilliseconds;
        if (_procs != null && now - _procsAt < 1000) return _procs;
        IntPtr snap = Native.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE || snap == IntPtr.Zero) {
          why = "Windows would not list the running programs (error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")";
          return _procs ?? new Dictionary<uint, Proc>();
        }
        var map = new Dictionary<uint, Proc>();
        try {
          var e = new PROCESSENTRY32();
          e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
          if (Native.Process32First(snap, ref e)) {
            do {
              var p = new Proc();
              p.Parent = e.th32ParentProcessID;
              p.Exe = (e.szExeFile ?? "").ToLowerInvariant();
              map[e.th32ProcessID] = p;
            } while (Native.Process32Next(snap, ref e));
          }
        } finally {
          Native.CloseHandle(snap);
        }
        _procs = map;
        _procsAt = now;
        // A pid's package cannot change, but a pid is reused: forget them all every 30 s.
        if (now - _pkgAt > 30000) { _pkg.Clear(); _pkgAt = now; }
        return map;
      }
    }

    /// The package family of a packaged process ("" for a classic one or one we may not open).
    static string PackageOf(uint pid) {
      lock (_gate) {
        string hit;
        if (_pkg.TryGetValue(pid, out hit)) return hit;
      }
      string fam = "";
      IntPtr h = Native.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (h != IntPtr.Zero) {
        try {
          uint len = 0;
          int rc = Native.GetPackageFamilyName(h, ref len, null);
          if (rc == 122 && len > 0 && len < 1024) {               // ERROR_INSUFFICIENT_BUFFER: packaged
            var sb = new StringBuilder((int)len);
            if (Native.GetPackageFamilyName(h, ref len, sb) == 0) fam = sb.ToString();
          }
        } catch (EntryPointNotFoundException) {
          fam = "";
        } finally {
          Native.CloseHandle(h);
        }
      }
      lock (_gate) _pkg[pid] = fam;
      return fam;
    }

    static List<object> Chain(uint pid, Dictionary<uint, Proc> map) {
      var chain = new List<object>();
      var seen = new HashSet<uint>();
      uint cur = pid;
      for (int hop = 0; hop <= MaxHops; hop++) {
        if (cur <= 4 || seen.Contains(cur)) break;             // 0 idle, 4 System; never loop on a recycled pid
        seen.Add(cur);
        Proc p;
        if (!map.TryGetValue(cur, out p)) break;
        string pkg = PackageOf(cur);
        chain.Add(Json.Obj("pid", (long)cur, "exe", p.Exe, "pkg", pkg.Length == 0 ? null : pkg));
        if (p.Parent == 0 || p.Parent == cur) break;
        cur = p.Parent;
      }
      return chain;
    }

    // ------------------------------------------------------------ the read

    sealed class Row { public uint Pid; public bool Sys; public bool Active; public float Peak; }

    static string Peaks(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      var rcws = new List<object>();
      var rows = new Dictionary<string, Row>(StringComparer.Ordinal);
      var order = new List<Row>();
      int devices = 0;
      string reason = null;
      try {
        Type t = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
        object o = t == null ? null : Activator.CreateInstance(t);
        if (o != null) rcws.Add(o);
        var en = o as IMMDeviceEnumerator;
        if (en == null) {
          result = Json.Obj("ok", false, "readMs", sw.ElapsedMilliseconds, "devices", 0, "sessions", new List<object>(),
                            "reason", "Windows' sound system could not be reached, so no app's sound can be measured");
          return null;
        }
        IMMDeviceCollection col;
        int hr = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col);
        if (col != null) rcws.Add(col);
        uint count = 0;
        if (hr != S_OK || col == null || col.GetCount(out count) != S_OK) {
          result = Json.Obj("ok", false, "readMs", sw.ElapsedMilliseconds, "devices", 0, "sessions", new List<object>(),
                            "reason", "Windows would not list the playback devices (HRESULT 0x" + hr.ToString("x8") + ")");
          return null;
        }
        for (uint d = 0; d < count && d < 8; d++) {
          IMMDevice dev;
          if (col.Item(d, out dev) != S_OK || dev == null) continue;
          rcws.Add(dev);
          devices++;
          string err = ReadDevice(dev, rcws, rows, order);
          if (err != null && reason == null) reason = err;
        }
      } catch (Exception ex) {
        result = Json.Obj("ok", false, "readMs", sw.ElapsedMilliseconds, "devices", devices, "sessions", new List<object>(),
                          "reason", "the apps' sound levels could not be read (" + ex.GetType().Name + ")");
        return null;
      } finally {
        for (int i = rcws.Count - 1; i >= 0; i--) {
          object x = rcws[i];
          if (x != null && Marshal.IsComObject(x)) { try { Marshal.ReleaseComObject(x); } catch (Exception) { } }
        }
      }

      string mapWhy;
      var map = ProcessMap(out mapWhy);
      var list = new List<object>();
      foreach (Row r in order) {
        list.Add(Json.Obj("pid", (long)r.Pid, "sys", r.Sys, "active", r.Active,
                          "peak", Math.Round((double)r.Peak, 6),
                          "chain", r.Pid == 0 ? new List<object>() : Chain(r.Pid, map)));
      }
      result = Json.Obj("ok", true, "readMs", sw.ElapsedMilliseconds, "devices", devices, "sessions", list,
                        "reason", mapWhy ?? reason);
      return null;
    }

    /// One device's sessions, folded by process (louder wins) into rows.
    static string ReadDevice(IMMDevice dev, List<object> rcws, Dictionary<string, Row> rows, List<Row> order) {
      Guid iid = IID_IAudioSessionManager2;
      object raw;
      int hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw);
      if (raw != null) rcws.Add(raw);
      var mgr = raw as IAudioSessionManager2;
      if (hr != S_OK || mgr == null) return "a playback device refused its session list (HRESULT 0x" + hr.ToString("x8") + ")";
      IAudioSessionEnumerator se;
      hr = mgr.GetSessionEnumerator(out se);
      if (se != null) rcws.Add(se);
      int n;
      if (hr != S_OK || se == null || se.GetCount(out n) != S_OK) return "Windows would not list a device's audio sessions";
      for (int i = 0; i < n && i < 256; i++) {
        object so;
        if (se.GetSession(i, out so) != S_OK || so == null) continue;
        rcws.Add(so);
        var ctl = so as IAudioSessionControl2;
        if (ctl == null) continue;
        int state;
        if (ctl.GetState(out state) != S_OK || state == AudioSessionStateExpired) continue;
        bool sys = ctl.IsSystemSoundsSession() == S_OK;
        uint pid;
        if (ctl.GetProcessId(out pid) < 0) pid = 0;   // AUDCLNT_S_NO_SINGLE_PROCESS is a success code
        float peak = 0f;
        var meter = so as IAudioMeterInformation;
        if (meter == null || meter.GetPeakValue(out peak) != S_OK) peak = 0f;
        if (float.IsNaN(peak) || peak < 0f) peak = 0f;
        if (peak > 1f) peak = 1f;
        string key = sys ? "sys" : pid.ToString(CultureInfo.InvariantCulture);
        Row row;
        if (!rows.TryGetValue(key, out row)) {
          row = new Row();
          row.Pid = sys ? 0 : pid;
          row.Sys = sys;
          rows[key] = row;
          order.Add(row);
        }
        if (peak > row.Peak) row.Peak = peak;
        if (state == AudioSessionStateActive) row.Active = true;
      }
      return null;
    }
  }
}
