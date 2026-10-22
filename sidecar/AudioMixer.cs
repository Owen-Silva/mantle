// AudioMixer.cs - `audio`: the sound view behind the '>' beside the Quick
// Settings volume slider. Which device plays (and making another one the
// default), and how loud each app is.
//
// Hand-declared COM, like Volume.cs, and under the same rule: METHOD ORDER IS
// THE ABI. Every method of every interface is declared in vtable order, the
// ones never called included. Unlike Volume.cs every method here is
// [PreserveSig]: without it the runtime reads `int` as a hidden [out, retval]
// and turns failures into exceptions, and IsSystemSoundsSession ANSWERS in
// its HRESULT (S_OK = yes, S_FALSE = no), which only PreserveSig can see.
//
// IPolicyConfig is undocumented. It is what Windows' own Sound control panel
// calls to change the default device, stable since Windows 7 (EarTrumpet,
// SoundSwitch and AudioDeviceCmdlets call it the same way); there is no
// documented API for this at all. If a future Windows drops the interface the
// reply says so, and Windows' Sound settings are one click away in the panel.
//
// THE READ-BACK RULE: the default shown is the one Windows reports after the
// change, and an app's level is the one its session reports after the set -
// never the click.
//
// WHAT A TEST MAY DO (2026-09-23 brief; the user may be recording with audio):
// read everything. In --passive the ONLY default-device call allowed is making
// the device that is ALREADY the default for all three roles the default
// again - a no-op that proves the IPolicyConfig path - and the only session
// writes allowed are to sessions of a process the test harness itself started
// (its parent process is this sidecar's --parent-pid). Everything else is
// refused with the reason.
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
  static class AudioMixer {
    const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid CLSID_PolicyConfigClient = new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9");
    static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    const int eRender = 0;
    const int eMultimedia = 1;
    static readonly string[] RoleNames = { "console", "multimedia", "communications" };
    const int DEVICE_STATE_ACTIVE = 1;
    const int CLSCTX_ALL = 23;
    const int STGM_READ = 0;
    const ushort VT_LPWSTR = 31;
    const int S_OK = 0;
    const int AudioSessionStateActive = 1, AudioSessionStateExpired = 2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint STILL_ACTIVE = 259;
    /// The event context on every set: "mantle-mixer----" in hex, so a session
    /// listener can tell Mantle's own changes from anybody else's.
    static readonly Guid MantleContext = new Guid("6d616e74-6c65-2d6d-6978-65722d2d2d2d");

    static readonly PROPERTYKEY PKEY_Device_FriendlyName =
      new PROPERTYKEY(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);

    // ------------------------------------------------------------ interop

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY {
      public Guid fmtid;
      public uint pid;
      public PROPERTYKEY(Guid f, uint p) { fmtid = f; pid = p; }
    }

    /// 24 bytes on x64 (16 on x86): vt, three reserved words, then the union,
    /// whose widest member (a BLOB: count + pointer) is two pointers wide.
    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT {
      public ushort vt;
      public ushort r1, r2, r3;
      public IntPtr p1;
      public IntPtr p2;
    }

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
      [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
      [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
      [PreserveSig] int GetCount(out uint count);
      [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
      [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
      [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
      [PreserveSig] int Commit();
    }

    /// Windows 7+ IPolicyConfig. SetDefaultEndpoint is the 11th method (vtable
    /// slot 13): the ten before it are declared with inert parameter types
    /// purely to hold their places, and are never called.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig {
      [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr format);
      [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, IntPtr format);
      [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
      [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpointFormat, IntPtr mixFormat);
      [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
      [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr period);
      [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
      [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
      [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr value);
      [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr value);
      [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
      [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
    }

    /// IAudioSessionManager's two methods, then IAudioSessionManager2's five.
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

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume {
      [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
      [PreserveSig] int GetMasterVolume(out float level);
      [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
      [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    static class Native {
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct PROCESSENTRY32 {
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

      [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT pv);
      [DllImport("kernel32.dll", SetLastError = true)]
      public static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW")]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
      [DllImport("kernel32.dll", SetLastError = true)]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
      [DllImport("kernel32.dll", SetLastError = true)]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool CloseHandle(IntPtr h);
      [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
      public static extern int SHLoadIndirectString(string source, StringBuilder outBuf, uint cchOutBuf, IntPtr reserved);
      [DllImport("kernel32.dll", SetLastError = true)]
      public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
      [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
      [return: MarshalAs(UnmanagedType.Bool)]
      public static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    }

    // ================================================================ dispatch

    /// Runs on the audio lane (MTA: CoreAudio is free-threaded). Returns a
    /// plain-words error for a request that cannot run, else fills result.
    public static string Run(Dictionary<string, object> req, bool passive, out object result) {
      result = null;
      string op = Json.GetString(req, "op");
      if (string.IsNullOrEmpty(op)) op = "devices";
      switch (op) {
        case "devices":
          result = Devices();
          return null;

        case "sessions":
          result = Sessions();
          return null;

        case "default": {
          // The argument is "device", never "id": "id" is the protocol's request id, and
          // lib/sidecar.js refuses any argument by that name (a device id sent as "id"
          // replaced the request id and the reply went nowhere -- measured 2026-09-23).
          string id = Json.GetString(req, "device");
          if (string.IsNullOrEmpty(id)) return "audio default needs device: a playback device's id from audio devices";
          IDictionary r;
          string err = SetDefault(id, passive, out r);
          if (err != null) return err;
          result = r;
          return null;
        }

        case "session": {
          string key = Json.GetString(req, "key");
          if (string.IsNullOrEmpty(key)) return "audio session needs key: a session's key from audio sessions";
          int? level = null;
          bool? muted = null;
          object lv;
          if (Json.TryGet(req, "level", out lv)) {
            if (!(lv is double)) return "audio session: level must be a number from 0 to 100";
            double d = (double)lv;
            if (d < 0 || d > 100) return "audio session: level must be a number from 0 to 100";
            level = (int)Math.Round(d);
          }
          object mv;
          if (Json.TryGet(req, "muted", out mv)) {
            if (!(mv is bool)) return "audio session: muted must be true or false";
            muted = (bool)mv;
          }
          if (level == null && muted == null) return "audio session needs level (0-100) or muted (true/false)";
          IDictionary r;
          string err = SetSession(key, level, muted, passive, out r);
          if (err != null) return err;
          result = r;
          return null;
        }

        default:
          return "audio: unknown op \"" + op + "\" (it does devices, default, sessions, session)";
      }
    }

    // ================================================================ devices

    /// Every ACTIVE playback device, with Windows' own name for it, and which
    /// one is the default for each role.
    public static IDictionary Devices() {
      var sw = Stopwatch.StartNew();
      var rcws = new List<object>();
      try {
        IMMDeviceEnumerator en = NewEnumerator(rcws);
        string[] defaults = DefaultIds(en, rcws);
        List<object> list;
        string err = ListDevices(en, defaults, rcws, out list);
        if (err != null) return Json.Obj("ok", false, "devices", new List<object>(), "defaultId", null, "readMs", sw.ElapsedMilliseconds, "reason", err);
        return Json.Obj("ok", true, "devices", list, "defaultId", defaults[0], "readMs", sw.ElapsedMilliseconds,
                        "reason", list.Count == 0 ? "no playback device is active: nothing is plugged in, or every output is disabled" : null);
      } catch (Exception ex) {
        return Json.Obj("ok", false, "devices", new List<object>(), "defaultId", null, "readMs", sw.ElapsedMilliseconds,
                        "reason", "the playback devices could not be read (" + ex.GetType().Name + ": " + ex.Message + ")");
      } finally {
        Release(rcws);
      }
    }

    static string ListDevices(IMMDeviceEnumerator en, string[] defaults, List<object> rcws, out List<object> list) {
      list = new List<object>();
      IMMDeviceCollection col;
      int hr = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col);
      if (col != null) rcws.Add(col);
      if (hr != 0 || col == null) return "Windows would not list the playback devices (HRESULT 0x" + hr.ToString("x8") + ")";
      uint count;
      hr = col.GetCount(out count);
      if (hr != 0) return "Windows would not count the playback devices (HRESULT 0x" + hr.ToString("x8") + ")";
      var rows = new List<IDictionary>();
      for (uint i = 0; i < count && i < 64; i++) {
        IMMDevice dev;
        if (col.Item(i, out dev) != 0 || dev == null) continue;
        rcws.Add(dev);
        string id;
        if (dev.GetId(out id) != 0 || string.IsNullOrEmpty(id)) continue;
        string name = FriendlyName(dev, rcws) ?? ("Playback device " + (i + 1));
        var roles = Json.Obj(RoleNames[0], id == defaults[0], RoleNames[1], id == defaults[1], RoleNames[2], id == defaults[2]);
        rows.Add(Json.Obj("id", id, "name", name, "isDefault", id == defaults[0], "roles", roles));
      }
      // Windows' own picker lists them by name.
      rows.Sort(delegate (IDictionary a, IDictionary b) {
        return string.Compare((string)a["name"], (string)b["name"], StringComparison.CurrentCultureIgnoreCase);
      });
      foreach (IDictionary r in rows) list.Add(r);
      return null;
    }

    /// Make `id` the default playback device for all three roles (console,
    /// multimedia, communications), then report what Windows says the
    /// defaults are now.
    static string SetDefault(string id, bool passive, out IDictionary result) {
      result = null;
      var sw = Stopwatch.StartNew();
      var rcws = new List<object>();
      try {
        IMMDeviceEnumerator en = NewEnumerator(rcws);
        string[] before = DefaultIds(en, rcws);
        List<object> list;
        string err = ListDevices(en, before, rcws, out list);
        if (err != null) return "audio default: " + err;
        string name = null;
        foreach (IDictionary d in list) if ((string)d["id"] == id) name = (string)d["name"];
        if (name == null) return "audio default: no active playback device has that id (it may have been unplugged or disabled)";

        bool noop = before[0] == id && before[1] == id && before[2] == id;
        if (passive && !noop)
          return PassiveRefusal + ": audio default would change the live output device (a test may only make the current default the default again)";
        // MEASURED 2026-09-23 (a read-only IMMNotificationClient watching one such
        // call): making the current default the default again is NOT silent.
        // Windows broadcast OnDefaultDeviceChanged five times within ~35 ms plus
        // ~150 OnPropertyValueChanged over ~480 ms, so an app that follows the
        // default device may reopen its stream mid-recording. A live sidecar
        // therefore skips a no-op outright. Only the passive test harness makes
        // it, and only with MANTLE_TEST_AUDIO_DEFAULT=1, because that one call is
        // how a test proves the IPolicyConfig path without changing the output.
        if (noop && !passive) {
          result = Json.Obj("ok", true, "id", id, "name", name, "noop", true, "skipped", true,
                            "roles", Json.Obj(RoleNames[0], true, RoleNames[1], true, RoleNames[2], true),
                            "hr", null, "devices", list, "ms", sw.ElapsedMilliseconds, "reason", null);
          return null;
        }

        string perr;
        IPolicyConfig pc = NewPolicyConfig(rcws, out perr);
        if (pc == null) {
          result = Json.Obj("ok", false, "id", id, "name", name, "noop", noop, "devices", list, "ms", sw.ElapsedMilliseconds, "reason", perr);
          return null;
        }
        var hrs = Json.Obj();
        string failed = null;
        for (int role = 0; role < 3; role++) {
          int hr = pc.SetDefaultEndpoint(id, role);
          hrs[RoleNames[role]] = "0x" + hr.ToString("x8");
          if (hr != 0 && failed == null)
            failed = "Windows refused to make \"" + name + "\" the " + RoleNames[role] + " default (HRESULT 0x" + hr.ToString("x8") + ")";
        }

        // Read back. The change is synchronous in the audio service, but give
        // it a few short tries before calling a slow answer a refusal.
        string[] after = null;
        for (int attempt = 0; attempt < 5; attempt++) {
          after = DefaultIds(en, rcws);
          if (after[0] == id && after[1] == id && after[2] == id) break;
          Thread.Sleep(40);
        }
        bool ok = after[0] == id && after[1] == id && after[2] == id;
        err = ListDevices(en, after, rcws, out list);
        string reason = ok ? null
          : failed ?? ("Windows accepted the change but still reports a different default afterwards (" +
                       Describe(after, id) + ")");
        result = Json.Obj("ok", ok, "id", id, "name", name, "noop", noop,
                          "roles", Json.Obj(RoleNames[0], after[0] == id, RoleNames[1], after[1] == id, RoleNames[2], after[2] == id),
                          "hr", hrs, "devices", err == null ? list : new List<object>(),
                          "ms", sw.ElapsedMilliseconds, "reason", reason);
        return null;
      } catch (Exception ex) {
        result = Json.Obj("ok", false, "id", id, "ms", sw.ElapsedMilliseconds,
                          "reason", "the default device could not be changed (" + ex.GetType().Name + ": " + ex.Message + ")");
        return null;
      } finally {
        Release(rcws);
      }
    }

    static string Describe(string[] ids, string wanted) {
      var parts = new List<string>();
      for (int i = 0; i < 3; i++) parts.Add(RoleNames[i] + (ids[i] == wanted ? " ok" : " still another device"));
      return string.Join(", ", parts.ToArray());
    }

    static IPolicyConfig NewPolicyConfig(List<object> rcws, out string err) {
      err = null;
      Type t = Type.GetTypeFromCLSID(CLSID_PolicyConfigClient);
      if (t == null) { err = "Windows has no PolicyConfig client registered, so Mantle cannot switch the output; Windows' Sound settings can"; return null; }
      object o = Activator.CreateInstance(t);
      rcws.Add(o);
      var pc = o as IPolicyConfig;
      if (pc == null)
        err = "this Windows build does not offer IPolicyConfig {F8679F50-850A-41CF-9C72-430F290290C8}, so Mantle cannot switch the output; Windows' Sound settings can";
      return pc;
    }

    // =============================================================== sessions

    sealed class Row {
      public string Key;
      public uint Pid;
      public bool IsSystem;
      public string Name;
      public string Path;
      public bool Active;
      public float Level;
      public bool Muted;
      public int Count;
    }

    /// One row per app playing (or able to play) on the default output: the
    /// sessions of one process fold into one row, the way Windows' mixer shows
    /// them, and system sounds get their own.
    public static IDictionary Sessions() {
      var sw = Stopwatch.StartNew();
      var rcws = new List<object>();
      try {
        IMMDeviceEnumerator en = NewEnumerator(rcws);
        IMMDevice dev;
        int hr = en.GetDefaultAudioEndpoint(eRender, eMultimedia, out dev);
        if (dev != null) rcws.Add(dev);
        if (hr != 0 || dev == null)
          return Json.Obj("ok", true, "device", null, "sessions", new List<object>(), "readMs", sw.ElapsedMilliseconds,
                          "reason", "there is no default playback device (HRESULT 0x" + hr.ToString("x8") + "), so no app can play sound");
        string devId;
        dev.GetId(out devId);
        string devName = FriendlyName(dev, rcws);

        List<Row> rows;
        string err = ReadSessions(dev, rcws, out rows);
        if (err != null)
          return Json.Obj("ok", false, "device", Json.Obj("id", devId, "name", devName), "sessions", new List<object>(),
                          "readMs", sw.ElapsedMilliseconds, "reason", err);
        var list = new List<object>();
        foreach (Row r in rows) list.Add(RowJson(r));
        return Json.Obj("ok", true, "device", Json.Obj("id", devId, "name", devName), "sessions", list,
                        "readMs", sw.ElapsedMilliseconds, "reason", null);
      } catch (Exception ex) {
        return Json.Obj("ok", false, "device", null, "sessions", new List<object>(), "readMs", sw.ElapsedMilliseconds,
                        "reason", "the app volumes could not be read (" + ex.GetType().Name + ": " + ex.Message + ")");
      } finally {
        Release(rcws);
      }
    }

    static IDictionary RowJson(Row r) {
      return Json.Obj("key", r.Key, "pid", r.Pid, "system", r.IsSystem, "name", r.Name, "path", r.Path,
                      "active", r.Active, "level", (int)Math.Round(r.Level * 100f), "muted", r.Muted, "sessions", r.Count);
    }

    /// The sessions on `dev`, folded into rows. When `apply` is given it is
    /// called for every live session whose row key matches `applyKey` (the
    /// set path), before that session is read - so the row comes back with
    /// the values the session holds AFTER the set.
    delegate string SessionAction(ISimpleAudioVolume vol);

    static string ReadSessions(IMMDevice dev, List<object> rcws, out List<Row> rows) {
      return ReadSessions(dev, rcws, null, null, out rows);
    }

    static string ReadSessions(IMMDevice dev, List<object> rcws, string applyKey, SessionAction apply, out List<Row> rows) {
      rows = new List<Row>();
      Guid iid = IID_IAudioSessionManager2;
      object raw;
      int hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw);
      if (raw != null) rcws.Add(raw);
      var mgr = raw as IAudioSessionManager2;
      if (hr != 0 || mgr == null) return "the output device refused the session manager (HRESULT 0x" + hr.ToString("x8") + ")";
      IAudioSessionEnumerator se;
      hr = mgr.GetSessionEnumerator(out se);
      if (se != null) rcws.Add(se);
      if (hr != 0 || se == null) return "Windows would not list the audio sessions (HRESULT 0x" + hr.ToString("x8") + ")";
      int n;
      hr = se.GetCount(out n);
      if (hr != 0) return "Windows would not count the audio sessions (HRESULT 0x" + hr.ToString("x8") + ")";

      var byKey = new Dictionary<string, Row>(StringComparer.Ordinal);
      string applyErr = null;
      for (int i = 0; i < n && i < 256; i++) {
        object so;
        if (se.GetSession(i, out so) != 0 || so == null) continue;
        rcws.Add(so);
        var ctl = so as IAudioSessionControl2;
        var vol = so as ISimpleAudioVolume;
        if (ctl == null || vol == null) continue;
        int state;
        if (ctl.GetState(out state) != 0 || state == AudioSessionStateExpired) continue;
        bool sys = ctl.IsSystemSoundsSession() == S_OK;
        uint pid;
        if (ctl.GetProcessId(out pid) < 0) pid = 0;   // AUDCLNT_S_NO_SINGLE_PROCESS is a success code
        string key;
        if (sys) key = "system";
        else if (pid != 0) {
          if (!Alive(pid)) continue;                   // a dead app's leftover session
          key = "pid:" + pid.ToString(CultureInfo.InvariantCulture);
        } else {
          string sid;
          ctl.GetSessionIdentifier(out sid);
          key = "sid:" + ((sid ?? "").GetHashCode() & 0x7fffffff).ToString(CultureInfo.InvariantCulture);
        }

        if (apply != null && key == applyKey) {
          string e = apply(vol);
          if (e != null && applyErr == null) applyErr = e;
        }

        float level;
        bool muted;
        if (vol.GetMasterVolume(out level) != 0) level = 0;
        if (vol.GetMute(out muted) != 0) muted = false;

        Row row;
        if (!byKey.TryGetValue(key, out row)) {
          row = new Row();
          row.Key = key;
          row.Pid = pid;
          row.IsSystem = sys;
          row.Level = level;
          row.Muted = muted;
          row.Path = sys || pid == 0 ? null : ImagePath(pid);
          row.Name = NameFor(ctl, sys, pid, row.Path);
          byKey[key] = row;
          rows.Add(row);
        } else {
          // One app, several sessions: louder wins the slider, and the row is
          // muted only if every session is.
          if (level > row.Level) row.Level = level;
          row.Muted = row.Muted && muted;
        }
        row.Count++;
        if (state == AudioSessionStateActive) row.Active = true;
      }
      // System sounds first, as in Windows' mixer; then what is playing; then by name.
      rows.Sort(delegate (Row a, Row b) {
        if (a.IsSystem != b.IsSystem) return a.IsSystem ? -1 : 1;
        if (a.Active != b.Active) return a.Active ? -1 : 1;
        return string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase);
      });
      return applyErr;
    }

    /// Set one app's level and/or mute on the default output, then read it back.
    static string SetSession(string key, int? level, bool? muted, bool passive, out IDictionary result) {
      result = null;
      uint pid = 0;
      if (key != "system") {
        if (!key.StartsWith("pid:", StringComparison.Ordinal) && !key.StartsWith("sid:", StringComparison.Ordinal))
          return "audio session: key must be \"system\", \"pid:<n>\" or \"sid:<n>\" as audio sessions reports it";
        if (key.StartsWith("pid:", StringComparison.Ordinal) &&
            !uint.TryParse(key.Substring(4), NumberStyles.None, CultureInfo.InvariantCulture, out pid))
          return "audio session: \"" + key + "\" is not a pid key";
      }
      if (passive) {
        // The fence: a test run may only touch a session of a process its own
        // harness started - never the user's apps, never system sounds.
        uint parent = pid == 0 ? 0 : ParentOf(pid);
        if (pid == 0 || Program.ParentPid <= 0 || parent != (uint)Program.ParentPid)
          return PassiveRefusal + ": audio session would change another app's volume on the live machine " +
                 "(a test may only touch a session of a process its own harness started)";
      }

      var sw = Stopwatch.StartNew();
      var rcws = new List<object>();
      try {
        IMMDeviceEnumerator en = NewEnumerator(rcws);
        IMMDevice dev;
        int hr = en.GetDefaultAudioEndpoint(eRender, eMultimedia, out dev);
        if (dev != null) rcws.Add(dev);
        if (hr != 0 || dev == null) {
          result = Json.Obj("ok", false, "key", key, "session", null, "ms", sw.ElapsedMilliseconds,
                            "reason", "there is no default playback device (HRESULT 0x" + hr.ToString("x8") + ")");
          return null;
        }
        Guid ctx = MantleContext;
        List<Row> rows;
        string err = ReadSessions(dev, rcws, key, delegate (ISimpleAudioVolume vol) {
          int h;
          if (level.HasValue) {
            h = vol.SetMasterVolume(level.Value / 100f, ref ctx);
            if (h != 0) return "the app refused the volume (HRESULT 0x" + h.ToString("x8") + ")";
          }
          if (muted.HasValue) {
            h = vol.SetMute(muted.Value, ref ctx);
            if (h != 0) return "the app refused mute (HRESULT 0x" + h.ToString("x8") + ")";
          }
          return null;
        }, out rows);
        Row hit = null;
        foreach (Row r in rows) if (r.Key == key) hit = r;
        if (hit == null) {
          result = Json.Obj("ok", false, "key", key, "session", null, "ms", sw.ElapsedMilliseconds,
                            "reason", err ?? "that app has no audio session on the current output any more (it may have stopped or closed)");
          return null;
        }
        bool took = (!level.HasValue || Math.Abs(hit.Level * 100f - level.Value) < 1.01f) &&
                    (!muted.HasValue || hit.Muted == muted.Value);
        result = Json.Obj("ok", err == null && took, "key", key, "session", RowJson(hit), "ms", sw.ElapsedMilliseconds,
                          "reason", err ?? (took ? null : "the app's session reports a different value after the change"));
        return null;
      } catch (Exception ex) {
        result = Json.Obj("ok", false, "key", key, "session", null, "ms", sw.ElapsedMilliseconds,
                          "reason", "the app volume could not be changed (" + ex.GetType().Name + ": " + ex.Message + ")");
        return null;
      } finally {
        Release(rcws);
      }
    }

    // ================================================================ helpers

    static IMMDeviceEnumerator NewEnumerator(List<object> rcws) {
      Type t = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
      if (t == null) throw new InvalidOperationException("the CoreAudio device enumerator is not registered on this system");
      object o = Activator.CreateInstance(t);
      rcws.Add(o);
      var en = o as IMMDeviceEnumerator;
      if (en == null) throw new InvalidOperationException("the CoreAudio device enumerator does not offer IMMDeviceEnumerator");
      return en;
    }

    /// The default render device's id for each role; null for a role with none.
    static string[] DefaultIds(IMMDeviceEnumerator en, List<object> rcws) {
      var ids = new string[3];
      for (int role = 0; role < 3; role++) {
        IMMDevice d;
        if (en.GetDefaultAudioEndpoint(eRender, role, out d) == 0 && d != null) {
          rcws.Add(d);
          string id;
          if (d.GetId(out id) == 0) ids[role] = id;
        } else if (d != null) rcws.Add(d);
      }
      return ids;
    }

    static string FriendlyName(IMMDevice dev, List<object> rcws) {
      IPropertyStore store;
      if (dev.OpenPropertyStore(STGM_READ, out store) != 0 || store == null) return null;
      rcws.Add(store);
      var key = PKEY_Device_FriendlyName;
      var pv = new PROPVARIANT();
      try {
        if (store.GetValue(ref key, out pv) != 0) return null;
        return pv.vt == VT_LPWSTR && pv.p1 != IntPtr.Zero ? Marshal.PtrToStringUni(pv.p1) : null;
      } finally {
        Native.PropVariantClear(ref pv);
      }
    }

    /// What Windows' mixer would call the app: the session's own display name
    /// (resolving "@dll,-id" resource strings), else the exe's description
    /// ("Google Chrome"), else the exe's name.
    static string NameFor(IAudioSessionControl2 ctl, bool sys, uint pid, string path) {
      string dn = null;
      try { if (ctl.GetDisplayName(out dn) != 0) dn = null; } catch (Exception) { dn = null; }
      dn = Indirect(dn);
      if (sys) return string.IsNullOrEmpty(dn) || dn.StartsWith("@", StringComparison.Ordinal) ? "System sounds" : dn;
      if (!string.IsNullOrEmpty(dn) && !dn.StartsWith("@", StringComparison.Ordinal)) return dn;
      string desc = Description(path);
      if (!string.IsNullOrEmpty(desc)) return desc;
      if (!string.IsNullOrEmpty(path)) return System.IO.Path.GetFileNameWithoutExtension(path);
      return pid != 0 ? "App (process " + pid + ")" : "Unnamed app";
    }

    static string Indirect(string s) {
      if (string.IsNullOrEmpty(s) || s[0] != '@') return s;
      try {
        var sb = new StringBuilder(512);
        if (Native.SHLoadIndirectString(s, sb, (uint)sb.Capacity, IntPtr.Zero) == 0) return sb.ToString();
      } catch (Exception) { }
      return s;
    }

    static readonly Dictionary<string, string> _descriptions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// The exe's FileDescription, cached per path (the mixer view re-reads the
    /// sessions every ~1.5 s while it is open; the version resource never changes).
    static string Description(string path) {
      if (string.IsNullOrEmpty(path)) return null;
      lock (_descriptions) {
        string hit;
        if (_descriptions.TryGetValue(path, out hit)) return hit;
      }
      string d = null;
      try {
        var v = FileVersionInfo.GetVersionInfo(path);
        d = v.FileDescription == null ? null : v.FileDescription.Trim();
      } catch (Exception) { d = null; }
      lock (_descriptions) {
        if (_descriptions.Count > 256) _descriptions.Clear();
        _descriptions[path] = d;
      }
      return d;
    }

    static string ImagePath(uint pid) {
      IntPtr h = Native.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (h == IntPtr.Zero) return null;
      try {
        var sb = new StringBuilder(1024);
        uint size = (uint)sb.Capacity;
        return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString(0, (int)size) : null;
      } finally {
        Native.CloseHandle(h);
      }
    }

    /// False only when the process is provably gone: no such pid, or it has
    /// exited. A process we may not open (access denied) is alive.
    static bool Alive(uint pid) {
      IntPtr h = Native.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() != 87;   // ERROR_INVALID_PARAMETER: no such process
      try {
        uint code;
        return !Native.GetExitCodeProcess(h, out code) || code == STILL_ACTIVE;
      } finally {
        Native.CloseHandle(h);
      }
    }

    /// The parent process id from a Toolhelp snapshot, or 0 when unknown.
    static uint ParentOf(uint pid) {
      IntPtr snap = Native.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
      try {
        var e = new Native.PROCESSENTRY32();
        e.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32));
        if (!Native.Process32First(snap, ref e)) return 0;
        do {
          if (e.th32ProcessID == pid) return e.th32ParentProcessID;
        } while (Native.Process32Next(snap, ref e));
        return 0;
      } finally {
        Native.CloseHandle(snap);
      }
    }

    /// RCWs on objects from another apartment keep the COM object alive until a
    /// GC; release them deterministically, newest first.
    static void Release(List<object> rcws) {
      for (int i = rcws.Count - 1; i >= 0; i--) {
        object o = rcws[i];
        if (o == null || !Marshal.IsComObject(o)) continue;
        try { Marshal.ReleaseComObject(o); } catch (Exception) { }
      }
      rcws.Clear();
    }
  }
}
