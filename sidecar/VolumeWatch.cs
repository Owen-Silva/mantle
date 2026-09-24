// VolumeWatch.cs - {cmd:"volume", watch:true|false}: the master volume PUSHED the moment it changes,
// from the volume keys, Windows' own flyout, another app, or Mantle's own slider (qsx lane,
// 2026-09-23).
//
// WHY: the bar's speaker glyph was read once at start-up and then only while the quick-settings
// panel was open (a 2 s poll), so a press of the volume keys left it wrong until the panel was next
// opened. CoreAudio tells a listener about every change (IAudioEndpointVolumeCallback, the same
// notification Windows' own volume flyout listens to), and about a new default playback device
// (IMMNotificationClient) - so nothing here polls.
//
//   {ev:"volume", level, muted, device, via}   whenever the level, mute or default device changes
//                                              ("start" once when the watch starts)
//
// THREADING: CoreAudio calls both callbacks on its own MTA threads, and a callback must not call
// back into CoreAudio (Microsoft's own warning for OnDefaultDeviceChanged). So the callbacks only
// record and signal; one watch thread (MTA) does every registration, re-registers on a new
// default device, and emits. Listening changes nothing, so it runs in --passive too.
//
// MEASURED 2026-09-23 on Owen's machine: a same-value SetMasterVolumeLevelScalar takes 0.02-0.35 ms
// once the endpoint is open (opening it: 27 ms cold); the sidecar's volume set answers in 2-4 ms.
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  static class VolumeWatch {
    const int eRender = 0, eConsole = 0, eMultimedia = 1;
    const int CLSCTX_ALL = 23;

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
      [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
      [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
      [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
      [PreserveSig] int RegisterEndpointNotificationCallback(IMMNotificationClient client);
      [PreserveSig] int UnregisterEndpointNotificationCallback(IMMNotificationClient client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
      [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
      [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
      [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetState(out int state);
    }

    // METHOD ORDER IS THE ABI (see Volume.cs): every method, in vtable order.
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
      [PreserveSig] int RegisterControlChangeNotify(IAudioEndpointVolumeCallback notify);
      [PreserveSig] int UnregisterControlChangeNotify(IAudioEndpointVolumeCallback notify);
      [PreserveSig] int GetChannelCount(out uint count);
      [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid eventContext);
      [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
      [PreserveSig] int GetMasterVolumeLevel(out float db);
      [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
      [PreserveSig] int SetChannelVolumeLevel(uint channel, float db, ref Guid eventContext);
      [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
      [PreserveSig] int GetChannelVolumeLevel(uint channel, out float db);
      [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
      [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
      [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("657804FA-D6AD-4496-8A60-352752AF4F89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolumeCallback {
      [PreserveSig] int OnNotify(IntPtr notifyData);
    }

    [ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMNotificationClient {
      [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int newState);
      [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
      [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
      [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string defaultDeviceId);
      [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, PROPERTYKEY key);
    }

    /// The level callback: AUDIO_VOLUME_NOTIFICATION_DATA is {GUID context; BOOL muted; float master; ...},
    /// so muted sits at offset 16 and the master scalar at 20. It only records and signals.
    sealed class LevelSink : IAudioEndpointVolumeCallback {
      public int OnNotify(IntPtr data) {
        try {
          if (data != IntPtr.Zero) {
            bool muted = Marshal.ReadInt32(data, 16) != 0;
            float master = BitConverter.ToSingle(BitConverter.GetBytes(Marshal.ReadInt32(data, 20)), 0);
            Noted(master, muted);
          }
        } catch (Exception) { /* never throw into CoreAudio */ }
        return 0;
      }
    }

    /// The device callback: a new default playback device means re-registering on it, which the
    /// watch thread does (not here: a CoreAudio call from inside this callback can deadlock).
    sealed class DeviceSink : IMMNotificationClient {
      public int OnDeviceStateChanged(string id, int state) { return 0; }
      public int OnDeviceAdded(string id) { return 0; }
      public int OnDeviceRemoved(string id) { return 0; }
      public int OnDefaultDeviceChanged(int flow, int role, string id) {
        if (flow == eRender && (role == eMultimedia || role == eConsole)) {
          Interlocked.Exchange(ref _deviceChanged, 1);
          _wake.Set();
        }
        return 0;
      }
      public int OnPropertyValueChanged(string id, PROPERTYKEY key) { return 0; }
    }

    static readonly object _lock = new object();
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;
    static volatile bool _on;
    static volatile int _gen;          // one thread at a time: see NetState.cs
    static int _deviceChanged;
    static string _reason;             // why the watch is not running, or null

    // Filled by LevelSink on CoreAudio's thread, emitted by the watch thread.
    static float _noteLevel = -1;
    static bool _noteMuted;
    static int _noted;

    // What was last emitted, so an unchanged reading is not sent twice.
    static int _lastLevel = -1;
    static bool _lastMuted;
    static string _lastDevice;
    static long _events;

    // Every callback, including a set that changed nothing: proof the listener is live.
    static int _notifies;

    static void Noted(float master, bool muted) {
      Interlocked.Increment(ref _notifies);
      lock (_lock) { _noteLevel = master; _noteMuted = muted; }
      Interlocked.Exchange(ref _noted, 1);
      _wake.Set();
    }

    /// Start or stop. Idempotent: a second start reports started:false.
    public static IDictionary Set(bool on) {
      lock (_lock) {
        if (on) {
          if (_on && _thread != null && _thread.IsAlive)
            return Json.Obj("ok", true, "watching", true, "started", false, "events", _events, "reason", null);
          _on = true;
          _reason = null;
          int gen = ++_gen;
          _thread = new Thread(delegate () { Loop(gen); });
          _thread.IsBackground = true;
          _thread.Name = "mantle-volume-watch";
          _thread.SetApartmentState(ApartmentState.MTA);
          _thread.Start();
          return Json.Obj("ok", true, "watching", true, "started", true, "events", _events, "reason", null);
        }
        bool was = _on;
        _on = false;
        _gen++;
        _wake.Set();
        return Json.Obj("ok", true, "watching", false, "stopped", was, "events", _events, "reason", null);
      }
    }

    public static IDictionary Snapshot() {
      return Json.Obj("watching", _on, "events", _events, "notifies", Thread.VolatileRead(ref _notifies), "reason", _reason,
                      "level", _lastLevel < 0 ? (object)null : _lastLevel, "muted", _lastMuted);
    }

    static void Loop(int gen) {
      IMMDeviceEnumerator en = null;
      var devSink = new DeviceSink();
      var levelSink = new LevelSink();
      IAudioEndpointVolume vol = null;
      string device = null;
      bool devRegistered = false;
      try {
        Type t = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
        en = (IMMDeviceEnumerator)Activator.CreateInstance(t);
        int hr = en.RegisterEndpointNotificationCallback(devSink);
        devRegistered = hr == 0;
        if (!devRegistered)
          Program.EmitLog("warn", "volume watch: Windows refused the default-device listener (HRESULT 0x" + hr.ToString("X8") +
                                  "), so a new playback device is noticed only on its first volume change");
        string why;
        vol = Attach(en, levelSink, out device, out why);
        if (vol == null) _reason = why;
        EmitNow(vol, device, "start", why);

        while (_on && gen == _gen) {
          _wake.WaitOne(30000);
          if (!_on || gen != _gen) break;
          if (Interlocked.Exchange(ref _deviceChanged, 0) == 1 || vol == null) {
            Detach(vol, levelSink);
            vol = Attach(en, levelSink, out device, out why);
            _reason = vol == null ? why : null;
            EmitNow(vol, device, "device", why);
            continue;
          }
          if (Interlocked.Exchange(ref _noted, 0) == 1) {
            float lv; bool m;
            lock (_lock) { lv = _noteLevel; m = _noteMuted; }
            Emit((int)Math.Round(lv * 100f), m, device, "notify", null);
          }
        }
      } catch (Exception ex) {
        _reason = "the volume watch stopped (" + ex.GetType().Name + ": " + ex.Message + ")";
        Program.EmitLog("warn", "volume watch: " + _reason);
        Program.Emit(Json.Obj("ev", "volume", "ok", false, "level", null, "muted", false, "device", device,
                              "via", "error", "reason", _reason));
      } finally {
        Detach(vol, levelSink);
        if (en != null) {
          if (devRegistered) { try { en.UnregisterEndpointNotificationCallback(devSink); } catch (Exception) { } }
          try { Marshal.ReleaseComObject(en); } catch (Exception) { }
        }
        lock (_lock) { if (gen == _gen) _on = false; }
      }
    }

    /// The default playback device's volume, with the level sink registered on it.
    static IAudioEndpointVolume Attach(IMMDeviceEnumerator en, LevelSink sink, out string device, out string why) {
      device = null;
      why = null;
      IMMDevice d = null;
      try {
        int hr = en.GetDefaultAudioEndpoint(eRender, eMultimedia, out d);
        if (hr != 0 || d == null) {
          why = "there is no default playback device (HRESULT 0x" + hr.ToString("X8") + ")";
          return null;
        }
        d.GetId(out device);
        Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        object raw;
        hr = d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw);
        if (hr != 0 || raw == null) {
          why = "the playback device refused its volume control (HRESULT 0x" + hr.ToString("X8") + ")";
          return null;
        }
        var vol = (IAudioEndpointVolume)raw;
        hr = vol.RegisterControlChangeNotify(sink);
        if (hr != 0) {
          why = "Windows refused the volume listener (HRESULT 0x" + hr.ToString("X8") + ")";
          try { Marshal.ReleaseComObject(vol); } catch (Exception) { }
          return null;
        }
        return vol;
      } catch (Exception ex) {
        why = "the playback device could not be watched (" + ex.GetType().Name + ": " + ex.Message + ")";
        return null;
      } finally {
        if (d != null) { try { Marshal.ReleaseComObject(d); } catch (Exception) { } }
      }
    }

    static void Detach(IAudioEndpointVolume vol, LevelSink sink) {
      if (vol == null) return;
      try { vol.UnregisterControlChangeNotify(sink); } catch (Exception) { }
      try { Marshal.ReleaseComObject(vol); } catch (Exception) { }
    }

    static void EmitNow(IAudioEndpointVolume vol, string device, string via, string why) {
      if (vol == null) {
        Program.Emit(Json.Obj("ev", "volume", "ok", false, "level", null, "muted", false, "device", device,
                              "via", via, "reason", why ?? "the volume could not be read"));
        return;
      }
      float lv; bool m;
      if (vol.GetMasterVolumeLevelScalar(out lv) != 0 || vol.GetMute(out m) != 0) {
        Program.Emit(Json.Obj("ev", "volume", "ok", false, "level", null, "muted", false, "device", device,
                              "via", via, "reason", "the playback device would not report its volume"));
        return;
      }
      Emit((int)Math.Round(lv * 100f), m, device, via, null);
    }

    static void Emit(int level, bool muted, string device, string via, string reason) {
      bool first = via == "start" || via == "device";
      if (!first && level == _lastLevel && muted == _lastMuted && device == _lastDevice) return;
      _lastLevel = level;
      _lastMuted = muted;
      _lastDevice = device;
      _events++;
      Program.Emit(Json.Obj("ev", "volume", "ok", true, "level", level, "muted", muted, "device", device,
                            "via", via, "reason", reason));
    }
  }
}
