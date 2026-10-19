// AutoPause.cs - `autopause.peaks`: how loud every app's audio is RIGHT NOW, and which process
// tree it comes from. The read behind Spotify auto-pause (lib/features/autopause.js, r5-autopause
// lane, 2026-09-30), which ports an earlier standalone PowerShell bridge into
// Mantle.
//
//   {cmd:"autopause.peaks", everyMs?:250} -> {ok, warming, ageMs, readMs, devices,
//                               sessions:[{pid, sys, active, peak, chain:[{pid, exe, pkg}, ...]}], reason}
//
// READ ONLY. Nothing here writes a volume, a mute or a process; there is no write op at all, so a
// --passive sidecar answers it like a live one.
//
// WHY THE CHAIN (measured on the bridge, 2026-09-10): a Store lesson app (a WinUI 3 exe) plays its
// sound from a GRANDCHILD: LessonApp.exe -> msedgewebview2.exe -> msedgewebview2.exe.
// Metering the app's own pid reads 0.0000 for ever. So every session comes back with its process
// and up to 8 ancestors (the bridge's hop limit), each with its exe name and, for a packaged app, its
// package family ("Publisher.App_<hash>" = the part of the media session's
// AUMID before the '!'), and main matches a media session to a session here by either.
//
// WHY EVERY ACTIVE OUTPUT, not only the default: a headset that is not the default still plays the
// lesson. Up to 8 devices x 256 sessions.
//
// PEAK = IAudioMeterInformation::GetPeakValue on the session: 0..1, the loudest sample since the last
// read. The bridge's threshold is 0.0008 (measured: a real lesson's quietest beat was 0.000846), so
// peaks are sent with 6 decimals.
//
// THE METER RUNS ON ITS OWN THREAD (r6-apfix, 2026-09-30, after the first live day). The first cut did
// the whole read inside the request: a new device enumerator, every device's session manager, every
// session, a Toolhelp snapshot each second and a package lookup per pid, 4 times a second, on the
// AboveNormal audio lane. Measured: 6.4 ms of CPU a read (2.5% of a core at 250 ms, passive build); the
// live sidecar at ~12% of a core while Spotify played against ~7% with auto-pause off; and the first
// live start had "foreground", "place" and "gamemode.scan" time out. Now (same bench: 0.4 ms a read,
// 0.16% of a core, and a ping beside 40 asks never above 150 ms):
//   - the request NEVER does audio work: it answers at once with the newest reading (ageMs says how old;
//     warming:true before the first one), so no other command can ever wait behind a meter read;
//   - one background thread (MTA, BELOW-normal priority, so it never takes the CPU from a request lane)
//     reads every `everyMs` (250, the bridge's pollMs) only while someone asked in the last 2.5 s, then
//     drops every COM object and sleeps on an event: no reads, no CPU, while auto-pause is idle;
//   - the enumerator and each device's session manager are kept (devices re-listed every 15 s), the
//     session list is re-taken once a second (new sessions show within 1 s) and only the cached
//     meters are read in between;
//   - each pid's chain is built ONCE (one snapshot, at most every 2 s, only when a new pid appears)
//     and kept until its session goes; every chain is re-checked every 30 s against a reused pid.
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
using System.Threading;

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
    const int InterestMs = 2500;          // the meter keeps reading this long after the last request
    const int DevicesEveryMs = 15000;     // re-list the playback devices (and at once after a failed read)
    const int SessionsEveryMs = 1000;     // re-take each device's session list
    const int SnapshotMinGapMs = 2000;    // at most one process snapshot this often (only for a new pid)
    const int ChainsFreshMs = 30000;      // forget every chain this often (a reused pid)
    static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);
    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    public static void Register(FeatureTable t) {
      t.Add("autopause.peaks", Lanes.Audio, Peaks);   // {everyMs?} -> the newest reading, at once; read only
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

    // ------------------------------------------------------------ the request (never does audio work)

    sealed class Reading {
      public bool Ok;
      public long ReadMs;
      public int Devices;
      public List<object> Sessions;
      public string Reason;
      public long At;             // _clock ms when it was taken
    }

    static readonly object _gate = new object();
    static readonly Stopwatch _clock = Stopwatch.StartNew();   // Environment.TickCount64 is not in .NET 4
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;              // under _gate
    static long _interestUntil = -1;    // under _gate
    static int _everyMs = 250;          // under _gate
    static bool _idle = true;           // under _gate: the meter is asleep on _wake
    static Reading _last;               // under _gate

    static string Peaks(Dictionary<string, object> req, ref object result) {
      int every = Json.GetInt(req, "everyMs", 250);
      if (every < 100) every = 100;
      if (every > 2000) every = 2000;
      Reading r;
      long now;
      bool wake = false;
      lock (_gate) {
        now = _clock.ElapsedMilliseconds;
        _interestUntil = now + Math.Max(InterestMs, every * 4);
        _everyMs = every;
        if (_thread == null) {
          var t = new Thread(MeterLoop);
          t.IsBackground = true;                     // must never hold the process open
          t.Name = "mantle-autopause-meter";
          t.SetApartmentState(ApartmentState.MTA);  // CoreAudio is happy in the MTA and needs no pumping
          t.Priority = ThreadPriority.BelowNormal;  // never takes the CPU from a request lane
          _thread = t;
          t.Start();
        } else if (_idle) {
          wake = true;
        }
        r = _last;
      }
      if (wake) _wake.Set();
      // A reading older than 4 rounds is from before the meter last slept: say "warming", never stale peaks.
      if (r == null || now - r.At > Math.Max(1500, every * 4)) {
        result = Json.Obj("ok", true, "warming", true, "ageMs", -1, "readMs", 0, "devices", 0, "sessions", new List<object>(),
                          "reason", null);
        return null;
      }
      result = Json.Obj("ok", r.Ok, "warming", false, "ageMs", now - r.At, "readMs", r.ReadMs, "devices", r.Devices,
                        "sessions", r.Sessions, "reason", r.Reason);
      return null;
    }

    // ------------------------------------------------------------ the meter thread

    static void MeterLoop() {
      var m = new Meter();
      while (true) {
        long now;
        int every;
        bool want;
        lock (_gate) {
          now = _clock.ElapsedMilliseconds;
          want = now < _interestUntil;
          every = _everyMs;
          _idle = !want;
          if (!want) _last = null;     // what it read before sleeping is not news after it
        }
        if (!want) {
          m.Drop();                    // every COM object and cache goes; nothing runs until a request
          _wake.WaitOne();
          continue;
        }
        Reading r;
        try {
          r = m.Read();
        } catch (Exception ex) {
          m.Drop();
          r = new Reading();
          r.Ok = false;
          r.Sessions = new List<object>();
          r.Reason = "the apps' sound levels could not be read (" + ex.GetType().Name + ")";
        }
        r.At = _clock.ElapsedMilliseconds;
        r.ReadMs = r.At - now;
        lock (_gate) _last = r;
        long wait = every - (_clock.ElapsedMilliseconds - now);
        if (wait < 20) wait = 20;
        _wake.WaitOne((int)wait);
      }
    }

    sealed class Proc { public uint Parent; public string Exe; }

    sealed class Sess { public object Raw; public IAudioSessionControl2 Ctl; public IAudioMeterInformation Meter; public uint Pid; public bool Sys; }

    sealed class Dev { public IMMDevice Device; public object Raw; public IAudioSessionManager2 Mgr; public List<Sess> Sessions = new List<Sess>(); }

    sealed class Row { public uint Pid; public bool Sys; public bool Active; public float Peak; }

    /// Everything here lives on the meter thread only.
    sealed class Meter {
      object _enRaw;
      IMMDeviceEnumerator _en;
      readonly List<Dev> _devs = new List<Dev>();
      string _devReason;
      long _devsAt = -100000, _sessAt = -100000, _snapAt = -100000, _chainsAt = -100000;
      readonly Dictionary<uint, List<object>> _chains = new Dictionary<uint, List<object>>();
      Dictionary<uint, Proc> _procs;
      string _procWhy;

      static void Free(object o) {
        if (o != null && Marshal.IsComObject(o)) { try { Marshal.ReleaseComObject(o); } catch (Exception) { } }
      }

      static void FreeSessions(Dev d) {
        foreach (Sess s in d.Sessions) Free(s.Raw);
        d.Sessions.Clear();
      }

      void FreeDevices() {
        foreach (Dev d in _devs) { FreeSessions(d); Free(d.Raw); Free(d.Device); }
        _devs.Clear();
      }

      public void Drop() {
        FreeDevices();
        Free(_enRaw);
        _enRaw = null;
        _en = null;
        _chains.Clear();
        _procs = null;
        _devsAt = _sessAt = _snapAt = _chainsAt = -100000;
      }

      long Now() { return _clock.ElapsedMilliseconds; }

      public Reading Read() {
        var r = new Reading();
        long now = Now();
        if (_en == null) {
          Type t = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
          _enRaw = t == null ? null : Activator.CreateInstance(t);
          _en = _enRaw as IMMDeviceEnumerator;
          if (_en == null) {
            Free(_enRaw);
            _enRaw = null;
            r.Ok = false;
            r.Sessions = new List<object>();
            r.Reason = "Windows' sound system could not be reached, so no app's sound can be measured";
            return r;
          }
        }
        if (now - _devsAt >= DevicesEveryMs) { ListDevices(); _devsAt = now; _sessAt = -100000; }
        if (now - _sessAt >= SessionsEveryMs) {
          string why = null;
          foreach (Dev d in _devs) { string e = ListSessions(d); if (e != null && why == null) why = e; }
          _sessAt = now;
          if (_devReason == null) _devReason = why;
          ForgetGonePids();
        }
        // The cheap part, 4 times a second: each cached session's state and peak.
        var rows = new Dictionary<string, Row>(StringComparer.Ordinal);
        var order = new List<Row>();
        foreach (Dev d in _devs) {
          foreach (Sess s in d.Sessions) {
            int state;
            int hs = s.Ctl.GetState(out state);
            if (hs != S_OK) { _devsAt = -100000; continue; }   // a device went away: re-list on the next read
            if (state == AudioSessionStateExpired) continue;
            float peak = 0f;
            if (s.Meter == null || s.Meter.GetPeakValue(out peak) != S_OK) peak = 0f;
            if (float.IsNaN(peak) || peak < 0f) peak = 0f;
            if (peak > 1f) peak = 1f;
            string key = s.Sys ? "sys" : s.Pid.ToString(CultureInfo.InvariantCulture);
            Row row;
            if (!rows.TryGetValue(key, out row)) {
              row = new Row();
              row.Pid = s.Sys ? 0 : s.Pid;
              row.Sys = s.Sys;
              rows[key] = row;
              order.Add(row);
            }
            if (peak > row.Peak) row.Peak = peak;
            if (state == AudioSessionStateActive) row.Active = true;
          }
        }
        if (now - _chainsAt >= ChainsFreshMs) { _chains.Clear(); _procs = null; _chainsAt = now; }   // a reused pid
        var list = new List<object>();
        foreach (Row x in order) {
          list.Add(Json.Obj("pid", (long)x.Pid, "sys", x.Sys, "active", x.Active,
                            "peak", Math.Round((double)x.Peak, 6),
                            "chain", x.Pid == 0 ? new List<object>() : ChainOf(x.Pid)));
        }
        r.Ok = true;
        r.Devices = _devs.Count;
        r.Sessions = list;
        r.Reason = _procWhy ?? _devReason;
        return r;
      }

      void ListDevices() {
        FreeDevices();
        _devReason = null;
        IMMDeviceCollection col;
        int hr = _en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col);
        try {
          uint count = 0;
          if (hr != S_OK || col == null || col.GetCount(out count) != S_OK) {
            _devReason = "Windows would not list the playback devices (HRESULT 0x" + hr.ToString("x8") + ")";
            return;
          }
          for (uint i = 0; i < count && i < 8; i++) {
            IMMDevice dev;
            if (col.Item(i, out dev) != S_OK || dev == null) continue;
            Guid iid = IID_IAudioSessionManager2;
            object raw;
            int h2 = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw);
            var mgr = raw as IAudioSessionManager2;
            if (h2 != S_OK || mgr == null) {
              Free(raw);
              Free(dev);
              if (_devReason == null) _devReason = "a playback device refused its session list (HRESULT 0x" + h2.ToString("x8") + ")";
              continue;
            }
            var d = new Dev();
            d.Device = dev;
            d.Raw = raw;
            d.Mgr = mgr;
            _devs.Add(d);
          }
        } finally {
          Free(col);
        }
      }

      /// One device's sessions, taken again (the old ones released after the new ones are held).
      static string ListSessions(Dev d) {
        var old = new List<Sess>(d.Sessions);
        d.Sessions.Clear();
        IAudioSessionEnumerator se;
        int hr = d.Mgr.GetSessionEnumerator(out se);
        try {
          int n;
          if (hr != S_OK || se == null || se.GetCount(out n) != S_OK) return "Windows would not list a device's audio sessions";
          for (int i = 0; i < n && i < 256; i++) {
            object so;
            if (se.GetSession(i, out so) != S_OK || so == null) continue;
            var ctl = so as IAudioSessionControl2;
            int state;
            if (ctl == null || ctl.GetState(out state) != S_OK || state == AudioSessionStateExpired) { Free(so); continue; }
            var s = new Sess();
            s.Raw = so;
            s.Ctl = ctl;
            s.Meter = so as IAudioMeterInformation;
            s.Sys = ctl.IsSystemSoundsSession() == S_OK;
            uint pid;
            if (ctl.GetProcessId(out pid) < 0) pid = 0;   // AUDCLNT_S_NO_SINGLE_PROCESS is a success code
            s.Pid = pid;
            d.Sessions.Add(s);
          }
          return null;
        } finally {
          Free(se);
          foreach (Sess s in old) Free(s.Raw);
        }
      }

      void ForgetGonePids() {
        if (_chains.Count == 0) return;
        var live = new HashSet<uint>();
        foreach (Dev d in _devs) foreach (Sess s in d.Sessions) live.Add(s.Pid);
        var gone = new List<uint>();
        foreach (uint pid in _chains.Keys) if (!live.Contains(pid)) gone.Add(pid);
        foreach (uint pid in gone) _chains.Remove(pid);
      }

      /// A session pid's chain, built once. A pid the last snapshot did not have waits for the next one
      /// (at most every 2 s) and comes back empty until then.
      List<object> ChainOf(uint pid) {
        List<object> hit;
        if (_chains.TryGetValue(pid, out hit)) return hit;
        long now = Now();
        if (_procs == null || (!_procs.ContainsKey(pid) && now - _snapAt >= SnapshotMinGapMs)) {
          _procs = Snapshot(out _procWhy);
          _snapAt = now;
        }
        if (!_procs.ContainsKey(pid)) return new List<object>();
        var chain = Chain(pid, _procs);
        _chains[pid] = chain;
        return chain;
      }
    }

    static Dictionary<uint, Proc> Snapshot(out string why) {
      why = null;
      var map = new Dictionary<uint, Proc>();
      IntPtr snap = Native.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (snap == INVALID_HANDLE || snap == IntPtr.Zero) {
        why = "Windows would not list the running programs (error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")";
        return map;
      }
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
      return map;
    }

    /// The package family of a packaged process ("" for a classic one or one we may not open).
    static string PackageOf(uint pid) {
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
  }
}
