// SysSound.cs - Mantle Settings > System > Sound, natively (lane syssnd, 2026-09-28).
//
// WHY: Mantle Settings replaces Windows' Settings app, so its Sound page must read and change what
// Windows' Sound page (and the old Sound control panel behind "More sound settings") does - which
// device plays and records (default and communications), each device's name, format, enhancements,
// spatial sound, volume and per-channel balance, enable/disable, a test tone and a microphone test,
// mono audio, the communications "ducking" rule, and the per-app volume mixer with each app's own
// output and input device - without ever opening Windows' Settings. AudioMixer.cs (the bar's '>'
// view) is left alone: it only knows the default output; this file is the whole page.
//
// COMMANDS (every write takes dryRun; dryRun validates against a FRESH read and writes nothing):
//   syssound.devices   {}                           every output + input device, defaults, mono, ducking
//   syssound.meter     {}                           peak level (0-100) of every active device, now
//   syssound.apps      {}                           the volume mixer: every app playing sound
//   syssound.default   {device, role:'default'|'communications', dryRun}
//   syssound.level     {device, level?, muted?, channel?, dryRun}   channel = one channel's level
//   syssound.props     {device, prop:'name'|'enhancements'|'exclusive'|'exclusivePriority'|'format'|'spatial', value, dryRun}
//   syssound.enable    {device, on, dryRun}          show/hide a device (Windows' Enable/Disable)
//   syssound.setting   {key:'mono'|'ducking', value, dryRun}
//   syssound.tone      {device, dryRun}              a 0.7 s test tone on an output device
//   syssound.micTest   {device, ms?, dryRun}         listens up to ms (default 6000) and streams levels
//   syssound.micStop   {}                            ends a microphone test early
//   syssound.appSet    {app, level?, muted?, dryRun} one app's level / mute (app = its key from apps)
//   syssound.appDevice {app, flow:'output'|'input', device ('' = the default), dryRun}
//   syssound.resetApps {dryRun}                      Windows' "Reset" for every app: devices + volumes
//   syssound.decide    {what, ...}                   PURE: the format maths over made-up inputs (tests)
//   [Elevated] syssound.deviceProp {device, prop, value}   a property-store write as administrator
// EVENTS {"ev":"syssound", what:'mic'|'micDone'|'tone', device, peak?, peakMax?, ok?, reason?}: the
// main half relays them to the page as settings.system.sound.
//
// THE DEVICE KEY (`device`, never `id`): the MMDevice endpoint id, "{0.0.0.00000000}.{guid}" for an
// output, "{0.0.1.00000000}.{guid}" for an input. It survives restarts.
//
// WHAT IS DOCUMENTED AND WHAT IS NOT (said here so the page can say it on the row):
//   documented: IMMDeviceEnumerator, IAudioEndpointVolume, IAudioMeterInformation, IAudioClient,
//     IAudioSessionManager2, the endpoint property store (names, form factor, the device format,
//     PKEY_AudioEndpoint_Disable_SysFx), and Windows.Media.Audio.SpatialAudioDeviceConfiguration
//     (WinRT) for spatial sound.
//   undocumented but what Windows' own panels call (EarTrumpet, SoundSwitch do the same):
//     IPolicyConfig (default device, format, enable/disable) and the WinRT factory
//     Windows.Media.Internal.AudioPolicyConfig (each app's own output/input device), called through
//     its raw vtable (slots 25-27 after the 21H2 layout) on an MTA thread. If a future Windows moves
//     either, the reply says so in words; nothing guesses.
//   property-store WRITES (name, enhancements, exclusive mode) go to HKLM\...\MMDevices: if Windows
//     refuses the user's filtered token they answer needsAdmin + elevate:'syssound.deviceProp'.
//   the exclusive-mode keys ({b3f8fa53-0004-438e-9003-51a46e139bfc},3 and ,4) are the ones the Sound
//     control panel writes; they are read as they are and written back in the same variant type.
//
// READ-ONLY, with the reason on the row: "Listen to this device" (kept in the driver's effects store,
// which only the Sound control panel's own interface writes); a device's supported formats when an
// app holds it in exclusive mode; spatial sound on a device that reports no spatial formats.
//
// PRIVACY: nothing in this file logs. Reasons carry codes and states only - never a device name, app
// name or path; results to the page may carry them (the page shows them).
//
// PASSIVE (every test sidecar): reads and every dryRun answer; each real write, the tone and the
// microphone test answer FeatureTable.PassiveRefusal + ": it would have ...".
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
#if MANTLE_WINMD
using Windows.Media.Audio;
#endif

namespace Mantle {
  [MantleFeature]
  static class SysSound {
    public static void Register(FeatureTable t) {
      t.Add("syssound.devices", Lanes.Slow, DevicesCmd);
      t.Add("syssound.meter", Lanes.Slow, MeterCmd);
      t.Add("syssound.apps", Lanes.Slow, AppsCmd);
      t.Add("syssound.default", Lanes.Slow, DefaultCmd);
      t.Add("syssound.level", Lanes.Slow, LevelCmd);
      t.Add("syssound.props", Lanes.Slow, PropsCmd);
      t.Add("syssound.enable", Lanes.Slow, EnableCmd);
      t.Add("syssound.setting", Lanes.Slow, SettingCmd);
      t.Add("syssound.tone", Lanes.Slow, ToneCmd);
      t.Add("syssound.micTest", Lanes.Slow, MicTestCmd);
      t.Add("syssound.micStop", Lanes.Slow, MicStopCmd);
      t.Add("syssound.appSet", Lanes.Slow, AppSetCmd);
      t.Add("syssound.appDevice", Lanes.Slow, AppDeviceCmd);
      t.Add("syssound.resetApps", Lanes.Slow, ResetAppsCmd);
      t.Add("syssound.decide", Lanes.Slow, DecideCmd);   // PURE: no Windows call at all
    }

    // ================================================================== constants
    const int eRender = 0, eCapture = 1;
    const int eConsole = 0, eMultimedia = 1, eCommunications = 2;
    const int ST_ACTIVE = 1, ST_DISABLED = 2, ST_NOTPRESENT = 4, ST_UNPLUGGED = 8;
    const int SHOWN = ST_ACTIVE | ST_DISABLED | ST_UNPLUGGED;
    const int CLSCTX_ALL = 23;
    const int STGM_READ = 0, STGM_READWRITE = 2;
    const ushort VT_EMPTY = 0, VT_I4 = 3, VT_BOOL = 11, VT_UI4 = 19, VT_LPWSTR = 31, VT_BLOB = 65;
    const int E_ACCESSDENIED = unchecked((int)0x80070005);
    const int AUDCLNT_E_DEVICE_IN_USE = unchecked((int)0x8889000A);
    const string AudioKey = @"Software\Microsoft\Multimedia\Audio";
    const string RenderIface = "{e6327cad-dcec-4949-ae8a-991e976a79d2}";
    const string CaptureIface = "{2eef81be-33fa-4800-9670-1cd474972c3f}";

    /// The event context on every set: "mantle-sound----" in hex, so a listener can tell Mantle's own changes.
    static readonly Guid Ctx = new Guid("6d616e74-6c65-2d73-6f75-6e642d2d2d2d");
    static readonly Guid CLSID_Enum = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid CLSID_PolicyConfig = new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9");
    static readonly Guid IID_EpVol = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static readonly Guid IID_Meter = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
    static readonly Guid IID_Client = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    static readonly Guid IID_Render = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");
    static readonly Guid IID_Capture = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
    static readonly Guid IID_Sessions = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static readonly Guid SUB_PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
    static readonly Guid SUB_FLOAT = new Guid("00000003-0000-0010-8000-00AA00389B71");

    static readonly Guid FMT_DEVICE = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
    static readonly Guid FMT_EP = new Guid("1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E");
    static readonly Guid FMT_EXCL = new Guid("B3F8FA53-0004-438E-9003-51A46E139BFC");
    static readonly PROPERTYKEY PK_FriendlyName = new PROPERTYKEY(FMT_DEVICE, 14);
    static readonly PROPERTYKEY PK_DeviceDesc = new PROPERTYKEY(FMT_DEVICE, 2);
    static readonly PROPERTYKEY PK_IfaceName = new PROPERTYKEY(new Guid("026E516E-B814-414B-83CD-856D6FEF4822"), 2);
    static readonly PROPERTYKEY PK_FormFactor = new PROPERTYKEY(FMT_EP, 0);
    static readonly PROPERTYKEY PK_DisableSysFx = new PROPERTYKEY(FMT_EP, 5);
    static readonly PROPERTYKEY PK_DeviceFormat = new PROPERTYKEY(new Guid("F19F064D-082C-4E27-BC73-6882A1BB8E4C"), 0);
    static readonly PROPERTYKEY PK_ExclAllow = new PROPERTYKEY(FMT_EXCL, 3);
    static readonly PROPERTYKEY PK_ExclPriority = new PROPERTYKEY(FMT_EXCL, 4);

    static readonly int[] RATES = { 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000 };
    static readonly string[] FORM = { "network", "speakers", "line", "headphones", "microphone", "headset", "handset",
                                      "digital", "spdif", "display", "unknown" };
    static readonly string[] CHAN = { "Left", "Right", "Center", "Subwoofer", "Back left", "Back right", "Front left of center",
                                      "Front right of center", "Back center", "Side left", "Side right" };
    static readonly string[] DUCK = { "Mute all other sounds", "Reduce the volume of other sounds by 80%",
                                      "Reduce the volume of other sounds by 50%", "Do nothing" };

    // ================================================================== interop (METHOD ORDER IS THE ABI)
    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public uint pid; public PROPERTYKEY(Guid f, uint p) { fmtid = f; pid = p; } }

