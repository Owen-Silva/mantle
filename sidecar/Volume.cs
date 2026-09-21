// Volume.cs - master volume and mute, via CoreAudio COM.
//
// There is no Win32 function for "set the system volume"; the only supported
// route is the COM interface the volume flyout itself uses. There is no
// NAudio here (no NuGet on this machine), so the three interfaces are declared
// by hand.
//
// THE ONE RULE for hand-declared COM: METHOD ORDER IS THE ABI. The vtable is
// positional, so adding, reordering or omitting a method silently calls the
// wrong function - usually with a crash rather than an error. Every method of
// each interface is declared here even though we call three of them, precisely
// so the order cannot drift.
using System;
using System.Runtime.InteropServices;

namespace Mantle {
  static class Volume {
    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    const int eRender = 0;       // playback (not capture)
    const int eMultimedia = 1;   // the role the volume keys control
    const int CLSCTX_ALL = 23;

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
      int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
      int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
      int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
      int RegisterEndpointNotificationCallback(IntPtr client);
      int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
      int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                   [MarshalAs(UnmanagedType.IUnknown)] out object iface);
      int OpenPropertyStore(int access, out IntPtr store);
      int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      int GetState(out int state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
      int RegisterControlChangeNotify(IntPtr notify);
      int UnregisterControlChangeNotify(IntPtr notify);
      int GetChannelCount(out uint count);
      int SetMasterVolumeLevel(float db, ref Guid eventContext);
      int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
      int GetMasterVolumeLevel(out float db);
      int GetMasterVolumeLevelScalar(out float level);
      int SetChannelVolumeLevel(uint channel, float db, ref Guid eventContext);
      int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
      int GetChannelVolumeLevel(uint channel, out float db);
      int GetChannelVolumeLevelScalar(uint channel, out float level);
      int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
      int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
      int GetVolumeStepInfo(out uint step, out uint stepCount);
      int VolumeStepUp(ref Guid eventContext);
      int VolumeStepDown(ref Guid eventContext);
      int QueryHardwareSupport(out uint mask);
      int GetVolumeRange(out float min, out float max, out float increment);
    }

    /// Read and/or write, then always read back, so the reply is what the
    /// hardware actually settled on rather than what we asked for.
    /// setLevel/setMute are null when that half is not being changed.
    public static void Apply(int? setLevel, bool? setMute, out int level, out bool muted) {
      IMMDeviceEnumerator enumerator = null;
      IMMDevice device = null;
      IAudioEndpointVolume vol = null;
      object raw = null;
      try {
        Type t = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
        if (t == null) throw new InvalidOperationException("the CoreAudio device enumerator is not registered on this system");
        enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(t);

        int hr = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia, out device);
        if (hr != 0 || device == null)
          throw new InvalidOperationException("no default playback device (HRESULT 0x" + hr.ToString("x8") +
            ") - nothing is plugged in, or audio is disabled");

        Guid iid = IID_IAudioEndpointVolume;
        hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw);
        if (hr != 0 || raw == null)
          throw new InvalidOperationException("the playback device refused the volume interface (HRESULT 0x" + hr.ToString("x8") + ")");
        vol = (IAudioEndpointVolume)raw;

        Guid ctx = Guid.Empty;
        if (setLevel.HasValue) {
          int want = Math.Max(0, Math.Min(100, setLevel.Value));
          hr = vol.SetMasterVolumeLevelScalar(want / 100f, ref ctx);
          if (hr != 0) throw new InvalidOperationException("setting the volume failed (HRESULT 0x" + hr.ToString("x8") + ")");
        }
        if (setMute.HasValue) {
          hr = vol.SetMute(setMute.Value, ref ctx);
          if (hr != 0) throw new InvalidOperationException("setting mute failed (HRESULT 0x" + hr.ToString("x8") + ")");
        }

        float scalar;
        vol.GetMasterVolumeLevelScalar(out scalar);
        bool m;
        vol.GetMute(out m);
        level = (int)Math.Round(scalar * 100f);
        muted = m;
      } finally {
        // RCWs on COM objects from another apartment leak the underlying object
        // until a GC otherwise; release them deterministically.
        if (vol != null) Marshal.ReleaseComObject(vol);
        else if (raw != null) Marshal.ReleaseComObject(raw);
        if (device != null) Marshal.ReleaseComObject(device);
        if (enumerator != null) Marshal.ReleaseComObject(enumerator);
      }
    }
  }
}