    /// 24 bytes on x64: vt, three reserved words, then the union (a BLOB is count + pointer).
    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p1; public IntPtr p2; }

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
      [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
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
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
      [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
      [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
      [PreserveSig] int GetChannelCount(out uint count);
      [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
      [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
      [PreserveSig] int GetMasterVolumeLevel(out float db);
      [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
      [PreserveSig] int SetChannelVolumeLevel(uint channel, float db, ref Guid ctx);
      [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid ctx);
      [PreserveSig] int GetChannelVolumeLevel(uint channel, out float db);
      [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
      [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
      [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
      [PreserveSig] int GetVolumeStepInfo(out uint step, out uint count);
      [PreserveSig] int VolumeStepUp(ref Guid ctx);
      [PreserveSig] int VolumeStepDown(ref Guid ctx);
      [PreserveSig] int QueryHardwareSupport(out uint mask);
      [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incDb);
    }
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation {
      [PreserveSig] int GetPeakValue(out float peak);
      [PreserveSig] int GetMeteringChannelCount(out uint count);
      [PreserveSig] int GetChannelsPeakValues(uint count, [Out, MarshalAs(UnmanagedType.LPArray)] float[] peaks);
      [PreserveSig] int QueryHardwareSupport(out uint mask);
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient {
      [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
      [PreserveSig] int GetBufferSize(out uint frames);
      [PreserveSig] int GetStreamLatency(out long latency);
      [PreserveSig] int GetCurrentPadding(out uint padding);
      [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closestMatch);
      [PreserveSig] int GetMixFormat(out IntPtr format);
      [PreserveSig] int GetDevicePeriod(out long dflt, out long min);
      [PreserveSig] int Start();
      [PreserveSig] int Stop();
      [PreserveSig] int Reset();
      [PreserveSig] int SetEventHandle(IntPtr handle);
      [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }
    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioRenderClient {
      [PreserveSig] int GetBuffer(uint frames, out IntPtr data);
      [PreserveSig] int ReleaseBuffer(uint frames, uint flags);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient {
      [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
      [PreserveSig] int ReleaseBuffer(uint frames);
      [PreserveSig] int GetNextPacketSize(out uint frames);
    }
    /// Windows 7+ IPolicyConfig (undocumented; the Sound control panel's own interface).
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig {
      [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr format);
      [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, IntPtr format);
      [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
      [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpointFormat, IntPtr mixFormat);
      [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, IntPtr dflt, IntPtr min);
      [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr period);
      [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
      [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
      [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr value);
      [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr value);
      [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
      [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
    }
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
      [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr control);
      [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr volume);
      [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
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
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
      [PreserveSig] int GetState(out int state);
      [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
      [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid ctx);
      [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
      [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid ctx);
      [PreserveSig] int GetGroupingParam(out Guid grouping);
      [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid ctx);
      [PreserveSig] int RegisterAudioSessionNotification(IntPtr notifications);
      [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notifications);
      [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sid);
      [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sid);
      [PreserveSig] int GetProcessId(out uint pid);
      [PreserveSig] int IsSystemSoundsSession();
      [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }
    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume {
      [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
      [PreserveSig] int GetMasterVolume(out float level);
      [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
      [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern int SHLoadIndirectString(string source, StringBuilder outBuf, uint cch, IntPtr reserved);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, out IntPtr factory);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string s, uint len, out IntPtr hs);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hs);
    [DllImport("combase.dll")] static extern IntPtr WindowsGetStringRawBuffer(IntPtr hs, out uint len);

    // ================================================================== small helpers
    /// Every COM object a call touched, released together.
    sealed class Bag : IDisposable {
      readonly List<object> _l = new List<object>();
      public T Add<T>(T o) where T : class { if (o != null) _l.Add(o); return o; }
      public void Dispose() {
        for (int i = _l.Count - 1; i >= 0; i--) { try { if (Marshal.IsComObject(_l[i])) Marshal.ReleaseComObject(_l[i]); } catch (Exception) { } }
        _l.Clear();
      }
    }

    static string Hr(int hr) { return "HRESULT 0x" + hr.ToString("x8", CultureInfo.InvariantCulture); }
    static string Why(Exception ex) { return SysCommon.Why(ex); }
    static string Passive(string wouldHave) { return FeatureTable.PassiveRefusal + ": it would have " + wouldHave; }
    static List<object> L(params object[] items) { return new List<object>(items); }
    static int Pct(float f) { return (int)Math.Round(Math.Max(0f, Math.Min(1f, f)) * 100f); }
    static double R1(float f) { return Math.Round((double)f, 1); }

    static string DryArg(Dictionary<string, object> req, string cmd, out bool dry) {
      dry = false; object o;
      if (!Json.TryGet(req, "dryRun", out o) || o == null) return null;
      if (!(o is bool)) return cmd + " needs dryRun: true or false";
      dry = (bool)o; return null;
    }
    static readonly Regex DeviceRx = new Regex(@"^\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$");
    static string DeviceArg(Dictionary<string, object> req, string cmd, out string dev) {
      dev = Json.GetString(req, "device");
      if (string.IsNullOrEmpty(dev) || !DeviceRx.IsMatch(dev)) { dev = null; return cmd + " needs device: a device key from syssound.devices"; }
      return null;
    }
    static int FlowOf(string dev) { return dev.StartsWith("{0.0.1.", StringComparison.Ordinal) ? eCapture : eRender; }

    static IMMDeviceEnumerator NewEnum(Bag b) {
      Type t = Type.GetTypeFromCLSID(CLSID_Enum, true);
      return b.Add((IMMDeviceEnumerator)Activator.CreateInstance(t));
    }
    static T Activate<T>(IMMDevice d, Guid iid, Bag b, out int hr) where T : class {
      object o = null;
      hr = d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
      if (o != null) b.Add(o);
      return hr == 0 ? o as T : null;
    }

    /// Runs fn on its own MTA thread (WinRT and the policy factory want one; the slow lane is STA).
    static T OnMta<T>(Func<T> fn, int ms, out string err) {
      T res = default(T); Exception ex = null;
      var th = new Thread(delegate () { try { res = fn(); } catch (Exception e) { ex = e; } });
      th.IsBackground = true;
      th.SetApartmentState(ApartmentState.MTA);
      th.Start();
      if (!th.Join(ms)) { err = "did not answer within " + (ms / 1000) + " s"; return default(T); }
      err = ex == null ? null : Why(ex);
      return res;
    }

    // ------------------------------------------------------------------ property store
    static string PropString(IPropertyStore ps, PROPERTYKEY k) {
      PROPVARIANT pv;
      if (ps.GetValue(ref k, out pv) != 0) return null;
      try { return pv.vt == VT_LPWSTR && pv.p1 != IntPtr.Zero ? Marshal.PtrToStringUni(pv.p1) : null; }
      finally { PropVariantClear(ref pv); }
    }
    /// A number (UI4 / I4 / BOOL) or null when missing; vt says which type Windows stored.
    static long? PropNumber(IPropertyStore ps, PROPERTYKEY k, out ushort vt) {
      PROPVARIANT pv; vt = VT_EMPTY;
      if (ps.GetValue(ref k, out pv) != 0) return null;
      try {
        vt = pv.vt;
        long raw = pv.p1.ToInt64();
        if (pv.vt == VT_UI4) return (long)(uint)(raw & 0xffffffffL);
        if (pv.vt == VT_I4) return (long)(int)(raw & 0xffffffffL);
        if (pv.vt == VT_BOOL) return (raw & 0xffffL) != 0 ? 1 : 0;
        return null;
      } finally { PropVariantClear(ref pv); }
    }
    static byte[] PropBlob(IPropertyStore ps, PROPERTYKEY k) {
      PROPVARIANT pv;
      if (ps.GetValue(ref k, out pv) != 0) return null;
      try {
        if (pv.vt != VT_BLOB || pv.p2 == IntPtr.Zero) return null;
        int n = (int)(pv.p1.ToInt64() & 0xffffffffL);
        if (n <= 0 || n > 4096) return null;
        byte[] b = new byte[n];
        Marshal.Copy(pv.p2, b, 0, n);
        return b;
      } finally { PropVariantClear(ref pv); }
    }

    // ------------------------------------------------------------------ formats (pure)
    sealed class Fmt { public int Tag, Channels, Rate, Bits, Valid, Mask; public bool Float; }
    static Fmt ParseFmt(byte[] b) {
      if (b == null || b.Length < 16) return null;
      var f = new Fmt();
      f.Tag = BitConverter.ToUInt16(b, 0); f.Channels = BitConverter.ToUInt16(b, 2);
      f.Rate = (int)BitConverter.ToUInt32(b, 4); f.Bits = BitConverter.ToUInt16(b, 14); f.Valid = f.Bits;
      if (f.Tag == 0xFFFE && b.Length >= 40) {
        f.Valid = BitConverter.ToUInt16(b, 18); f.Mask = (int)BitConverter.ToUInt32(b, 20);
        byte[] g = new byte[16]; Array.Copy(b, 24, g, 0, 16);
        f.Float = new Guid(g) == SUB_FLOAT;
      } else f.Float = f.Tag == 3;
      if (f.Valid == 0) f.Valid = f.Bits;
      return f;
    }
    static void P16(byte[] b, int at, int v) { b[at] = (byte)v; b[at + 1] = (byte)(v >> 8); }
    static void P32(byte[] b, int at, int v) { P16(b, at, v & 0xffff); P16(b, at + 2, (v >> 16) & 0xffff); }
    /// A WAVEFORMATEXTENSIBLE (40 bytes).
    static byte[] MakeFmt(int ch, int rate, int container, int valid, int mask, bool flt) {
      byte[] b = new byte[40];
      int align = ch * container / 8;
      P16(b, 0, 0xFFFE); P16(b, 2, ch); P32(b, 4, rate); P32(b, 8, rate * align); P16(b, 12, align); P16(b, 14, container);
      P16(b, 16, 22); P16(b, 18, valid); P32(b, 20, mask);
      Array.Copy((flt ? SUB_FLOAT : SUB_PCM).ToByteArray(), 0, b, 24, 16);
      return b;
    }
    static int DefaultMask(int ch) { return ch == 1 ? 0x4 : ch == 2 ? 0x3 : ch == 4 ? 0x33 : ch == 6 ? 0x3F : ch == 8 ? 0x63F : 0; }
    static string Quality(int bits, int rate) {
      if (bits == 16 && rate == 44100) return " (CD Quality)";
      if (bits == 16 && rate == 48000) return " (DVD Quality)";
      if (bits >= 24) return " (Studio Quality)";
      return "";
    }
    static string FmtText(int ch, int bits, int rate) {
      return ch + " channel, " + bits + " bit, " + rate.ToString(CultureInfo.InvariantCulture) + " Hz" + Quality(bits, rate);
    }
    /// "rate/bits/container": the page's value for one format.
    static string FmtValue(int rate, int bits, int container) { return rate + "/" + bits + "/" + container; }
    static bool ParseValue(string v, out int rate, out int bits, out int container) {
      rate = bits = container = 0;
      if (string.IsNullOrEmpty(v)) return false;
      string[] p = v.Split('/');
      if (p.Length != 3) return false;
      if (!int.TryParse(p[0], NumberStyles.None, CultureInfo.InvariantCulture, out rate) ||
          !int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out bits) ||
          !int.TryParse(p[2], NumberStyles.None, CultureInfo.InvariantCulture, out container)) return false;
      if (Array.IndexOf(RATES, rate) < 0) return false;
      if (bits != 16 && bits != 24 && bits != 32) return false;
      if (container != bits && !(bits == 24 && container == 32)) return false;
      return true;
    }
    static IDictionary FmtJson(Fmt f) {
      if (f == null) return null;
      return Json.Obj("rate", f.Rate, "bits", f.Valid, "container", f.Bits, "channels", f.Channels, "float", f.Float,
                      "value", FmtValue(f.Rate, f.Valid, f.Bits), "text", FmtText(f.Channels, f.Valid, f.Rate));
    }
    static List<object> ChannelNames(int mask, int count) {
      var names = new List<object>();
      if (count == 1) { names.Add("Mono"); return names; }
      for (int bit = 0; bit < 18 && names.Count < count; bit++)
        if ((mask & (1 << bit)) != 0) names.Add(bit < CHAN.Length ? CHAN[bit] : "Channel " + (names.Count + 1));
      while (names.Count < count) names.Add(count == 2 ? (names.Count == 0 ? "Left" : "Right") : "Channel " + (names.Count + 1));
      return names;
    }
    static string IfacePath(string dev, int flow) {
      return @"\\?\SWD#MMDEVAPI#" + dev + "#" + (flow == eRender ? RenderIface : CaptureIface);
    }
    static string FromIfacePath(string path) {
      if (string.IsNullOrEmpty(path)) return "";
      int a = path.IndexOf("MMDEVAPI#", StringComparison.OrdinalIgnoreCase);
      if (a < 0) return null;
      a += 9;
      int z = path.IndexOf('#', a);
      string d = z < 0 ? path.Substring(a) : path.Substring(a, z - a);
      return DeviceRx.IsMatch(d) ? d : null;
    }

    // ================================================================== endpoints
    sealed class Ep {
      public string Id, Name, Label, Adapter; public int Flow, State, FormFactor = -1; public IMMDevice Dev; public IPropertyStore Ps;
    }
    static List<Ep> Endpoints(IMMDeviceEnumerator en, int flow, int mask, Bag b, out string err) {
      var list = new List<Ep>(); err = null;
      IMMDeviceCollection col;
      int hr = en.EnumAudioEndpoints(flow, mask, out col);
      if (hr != 0 || col == null) { err = "Windows would not list the " + (flow == eRender ? "output" : "input") + " devices (" + Hr(hr) + ")"; return list; }
      b.Add(col);
      uint n;
      if (col.GetCount(out n) != 0) n = 0;
      for (uint i = 0; i < n && i < 64; i++) {
        IMMDevice d;
        if (col.Item(i, out d) != 0 || d == null) continue;
        b.Add(d);
        string sid;
        if (d.GetId(out sid) != 0 || string.IsNullOrEmpty(sid)) continue;
        var e = new Ep(); e.Dev = d; e.Flow = flow; e.Id = sid;
        int st; e.State = d.GetState(out st) == 0 ? st : 0;
        IPropertyStore ps;
        if (d.OpenPropertyStore(STGM_READ, out ps) == 0 && ps != null) {
          b.Add(ps); e.Ps = ps;
          e.Name = PropString(ps, PK_FriendlyName); e.Label = PropString(ps, PK_DeviceDesc); e.Adapter = PropString(ps, PK_IfaceName);
          ushort vt; long? ff = PropNumber(ps, PK_FormFactor, out vt);
          e.FormFactor = ff.HasValue ? (int)ff.Value : -1;
        }
        list.Add(e);
      }
      return list;
    }
    /// One device by key (any state), or null with the reason.
    static Ep Find(IMMDeviceEnumerator en, string dev, Bag b, out string err) {
      List<Ep> all = Endpoints(en, FlowOf(dev), SHOWN | ST_NOTPRESENT, b, out err);
      if (err != null) return null;
      foreach (Ep e in all) if (string.Equals(e.Id, dev, StringComparison.OrdinalIgnoreCase)) return e;
      err = "that sound device is not on this PC any more (it may have been removed)";
      return null;
    }
    static string DefaultId(IMMDeviceEnumerator en, int flow, int role, Bag b) {
      IMMDevice d;
      if (en.GetDefaultAudioEndpoint(flow, role, out d) != 0 || d == null) return null;
      b.Add(d);
      string s;
      return d.GetId(out s) == 0 ? s : null;
    }
    static string StateName(int s) {
      return s == ST_ACTIVE ? "active" : s == ST_DISABLED ? "disabled" : s == ST_UNPLUGGED ? "unplugged" : s == ST_NOTPRESENT ? "notpresent" : "unknown";
    }

    // ------------------------------------------------------------------ volume
    static IDictionary VolumeJson(Ep e, Fmt f, Bag b) {
      int hr;
      var v = Activate<IAudioEndpointVolume>(e.Dev, IID_EpVol, b, out hr);
      if (v == null) return Json.Obj("reason", "the device refused its volume control (" + Hr(hr) + ")");
      float m; bool mu; uint n;
      if (v.GetMasterVolumeLevelScalar(out m) != 0) return Json.Obj("reason", "the device did not report its volume");
      if (v.GetMute(out mu) != 0) mu = false;
      if (v.GetChannelCount(out n) != 0) n = 0;
      var names = ChannelNames(f != null ? f.Mask : DefaultMask((int)n), (int)n);
      var chs = new List<object>();
      for (uint i = 0; i < n && i < 16; i++) {
        float c;
        if (v.GetChannelVolumeLevelScalar(i, out c) != 0) continue;
        chs.Add(Json.Obj("index", (int)i, "name", names[(int)i], "level", Pct(c)));
      }
      float mn, mx, inc;
      object range = v.GetVolumeRange(out mn, out mx, out inc) == 0 ? Json.Obj("minDb", R1(mn), "maxDb", R1(mx), "stepDb", R1(inc)) : null;
      return Json.Obj("level", Pct(m), "muted", mu, "channels", chs, "range", range, "reason", null);
    }

    // ------------------------------------------------------------------ supported formats
    static int Supported(IAudioClient ac, byte[] f) {
      IntPtr p = Marshal.AllocCoTaskMem(f.Length);
      try { Marshal.Copy(f, 0, p, f.Length); return ac.IsFormatSupported(1 /* EXCLUSIVE */, p, IntPtr.Zero); }
      finally { Marshal.FreeCoTaskMem(p); }
    }
    static List<object> Formats(Ep e, Fmt cur, Bag b, out string why) {
      why = null;
      var list = new List<object>();
      int hr;
      var ac = Activate<IAudioClient>(e.Dev, IID_Client, b, out hr);
      if (ac == null) { why = "the device would not say which formats it takes (" + Hr(hr) + ")"; return list; }
      int ch = cur != null && cur.Channels > 0 ? cur.Channels : 2;
      int mask = cur != null && cur.Mask != 0 ? cur.Mask : DefaultMask(ch);
      bool inUse = false;
      foreach (int bits in new int[] { 16, 24, 32 }) {
        foreach (int rate in RATES) {
          // 24-bit: the container the device uses now first, so the current format is listed as itself
          bool cur32 = cur != null && cur.Valid == 24 && cur.Bits == 32;
          int[] conts = bits == 24 ? (cur32 ? new int[] { 32, 24 } : new int[] { 24, 32 }) : new int[] { bits };
          foreach (int cont in conts) {
            int r = Supported(ac, MakeFmt(ch, rate, cont, bits, mask, false));
            if (r == AUDCLNT_E_DEVICE_IN_USE) inUse = true;
            if (r == 0) { list.Add(Json.Obj("value", FmtValue(rate, bits, cont), "rate", rate, "bits", bits, "container", cont, "channels", ch, "text", FmtText(ch, bits, rate))); break; }
          }
        }
      }
      if (list.Count == 0) why = inUse ? "an app is using this device in exclusive mode, so Windows cannot say which formats it takes right now"
                                       : "the device reports no standard PCM format Windows could offer";
      return list;
    }

    // ------------------------------------------------------------------ property-store writability
    static int _storeProbe = -1;          // -1 not probed, 1 writable, 0 refused
    static string _storeWhy;
    /// Opens ONE endpoint's store for writing and closes it at once (nothing is written): says whether
    /// the user's token may write device properties, or needs the administrator prompt.
    static void ProbeStore(IMMDevice d) {
      if (_storeProbe >= 0) return;
      IPropertyStore ps;
      int hr = d.OpenPropertyStore(STGM_READWRITE, out ps);
      if (ps != null) { try { Marshal.ReleaseComObject(ps); } catch (Exception) { } }
      if (hr == 0) { _storeProbe = 1; _storeWhy = null; }
      else { _storeProbe = 0; _storeWhy = hr == E_ACCESSDENIED ? "admin" : "Windows would not open the device's settings for writing (" + Hr(hr) + ")"; }
    }

    // ------------------------------------------------------------------ spatial sound (WinRT, documented)
#if MANTLE_WINMD
    static List<string[]> SpatialNames() {
      var l = new List<string[]>();
      l.Add(new string[] { SpatialAudioFormatSubtype.WindowsSonic, "Windows Sonic for Headphones" });
      l.Add(new string[] { SpatialAudioFormatSubtype.DolbyAtmosForHeadphones, "Dolby Atmos for Headphones" });
      l.Add(new string[] { SpatialAudioFormatSubtype.DolbyAtmosForHomeTheater, "Dolby Atmos for home theater" });
      l.Add(new string[] { SpatialAudioFormatSubtype.DolbyAtmosForSpeakers, "Dolby Atmos for built-in speakers" });
      l.Add(new string[] { SpatialAudioFormatSubtype.DTSHeadphoneX, "DTS Headphone:X" });
      l.Add(new string[] { SpatialAudioFormatSubtype.DTSXUltra, "DTS Sound Unbound" });
      l.Add(new string[] { SpatialAudioFormatSubtype.DTSXForHomeTheater, "DTS:X for home theater" });
      return l;
    }
#endif
    static IDictionary SpatialRead(string dev) {
#if MANTLE_WINMD
      string err;
      IDictionary r = OnMta<IDictionary>(delegate () {
        var c = SpatialAudioDeviceConfiguration.GetForDeviceId(IfacePath(dev, eRender));
        bool sup = c.IsSpatialAudioSupported;
        var fl = new List<object>();
        if (sup) foreach (string[] s in SpatialNames()) if (c.IsSpatialAudioFormatSupported(s[0])) fl.Add(Json.Obj("subtype", s[0], "name", s[1]));
        string act = c.ActiveSpatialAudioFormat ?? "", dflt = c.DefaultSpatialAudioFormat ?? "";
        string name = "";
        foreach (string[] s in SpatialNames()) if (string.Equals(s[0], dflt, StringComparison.OrdinalIgnoreCase)) name = s[1];
        return Json.Obj("supported", sup, "active", act, "current", dflt, "currentName", name, "formats", fl,
                        "writable", sup && fl.Count > 0,
                        "why", !sup ? "this device does not support spatial sound (Windows reports no spatial formats for it)"
                             : fl.Count == 0 ? "no spatial sound format is installed for this device" : null);
      }, 5000, out err);
      if (err != null || r == null) return Json.Obj("supported", null, "formats", new List<object>(), "writable", false,
                                                    "why", "Windows' spatial sound settings did not answer (" + (err ?? "no answer") + ")");
      return r;
#else
      return Json.Obj("supported", null, "formats", new List<object>(), "writable", false,
                      "why", "spatial sound needs Windows' WinRT metadata, which this build of Mantle was compiled without");
#endif
    }

    // ================================================================== syssound.devices
    static string DevicesCmd(Dictionary<string, object> req, ref object result) {
      try {
        using (var b = new Bag()) {
          var en = NewEnum(b);
          IDictionary output = FlowJson(en, eRender, b);
          IDictionary input = FlowJson(en, eCapture, b);
          result = Json.Obj("output", output, "input", input, "mono", MonoJson(), "ducking", DuckJson(),
                            "propsWritable", _storeProbe < 0 ? null : (object)(_storeProbe == 1),
                            "propsWhy", _storeProbe == 0 ? (_storeWhy == "admin" ? "Windows keeps device properties for the whole PC, so changing them asks for administrator permission" : _storeWhy) : null,
                            "listen", Json.Obj("writable", false, "why", "Windows keeps \"Listen to this device\" in the audio driver's effects store, which only the Sound control panel's own interface writes"));
        }
        return null;
      } catch (Exception ex) { return "syssound.devices failed: " + Why(ex); }
    }

    static IDictionary FlowJson(IMMDeviceEnumerator en, int flow, Bag b) {
      string err;
      List<Ep> eps = Endpoints(en, flow, SHOWN, b, out err);
      string dCon = DefaultId(en, flow, eConsole, b), dCom = DefaultId(en, flow, eCommunications, b);
      var list = new List<object>();
      foreach (Ep e in eps) {
        bool active = e.State == ST_ACTIVE;
        if (active) ProbeStore(e.Dev);
        byte[] fb = e.Ps != null ? PropBlob(e.Ps, PK_DeviceFormat) : null;
        Fmt f = ParseFmt(fb);
        ushort vt, vtA, vtP;
        long? sysfx = e.Ps != null ? PropNumber(e.Ps, PK_DisableSysFx, out vt) : null;
        long? exA = e.Ps != null ? PropNumber(e.Ps, PK_ExclAllow, out vtA) : null;
        long? exP = e.Ps != null ? PropNumber(e.Ps, PK_ExclPriority, out vtP) : null;
        string fWhy = null;
        List<object> fmts = active ? Formats(e, f, b, out fWhy) : new List<object>();
        if (!active) fWhy = "the device is " + StateName(e.State) + ", so Windows cannot ask it which formats it takes";
        list.Add(Json.Obj(
          "device", e.Id, "flow", flow == eRender ? "output" : "input",
          "name", e.Name ?? e.Label ?? "Sound device", "label", e.Label, "adapter", e.Adapter,
          "state", StateName(e.State), "formFactor", e.FormFactor >= 0 && e.FormFactor < FORM.Length ? FORM[e.FormFactor] : "unknown",
          "isDefault", e.Id == dCon, "isDefaultComms", e.Id == dCom,
          "volume", active ? VolumeJson(e, f, b) : Json.Obj("reason", "the device is " + StateName(e.State) + ", so it has no volume right now"),
          "format", FmtJson(f), "formatReason", f == null ? "Windows has not stored a format for this device yet" : null,
          "formats", fmts, "formatsReason", fWhy,
          "enhancements", Json.Obj("on", sysfx == null ? true : sysfx.Value == 0, "set", sysfx != null,
                                   "note", sysfx == null ? "Not set: the driver's default effects apply" : null),
          "exclusive", Json.Obj("allow", exA == null ? true : exA.Value != 0, "priority", exP == null ? true : exP.Value != 0,
                                "set", exA != null || exP != null),
          "spatial", flow == eRender && active ? SpatialRead(e.Id) : null));
      }
      return Json.Obj("devices", list, "defaultDevice", dCon, "defaultComms", dCom, "reason", err);
    }

    static IDictionary MonoJson() {
      string why;
      long? v = SysCommon.ReadNumber("HKCU", AudioKey, "AccessibilityMonoMixState", out why);
      return Json.Obj("on", v != null && v.Value != 0, "set", v != null, "writable", true, "why", null,
                      "note", "Windows applies mono audio to sound that starts after the change; a playing app may need to restart its sound");
    }
    static IDictionary DuckJson() {
      string why;
      long? v = SysCommon.ReadNumber("HKCU", AudioKey, "UserDuckingPreference", out why);
      int val = v == null || v.Value < 0 || v.Value > 3 ? 1 : (int)v.Value;   // Windows' default: reduce by 80%
      var opts = new List<object>();
      for (int i = 0; i < DUCK.Length; i++) opts.Add(Json.Obj("value", i, "label", DUCK[i]));
      return Json.Obj("value", val, "set", v != null, "options", opts, "writable", true, "why", null);
    }

    // ================================================================== syssound.meter
    static string MeterCmd(Dictionary<string, object> req, ref object result) {
      try {
        using (var b = new Bag()) {
          var en = NewEnum(b);
          var peaks = new List<object>();
          foreach (int flow in new int[] { eRender, eCapture }) {
            string err;
            foreach (Ep e in Endpoints(en, flow, ST_ACTIVE, b, out err)) {
              int hr;
              var m = Activate<IAudioMeterInformation>(e.Dev, IID_Meter, b, out hr);
              float p;
              if (m == null || m.GetPeakValue(out p) != 0) continue;
              peaks.Add(Json.Obj("device", e.Id, "peak", Pct(p)));
            }
          }
          result = Json.Obj("peaks", peaks, "micTest", _mic != null ? (object)_mic.Device : null);
        }
        return null;
      } catch (Exception ex) { return "syssound.meter failed: " + Why(ex); }
    }

    // ================================================================== syssound.default
    static string DefaultCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.default";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string dev; e = DeviceArg(req, C, out dev); if (e != null) return e;
        string role = Json.GetString(req, "role") ?? "default";
        if (role != "default" && role != "communications") return C + " needs role: 'default' or 'communications'";
        int flow = FlowOf(dev);
        int[] roles = role == "default" ? new int[] { eConsole, eMultimedia } : new int[] { eCommunications };
        using (var b = new Bag()) {
          var en = NewEnum(b);
          Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
          string refuse = ep.State != ST_ACTIVE ? "the device is " + StateName(ep.State) + ", and Windows only makes a working device the default" : null;
          string before = DefaultId(en, flow, roles[0], b);
          bool same = string.Equals(before, dev, StringComparison.OrdinalIgnoreCase);
          IDictionary write = Json.Obj("api", "IPolicyConfig.SetDefaultEndpoint", "device", dev, "value", role == "default" ? "console+multimedia" : "communications");
          if (dry) {
            IDictionary r = SysCommon.Dry(same || refuse != null ? new List<object>() : L(write), before, refuse, false);
            r["changed"] = !same && refuse == null;
            result = r; return null;
          }
          if (Program.Passive) return Passive("made a sound device the " + (role == "default" ? "default" : "communications") + " device");
          if (refuse != null) return refuse;
          if (!same) {
            IPolicyConfig pc = NewPolicy(b, out e); if (pc == null) return e;
            foreach (int r in roles) {
              int hr = pc.SetDefaultEndpoint(dev, r);
              if (hr != 0) return "Windows refused to change the default device (" + Hr(hr) + ")";
            }
          }
          string after = DefaultId(en, flow, roles[0], b);
          if (!string.Equals(after, dev, StringComparison.OrdinalIgnoreCase))
            return "Windows accepted the change, but it still reports another device as the default";
          result = Json.Obj("ok", true, "changed", !same, "device", after, "role", role);
          return null;
        }
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static IPolicyConfig NewPolicy(Bag b, out string err) {
      err = null;
      try {
        Type t = Type.GetTypeFromCLSID(CLSID_PolicyConfig, true);
        object o = b.Add(Activator.CreateInstance(t));
        var pc = o as IPolicyConfig;
        if (pc == null) err = "this Windows no longer offers the interface its Sound panel uses to change devices (IPolicyConfig), so Mantle cannot change it";
        return pc;
      } catch (Exception ex) { err = "Windows' sound policy interface did not start (" + Why(ex) + ")"; return null; }
    }

    // ================================================================== syssound.level
    static string LevelCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.level";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string dev; e = DeviceArg(req, C, out dev); if (e != null) return e;
        long level = -1, channel = -1; bool muted = false;
        bool hasLevel = Json.HasKey(req, "level"), hasMute = Json.HasKey(req, "muted"), hasCh = Json.HasKey(req, "channel");
        if (!hasLevel && !hasMute) return C + " needs level (0-100) and/or muted (true or false)";
        if (hasLevel) { e = SysCommon.Number(req, "level", C, 0, 100, out level); if (e != null) return e; }
        if (hasMute) { e = SysCommon.Bool(req, "muted", C, out muted); if (e != null) return e; }
        if (hasCh) {
          if (!hasLevel || hasMute) return C + " with channel needs level only (one channel's level)";
          e = SysCommon.Number(req, "channel", C, 0, 15, out channel); if (e != null) return e;
        }
        using (var b = new Bag()) {
          var en = NewEnum(b);
          Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
          if (ep.State != ST_ACTIVE) return "the device is " + StateName(ep.State) + ", so it has no volume to change";
          int hr;
          var v = Activate<IAudioEndpointVolume>(ep.Dev, IID_EpVol, b, out hr);
          if (v == null) return "the device refused its volume control (" + Hr(hr) + ")";
          float m; bool mu; uint n;
          v.GetMasterVolumeLevelScalar(out m); v.GetMute(out mu);
          if (v.GetChannelCount(out n) != 0) n = 0;
          if (hasCh && channel >= n) return C + " needs channel: 0 to " + ((int)n - 1) + " (this device has " + n + ")";
          float chBefore = 0;
          if (hasCh) v.GetChannelVolumeLevelScalar((uint)channel, out chBefore);
          var writes = new List<object>();
          if (hasCh) { if (Pct(chBefore) != level) writes.Add(Json.Obj("api", "IAudioEndpointVolume.SetChannelVolumeLevelScalar", "channel", (int)channel, "value", level / 100.0)); }
          else {
            if (hasLevel && Pct(m) != level) writes.Add(Json.Obj("api", "IAudioEndpointVolume.SetMasterVolumeLevelScalar", "value", level / 100.0));
            if (hasMute && mu != muted) writes.Add(Json.Obj("api", "IAudioEndpointVolume.SetMute", "on", muted));
          }
          if (dry) {
            IDictionary r = SysCommon.Dry(writes, Json.Obj("level", Pct(m), "muted", mu), null, false);
            r["changed"] = writes.Count > 0;
            result = r; return null;
          }
          if (Program.Passive) return Passive("changed a sound device's " + (hasCh ? "channel level" : hasLevel ? "volume" : "mute"));
          Guid ctx = Ctx;
          if (hasCh) { hr = v.SetChannelVolumeLevelScalar((uint)channel, level / 100f, ref ctx); if (hr != 0) return "Windows refused the channel level (" + Hr(hr) + ")"; }
          else {
            if (hasLevel) { hr = v.SetMasterVolumeLevelScalar(level / 100f, ref ctx); if (hr != 0) return "Windows refused the volume (" + Hr(hr) + ")"; }
            if (hasMute) { hr = v.SetMute(muted, ref ctx); if (hr != 0) return "Windows refused to " + (muted ? "mute" : "unmute") + " the device (" + Hr(hr) + ")"; }
          }
          float m2; bool mu2;
          v.GetMasterVolumeLevelScalar(out m2); v.GetMute(out mu2);
          var chs = new List<object>();
          for (uint i = 0; i < n && i < 16; i++) { float c; if (v.GetChannelVolumeLevelScalar(i, out c) == 0) chs.Add(Pct(c)); }
          if (hasCh && Math.Abs(Convert.ToInt32(chs.Count > channel ? chs[(int)channel] : -99) - level) > 1)
            return "Windows accepted the channel level, but it reads back differently";
          if (!hasCh && hasLevel && Math.Abs(Pct(m2) - level) > 1) return "Windows accepted the volume, but it reads back as " + Pct(m2) + "%";
          if (hasMute && mu2 != muted) return "Windows accepted the mute switch, but it reads back " + (mu2 ? "muted" : "unmuted");
          result = Json.Obj("ok", true, "changed", writes.Count > 0, "level", Pct(m2), "muted", mu2, "channels", chs);
          return null;
        }
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== syssound.props
    static readonly string[] StoreProps = { "name", "enhancements", "exclusive", "exclusivePriority" };
    static PROPERTYKEY StoreKey(string prop) {
      return prop == "name" ? PK_DeviceDesc : prop == "enhancements" ? PK_DisableSysFx : prop == "exclusive" ? PK_ExclAllow : PK_ExclPriority;
    }
    static string CheckValue(string prop, object v, out string name, out bool on) {
      name = null; on = false;
      if (prop == "name") {
        name = v as string;
        if (name == null) return "the name must be text";
        name = name.Trim();
        if (name.Length < 1 || name.Length > 64) return "the name must be 1 to 64 characters";
        foreach (char c in name) if (char.IsControl(c)) return "the name cannot hold control characters";
        return null;
      }
      if (!(v is bool)) return prop + " needs value: true or false";
      on = (bool)v;
      return null;
    }

    static string PropsCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.props";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string dev; e = DeviceArg(req, C, out dev); if (e != null) return e;
        string prop = Json.GetString(req, "prop");
        object value; Json.TryGet(req, "value", out value);
        if (prop == "format") return FormatSet(dev, value as string, dry, ref result);
        if (prop == "spatial") return SpatialSet(dev, value as string, dry, ref result);
        if (Array.IndexOf(StoreProps, prop) < 0) return C + " needs prop: name, enhancements, exclusive, exclusivePriority, format or spatial";
        string name; bool on;
        e = CheckValue(prop, value, out name, out on); if (e != null) return C + ": " + e;
        using (var b = new Bag()) {
          var en = NewEnum(b);
          Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
          if (ep.Ps == null) return "Windows would not open this device's settings";
          ushort vt;
          object before; long target;
          if (prop == "name") { before = ep.Label; target = 0; }
          else {
            long? cur = PropNumber(ep.Ps, StoreKey(prop), out vt);
            before = cur;
            // enhancements: the key DISABLES effects (1 = off); the exclusive keys are "allowed" (1 = on)
            target = prop == "enhancements" ? (on ? 0 : 1) : (on ? 1 : 0);
          }
          bool same = prop == "name" ? string.Equals(ep.Label, name, StringComparison.Ordinal)
                                     : (before != null && (long)before == target) || (before == null && ((prop == "enhancements" && on) || (prop != "enhancements" && on)));
          IDictionary write = Json.Obj("api", "IPropertyStore.SetValue", "device", dev, "prop", prop, "value", prop == "name" ? (object)name : target);
          int hrOpen = 0;
          IPropertyStore probe;
          hrOpen = ep.Dev.OpenPropertyStore(STGM_READWRITE, out probe);
          if (probe != null) { try { Marshal.ReleaseComObject(probe); } catch (Exception) { } }
          bool admin = hrOpen == E_ACCESSDENIED;
          string refuse = hrOpen != 0 && !admin ? "Windows would not open the device's settings for writing (" + Hr(hrOpen) + ")" : null;
          if (dry) {
            IDictionary r = SysCommon.Dry(same || refuse != null ? new List<object>() : L(write), before, refuse, admin && !same);
            r["changed"] = !same && refuse == null;
            if (admin && !same) r["elevate"] = "syssound.deviceProp";
            result = r; return null;
          }
          if (Program.Passive) return Passive("changed a sound device's " + prop);
          if (refuse != null) return refuse;
          if (same) { result = Json.Obj("ok", true, "changed", false, "prop", prop, "value", prop == "name" ? (object)name : on); return null; }
          if (admin) {
            IDictionary na = SysCommon.NeedsAdmin("syssound.deviceProp", "change a sound device's properties", L(write));
            na["args"] = Json.Obj("device", dev, "prop", prop, "value", prop == "name" ? (object)name : on);
            result = na;
            return null;
          }
          e = StoreWrite(dev, prop, name, on, out result);
          return e;
        }
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    /// The property-store write itself (non-elevated when Windows allows it, and the elevated action).
    static string StoreWrite(string dev, string prop, string name, bool on, out object result) {
      result = null;
      using (var b = new Bag()) {
        var en = NewEnum(b);
        string e;
        Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
        IPropertyStore ps;
        int hr = ep.Dev.OpenPropertyStore(STGM_READWRITE, out ps);
        if (ps != null) b.Add(ps);
        if (hr != 0 || ps == null) return hr == E_ACCESSDENIED ? "Windows needs administrator permission to change a sound device's properties" : "Windows would not open the device's settings for writing (" + Hr(hr) + ")";
        PROPERTYKEY k = StoreKey(prop);
        PROPVARIANT pv = new PROPVARIANT();
        long target = 0;
        if (prop == "name") { pv.vt = VT_LPWSTR; pv.p1 = Marshal.StringToCoTaskMemUni(name); }
        else {
          ushort vt; PropNumber(ps, k, out vt);
          target = prop == "enhancements" ? (on ? 0 : 1) : (on ? 1 : 0);
          if (vt == VT_BOOL) { pv.vt = VT_BOOL; pv.p1 = new IntPtr(target != 0 ? 0xFFFF : 0); }
          else if (vt == VT_I4) { pv.vt = VT_I4; pv.p1 = new IntPtr(target); }
          else { pv.vt = VT_UI4; pv.p1 = new IntPtr(target); }
        }
        try {
          hr = ps.SetValue(ref k, ref pv);
          if (hr == 0) hr = ps.Commit();
        } finally { if (pv.vt == VT_LPWSTR) PropVariantClear(ref pv); }
        if (hr != 0) return hr == E_ACCESSDENIED ? "Windows needs administrator permission to change a sound device's properties" : "Windows refused the change (" + Hr(hr) + ")";
        // read back through a fresh store
        IPropertyStore rs;
        if (ep.Dev.OpenPropertyStore(STGM_READ, out rs) != 0 || rs == null) return "the change was written but could not be read back";
        b.Add(rs);
        if (prop == "name") {
          string back = PropString(rs, k);
          if (!string.Equals(back, name, StringComparison.Ordinal)) return "the name was written but reads back differently";
          result = Json.Obj("ok", true, "changed", true, "prop", prop, "value", back);
        } else {
          ushort vt2; long? back = PropNumber(rs, k, out vt2);
          if (back == null || back.Value != target) return "the change was written but reads back " + (back == null ? "missing" : back.Value.ToString(CultureInfo.InvariantCulture));
          result = Json.Obj("ok", true, "changed", true, "prop", prop, "value", on,
                            "note", "Apps pick this up the next time they open the device");
        }
        return null;
      }
    }

    [Elevated("syssound.deviceProp", "CheckDeviceProp", "change a sound device's properties")]
    static string DevicePropAction(Dictionary<string, object> args, ref object result) {
      string dev = (string)args["device"], prop = (string)args["prop"];
      string name; bool on;
      string e = CheckValue(prop, args["value"], out name, out on); if (e != null) return e;
      object r;
      e = StoreWrite(dev, prop, name, on, out r);
      if (e != null) return e;
      result = r;
      return null;
    }
    static string CheckDeviceProp(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "device", "prop", "value");
      if (why != null) return why;
      object d, p, v;
      if (!args.TryGetValue("device", out d) || !(d is string) || !DeviceRx.IsMatch((string)d)) return "device must be a sound device key";
      if (!args.TryGetValue("prop", out p) || !(p is string) || Array.IndexOf(StoreProps, (string)p) < 0) return "prop must be name, enhancements, exclusive or exclusivePriority";
      if (!args.TryGetValue("value", out v)) return "value is missing";
      string name; bool on;
      return CheckValue((string)p, v, out name, out on);
    }

    // ------------------------------------------------------------------ format
    static string FormatSet(string dev, string value, bool dry, ref object result) {
      const string C = "syssound.props";
      int rate, bits, cont;
      if (!ParseValue(value, out rate, out bits, out cont)) return C + " format needs value: one of the device's formats (\"rate/bits/container\")";
      using (var b = new Bag()) {
        var en = NewEnum(b);
        string e;
        Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
        if (ep.State != ST_ACTIVE) return "the device is " + StateName(ep.State) + ", so its format cannot be changed now";
        Fmt cur = ParseFmt(ep.Ps != null ? PropBlob(ep.Ps, PK_DeviceFormat) : null);
        string why;
        List<object> fmts = Formats(ep, cur, b, out why);
        bool offered = false;
        foreach (IDictionary f in fmts) if ((string)f["value"] == value) offered = true;
        string refuse = offered ? null : (fmts.Count == 0 ? why : "this device does not take that format (it is not in the list Windows reports)");
        bool same = cur != null && cur.Rate == rate && cur.Valid == bits && cur.Bits == cont;
        int ch = cur != null && cur.Channels > 0 ? cur.Channels : 2, mask = cur != null && cur.Mask != 0 ? cur.Mask : DefaultMask(ch);
        IDictionary write = Json.Obj("api", "IPolicyConfig.SetDeviceFormat", "device", dev, "value", FmtText(ch, bits, rate));
        if (dry) {
          IDictionary r = SysCommon.Dry(same || refuse != null ? new List<object>() : L(write), FmtJson(cur), refuse, false);
          r["changed"] = !same && refuse == null;
          result = r; return null;
        }
        if (Program.Passive) return Passive("changed a sound device's format to " + FmtText(ch, bits, rate));
        if (refuse != null) return refuse;
        if (same) { result = Json.Obj("ok", true, "changed", false, "format", FmtJson(cur)); return null; }
        IPolicyConfig pc = NewPolicy(b, out e); if (pc == null) return e;
        byte[] ef = MakeFmt(ch, rate, cont, bits, mask, false), mf = MakeFmt(ch, rate, 32, 32, mask, true);
        IntPtr pe = Marshal.AllocCoTaskMem(40), pm = Marshal.AllocCoTaskMem(40);
        int hr;
        try { Marshal.Copy(ef, 0, pe, 40); Marshal.Copy(mf, 0, pm, 40); hr = pc.SetDeviceFormat(dev, pe, pm); }
        finally { Marshal.FreeCoTaskMem(pe); Marshal.FreeCoTaskMem(pm); }
        if (hr != 0) return (hr == E_ACCESSDENIED ? "Windows refused the format: access denied" : "Windows refused the format (" + Hr(hr) + ")");
        using (var b2 = new Bag()) {
          var en2 = NewEnum(b2);
          Ep ep2 = Find(en2, dev, b2, out e);
          Fmt back = ep2 != null && ep2.Ps != null ? ParseFmt(PropBlob(ep2.Ps, PK_DeviceFormat)) : null;
          if (back == null || back.Rate != rate || back.Valid != bits) return "Windows accepted the format, but the device reads back " + (back == null ? "no format" : FmtText(back.Channels, back.Valid, back.Rate));
          result = Json.Obj("ok", true, "changed", true, "format", FmtJson(back), "note", "Apps playing on this device may need to restart their sound");
        }
        return null;
      }
    }

    // ------------------------------------------------------------------ spatial
    static string SpatialSet(string dev, string subtype, bool dry, ref object result) {
      const string C = "syssound.props";
      if (subtype == null) return C + " spatial needs value: a format's subtype from the device's list, or '' for Off";
      if (FlowOf(dev) != eRender) return "spatial sound is for output devices only";
      IDictionary s = SpatialRead(dev);
      bool offered = subtype.Length == 0;
      string wantName = "Off";
      IList fl = s["formats"] as IList;
      if (fl != null) foreach (IDictionary f in fl) if (string.Equals((string)f["subtype"], subtype, StringComparison.OrdinalIgnoreCase)) { offered = true; wantName = (string)f["name"]; }
      string refuse = !(s["writable"] is bool && (bool)s["writable"]) && subtype.Length > 0 ? (string)s["why"]
                    : !offered ? "that spatial sound format is not offered for this device" : null;
      string cur = s["current"] as string;
      bool same = cur != null && string.Equals(cur, subtype, StringComparison.OrdinalIgnoreCase);
      IDictionary write = Json.Obj("api", "SpatialAudioDeviceConfiguration.SetDefaultSpatialAudioFormatAsync", "device", dev, "value", wantName);
      if (dry) {
        IDictionary r = SysCommon.Dry(same || refuse != null ? new List<object>() : L(write), cur, refuse, false);
        r["changed"] = !same && refuse == null;
        result = r; return null;
      }
      if (Program.Passive) return Passive("set spatial sound to " + wantName);
      if (refuse != null) return refuse;
      if (same) { result = Json.Obj("ok", true, "changed", false, "current", cur); return null; }
#if MANTLE_WINMD
      string err;
      string status = OnMta<string>(delegate () {
        var c = SpatialAudioDeviceConfiguration.GetForDeviceId(IfacePath(dev, eRender));
        SetDefaultSpatialAudioFormatResult res;
        string w = WinRt.Await(c.SetDefaultSpatialAudioFormatAsync(subtype), 8000, "Windows' spatial sound switch", out res);
        if (w != null) return "!" + w;
        return res == null ? "!no answer" : res.Status.ToString();
      }, 10000, out err);
      if (err != null) return "Windows' spatial sound switch failed (" + err + ")";
      if (status != null && status.StartsWith("!", StringComparison.Ordinal)) return status.Substring(1);
      if (status != "Succeeded") return "Windows refused spatial sound: " + SpatialWords(status);
      IDictionary back = SpatialRead(dev);
      if (!string.Equals(back["current"] as string, subtype, StringComparison.OrdinalIgnoreCase))
        return "Windows accepted spatial sound, but it reads back as " + ((back["currentName"] as string) ?? "something else");
      result = Json.Obj("ok", true, "changed", true, "current", back["current"], "currentName", back["currentName"]);
      return null;
#else
      return (string)s["why"];
#endif
    }
    static string SpatialWords(string status) {
      switch (status) {
        case "AccessDenied": return "access denied";
        case "LicenseExpired": return "the format's licence has expired (renew it in its own app)";
        case "LicenseNotValidForAudioEndpoint": return "the format's licence does not cover this device";
        case "NotSupportedOnAudioEndpoint": return "this device does not support that format";
        default: return "Windows gave no reason (" + (status ?? "unknown") + ")";
      }
    }

    // ================================================================== syssound.enable
    static string EnableCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.enable";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string dev; e = DeviceArg(req, C, out dev); if (e != null) return e;
        bool on; e = SysCommon.Bool(req, "on", C, out on); if (e != null) return e;
        using (var b = new Bag()) {
          var en = NewEnum(b);
          Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
          bool isOn = ep.State != ST_DISABLED;
          string refuse = on && ep.State == ST_NOTPRESENT ? "the device is not connected, so it cannot be enabled" : null;
          bool same = isOn == on;
          bool wasDefault = DefaultId(en, ep.Flow, eConsole, b) == dev;
          IDictionary write = Json.Obj("api", "IPolicyConfig.SetEndpointVisibility", "device", dev, "on", on);
          if (dry) {
            IDictionary r = SysCommon.Dry(same || refuse != null ? new List<object>() : L(write), isOn, refuse, false);
            r["changed"] = !same && refuse == null;
            if (!on && wasDefault && !same) r["note"] = "This is the default device: Windows will pick another one";
            result = r; return null;
          }
          if (Program.Passive) return Passive((on ? "enabled" : "disabled") + " a sound device");
          if (refuse != null) return refuse;
          if (same) { result = Json.Obj("ok", true, "changed", false, "on", on); return null; }
          IPolicyConfig pc = NewPolicy(b, out e); if (pc == null) return e;
          int hr = pc.SetEndpointVisibility(dev, on ? 1 : 0);
          if (hr != 0) return "Windows refused to " + (on ? "enable" : "disable") + " the device (" + Hr(hr) + ")";
        }
        using (var b2 = new Bag()) {
          var en2 = NewEnum(b2);
          Ep ep2 = Find(en2, dev, b2, out e);
          if (ep2 == null) return "Windows accepted the change, but the device could not be read back (" + e + ")";
          bool now = ep2.State != ST_DISABLED;
          if (now != on) return "Windows accepted the change, but the device reads back " + StateName(ep2.State);
          result = Json.Obj("ok", true, "changed", true, "on", on, "state", StateName(ep2.State));
        }
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== syssound.setting (mono, ducking)
    static string SettingCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.setting";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string key = Json.GetString(req, "key");
        string name; long value;
        if (key == "mono") {
          bool on; e = SysCommon.Bool(req, "value", C, out on); if (e != null) return e;
          name = "AccessibilityMonoMixState"; value = on ? 1 : 0;
        } else if (key == "ducking") {
          e = SysCommon.Number(req, "value", C, 0, 3, out value); if (e != null) return e;
          name = "UserDuckingPreference";
        } else return C + " needs key: 'mono' or 'ducking'";
        string why;
        long? before = SysCommon.ReadNumber("HKCU", AudioKey, name, out why);
        long effective = before ?? (key == "ducking" ? 1 : 0);
        bool same = before != null && before.Value == value;
        IDictionary write = SysCommon.RegWrite("HKCU", AudioKey, name, value, false, before);
        if (dry) {
          IDictionary r = SysCommon.Dry(same ? new List<object>() : L(write), before, null, false);
          r["changed"] = !same && effective != value;
          result = r; return null;
        }
        if (Program.Passive) return Passive("changed " + (key == "mono" ? "mono audio" : "what happens during calls"));
        if (!same) { e = SysCommon.WriteNumber("HKCU", AudioKey, name, value, false); if (e != null) return e; }
        result = Json.Obj("ok", true, "changed", !same, "key", key, "value", key == "mono" ? (object)(value != 0) : value,
                          "note", key == "mono" ? "Sound that starts from now on is mixed to mono; an app already playing may need to restart its sound" : null);
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== test tone
    static int _toneBusy;
    static string ToneCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.tone";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string dev; e = DeviceArg(req, C, out dev); if (e != null) return e;
        if (FlowOf(dev) != eRender) return "a test tone plays on an output device";
        using (var b = new Bag()) {
          var en = NewEnum(b);
          Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
          string refuse = ep.State != ST_ACTIVE ? "the device is " + StateName(ep.State) + ", so it cannot play" : null;
          if (dry) {
            result = SysCommon.Dry(refuse != null ? new List<object>() : L(Json.Obj("api", "IAudioClient (shared)", "device", dev, "value", "a 0.7 s 440 Hz tone")), null, refuse, false);
            return null;
          }
          if (Program.Passive) return Passive("played a test tone");
          if (refuse != null) return refuse;
        }
        if (Interlocked.CompareExchange(ref _toneBusy, 1, 0) != 0) return "a test tone is already playing";
        var th = new Thread(delegate () {
          string err = null;
          try { err = PlayTone(dev); } catch (Exception ex) { err = Why(ex); }
          finally { Interlocked.Exchange(ref _toneBusy, 0); }
          Features.Event("syssound", Json.Obj("what", "tone", "device", dev, "ok", err == null, "reason", err));
        });
        th.IsBackground = true; th.SetApartmentState(ApartmentState.MTA); th.Start();
        result = Json.Obj("ok", true, "started", true, "ms", 700);
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static string PlayTone(string dev) {
      using (var b = new Bag()) {
        var en = NewEnum(b);
        IMMDevice d;
        if (en.GetDevice(dev, out d) != 0 || d == null) return "the device is not there any more";
        b.Add(d);
        int hr;
        var ac = Activate<IAudioClient>(d, IID_Client, b, out hr);
        if (ac == null) return "the device would not open for playback (" + Hr(hr) + ")";
        IntPtr mix;
        if ((hr = ac.GetMixFormat(out mix)) != 0) return "the device did not say its mix format (" + Hr(hr) + ")";
        try {
          byte[] mb = new byte[40];
          int cb = 18 + Marshal.ReadInt16(mix, 16);
          Marshal.Copy(mix, mb, 0, Math.Min(40, Math.Max(18, cb)));
          Fmt f = ParseFmt(mb);
          if (f == null || !((f.Float && f.Bits == 32) || (!f.Float && f.Bits == 16))) return "the device's mix format is not one Mantle writes a tone in";
          if ((hr = ac.Initialize(0, 0, 10000000, 0, mix, IntPtr.Zero)) != 0) return "the device refused the playback stream (" + Hr(hr) + ")";
          uint size; ac.GetBufferSize(out size);
          object o; Guid iid = IID_Render;
          if ((hr = ac.GetService(ref iid, out o)) != 0 || o == null) return "the device refused the render client (" + Hr(hr) + ")";
          b.Add(o);
          var rc = (IAudioRenderClient)o;
          uint frames = (uint)Math.Min(size, f.Rate * 7 / 10);
          IntPtr buf;
          if ((hr = rc.GetBuffer(frames, out buf)) != 0) return "the device refused the buffer (" + Hr(hr) + ")";
          int fade = f.Rate / 50;
          for (int i = 0; i < frames; i++) {
            double env = Math.Min(1.0, Math.Min(i, (int)frames - 1 - i) / (double)fade);
            double s = 0.2 * env * Math.Sin(2 * Math.PI * 440 * i / f.Rate);
            for (int c = 0; c < f.Channels; c++) {
              int at = (i * f.Channels + c) * (f.Bits / 8);
              if (f.Float) Marshal.WriteInt32(buf, at, BitConverter.ToInt32(BitConverter.GetBytes((float)s), 0));
              else Marshal.WriteInt16(buf, at, (short)(s * 32767));
            }
          }
          rc.ReleaseBuffer(frames, 0);
          if ((hr = ac.Start()) != 0) return "the device would not start playing (" + Hr(hr) + ")";
          Thread.Sleep((int)(frames * 1000L / f.Rate) + 80);
          ac.Stop();
          return null;
        } finally { Marshal.FreeCoTaskMem(mix); }
      }
    }

    // ================================================================== microphone test
    sealed class MicRun { public string Device; public volatile bool Stop; }
    static MicRun _mic;
    static readonly object _micGate = new object();

    static string MicTestCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.micTest";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string dev; e = DeviceArg(req, C, out dev); if (e != null) return e;
        if (FlowOf(dev) != eCapture) return "a microphone test listens to an input device";
        long ms = 6000;
        if (Json.HasKey(req, "ms")) { e = SysCommon.Number(req, "ms", C, 500, 15000, out ms); if (e != null) return e; }
        using (var b = new Bag()) {
          var en = NewEnum(b);
          Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
          string refuse = ep.State != ST_ACTIVE ? "the device is " + StateName(ep.State) + ", so it cannot listen" : null;
          if (dry) {
            result = SysCommon.Dry(refuse != null ? new List<object>() : L(Json.Obj("api", "IAudioClient (shared capture)", "device", dev, "value", ms + " ms of listening, nothing kept")), null, refuse, false);
            return null;
          }
          if (Program.Passive) return Passive("listened to a microphone");
          if (refuse != null) return refuse;
        }
        var run = new MicRun(); run.Device = dev;
        lock (_micGate) {
          if (_mic != null) return "a microphone test is already running";
          _mic = run;
        }
        int limit = (int)ms;
        var th = new Thread(delegate () {
          float max = 0; string err = null;
          try { err = Listen(run, limit, ref max); } catch (Exception ex) { err = Why(ex); }
          finally { lock (_micGate) { if (_mic == run) _mic = null; } }
          Features.Event("syssound", Json.Obj("what", "micDone", "device", dev, "peakMax", Pct(max), "ok", err == null, "reason", err));
        });
        th.IsBackground = true; th.SetApartmentState(ApartmentState.MTA); th.Start();
        result = Json.Obj("ok", true, "started", true, "ms", limit, "note", "Nothing is recorded or kept: Mantle only reads the level");
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static string MicStopCmd(Dictionary<string, object> req, ref object result) {
      MicRun r;
      lock (_micGate) r = _mic;
      if (r != null) r.Stop = true;
      result = Json.Obj("ok", true, "stopped", r != null);
      return null;
    }

    /// Opens a shared capture stream (so the endpoint meter moves), throws the samples away, and
    /// sends the meter's peak ten times a second.
    static string Listen(MicRun run, int ms, ref float max) {
      using (var b = new Bag()) {
        var en = NewEnum(b);
        IMMDevice d;
        if (en.GetDevice(run.Device, out d) != 0 || d == null) return "the device is not there any more";
        b.Add(d);
        int hr;
        var ac = Activate<IAudioClient>(d, IID_Client, b, out hr);
        if (ac == null) return "the device would not open for listening (" + Hr(hr) + ")";
        var meter = Activate<IAudioMeterInformation>(d, IID_Meter, b, out hr);
        if (meter == null) return "the device has no level meter (" + Hr(hr) + ")";
        IntPtr mix;
        if ((hr = ac.GetMixFormat(out mix)) != 0) return "the device did not say its mix format (" + Hr(hr) + ")";
        try {
          if ((hr = ac.Initialize(0, 0, 2000000, 0, mix, IntPtr.Zero)) != 0)
            return hr == E_ACCESSDENIED ? "Windows' microphone privacy setting blocks desktop apps from the microphone" : "the device refused the listening stream (" + Hr(hr) + ")";
        } finally { Marshal.FreeCoTaskMem(mix); }
        object o; Guid iid = IID_Capture;
        if ((hr = ac.GetService(ref iid, out o)) != 0 || o == null) return "the device refused the capture client (" + Hr(hr) + ")";
        b.Add(o);
        var cc = (IAudioCaptureClient)o;
        if ((hr = ac.Start()) != 0) return "the device would not start listening (" + Hr(hr) + ")";
        var sw = Stopwatch.StartNew();
        try {
          while (!run.Stop && sw.ElapsedMilliseconds < ms) {
            Thread.Sleep(100);
            uint next;
            while (cc.GetNextPacketSize(out next) == 0 && next > 0) {
              IntPtr data; uint frames, flags; ulong p1, p2;
              if (cc.GetBuffer(out data, out frames, out flags, out p1, out p2) != 0) break;
              cc.ReleaseBuffer(frames);
            }
            float peak;
            if (meter.GetPeakValue(out peak) == 0) {
              if (peak > max) max = peak;
              Features.Event("syssound", Json.Obj("what", "mic", "device", run.Device, "peak", Pct(peak)));
            }
          }
        } finally { ac.Stop(); }
        return null;
      }
    }

    // ================================================================== the volume mixer
    sealed class AppRow {
      public string Key, Name, Path, Device; public uint Pid; public bool Sys, Active; public float Level; public bool Muted;
      public List<ISimpleAudioVolume> Vols = new List<ISimpleAudioVolume>();
    }

    static List<AppRow> ReadApps(IMMDeviceEnumerator en, Bag b, out string err) {
      var rows = new List<AppRow>();
      var byKey = new Dictionary<string, AppRow>(StringComparer.Ordinal);
      List<Ep> eps = Endpoints(en, eRender, ST_ACTIVE, b, out err);
      foreach (Ep ep in eps) {
        int hr;
        var mgr = Activate<IAudioSessionManager2>(ep.Dev, IID_Sessions, b, out hr);
        if (mgr == null) continue;
        IAudioSessionEnumerator se;
        if (mgr.GetSessionEnumerator(out se) != 0 || se == null) continue;
        b.Add(se);
        int n;
        if (se.GetCount(out n) != 0) continue;
        for (int i = 0; i < n && i < 256; i++) {
          object so;
          if (se.GetSession(i, out so) != 0 || so == null) continue;
          b.Add(so);
          var ctl = so as IAudioSessionControl2; var vol = so as ISimpleAudioVolume;
          if (ctl == null || vol == null) continue;
          int state;
          if (ctl.GetState(out state) != 0 || state == 2 /* expired */) continue;
          bool sys = ctl.IsSystemSoundsSession() == 0;
          uint pid;
          if (ctl.GetProcessId(out pid) < 0) pid = 0;
          string key;
          if (sys) key = "system";
          else if (pid != 0) { if (!Alive(pid)) continue; key = "pid:" + pid.ToString(CultureInfo.InvariantCulture); }
          else { string sid; ctl.GetSessionIdentifier(out sid); key = "sid:" + ((sid ?? "").GetHashCode() & 0x7fffffff).ToString(CultureInfo.InvariantCulture); }
          float level; bool muted;
          if (vol.GetMasterVolume(out level) != 0) level = 0;
          if (vol.GetMute(out muted) != 0) muted = false;
          AppRow row;
          if (!byKey.TryGetValue(key, out row)) {
            row = new AppRow(); row.Key = key; row.Pid = pid; row.Sys = sys; row.Level = level; row.Muted = muted; row.Device = ep.Id;
            row.Path = sys || pid == 0 ? null : ImagePath(pid);
            row.Name = sys ? "System sounds" : NameFor(ctl, row.Path);
            byKey[key] = row; rows.Add(row);
          } else {
            if (level > row.Level) row.Level = level;
            row.Muted = row.Muted && muted;
          }
          row.Vols.Add(vol);
          if (state == 1) row.Active = true;
        }
      }
      rows.Sort(delegate (AppRow a, AppRow c) {
        if (a.Sys != c.Sys) return a.Sys ? -1 : 1;
        if (a.Active != c.Active) return a.Active ? -1 : 1;
        return string.Compare(a.Name, c.Name, StringComparison.CurrentCultureIgnoreCase);
      });
      return rows;
    }

    static string NameFor(IAudioSessionControl2 ctl, string path) {
      string dn;
      if (ctl.GetDisplayName(out dn) == 0 && !string.IsNullOrEmpty(dn)) {
        if (dn.StartsWith("@", StringComparison.Ordinal)) {
          var sb = new StringBuilder(260);
          if (SHLoadIndirectString(dn, sb, 260, IntPtr.Zero) == 0 && sb.Length > 0) return sb.ToString();
        } else return dn;
      }
      if (!string.IsNullOrEmpty(path)) {
        try {
          string desc = FileVersionInfo.GetVersionInfo(path).FileDescription;
          if (!string.IsNullOrEmpty(desc) && desc.Trim().Length > 0) return desc.Trim();
        } catch (Exception) { }
        return System.IO.Path.GetFileNameWithoutExtension(path);
      }
      return "App";
    }
    static string ImagePath(uint pid) {
      IntPtr h = OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return null;
      try {
        var sb = new StringBuilder(1024); uint n = 1024;
        return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : null;
      } finally { CloseHandle(h); }
    }
    static bool Alive(uint pid) {
      IntPtr h = OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return true;   // can't look (another user's / protected): Windows says the session lives
      try { uint code; return !GetExitCodeProcess(h, out code) || code == 259; } finally { CloseHandle(h); }
    }

    // ------------------------------------------------------------------ each app's own device (undocumented factory)
    static readonly Guid IID_PolicyFactory = new Guid("AB3D4648-E242-459F-B02F-541C70306324");
    static readonly Guid IID_PolicyFactoryOld = new Guid("2A59116D-6C4F-45E0-A74F-707E3FEF9258");
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PSetFn(IntPtr self, uint pid, int flow, int role, IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PGetFn(IntPtr self, uint pid, int flow, int role, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PClearFn(IntPtr self);
    const int SLOT_SET = 25, SLOT_GET = 26, SLOT_CLEAR = 27;

    /// The factory, or IntPtr.Zero with the reason. MUST run on an MTA thread (OnMta).
    static IntPtr OpenFactory(out string why) {
      why = null;
      IntPtr cls;
      const string name = "Windows.Media.Internal.AudioPolicyConfig";
      if (WindowsCreateString(name, (uint)name.Length, out cls) != 0) { why = "Windows would not name its app-device factory"; return IntPtr.Zero; }
      try {
        IntPtr f; Guid iid = IID_PolicyFactory;
        int hr = RoGetActivationFactory(cls, ref iid, out f);
        if (hr != 0) { iid = IID_PolicyFactoryOld; hr = RoGetActivationFactory(cls, ref iid, out f); }
        if (hr != 0 || f == IntPtr.Zero) { why = "this Windows does not offer per-app sound devices to desktop apps (" + Hr(hr) + ")"; return IntPtr.Zero; }
        return f;
      } finally { WindowsDeleteString(cls); }
    }
    static T Slot<T>(IntPtr f, int slot) where T : class {
      IntPtr vt = Marshal.ReadIntPtr(f);
      return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, slot * IntPtr.Size), typeof(T)) as T;
    }
    /// Each pid's own output and input device ('' = follows the default). MTA only.
    static Dictionary<uint, string[]> PersistedFor(List<uint> pids, out string why) {
      var map = new Dictionary<uint, string[]>();
      IntPtr f = OpenFactory(out why);
      if (f == IntPtr.Zero) return map;
      try {
        PGetFn get = Slot<PGetFn>(f, SLOT_GET);
        foreach (uint pid in pids) {
          string[] two = new string[3];   // output, input, the reason a read failed
          for (int flow = 0; flow < 2; flow++) {
            IntPtr hs;
            int hr = get(f, pid, flow, eMultimedia, out hs);
            if (hr != 0 && two[2] == null) two[2] = "Windows would not say which device this app uses (" + Hr(hr) + ")";
            if (hr != 0) { two[flow] = null; continue; }
            string s = "";
            if (hs != IntPtr.Zero) {
              uint len; IntPtr raw = WindowsGetStringRawBuffer(hs, out len);
              s = raw == IntPtr.Zero ? "" : Marshal.PtrToStringUni(raw, (int)len);
              WindowsDeleteString(hs);
            }
            two[flow] = FromIfacePath(s);
          }
          map[pid] = two;
        }
      } finally { Marshal.Release(f); }
      return map;
    }

    static string AppsCmd(Dictionary<string, object> req, ref object result) {
      try {
        using (var b = new Bag()) {
          var en = NewEnum(b);
          string err;
          List<AppRow> rows = ReadApps(en, b, out err);
          var pids = new List<uint>();
          foreach (AppRow r in rows) if (!r.Sys && r.Pid != 0) pids.Add(r.Pid);
          // probePid (tests): also read one given process's own devices - a READ through the same
          // undocumented vtable slot, so the slot is proven even when no app is playing sound
          long probe = 0;
          if (Json.HasKey(req, "probePid")) { string pe = SysCommon.Number(req, "probePid", "syssound.apps", 1, uint.MaxValue, out probe); if (pe != null) return pe; pids.Add((uint)probe); }
          string pwhy = null, terr = null;
          Dictionary<uint, string[]> per = pids.Count == 0 ? new Dictionary<uint, string[]>()
            : OnMta<Dictionary<uint, string[]>>(delegate () { string w; var m = PersistedFor(pids, out w); pwhy = w; return m; }, 5000, out terr);
          if (per == null) { per = new Dictionary<uint, string[]>(); pwhy = "Windows' per-app device list did not answer (" + terr + ")"; }
          var list = new List<object>();
          foreach (AppRow r in rows) {
            string[] two;
            per.TryGetValue(r.Pid, out two);
            string devWhy = r.Sys ? "System sounds always play on the default device" : r.Pid == 0 ? "this sound session belongs to no single app" : pwhy ?? (two != null ? two[2] : null);
            list.Add(Json.Obj("app", r.Key, "name", r.Name, "path", r.Path, "pid", (long)r.Pid, "system", r.Sys, "active", r.Active,
                              "level", Pct(r.Level), "muted", r.Muted, "playingOn", r.Device,
                              "output", two != null ? two[0] : null, "input", two != null ? two[1] : null,
                              "deviceWritable", devWhy == null && two != null, "deviceWhy", devWhy ?? (two == null ? "Windows did not say which device this app uses" : null)));
          }
          string[] pr = null;
          if (probe > 0) per.TryGetValue((uint)probe, out pr);
          result = Json.Obj("apps", list, "reason", err, "perAppDevices", pwhy == null, "perAppWhy", pwhy,
                            "probe", probe > 0 ? Json.Obj("pid", probe, "read", pr != null && pr[2] == null, "reason", pr != null ? pr[2] : null, "output", pr != null ? pr[0] : null, "input", pr != null ? pr[1] : null) : null);
        }
        return null;
      } catch (Exception ex) { return "syssound.apps failed: " + Why(ex); }
    }

    static string AppArg(Dictionary<string, object> req, string cmd, out string key) {
      key = Json.GetString(req, "app");
      if (string.IsNullOrEmpty(key) || !Regex.IsMatch(key, @"^(system|pid:\d{1,10}|sid:\d{1,10})$")) { key = null; return cmd + " needs app: an app's key from syssound.apps"; }
      return null;
    }

    static string AppSetCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.appSet";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string key; e = AppArg(req, C, out key); if (e != null) return e;
        long level = -1; bool muted = false;
        bool hasLevel = Json.HasKey(req, "level"), hasMute = Json.HasKey(req, "muted");
        if (!hasLevel && !hasMute) return C + " needs level (0-100) and/or muted (true or false)";
        if (hasLevel) { e = SysCommon.Number(req, "level", C, 0, 100, out level); if (e != null) return e; }
        if (hasMute) { e = SysCommon.Bool(req, "muted", C, out muted); if (e != null) return e; }
        using (var b = new Bag()) {
          var en = NewEnum(b);
          string err;
          AppRow row = null;
          foreach (AppRow r in ReadApps(en, b, out err)) if (r.Key == key) row = r;
          if (row == null) return "that app is not playing sound any more";
          var writes = new List<object>();
          if (hasLevel && Pct(row.Level) != level) writes.Add(Json.Obj("api", "ISimpleAudioVolume.SetMasterVolume", "value", level / 100.0, "sessions", row.Vols.Count));
          if (hasMute && row.Muted != muted) writes.Add(Json.Obj("api", "ISimpleAudioVolume.SetMute", "on", muted, "sessions", row.Vols.Count));
          if (dry) {
            IDictionary r = SysCommon.Dry(writes, Json.Obj("level", Pct(row.Level), "muted", row.Muted), null, false);
            r["changed"] = writes.Count > 0;
            result = r; return null;
          }
          if (Program.Passive) return Passive("changed an app's " + (hasLevel ? "volume" : "mute"));
          Guid ctx = Ctx;
          foreach (ISimpleAudioVolume v in row.Vols) {
            int hr;
            if (hasLevel && (hr = v.SetMasterVolume(level / 100f, ref ctx)) != 0) return "Windows refused the app's volume (" + Hr(hr) + ")";
            if (hasMute && (hr = v.SetMute(muted, ref ctx)) != 0) return "Windows refused to " + (muted ? "mute" : "unmute") + " the app (" + Hr(hr) + ")";
          }
          float lv = 0; bool mu = true;
          foreach (ISimpleAudioVolume v in row.Vols) { float x; bool m; if (v.GetMasterVolume(out x) == 0 && x > lv) lv = x; if (v.GetMute(out m) == 0) mu = mu && m; }
          if (hasLevel && Math.Abs(Pct(lv) - level) > 1) return "Windows accepted the app's volume, but it reads back as " + Pct(lv) + "%";
          if (hasMute && mu != muted) return "Windows accepted the mute switch, but the app reads back " + (mu ? "muted" : "unmuted");
          result = Json.Obj("ok", true, "changed", writes.Count > 0, "level", Pct(lv), "muted", mu);
          return null;
        }
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static string AppDeviceCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.appDevice";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        string key; e = AppArg(req, C, out key); if (e != null) return e;
        string flowS = Json.GetString(req, "flow");
        if (flowS != "output" && flowS != "input") return C + " needs flow: 'output' or 'input'";
        int flow = flowS == "output" ? eRender : eCapture;
        string dev = Json.GetString(req, "device") ?? "";
        if (dev.Length > 0) {
          if (!DeviceRx.IsMatch(dev)) return C + " needs device: a device key, or '' for the default";
          if (FlowOf(dev) != flow) return C + ": that device is an " + (flow == eRender ? "input" : "output") + " device";
        }
        if (!key.StartsWith("pid:", StringComparison.Ordinal)) return key == "system" ? "System sounds always play on the default device" : "this sound session belongs to no single app, so it has no device of its own";
        uint pid = uint.Parse(key.Substring(4), CultureInfo.InvariantCulture);
        using (var b = new Bag()) {
          var en = NewEnum(b);
          if (dev.Length > 0) {
            Ep ep = Find(en, dev, b, out e); if (ep == null) return e;
            if (ep.State != ST_ACTIVE) return "the device is " + StateName(ep.State) + ", so an app cannot use it";
          }
          string err;
          bool found = false;
          foreach (AppRow r in ReadApps(en, b, out err)) if (r.Key == key) found = true;
          if (!found) return "that app is not playing sound any more";
        }
        string terr, why = null;
        string[] cur = OnMta<string[]>(delegate () {
          string w; var m = PersistedFor(new List<uint> { pid }, out w); why = w;
          string[] two; return m.TryGetValue(pid, out two) ? two : null;
        }, 5000, out terr);
        if (terr != null) return "Windows' per-app device list did not answer (" + terr + ")";
        if (why != null) return why;
        if (cur == null || cur[flow] == null) return (cur != null && cur[2] != null) ? cur[2] : "Windows did not say which device this app uses";
        bool same = string.Equals(cur[flow], dev, StringComparison.OrdinalIgnoreCase);
        IDictionary write = Json.Obj("api", "AudioPolicyConfig.SetPersistedDefaultAudioEndpoint", "flow", flowS, "value", dev.Length == 0 ? "the default device" : dev);
        if (dry) {
          IDictionary r = SysCommon.Dry(same ? new List<object>() : L(write), cur[flow], null, false);
          r["changed"] = !same;
          result = r; return null;
        }
        if (Program.Passive) return Passive("moved an app to another " + flowS + " device");
        if (!same) {
          string setErr = OnMta<string>(delegate () {
            string w; IntPtr f = OpenFactory(out w);
            if (f == IntPtr.Zero) return w;
            IntPtr hs = IntPtr.Zero;
            try {
              if (dev.Length > 0) { string path = IfacePath(dev, flow); if (WindowsCreateString(path, (uint)path.Length, out hs) != 0) return "Windows would not take the device name"; }
              PSetFn set = Slot<PSetFn>(f, SLOT_SET);
              foreach (int role in new int[] { eConsole, eMultimedia }) {
                int hr = set(f, pid, flow, role, hs);
                if (hr != 0) return "Windows refused the app's device (" + Hr(hr) + ")";
              }
              return null;
            } finally { if (hs != IntPtr.Zero) WindowsDeleteString(hs); Marshal.Release(f); }
          }, 5000, out terr);
          if (terr != null) return "Windows' per-app device switch did not answer (" + terr + ")";
          if (setErr != null) return setErr;
        }
        string[] back = OnMta<string[]>(delegate () { string w; var m = PersistedFor(new List<uint> { pid }, out w); string[] two; return m.TryGetValue(pid, out two) ? two : null; }, 5000, out terr);
        if (back == null || !string.Equals(back[flow], dev, StringComparison.OrdinalIgnoreCase))
          return "Windows accepted the app's device, but it reads back " + (back == null || back[flow] == null ? "nothing" : back[flow].Length == 0 ? "the default" : "another device");
        result = Json.Obj("ok", true, "changed", !same, "flow", flowS, "device", back[flow],
                          "note", "Windows remembers this for the app; some apps only switch when they next start playing");
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static string ResetAppsCmd(Dictionary<string, object> req, ref object result) {
      const string C = "syssound.resetApps";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        using (var b = new Bag()) {
          var en = NewEnum(b);
          string err;
          List<AppRow> rows = ReadApps(en, b, out err);
          int quiet = 0;
          foreach (AppRow r in rows) if (!r.Sys && (Pct(r.Level) != 100 || r.Muted)) quiet++;
          var writes = L(Json.Obj("api", "AudioPolicyConfig.ClearAllPersistedApplicationDefaultEndpoints", "value", "every app back to the default devices"),
                         Json.Obj("api", "ISimpleAudioVolume.SetMasterVolume", "value", 1.0, "apps", quiet));
          if (dry) { result = SysCommon.Dry(writes, null, null, false); return null; }
          if (Program.Passive) return Passive("reset every app's sound device and volume");
          string terr;
          string clr = OnMta<string>(delegate () {
            string w; IntPtr f = OpenFactory(out w);
            if (f == IntPtr.Zero) return w;
            try { int hr = Slot<PClearFn>(f, SLOT_CLEAR)(f); return hr == 0 ? null : "Windows refused to reset the apps' devices (" + Hr(hr) + ")"; }
            finally { Marshal.Release(f); }
          }, 5000, out terr);
          if (terr != null) return "Windows' per-app device reset did not answer (" + terr + ")";
          if (clr != null) return clr;
          Guid ctx = Ctx;
          int failed = 0;
          foreach (AppRow r in rows) {
            if (r.Sys) continue;
            foreach (ISimpleAudioVolume v in r.Vols) { if (v.SetMasterVolume(1f, ref ctx) != 0 || v.SetMute(false, ref ctx) != 0) failed++; }
          }
          result = Json.Obj("ok", true, "changed", true, "apps", rows.Count,
                            "note", failed > 0 ? failed + " app sessions refused the volume reset" : "Every app follows the default devices at full volume");
        }
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== syssound.decide (PURE)
    // {what:'fmt', hex}                         -> the parsed format (as the page gets it)
    // {what:'make', channels, rate, bits, container, float} -> the 40-byte WAVEFORMATEXTENSIBLE as hex
    // {what:'value', value}                     -> {ok, rate, bits, container} for a page value
    // {what:'path', device, flow}               -> the interface path and the key parsed back from it
    // {what:'channels', mask, count}            -> channel names
    static string DecideCmd(Dictionary<string, object> req, ref object result) {
      try {
        string what = Json.GetString(req, "what");
        switch (what) {
          case "fmt": {
            string hex = Json.GetString(req, "hex") ?? "";
            byte[] b = Hex(hex);
            if (b == null) return "decide fmt needs hex";
            result = Json.Obj("format", FmtJson(ParseFmt(b)));
            return null;
          }
          case "make": {
            int ch = Json.GetInt(req, "channels", 2), rate = Json.GetInt(req, "rate", 48000), bits = Json.GetInt(req, "bits", 16), cont = Json.GetInt(req, "container", bits);
            byte[] b = MakeFmt(ch, rate, cont, bits, DefaultMask(ch), Json.GetBool(req, "float", false));
            result = Json.Obj("hex", BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(), "format", FmtJson(ParseFmt(b)));
            return null;
          }
          case "value": {
            int rate, bits, cont;
            bool ok = ParseValue(Json.GetString(req, "value"), out rate, out bits, out cont);
            result = Json.Obj("ok", ok, "rate", rate, "bits", bits, "container", cont);
            return null;
          }
          case "path": {
            string dev = Json.GetString(req, "device") ?? "";
            string p = IfacePath(dev, Json.GetString(req, "flow") == "input" ? eCapture : eRender);
            result = Json.Obj("path", p, "back", FromIfacePath(p), "empty", FromIfacePath(""), "junk", FromIfacePath("\\\\?\\USB#nothing"));
            return null;
          }
          case "channels":
            result = Json.Obj("names", ChannelNames(Json.GetInt(req, "mask", 0), Json.GetInt(req, "count", 2)));
            return null;
          default: return "decide needs what: fmt, make, value, path or channels";
        }
      } catch (Exception ex) { return "syssound.decide failed: " + Why(ex); }
    }
    static byte[] Hex(string s) {
      if (s.Length % 2 != 0 || !Regex.IsMatch(s, "^[0-9a-fA-F]*$")) return null;
      byte[] b = new byte[s.Length / 2];
      for (int i = 0; i < b.Length; i++) b[i] = byte.Parse(s.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
      return b;
    }
  }
}
