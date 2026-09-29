// SysDisplay.cs - Mantle Settings > System > Display, natively (lane sysset-disp, 2026-09-28).
//
// WHY: Mantle Settings replaces Windows' Settings app, so its Display page must read and change
// what Windows' Display page does - resolution, refresh rate, orientation, which display is main,
// the arrangement, extend/duplicate, scale, HDR, night light's strength and schedule, and the
// Graphics page - without ever opening Windows' Settings. Brightness and night light on/off stay
// in Display.cs (the bar and Quick Settings use them); this file adds everything else.
//
// COMMANDS (every write takes dryRun; dryRun validates against a FRESH read and writes nothing):
//   sysdisplay.get          {}                                   every display + topology + GPUs
//   sysdisplay.mode         {display, width, height, hz?, orientation?, keepWithinMs?, dryRun}
//   sysdisplay.topology     {mode:'extend'|'clone'|'internal'|'external', keepWithinMs?, dryRun}
//   sysdisplay.primary      {display, keepWithinMs?, dryRun}
//   sysdisplay.arrange      {positions:[{display, x, y}], keepWithinMs?, dryRun}
//   sysdisplay.keep         {token}        keep a pending change (stops the revert timer)
//   sysdisplay.revert       {token}        put a pending change back now
//   sysdisplay.scale        {display, percent, dryRun}
//   sysdisplay.hdr          {display, on, dryRun}
//   sysdisplay.nightlight   {}                                   strength + schedule + on/off
//   sysdisplay.nightlightSet {from?, to?, strength?, schedule?, dryRun}
//   sysdisplay.gpuPrefs     {}                                   per-app GPU + global graphics switches
//   sysdisplay.gpuPrefSet   {app, pref:0|1|2, dryRun}
//   sysdisplay.gpuGlobalSet {key:'SwapEffectUpgradeEnable'|'VRROptimizeEnable'|'AutoHDREnable', on, dryRun}
//   sysdisplay.gpuSchedulingSet {on, dryRun}   HKLM: answers needsAdmin + elevate:"sysdisplay.gpuScheduling"
//   sysdisplay.decide       {what, ...}    PURE: the decisions below over made-up inputs (tests)
//   [Elevated] sysdisplay.gpuScheduling {on}   the elevated HwSchMode write (sidecar/ELEVATE.md)
//
// THE DISPLAY KEY (`display`, never `id`: lib/features/README.md): "<adapter LUID as 16 hex>-<target
// id>", e.g. "0000000000012f3a-4352". LUIDs are handed out at boot, so the key is stable for this
// boot only; `devicePath` (the monitor's PnP path) is the one that survives a restart.
//
// BOUNDS are PHYSICAL pixels in desktop coordinates (the source mode's position and size); the
// sidecar is per-monitor-DPI-aware (Program.cs), so nothing here is DPI-virtualised. Electron's
// screen.getAllDisplays() bounds are DIPs: bounds.x / scaleFactor etc. to match them for Identify.
//
// RESOLUTIONS are given the way Windows lists them, in landscape terms (1920 x 1080 even while the
// display is rotated to portrait); a mode change swaps width and height itself for portrait. The
// rotated case is NOT measured here (Owen's panel is landscape): EnumDisplaySettings' modes are
// normalised by their own orientation field, and portrait = DMDO_90, portrait-flipped = DMDO_270 is
// the conventional mapping, unverified on a rotated display.
//
// KEEP OR REVERT (the "Keep these display settings? Reverting in 15 s" safety): mode, topology,
// primary and arrange changes arm a timer IN THE SIDECAR, so the revert happens even if the page is
// hidden or the screen is black. The change answers {token, keepWithinMs}; sysdisplay.keep {token}
// stops it, sysdisplay.revert {token} (or the timer, or the sidecar exiting normally) puts the
// recorded previous state back. Events: {"ev":"sysdisplay", what:'pending'|'kept'|'reverted', ...}.
//   - a MODE change is applied dynamically (ChangeDisplaySettingsEx flags 0: NOT saved), and only
//     `keep` saves it (CDS_UPDATEREGISTRY). If the sidecar is killed mid-wait, the saved mode is
//     still the old one, so a sign-out or restart undoes a black screen.
//   - TOPOLOGY is saved by Windows as soon as it applies (SDC_TOPOLOGY_*, what Win+P does), and
//     PRIMARY / ARRANGE are written the documented way (CDS_UPDATEREGISTRY|CDS_NORESET, then one
//     apply), so for those three a revert writes the old state back; a killed sidecar leaves the new
//     one (every display stays on, so that is not a black-screen risk).
//   One change waits at a time; a second real change is refused until the first is kept/reverted.
//
// UNDOCUMENTED BUT WIDELY USED (said here, verified by read-back every time):
//   - SCALE: DisplayConfigGetDeviceInfo type -3 / DisplayConfigSetDeviceInfo type -4, the calls the
//     SetDPI-style tools use. They speak in STEPS relative to Windows' recommended scale, over the
//     fixed list 100,125,150,175,200,225,250,300,350,400,450,500. See ScaleInfo for the maths.
//   - NIGHT LIGHT strength/schedule: the CloudStore blob windows.data.bluelightreduction.settings,
//     parsed EXACTLY (see the night light section: it is Bond compact-binary v1, measured here).
//
// PRIVACY: nothing in this file logs. Reasons carry codes and states only - never a display name,
// device path, app path or user path; results to the page may carry them (the page shows them).
// Every handler catches its own exceptions (Features.TryRun would put ex.Message into the reply).
//
// PASSIVE (every test sidecar): reads and every dryRun answer; each real write answers
// FeatureTable.PassiveRefusal + ": it would have ...". Tests never change Owen's display.
//
// MEASURED ON OWEN'S MACHINE (2026-09-28, Windows 11 26200): one internal panel, landscape; the
// night light settings blob is 43 bytes (schedule fields: hours 21:00 -> 07:00, no strength field,
// empty sunset/sunrise); the state blob 41 bytes (off). See the night light section for the bytes.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysDisplay {
    public static void Register(FeatureTable t) {
      t.Add("sysdisplay.get", Lanes.Slow, Get);
      t.Add("sysdisplay.mode", Lanes.Slow, ModeCmd);
      t.Add("sysdisplay.topology", Lanes.Slow, TopologyCmd);
      t.Add("sysdisplay.primary", Lanes.Slow, PrimaryCmd);
      t.Add("sysdisplay.arrange", Lanes.Slow, ArrangeCmd);
      t.Add("sysdisplay.keep", Lanes.Slow, KeepCmd);
      t.Add("sysdisplay.revert", Lanes.Slow, RevertCmd);
      t.Add("sysdisplay.scale", Lanes.Slow, ScaleCmd);
      t.Add("sysdisplay.hdr", Lanes.Slow, HdrCmd);
      t.Add("sysdisplay.nightlight", Lanes.Slow, NightCmd);
      t.Add("sysdisplay.nightlightSet", Lanes.Slow, NightSetCmd);
      t.Add("sysdisplay.gpuPrefs", Lanes.Slow, GpuPrefsCmd);
      t.Add("sysdisplay.gpuPrefSet", Lanes.Slow, GpuPrefSetCmd);
      t.Add("sysdisplay.gpuGlobalSet", Lanes.Slow, GpuGlobalSetCmd);
      t.Add("sysdisplay.gpuSchedulingSet", Lanes.Slow, HagsSetCmd);
      t.Add("sysdisplay.decide", Lanes.Slow, DecideCmd);   // PURE: no Windows call at all
    }

    // ================================================================== native: CCD
    // QueryDisplayConfig / SetDisplayConfig / DisplayConfig{Get,Set}DeviceInfo (documented, wingdi.h).
    [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct RATIONAL { public uint Num; public uint Den; }
    [StructLayout(LayoutKind.Sequential)] struct PATH_SOURCE { public LUID Adapter; public uint Id; public uint ModeIdx; public uint Status; }
    [StructLayout(LayoutKind.Sequential)] struct PATH_TARGET {
      public LUID Adapter; public uint Id; public uint ModeIdx; public uint Tech; public uint Rotation; public uint Scaling;
      public RATIONAL Refresh; public uint ScanLine; public int Available; public uint Status;
    }
    [StructLayout(LayoutKind.Sequential)] struct PATH { public PATH_SOURCE Src; public PATH_TARGET Tgt; public uint Flags; }   // 72 bytes
    [StructLayout(LayoutKind.Explicit, Size = 64)] struct MODE {                                                               // 64 bytes
      [FieldOffset(0)] public uint Type; [FieldOffset(4)] public uint Id; [FieldOffset(8)] public LUID Adapter;
      // DISPLAYCONFIG_TARGET_MODE (Type 2)
      [FieldOffset(16)] public ulong PixelRate; [FieldOffset(32)] public uint VNum; [FieldOffset(36)] public uint VDen;
      [FieldOffset(40)] public uint ActiveCx; [FieldOffset(44)] public uint ActiveCy;
      // DISPLAYCONFIG_SOURCE_MODE (Type 1)
      [FieldOffset(16)] public uint SrcWidth; [FieldOffset(20)] public uint SrcHeight; [FieldOffset(24)] public uint SrcFormat;
      [FieldOffset(28)] public int SrcX; [FieldOffset(32)] public int SrcY;
    }

    const uint QDC_ALL_PATHS = 1, QDC_ONLY_ACTIVE_PATHS = 2, QDC_DATABASE_CURRENT = 4;
    const uint SDC_TOPOLOGY_INTERNAL = 1, SDC_TOPOLOGY_CLONE = 2, SDC_TOPOLOGY_EXTEND = 4, SDC_TOPOLOGY_EXTERNAL = 8;
    const uint SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x20, SDC_VALIDATE = 0x40, SDC_APPLY = 0x80,
               SDC_SAVE_TO_DATABASE = 0x200, SDC_ALLOW_CHANGES = 0x400;
    const uint NO_MODE = 0xffffffff;

    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPath, out uint numMode);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPath, [Out] PATH[] paths, ref uint numMode, [Out] MODE[] modes, IntPtr topology);
    [DllImport("user32.dll", EntryPoint = "QueryDisplayConfig")] static extern int QueryDisplayConfigDb(uint flags, ref uint numPath, [Out] PATH[] paths, ref uint numMode, [Out] MODE[] modes, out uint topology);
    [DllImport("user32.dll")] static extern int SetDisplayConfig(uint numPath, [In] PATH[] paths, uint numMode, [In] MODE[] modes, uint flags);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr packet);
    [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(IntPtr packet);

    sealed class Config { public PATH[] Paths = new PATH[0]; public MODE[] Modes = new MODE[0]; public uint Topology; public int Err; }

    static Config Query(uint flags) {
      for (int tries = 0; tries < 4; tries++) {
        uint np, nm;
        int e = GetDisplayConfigBufferSizes(flags, out np, out nm);
        if (e != 0) { var c0 = new Config(); c0.Err = e; return c0; }
        var p = new PATH[np]; var m = new MODE[nm];
        uint topo = 0;
        if (flags == QDC_DATABASE_CURRENT) e = QueryDisplayConfigDb(flags, ref np, p, ref nm, m, out topo);
        else e = QueryDisplayConfig(flags, ref np, p, ref nm, m, IntPtr.Zero);
        if (e == 122) continue;                    // ERROR_INSUFFICIENT_BUFFER: a display came and went
        var c = new Config(); c.Err = e;
        if (e != 0) return c;
        Array.Resize(ref p, (int)np); Array.Resize(ref m, (int)nm);
        c.Paths = p; c.Modes = m; c.Topology = topo;
        return c;
      }
      var cx = new Config(); cx.Err = 122; return cx;
    }

    // DisplayConfig*DeviceInfo packets are built as bytes: one helper instead of a struct per type.
    static byte[] DevGet(int type, int size, LUID a, uint id, out int err) {
      var b = new byte[size];
      PutHeader(b, type, size, a, id);
      IntPtr p = Marshal.AllocHGlobal(size);
      try {
        Marshal.Copy(b, 0, p, size);
        err = DisplayConfigGetDeviceInfo(p);
        if (err != 0) return null;
        Marshal.Copy(p, b, 0, size);
        return b;
      } finally { Marshal.FreeHGlobal(p); }
    }

    static int DevSet(int type, LUID a, uint id, int value) {
      var b = new byte[24];
      PutHeader(b, type, 24, a, id);
      PutI32(b, 20, value);
      IntPtr p = Marshal.AllocHGlobal(24);
      try { Marshal.Copy(b, 0, p, 24); return DisplayConfigSetDeviceInfo(p); }
      finally { Marshal.FreeHGlobal(p); }
    }

    static void PutHeader(byte[] b, int type, int size, LUID a, uint id) {
      PutI32(b, 0, type); PutI32(b, 4, size); PutI32(b, 8, (int)a.Low); PutI32(b, 12, a.High); PutI32(b, 16, (int)id);
    }
    static void PutI32(byte[] b, int at, int v) { byte[] x = BitConverter.GetBytes(v); Array.Copy(x, 0, b, at, 4); }
    static int I32(byte[] b, int at) { return BitConverter.ToInt32(b, at); }
    static uint U32(byte[] b, int at) { return BitConverter.ToUInt32(b, at); }
    static string WStr(byte[] b, int at, int chars) {
      string s = Encoding.Unicode.GetString(b, at, chars * 2);
      int z = s.IndexOf('\0');
      return z >= 0 ? s.Substring(0, z) : s;
    }

    // DisplayConfig device-info types (wingdi.h), plus the two undocumented DPI ones.
    const int GET_SOURCE_NAME = 1, GET_TARGET_NAME = 2, GET_TARGET_PREFERRED_MODE = 3, GET_ADAPTER_NAME = 4,
              GET_ADVANCED_COLOR_INFO = 9, SET_ADVANCED_COLOR_STATE = 10, GET_SDR_WHITE_LEVEL = 11,
              GET_ADVANCED_COLOR_INFO_2 = 15, SET_HDR_STATE = 16, GET_DPI_SCALE = -3, SET_DPI_SCALE = -4;

    // ================================================================== native: GDI modes
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DEVMODE {                                                   // DEVMODEW, 220 bytes
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
      public ushort SpecVersion, DriverVersion, Size, DriverExtra; public uint Fields;
      public int PosX, PosY; public uint Orientation, FixedOutput;
      public short Color, Duplex, YResolution, TTOption, Collate;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
      public ushort LogPixels; public uint Bpp, Width, Height, DisplayFlags, Frequency;
      public uint ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
    }
    const uint DM_POSITION = 0x20, DM_DISPLAYORIENTATION = 0x80, DM_BITSPERPEL = 0x40000, DM_PELSWIDTH = 0x80000,
               DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
    const uint CDS_UPDATEREGISTRY = 1, CDS_TEST = 2, CDS_SET_PRIMARY = 0x10, CDS_NORESET = 0x10000000;
    const int ENUM_CURRENT_SETTINGS = -1;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsW(string dev, int mode, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsExW(string dev, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr lparam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "ChangeDisplaySettingsExW")]
    static extern int ChangeDisplaySettingsExNull(string dev, IntPtr dm, IntPtr hwnd, uint flags, IntPtr lparam);

    static DEVMODE NewDevMode() {
      var dm = new DEVMODE();
      dm.DeviceName = ""; dm.FormName = "";
      dm.Size = (ushort)Marshal.SizeOf(typeof(DEVMODE));
      return dm;
    }

    static string CurrentMode(string dev, out DEVMODE dm) {
      dm = NewDevMode();
      if (!EnumDisplaySettingsW(dev, ENUM_CURRENT_SETTINGS, ref dm))
        return "Windows did not report this display's current mode (error " + Marshal.GetLastWin32Error() + ")";
      return null;
    }

    static string CdsWords(int code) {
      switch (code) {
        case 0: return null;
        case 1: return "Windows needs a restart before this display mode can be used (DISP_CHANGE_RESTART)";
        case -1: return "the display driver refused the change (DISP_CHANGE_FAILED)";
        case -2: return "the display does not support that mode (DISP_CHANGE_BADMODE)";
        case -3: return "Windows could not save the setting (DISP_CHANGE_NOTUPDATED)";
        case -4: return "Windows called the request's flags invalid (DISP_CHANGE_BADFLAGS)";
        case -5: return "Windows called the request invalid (DISP_CHANGE_BADPARAM)";
        case -6: return "the change was refused because this system is DualView capable (DISP_CHANGE_BADDUALVIEW)";
      }
      return "Windows refused the display change (code " + code + ")";
    }

    static string SdcWords(int err) {
      switch (err) {
        case 0: return null;
        case 5: return "Windows refused (access denied, 5): display changes only work from the unlocked, active desktop";
        case 31: return "the graphics driver could not apply that layout (error 31)";
        case 50: return "that display layout is not supported here (error 50)";
        case 87: return "Windows called that display layout invalid (error 87) - for extend or duplicate it needs a second display";
        case 1610: return "Windows has no saved layout for that yet (error 1610) - it needs the displays it names to be connected";
      }
      return "Windows refused the display layout (error " + err + ")";
    }

    // ================================================================== native: D3DKMT (GPUs)
    // D3DKMTEnumAdapters2 / D3DKMTQueryAdapterInfo (documented, d3dkmthk.h): every GPU with the same
    // LUID DisplayConfig uses, including a laptop's discrete GPU that drives no display.
    [StructLayout(LayoutKind.Sequential)] struct KMT_ENUM2 { public uint Num; public IntPtr Adapters; }
    [StructLayout(LayoutKind.Sequential)] struct KMT_QUERY { public uint Adapter; public int Type; public IntPtr Data; public uint Size; }
    [StructLayout(LayoutKind.Sequential)] struct KMT_CLOSE { public uint Adapter; }
    [DllImport("gdi32.dll")] static extern int D3DKMTEnumAdapters2(ref KMT_ENUM2 e);
    [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref KMT_QUERY q);
    [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref KMT_CLOSE c);
    const int KMTQAITYPE_ADAPTERREGISTRYINFO = 8, KMTQAITYPE_ADAPTERTYPE = 15, KMTQAITYPE_DRIVER_DESCRIPTION = 65,
              KMTQAITYPE_WDDM_2_7_CAPS = 70, KMTQAITYPE_WDDM_2_9_CAPS = 75;

    static byte[] KmtQuery(uint h, int type, int size, out int status) {
      IntPtr p = Marshal.AllocHGlobal(size);
      try {
        var zero = new byte[size];
        Marshal.Copy(zero, 0, p, size);
        var q = new KMT_QUERY(); q.Adapter = h; q.Type = type; q.Data = p; q.Size = (uint)size;
        status = D3DKMTQueryAdapterInfo(ref q);
        if (status != 0) return null;
        var b = new byte[size];
        Marshal.Copy(p, b, 0, size);
        return b;
      } finally { Marshal.FreeHGlobal(p); }
    }

    // ================================================================== small helpers
    static string Why(Exception ex) {
      if (ex is SecurityException || ex is UnauthorizedAccessException) return "access denied (5)";
      int hr = Marshal.GetHRForException(ex);
      return ex.GetType().Name + " (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")";
    }

    static bool IsAdmin() {
      try {
        using (WindowsIdentity wi = WindowsIdentity.GetCurrent())
          return new WindowsPrincipal(wi).IsInRole(WindowsBuiltInRole.Administrator);
      } catch (Exception) { return false; }
    }

    static string LuidKey(LUID a) { return ((uint)a.High).ToString("x8") + a.Low.ToString("x8"); }
    static string Key(LUID a, uint target) { return LuidKey(a) + "-" + target.ToString(CultureInfo.InvariantCulture); }

    static string Hex(byte[] b) {
      if (b == null) return null;
      var sb = new StringBuilder(b.Length * 2);
      foreach (byte x in b) sb.Append(x.ToString("x2"));
      return sb.ToString();
    }
    static byte[] Unhex(string s) {
      if (s == null || (s.Length & 1) != 0) return null;
      var b = new byte[s.Length / 2];
      for (int i = 0; i < b.Length; i++) {
        int v;
        if (!int.TryParse(s.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)) return null;
        b[i] = (byte)v;
      }
      return b;
    }

    /// Strict number argument (the wire gives doubles). null = fine.
    static string Num(Dictionary<string, object> req, string key, string cmd, double min, double max, bool whole, out double v) {
      v = 0;
      object o;
      if (!Json.TryGet(req, key, out o) || !(o is double)) return cmd + " needs " + key + ": a number from " + min + " to " + max;
      v = (double)o;
      if (double.IsNaN(v) || v < min || v > max || (whole && v != Math.Floor(v)))
        return cmd + " needs " + key + ": a " + (whole ? "whole " : "") + "number from " + min + " to " + max;
      return null;
    }
    static string BoolArg(Dictionary<string, object> req, string key, string cmd, out bool v) {
      v = false;
      object o;
      if (!Json.TryGet(req, key, out o) || !(o is bool)) return cmd + " needs " + key + ": true or false";
      v = (bool)o;
      return null;
    }
    static string DryArg(Dictionary<string, object> req, string cmd, out bool dry) {
      dry = false;
      object o;
      if (!Json.TryGet(req, "dryRun", out o) || o == null) return null;
      if (!(o is bool)) return cmd + " needs dryRun: true or false";
      dry = (bool)o;
      return null;
    }
    static string KeepArg(Dictionary<string, object> req, string cmd, out int ms) {
      ms = 15000;
      if (!Json.HasKey(req, "keepWithinMs")) return null;
      double d;
      string e = Num(req, "keepWithinMs", cmd, 5000, 60000, true, out d);
      if (e != null) return e;
      ms = (int)d;
      return null;
    }
    static string Passive(string wouldHave) { return FeatureTable.PassiveRefusal + ": it would have " + wouldHave; }
    static IDictionary Dry(IList writes, object before, string wouldRefuse, bool needsAdmin) {
      return Json.Obj("ok", true, "dryRun", true, "writes", writes, "before", before,
                      "wouldRefuse", wouldRefuse, "needsAdmin", needsAdmin);
    }
    static List<object> L(params object[] items) { return new List<object>(items); }
    static double Hz2(uint num, uint den) { return den == 0 ? 0 : Math.Round((double)num / den, 2); }

    // ================================================================== reading the displays
    sealed class Disp {
      public string Key, Name, NameSource, DevicePath, Gdi, AdapterPath;
      public LUID Adapter, SrcAdapter; public uint TargetId, SourceId, Tech, Rotation, RNum, RDen;
      public bool Active, Available, Primary, HasSource;
      public int X, Y, W, H, NativeW, NativeH; public double NativeHz;
      public string NameReason, NativeReason, SourceReason;
    }

    static Disp FromPath(PATH p) {
      var d = new Disp();
      d.Adapter = p.Tgt.Adapter; d.TargetId = p.Tgt.Id; d.SrcAdapter = p.Src.Adapter; d.SourceId = p.Src.Id;
      d.Tech = p.Tgt.Tech; d.Rotation = p.Tgt.Rotation;
      d.Key = Key(p.Tgt.Adapter, p.Tgt.Id);
      return d;
    }

    /// Every display Windows knows: the active ones (QDC_ONLY_ACTIVE_PATHS) first, then connected
    /// but unused targets (QDC_ALL_PATHS, targetAvailable). null + err when Windows did not answer.
    static List<Disp> ReadDisplays(out string err, out string inactiveReason) {
      err = null; inactiveReason = null;
      Config act = Query(QDC_ONLY_ACTIVE_PATHS);
      if (act.Err != 0) { err = "Windows did not report the displays (QueryDisplayConfig error " + act.Err + ")"; return null; }
      var byKey = new Dictionary<string, Disp>(StringComparer.Ordinal);
      var list = new List<Disp>();
      foreach (PATH p in act.Paths) {
        if ((p.Flags & 1) == 0) continue;                                    // DISPLAYCONFIG_PATH_ACTIVE
        Disp d = FromPath(p);
        if (byKey.ContainsKey(d.Key)) continue;
        d.Active = true; d.Available = true;
        if (p.Src.ModeIdx != NO_MODE && p.Src.ModeIdx < act.Modes.Length && act.Modes[p.Src.ModeIdx].Type == 1) {
          MODE m = act.Modes[p.Src.ModeIdx];
          d.X = m.SrcX; d.Y = m.SrcY; d.W = (int)m.SrcWidth; d.H = (int)m.SrcHeight; d.HasSource = true;
        } else d.SourceReason = "Windows gave no source mode for this display";
        if (p.Tgt.ModeIdx != NO_MODE && p.Tgt.ModeIdx < act.Modes.Length && act.Modes[p.Tgt.ModeIdx].Type == 2
            && act.Modes[p.Tgt.ModeIdx].VDen != 0) {
          d.RNum = act.Modes[p.Tgt.ModeIdx].VNum; d.RDen = act.Modes[p.Tgt.ModeIdx].VDen;
        } else if (p.Tgt.Refresh.Den != 0) { d.RNum = p.Tgt.Refresh.Num; d.RDen = p.Tgt.Refresh.Den; }
        d.Primary = d.HasSource && d.X == 0 && d.Y == 0;                   // the primary source sits at 0,0
        int e;
        byte[] sn = DevGet(GET_SOURCE_NAME, 84, d.SrcAdapter, d.SourceId, out e);
        if (sn != null) d.Gdi = WStr(sn, 20, 32);
        else d.SourceReason = "Windows did not name this display's source (error " + e + ")";
        byKey[d.Key] = d; list.Add(d);
      }
      Config all = Query(QDC_ALL_PATHS);
      if (all.Err != 0) inactiveReason = "Windows did not list displays that are connected but not in use (error " + all.Err + ")";
      else foreach (PATH p in all.Paths) {
        if (p.Tgt.Available == 0) continue;
        string k = Key(p.Tgt.Adapter, p.Tgt.Id);
        if (byKey.ContainsKey(k)) continue;
        Disp d = FromPath(p);
        d.Active = false; d.Available = true;
        byKey[k] = d; list.Add(d);
      }
      foreach (Disp d in list) {
        int e;
        byte[] tn = DevGet(GET_TARGET_NAME, 420, d.Adapter, d.TargetId, out e);
        if (tn != null) {
          uint flags = U32(tn, 20);
          d.Tech = U32(tn, 24);
          string fn = WStr(tn, 36, 64);
          d.DevicePath = WStr(tn, 164, 128);
          if (fn.Length > 0) { d.Name = fn; d.NameSource = (flags & 2) != 0 ? "forced" : ((flags & 1) != 0 ? "edid" : "driver"); }
          else { d.Name = IsInternal(d.Tech) ? "Built-in display" : "Display"; d.NameSource = "none";
                 d.NameReason = "the display reports no name of its own, so this is a generic one"; }
        } else { d.Name = "Display"; d.NameSource = "none"; d.NameReason = "Windows did not name this display (error " + e + ")"; }
        byte[] pm = DevGet(GET_TARGET_PREFERRED_MODE, 80, d.Adapter, d.TargetId, out e);
        if (pm != null) {
          d.NativeW = (int)U32(pm, 20); d.NativeH = (int)U32(pm, 24);
          d.NativeHz = Hz2(U32(pm, 48), U32(pm, 52));
        } else d.NativeReason = "Windows did not report this display's recommended mode (error " + e + ")";
        byte[] an = DevGet(GET_ADAPTER_NAME, 276, d.Adapter, 0, out e);
        if (an != null) d.AdapterPath = WStr(an, 20, 128);
      }
      return list;
    }

    static bool IsInternal(uint tech) {
      return tech == 0x80000000u || tech == 6 /* LVDS */ || tech == 11 /* eDP */ || tech == 13 /* UDI embedded */;
    }
    static string TechName(uint t) {
      switch (t) {
        case 0: return "vga"; case 1: return "s-video"; case 2: return "composite"; case 3: return "component";
        case 4: return "dvi"; case 5: return "hdmi"; case 6: return "lvds"; case 8: return "d-jpn"; case 9: return "sdi";
        case 10: return "displayport"; case 11: return "embedded-displayport"; case 12: return "udi"; case 13: return "embedded-udi";
        case 14: return "sdtv-dongle"; case 15: return "miracast"; case 16: return "indirect-wired"; case 17: return "indirect-virtual";
        case 18: return "displayport-usb-tunnel"; case 0x80000000u: return "internal";
      }
      return "other";
    }

    static readonly string[] OrientNames = { "landscape", "portrait", "landscape-flipped", "portrait-flipped" };
    /// DMDO_* (0..3) from a CCD rotation (1..4).
    static uint DmdoOfRotation(uint rot) { return rot >= 1 && rot <= 4 ? rot - 1 : 0; }
    static int OrientOf(string s) { return s == null ? -1 : Array.IndexOf(OrientNames, s); }
    static bool Tall(uint dmdo) { return dmdo == 1 || dmdo == 3; }

    /// The display's modes from EnumDisplaySettings on its GDI name, in landscape terms, deduped:
    /// each int[] is {width, height, hz}. Only modes at the current colour depth (what Windows lists).
    static List<int[]> ModesOf(string gdi, out uint bpp, out string reason) {
      bpp = 0; reason = null;
      var outList = new List<int[]>();
      DEVMODE cur;
      string e = CurrentMode(gdi, out cur);
      if (e != null) { reason = e; return outList; }
      bpp = cur.Bpp;
      var seen = new HashSet<string>(StringComparer.Ordinal);
      for (int i = 0; i < 4096; i++) {
        DEVMODE dm = NewDevMode();
        if (!EnumDisplaySettingsW(gdi, i, ref dm)) break;
        if (dm.Bpp != cur.Bpp || dm.Width == 0 || dm.Height == 0) continue;
        int w = (int)dm.Width, h = (int)dm.Height;
        if ((dm.Fields & DM_DISPLAYORIENTATION) != 0 && Tall(dm.Orientation)) { int t = w; w = h; h = t; }
        string k = w + "x" + h + "@" + dm.Frequency;
        if (!seen.Add(k)) continue;
        outList.Add(new int[] { w, h, (int)dm.Frequency });
      }
      if (outList.Count == 0) reason = "Windows listed no modes for this display";
      return outList;
    }

    /// Groups modes as the page shows them: [{width, height, hz:[...], native}], largest first.
    static List<object> ModesJson(List<int[]> modes, int nativeW, int nativeH) {
      var groups = new List<KeyValuePair<long, List<int>>>();
      var at = new Dictionary<long, int>();
      foreach (int[] m in modes) {
        long k = ((long)m[0] << 20) | (uint)m[1];
        int ix;
        if (!at.TryGetValue(k, out ix)) { ix = groups.Count; at[k] = ix; groups.Add(new KeyValuePair<long, List<int>>(k, new List<int>())); }
        if (!groups[ix].Value.Contains(m[2])) groups[ix].Value.Add(m[2]);
      }
      groups.Sort(delegate(KeyValuePair<long, List<int>> a, KeyValuePair<long, List<int>> b) {
        int wa = (int)(a.Key >> 20), wb = (int)(b.Key >> 20);
        if (wa != wb) return wb.CompareTo(wa);
        return ((int)(b.Key & 0xfffff)).CompareTo((int)(a.Key & 0xfffff));
      });
      var list = new List<object>();
      foreach (var g in groups) {
        g.Value.Sort(); g.Value.Reverse();
        int w = (int)(g.Key >> 20), h = (int)(g.Key & 0xfffff);
        var hz = new List<object>();
        foreach (int r in g.Value) hz.Add(r);
        list.Add(Json.Obj("width", w, "height", h, "hz", hz, "native", w == nativeW && h == nativeH));
      }
      return list;
    }

    static IDictionary DispJson(Disp d, bool withModes) {
      uint dmdo = DmdoOfRotation(d.Rotation);
      int lw = Tall(dmdo) ? d.H : d.W, lh = Tall(dmdo) ? d.W : d.H;
      object modes = null; string modesReason = null;
      if (withModes) {
        if (d.Active && d.Gdi != null) {
          uint bpp; List<int[]> ms = ModesOf(d.Gdi, out bpp, out modesReason);
          modes = ModesJson(ms, d.NativeW, d.NativeH);
        } else {
          modes = new List<object>();
          modesReason = d.Active ? "Windows did not name this display's source, so its modes cannot be listed"
                                 : "this display is connected but not in use, so Windows lists its modes only once it is turned on (extend or duplicate)";
        }
      }
      bool on = d.Active && d.HasSource;
      return Json.Obj(
        "display", d.Key, "name", d.Name, "nameSource", d.NameSource, "nameReason", d.NameReason,
        "kind", IsInternal(d.Tech) ? "internal" : "external", "connector", TechName(d.Tech),
        "active", d.Active, "available", d.Available, "primary", d.Primary,
        "gdiName", d.Gdi, "devicePath", d.DevicePath, "adapter", LuidKey(d.Adapter),
        "position", on ? Json.Obj("x", d.X, "y", d.Y) : null,
        "bounds", on ? Json.Obj("x", d.X, "y", d.Y, "width", d.W, "height", d.H) : null,
        "resolution", on ? Json.Obj("width", lw, "height", lh) : null,
        "refreshHz", d.Active && d.RDen != 0 ? (object)Hz2(d.RNum, d.RDen) : null,
        "refresh", d.Active && d.RDen != 0 ? Json.Obj("numerator", d.RNum, "denominator", d.RDen) : null,
        "orientation", d.Active ? OrientNames[dmdo] : null,
        "native", d.NativeW > 0 ? Json.Obj("width", d.NativeW, "height", d.NativeH, "hz", d.NativeHz) : null,
        "nativeReason", d.NativeReason,
        "modes", modes, "modesReason", modesReason,
        "scale", d.Active ? ScaleJson(d) : Json.Obj("percent", null, "reason", "this display is not in use"),
        "hdr", d.Active ? HdrJson(d) : Json.Obj("supported", null, "enabled", null, "reason", "this display is not in use"),
        "reason", d.Active ? d.SourceReason : "connected but not in use (Windows is showing only the other display)");
    }

    // ------------------------------------------------------------------ scale (undocumented -3/-4)
    static readonly int[] DpiVals = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

    /// PURE. Type -3 answers three numbers, all STEPS in DpiVals relative to the RECOMMENDED scale:
    /// minRel (<= 0: how far below recommended the list starts, i.e. 100% sits at index -minRel...
    /// so recommended = DpiVals[-minRel]), curRel (current = DpiVals[-minRel + curRel]) and maxRel
    /// (the largest allowed = DpiVals[-minRel + maxRel]). This is the maths the SetDPI-style tools
    /// use; Windows' own Settings shows the same list.
    public static IDictionary ScaleInfo(int minRel, int curRel, int maxRel) {
      int rec = -minRel, cur = rec + curRel, top = rec + maxRel;
      if (rec < 0 || rec >= DpiVals.Length || top < rec || cur < 0 || cur > top)
        return Json.Obj("percent", null, "recommended", null, "allowed", new List<object>(),
                        "reason", "Windows answered scale steps Mantle cannot map (min " + minRel + ", current " + curRel + ", max " + maxRel + ")");
      string cut = null;
      if (top >= DpiVals.Length) { top = DpiVals.Length - 1; cut = "Windows allows more steps than Mantle's list knows; the list stops at 500%"; }
      var allowed = new List<object>();
      for (int i = 0; i <= top; i++) allowed.Add(DpiVals[i]);
      return Json.Obj("percent", cur < DpiVals.Length ? (object)DpiVals[cur] : null, "recommended", DpiVals[rec],
                      "allowed", allowed, "reason", cut);
    }

    /// PURE. The relative step type -4 needs for `percent`, or why not.
    public static string ScaleRel(int minRel, int maxRel, int percent, out int rel) {
      rel = 0;
      int ix = Array.IndexOf(DpiVals, percent);
      int rec = -minRel, top = Math.Min(rec + maxRel, DpiVals.Length - 1);
      if (ix < 0) return percent + "% is not a scale Windows offers (it offers 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 up to each display's limit)";
      if (rec < 0 || rec >= DpiVals.Length) return "Windows answered a recommended scale Mantle cannot map, so nothing was changed";
      if (ix > top) return percent + "% is larger than this display allows (up to " + DpiVals[top] + "%)";
      rel = ix - rec;
      return null;
    }

    static bool DpiRead(Disp d, out int minRel, out int curRel, out int maxRel, out int err) {
      minRel = curRel = maxRel = 0;
      byte[] b = DevGet(GET_DPI_SCALE, 32, d.SrcAdapter, d.SourceId, out err);
      if (b == null) return false;
      minRel = I32(b, 20); curRel = I32(b, 24); maxRel = I32(b, 28);
      return true;
    }

    static IDictionary ScaleJson(Disp d) {
      int mn, cu, mx, err;
      if (!DpiRead(d, out mn, out cu, out mx, out err))
        return Json.Obj("percent", null, "recommended", null, "allowed", new List<object>(),
                        "source", "DisplayConfigGetDeviceInfo type -3 (undocumented)",
                        "reason", "Windows did not answer the scale read (error " + err + ")");
      IDictionary s = ScaleInfo(mn, cu, mx);
      s["source"] = "DisplayConfigGetDeviceInfo type -3 (undocumented, the call SetDPI-style tools use)";
      s["steps"] = Json.Obj("min", mn, "current", cu, "max", mx);
      string cs = CustomScaleOn();
      if (cs != null) s["reason"] = cs;
      return s;
    }

    /// Custom scaling (Settings > Display > Scale > Custom) overrides every display's scale until
    /// it is turned off and Owen signs out. HKCU\Control Panel\Desktop: Win8DpiScaling=1 + LogPixels.
    static string CustomScaleOn() {
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop")) {
          if (k == null) return null;
          object w8 = k.GetValue("Win8DpiScaling"), lp = k.GetValue("LogPixels");
          if (w8 is int && (int)w8 == 1 && lp is int && (int)lp > 0)
            return "custom scaling (" + ((int)lp * 100 / 96) + "%) is on for every display, which overrides this until it is turned off and you sign out";
        }
      } catch (Exception) { }
      return null;
    }

    static IDictionary CustomScaleJson() {
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop")) {
          object w8 = k == null ? null : k.GetValue("Win8DpiScaling"), lp = k == null ? null : k.GetValue("LogPixels");
          bool on = w8 is int && (int)w8 == 1 && lp is int && (int)lp > 0;
          return Json.Obj("on", on, "percent", on ? (object)((int)lp * 100 / 96) : null,
                          "source", @"HKCU\Control Panel\Desktop Win8DpiScaling + LogPixels",
                          "writable", false,
                          "why", "custom scaling only takes effect after signing out, so Mantle shows it but does not set it (use per-display scale)");
        }
      } catch (Exception ex) {
        return Json.Obj("on", null, "reason", "custom scaling could not be read: " + Why(ex));
      }
    }

    // ------------------------------------------------------------------ HDR / advanced colour
    sealed class Color {
      public bool Ok, V2, Supported, Enabled, Active, WcgSupported, WcgEnabled, LimitedByPolicy, ForceDisabled;
      public uint Encoding, Bpc, ActiveMode; public int Err;
    }

    static Color ReadColor(Disp d) {
      var c = new Color();
      int e;
      byte[] b = DevGet(GET_ADVANCED_COLOR_INFO_2, 36, d.Adapter, d.TargetId, out e);
      if (b != null) {                                      // Windows 11 24H2+: the HDR switch itself
        uint v = U32(b, 20);
        c.Ok = true; c.V2 = true;
        c.LimitedByPolicy = (v & 8) != 0; c.Supported = (v & 16) != 0; c.Enabled = (v & 32) != 0;
        c.WcgSupported = (v & 64) != 0; c.WcgEnabled = (v & 128) != 0;
        c.Encoding = U32(b, 24); c.Bpc = U32(b, 28); c.ActiveMode = U32(b, 32);
        c.Active = c.ActiveMode == 2;
        return c;
      }
      b = DevGet(GET_ADVANCED_COLOR_INFO, 32, d.Adapter, d.TargetId, out e);
      if (b == null) { c.Err = e; return c; }
      uint w = U32(b, 20);
      c.Ok = true; c.Supported = (w & 1) != 0; c.Enabled = (w & 2) != 0; c.Active = c.Enabled;
      c.ForceDisabled = (w & 8) != 0; c.Encoding = U32(b, 24); c.Bpc = U32(b, 28);
      c.ActiveMode = c.Enabled ? 2u : 0u;
      return c;
    }

    static readonly string[] EncNames = { "rgb", "ycbcr444", "ycbcr422", "ycbcr420", "intensity" };

    static IDictionary HdrJson(Disp d) {
      Color c = ReadColor(d);
      if (!c.Ok)
        return Json.Obj("supported", null, "enabled", null, "source", "DisplayConfigGetDeviceInfo GET_ADVANCED_COLOR_INFO",
                        "reason", "Windows did not answer the HDR read (error " + c.Err + ")");
      string why = null;
      if (!c.Supported) why = "this display does not report HDR support to Windows";
      else if (c.LimitedByPolicy) why = "Windows is limiting HDR here by policy (for example on battery power)";
      else if (c.ForceDisabled) why = "advanced colour is force-disabled for this display";
      object nits = null;
      int e;
      byte[] w = DevGet(GET_SDR_WHITE_LEVEL, 24, d.Adapter, d.TargetId, out e);
      if (w != null) nits = Math.Round(U32(w, 20) * 80.0 / 1000.0, 1);          // 1000 = 80 nits (wingdi.h)
      return Json.Obj(
        "supported", c.Supported, "enabled", c.Enabled, "active", c.Active,
        "wideColorSupported", c.V2 ? (object)c.WcgSupported : null, "wideColorEnabled", c.V2 ? (object)c.WcgEnabled : null,
        "limitedByPolicy", c.LimitedByPolicy,
        "activeMode", c.ActiveMode == 2 ? "hdr" : (c.ActiveMode == 1 ? "wcg" : "sdr"),
        "colorEncoding", c.Encoding < EncNames.Length ? EncNames[c.Encoding] : "other", "bitsPerColor", c.Bpc,
        "sdrWhiteNits", nits,
        "source", c.V2 ? "DisplayConfigGetDeviceInfo GET_ADVANCED_COLOR_INFO_2" : "DisplayConfigGetDeviceInfo GET_ADVANCED_COLOR_INFO",
        "writable", c.Supported, "reason", why);
    }

    // ------------------------------------------------------------------ topology
    static readonly string[] TopoNames = { "internal", "clone", "extend", "external" };
    static readonly uint[] TopoFlags = { SDC_TOPOLOGY_INTERNAL, SDC_TOPOLOGY_CLONE, SDC_TOPOLOGY_EXTEND, SDC_TOPOLOGY_EXTERNAL };
    static uint TopoFlag(string n) { int i = Array.IndexOf(TopoNames, n); return i < 0 ? 0 : TopoFlags[i]; }
    static string TopoName(uint id) { int i = Array.IndexOf(TopoFlags, id); return i < 0 ? null : TopoNames[i]; }

    static IDictionary TopologyJson() {
      Config db = Query(QDC_DATABASE_CURRENT);
      string cur = null, reason = null;
      if (db.Err != 0) reason = "Windows did not report the current layout (error " + db.Err + ")";
      else {
        cur = TopoName(db.Topology);
        if (cur == null) { cur = "custom"; reason = "the current layout is not one of Windows' four presets (topology " + db.Topology + ")"; }
      }
      var avail = new List<object>();
      var why = Json.Obj();
      for (int i = 0; i < TopoNames.Length; i++) {
        int e = SetDisplayConfig(0, null, 0, null, SDC_VALIDATE | TopoFlags[i]);   // validates only: changes nothing
        if (e == 0) avail.Add(TopoNames[i]); else why[TopoNames[i]] = SdcWords(e);
      }
      return Json.Obj("current", cur, "source", "QueryDisplayConfig(QDC_DATABASE_CURRENT)", "reason", reason,
                      "available", avail, "unavailable", why);
    }

    // ------------------------------------------------------------------ GPUs
    sealed class Gpu {
      public string Key, Name, NameSource;
      public bool Software, Display, Render, HybridD, HybridI, CapsOk, HwSupported, HwEnabled, HwDefault, Caps29Ok;
      public int CapsErr, Hw29State; public uint Raw27, Raw29;
    }
    static readonly string[] HwStates = { "off", "experimental", "stable", "always-on" };

    static List<Gpu> ReadGpus(out string reason) {
      reason = null;
      var list = new List<Gpu>();
      var e2 = new KMT_ENUM2();
      int st = D3DKMTEnumAdapters2(ref e2);
      if (st != 0) { reason = "Windows did not list the graphics adapters (status 0x" + st.ToString("X8") + ")"; return list; }
      if (e2.Num == 0) return list;
      const int Info = 20;                                   // D3DKMT_ADAPTERINFO: hAdapter, LUID, NumOfSources, bPrecise...
      IntPtr buf = Marshal.AllocHGlobal(Info * (int)e2.Num);
      try {
        e2.Adapters = buf;
        st = D3DKMTEnumAdapters2(ref e2);
        if (st != 0) { reason = "Windows did not list the graphics adapters (status 0x" + st.ToString("X8") + ")"; return list; }
        var raw = new byte[Info * (int)e2.Num];
        Marshal.Copy(buf, raw, 0, raw.Length);
        for (int i = 0; i < e2.Num; i++) {
          uint h = U32(raw, i * Info);
          var l = new LUID(); l.Low = U32(raw, i * Info + 4); l.High = I32(raw, i * Info + 8);
          var g = new Gpu(); g.Key = LuidKey(l);
          try {
            int s;
            byte[] dd = KmtQuery(h, KMTQAITYPE_DRIVER_DESCRIPTION, 8192, out s);
            if (dd != null && WStr(dd, 0, 4096).Length > 0) { g.Name = WStr(dd, 0, 4096); g.NameSource = "driver description"; }
            else {
              byte[] ri = KmtQuery(h, KMTQAITYPE_ADAPTERREGISTRYINFO, 2080, out s);
              if (ri != null) { g.Name = WStr(ri, 0, 260); g.NameSource = "adapter string"; }
            }
            if (string.IsNullOrEmpty(g.Name)) { g.Name = "Graphics adapter"; g.NameSource = "none"; }
            byte[] ty = KmtQuery(h, KMTQAITYPE_ADAPTERTYPE, 4, out s);
            if (ty != null) {
              uint v = U32(ty, 0);
              g.Render = (v & 1) != 0; g.Display = (v & 2) != 0; g.Software = (v & 4) != 0;
              g.HybridD = (v & 16) != 0; g.HybridI = (v & 32) != 0;
            }
            byte[] caps = KmtQuery(h, KMTQAITYPE_WDDM_2_7_CAPS, 4, out s);
            if (caps != null) {
              uint v = U32(caps, 0);
              g.CapsOk = true; g.Raw27 = v; g.HwSupported = (v & 1) != 0; g.HwEnabled = (v & 2) != 0; g.HwDefault = (v & 4) != 0;
            } else g.CapsErr = s;
            // WDDM 2.9 drivers report support as a state (0 off, 1 experimental, 2 stable, 3 always on)
            // and may leave the 2.7 bit clear, so both are read and either one counts.
            byte[] c29 = KmtQuery(h, KMTQAITYPE_WDDM_2_9_CAPS, 4, out s);
            if (c29 != null) {
              uint v = U32(c29, 0);
              g.Caps29Ok = true; g.Raw29 = v; g.Hw29State = (int)(v & 3);
              if (!g.CapsOk) { g.CapsOk = true; g.CapsErr = 0; }
              if (g.Hw29State >= 2) g.HwSupported = true;
              if ((v & 4) != 0) g.HwEnabled = true;
            }
          } finally {
            var c = new KMT_CLOSE(); c.Adapter = h;
            D3DKMTCloseAdapter(ref c);
          }
          list.Add(g);
        }
      } finally { Marshal.FreeHGlobal(buf); }
      return list;
    }

    static List<object> GpusJson(List<Gpu> gs) {
      var list = new List<object>();
      foreach (Gpu g in gs)
        list.Add(Json.Obj("adapter", g.Key, "name", g.Name, "nameSource", g.NameSource, "software", g.Software,
                          "displaySupported", g.Display, "renderSupported", g.Render,
                          "hybrid", g.HybridD ? "discrete" : (g.HybridI ? "integrated" : null),
                          "gpuScheduling", g.CapsOk
                            ? Json.Obj("supported", g.HwSupported, "enabled", g.HwEnabled, "enabledByDefault", g.HwDefault,
                                       "supportState", g.Caps29Ok ? (object)HwStates[g.Hw29State] : null,
                                       "raw", "2.7=0x" + g.Raw27.ToString("x") + (g.Caps29Ok ? " 2.9=0x" + g.Raw29.ToString("x") : ""),
                                       "source", "D3DKMTQueryAdapterInfo(WDDM_2_7_CAPS, WDDM_2_9_CAPS)", "reason", null)
                            : Json.Obj("supported", null, "enabled", null,
                                       "reason", "the driver does not answer the WDDM 2.7 capability query (status 0x" + g.CapsErr.ToString("X8") + "), so it predates GPU scheduling")));
      return list;
    }

    // ------------------------------------------------------------------ sysdisplay.get
    static string Get(Dictionary<string, object> req, ref object result) {
      long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
      try {
        string err, inactive, gpuWhy;
        List<Disp> ds = ReadDisplays(out err, out inactive);
        if (ds == null) return err;
        var list = new List<object>();
        foreach (Disp d in ds) list.Add(DispJson(d, true));
        List<Gpu> gs = ReadGpus(out gpuWhy);
        result = Json.Obj("ok", true, "displays", list, "inactiveReason", inactive,
                          "topology", TopologyJson(), "gpus", GpusJson(gs), "gpusReason", gpuWhy,
                          "customScale", CustomScaleJson(), "pending", PendingJson(),
                          "ms", Lanes.MsSince(t0));
        return null;
      } catch (Exception ex) { return "sysdisplay.get failed: " + Why(ex); }
    }

    static Disp Find(List<Disp> ds, string key) {
      if (ds == null || key == null) return null;
      foreach (Disp d in ds) if (d.Key == key) return d;
      return null;
    }

    static string FreshDisplay(Dictionary<string, object> req, string cmd, bool mustBeActive, out Disp d, out List<Disp> ds) {
      d = null; ds = null;
      string key = Json.GetString(req, "display");
      if (string.IsNullOrEmpty(key)) return cmd + " needs display: the \"display\" key from sysdisplay.get";
      string err, inactive;
      ds = ReadDisplays(out err, out inactive);
      if (ds == null) return err;
      d = Find(ds, key);
      if (d == null) return "that display is not connected now (it may have been unplugged, or the PC restarted: read sysdisplay.get again)";
      if (mustBeActive && (!d.Active || d.Gdi == null))
        return "that display is connected but not in use; turn it on first (sysdisplay.topology extend or clone)";
      return null;
    }

    // ================================================================== steps: what a change and its revert DO
    /// One Windows call, as data: the same object is shown in dryRun's `writes`/`revert`, run for
    /// real, and built by the pure planners below, so what the page previews is what runs.
    sealed class Step {
      public string Api, Display, Device, Topology;
      public int Width, Height, X, Y; public uint Hz, Orientation, Bpp, Flags; public bool SetPrimary;
      public Config Supplied;
    }

    static List<object> FlagNames(Step s) {
      var f = new List<object>();
      if (s.Api == "cds.mode" || s.Api == "cds.position") {
        if (s.Flags == 0) f.Add("dynamic (not saved)");
        if ((s.Flags & CDS_TEST) != 0) f.Add("CDS_TEST");
        if ((s.Flags & CDS_UPDATEREGISTRY) != 0) f.Add("CDS_UPDATEREGISTRY");
        if ((s.Flags & CDS_NORESET) != 0) f.Add("CDS_NORESET");
        if (s.SetPrimary) f.Add("CDS_SET_PRIMARY");
      } else if (s.Api.StartsWith("sdc.")) {
        if ((s.Flags & SDC_VALIDATE) != 0) f.Add("SDC_VALIDATE");
        if ((s.Flags & SDC_APPLY) != 0) f.Add("SDC_APPLY");
        if ((s.Flags & SDC_USE_SUPPLIED_DISPLAY_CONFIG) != 0) f.Add("SDC_USE_SUPPLIED_DISPLAY_CONFIG");
        if ((s.Flags & SDC_SAVE_TO_DATABASE) != 0) f.Add("SDC_SAVE_TO_DATABASE");
        if ((s.Flags & SDC_ALLOW_CHANGES) != 0) f.Add("SDC_ALLOW_CHANGES");
        if (s.Topology != null) f.Add("SDC_TOPOLOGY_" + s.Topology.ToUpperInvariant());
      }
      return f;
    }

    static IDictionary StepJson(Step s) {
      switch (s.Api) {
        case "cds.mode":
          return Json.Obj("api", "ChangeDisplaySettingsEx", "step", s.Api, "display", s.Display, "device", s.Device,
                          "width", s.Width, "height", s.Height, "hz", s.Hz,
                          "orientation", s.Orientation < 4 ? OrientNames[s.Orientation] : null,
                          "bitsPerPixel", s.Bpp, "flags", FlagNames(s));
        case "cds.position":
          return Json.Obj("api", "ChangeDisplaySettingsEx", "step", s.Api, "display", s.Display, "device", s.Device,
                          "x", s.X, "y", s.Y, "primary", s.SetPrimary, "flags", FlagNames(s));
        case "cds.apply":
          return Json.Obj("api", "ChangeDisplaySettingsEx", "step", s.Api, "note", "applies the saved positions (device null, flags 0)");
        case "cds.reset":
          return Json.Obj("api", "ChangeDisplaySettingsEx", "step", s.Api, "display", s.Display, "device", s.Device,
                          "note", "returns the display to its saved mode (devmode null, flags 0)");
        case "sdc.topology":
          return Json.Obj("api", "SetDisplayConfig", "step", s.Api, "topology", s.Topology, "flags", FlagNames(s));
        case "sdc.supplied":
          return Json.Obj("api", "SetDisplayConfig", "step", s.Api,
                          "paths", s.Supplied == null ? 0 : s.Supplied.Paths.Length, "flags", FlagNames(s),
                          "note", "puts back the whole recorded layout");
      }
      return Json.Obj("api", "unknown", "step", s.Api);
    }

    static List<object> StepsJson(List<Step> ss) {
      var l = new List<object>();
      if (ss != null) foreach (Step s in ss) l.Add(StepJson(s));
      return l;
    }

    static Step ModeStep(string display, string device, int w, int h, uint hz, uint dmdo, uint bpp, uint flags) {
      var s = new Step(); s.Api = "cds.mode"; s.Display = display; s.Device = device;
      s.Width = w; s.Height = h; s.Hz = hz; s.Orientation = dmdo; s.Bpp = bpp; s.Flags = flags;
      return s;
    }
    static Step PosStep(string display, string device, int x, int y, bool primary, uint flags) {
      var s = new Step(); s.Api = "cds.position"; s.Display = display; s.Device = device;
      s.X = x; s.Y = y; s.SetPrimary = primary; s.Flags = flags;
      return s;
    }
    static Step Simple(string api, string display, string device) { var s = new Step(); s.Api = api; s.Display = display; s.Device = device; return s; }
    static Step TopoStep(string topo, uint flags) { var s = new Step(); s.Api = "sdc.topology"; s.Topology = topo; s.Flags = flags; return s; }
    static Step SuppliedStep(Config c) {
      var s = new Step(); s.Api = "sdc.supplied"; s.Supplied = c;
      s.Flags = SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_SAVE_TO_DATABASE | SDC_ALLOW_CHANGES;
      return s;
    }

    /// Runs ONE step. null = Windows said yes, else plain words.
    static string RunStep(Step s) {
      try {
        switch (s.Api) {
          case "cds.mode": {
            DEVMODE dm; string e = CurrentMode(s.Device, out dm); if (e != null) return e;
            bool tall = Tall(s.Orientation);
            dm.Width = (uint)(tall ? s.Height : s.Width); dm.Height = (uint)(tall ? s.Width : s.Height);
            dm.Frequency = s.Hz; dm.Orientation = s.Orientation;
            dm.Fields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_DISPLAYORIENTATION;
            if (s.Bpp != 0) { dm.Bpp = s.Bpp; dm.Fields |= DM_BITSPERPEL; }
            return CdsWords(ChangeDisplaySettingsExW(s.Device, ref dm, IntPtr.Zero, s.Flags, IntPtr.Zero));
          }
          case "cds.position": {
            DEVMODE dm; string e = CurrentMode(s.Device, out dm); if (e != null) return e;
            dm.PosX = s.X; dm.PosY = s.Y; dm.Fields = DM_POSITION;
            uint f = s.Flags | (s.SetPrimary && (s.Flags & CDS_TEST) == 0 ? CDS_SET_PRIMARY : 0);
            return CdsWords(ChangeDisplaySettingsExW(s.Device, ref dm, IntPtr.Zero, f, IntPtr.Zero));
          }
          case "cds.apply": return CdsWords(ChangeDisplaySettingsExNull(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero));
          case "cds.reset": return CdsWords(ChangeDisplaySettingsExNull(s.Device, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero));
          case "sdc.topology": return SdcWords(SetDisplayConfig(0, null, 0, null, s.Flags | TopoFlag(s.Topology)));
          case "sdc.supplied":
            if (s.Supplied == null || s.Supplied.Paths.Length == 0) return "there is no recorded layout to put back";
            return SdcWords(SetDisplayConfig((uint)s.Supplied.Paths.Length, s.Supplied.Paths,
                                             (uint)s.Supplied.Modes.Length, s.Supplied.Modes, s.Flags));
        }
        return "unknown step";
      } catch (Exception ex) { return "the display call failed: " + Why(ex); }
    }

    static string RunAll(List<Step> ss) {
      if (ss == null) return null;
      foreach (Step s in ss) { string e = RunStep(s); if (e != null) return e; }
      return null;
    }

    // ================================================================== pure planners (sysdisplay.decide)
    /// PURE. modes: {width, height, hz} in landscape terms. Picks the mode for (w, h, hz); without hz
    /// it keeps curHz when that is offered at the new size, else the highest offered. Integer Hz from
    /// EnumDisplaySettings match a requested hz within half a hertz (59.94 -> 60).
    public static string MatchMode(List<int[]> modes, int w, int h, double hz, bool hzGiven, int curHz, out int chosenHz) {
      chosenHz = 0;
      var rates = new List<int>();
      foreach (int[] m in modes) if (m[0] == w && m[1] == h && !rates.Contains(m[2])) rates.Add(m[2]);
      if (rates.Count == 0) {
        int bw = 0, bh = 0;
        foreach (int[] m in modes) if ((long)m[0] * m[1] > (long)bw * bh) { bw = m[0]; bh = m[1]; }
        return w + " x " + h + " is not a resolution this display offers" + (bw > 0 ? " (the largest it offers is " + bw + " x " + bh + ")" : " (it lists none)");
      }
      rates.Sort();
      if (hzGiven) {
        foreach (int r in rates) if (Math.Abs(r - hz) < 0.51) { chosenHz = r; return null; }
        var sb = new StringBuilder();
        foreach (int r in rates) { if (sb.Length > 0) sb.Append(", "); sb.Append(r); }
        return hz.ToString(CultureInfo.InvariantCulture) + " Hz is not offered at " + w + " x " + h + " (offered: " + sb + " Hz)";
      }
      chosenHz = rates.Contains(curHz) ? curHz : rates[rates.Count - 1];
      return null;
    }

    public sealed class Rect { public string Key, Device; public int X, Y, W, H; public bool Primary; }

    static long Overlap1(int a, int al, int b, int bl) { return Math.Max(0L, (long)Math.Min(a + al, b + bl) - Math.Max(a, b)); }
    /// Two displays TOUCH when they share an edge segment of positive length (a corner is not enough).
    public static bool Touch(Rect a, Rect b) {
      bool side = (a.X + a.W == b.X || b.X + b.W == a.X) && Overlap1(a.Y, a.H, b.Y, b.H) > 0;
      bool stack = (a.Y + a.H == b.Y || b.Y + b.H == a.Y) && Overlap1(a.X, a.W, b.X, b.W) > 0;
      return side || stack;
    }
    public static bool Overlaps(Rect a, Rect b) { return Overlap1(a.X, a.W, b.X, b.W) > 0 && Overlap1(a.Y, a.H, b.Y, b.H) > 0; }

    /// PURE. Validates a layout: no two displays overlap and every display touches the group. The
    /// primary is shifted back to 0,0 (Windows requires it) and everything moves with it.
    public static string CheckLayout(List<Rect> rs) {
      if (rs.Count == 0) return "there are no displays in use";
      Rect prim = null;
      foreach (Rect r in rs) if (r.Primary) { if (prim != null) return "two displays are marked main"; prim = r; }
      if (prim == null) return "no display is marked main";
      int dx = prim.X, dy = prim.Y;
      foreach (Rect r in rs) { r.X -= dx; r.Y -= dy; }
      for (int i = 0; i < rs.Count; i++)
        for (int j = i + 1; j < rs.Count; j++)
          if (Overlaps(rs[i], rs[j])) return "displays " + (i + 1) + " and " + (j + 1) + " would overlap";
      var seen = new bool[rs.Count]; var q = new Queue<int>();
      seen[0] = true; q.Enqueue(0); int n = 1;
      while (q.Count > 0) {
        int a = q.Dequeue();
        for (int b = 0; b < rs.Count; b++)
          if (!seen[b] && Touch(rs[a], rs[b])) { seen[b] = true; n++; q.Enqueue(b); }
      }
      if (n != rs.Count) return "every display must touch another along an edge (a gap or a corner-only contact is not allowed)";
      return null;
    }

    static List<Rect> Copy(List<Rect> cur) {
      var l = new List<Rect>();
      foreach (Rect r in cur) { var c = new Rect(); c.Key = r.Key; c.Device = r.Device; c.X = r.X; c.Y = r.Y; c.W = r.W; c.H = r.H; c.Primary = r.Primary; l.Add(c); }
      return l;
    }

    /// PURE. New positions for `positions` ({display, x, y}); displays not named keep theirs.
    public static string PlanArrange(List<Rect> cur, List<Rect> want, out List<Rect> plan) {
      plan = Copy(cur);
      var named = new HashSet<string>(StringComparer.Ordinal);
      foreach (Rect w in want) {
        if (!named.Add(w.Key)) return "a display is named twice in positions";
        Rect hit = null;
        foreach (Rect r in plan) if (r.Key == w.Key) hit = r;
        if (hit == null) return "positions names a display that is not in use now (read sysdisplay.get again)";
        hit.X = w.X; hit.Y = w.Y;
      }
      return CheckLayout(plan);
    }

    /// PURE. Makes `key` the main display: it moves to 0,0 and every other display moves with it.
    public static string PlanPrimary(List<Rect> cur, string key, out List<Rect> plan) {
      plan = Copy(cur);
      Rect t = null;
      foreach (Rect r in plan) if (r.Key == key) t = r;
      if (t == null) return "that display is not in use now, so it cannot be the main display";
      foreach (Rect r in plan) r.Primary = r == t;
      return CheckLayout(plan);
    }

    static bool SameLayout(List<Rect> a, List<Rect> b) {
      if (a.Count != b.Count) return false;
      for (int i = 0; i < a.Count; i++) if (a[i].X != b[i].X || a[i].Y != b[i].Y || a[i].Primary != b[i].Primary) return false;
      return true;
    }

    /// PURE. The steps that write a layout (and, fed the old layout, the ones that put it back):
    /// one CDS_UPDATEREGISTRY|CDS_NORESET position per display, the main one with CDS_SET_PRIMARY,
    /// then one apply (the documented way to move several displays at once).
    public static List<object> LayoutStepsJson(List<Rect> plan) { return StepsJson(LayoutSteps(plan, CDS_UPDATEREGISTRY | CDS_NORESET)); }
    static List<Step> LayoutSteps(List<Rect> plan, uint flags) {
      var l = new List<Step>();
      foreach (Rect r in plan) l.Add(PosStep(r.Key, r.Device, r.X, r.Y, r.Primary, flags));
      if ((flags & CDS_TEST) == 0) l.Add(Simple("cds.apply", null, null));
      return l;
    }

    /// PURE. What a revert of a MODE change restores: the recorded previous mode, dynamically (the
    /// saved mode was never touched), and if Windows refuses that, the saved mode itself.
    static List<Step> ModeRevert(string display, string device, int w, int h, uint hz, uint dmdo, uint bpp) {
      return new List<Step> { ModeStep(display, device, w, h, hz, dmdo, bpp, 0) };
    }

    // ================================================================== keep / revert (the 15 s safety)
    sealed class Pending {
      public string Token, Kind; public List<Step> Revert, Fallback, Keep; public Timer Timer;
      public DateTime Deadline; public int KeepMs; public IDictionary Change;
    }
    static readonly object _pendGate = new object(), _applyGate = new object();
    static Pending _pending;
    static bool _exitHooked;

    static IDictionary PendingJson() {
      lock (_pendGate) {
        if (_pending == null) return null;
        long left = (long)(_pending.Deadline - DateTime.UtcNow).TotalMilliseconds;
        return Json.Obj("token", _pending.Token, "kind", _pending.Kind, "revertsInMs", Math.Max(0, left),
                        "revert", StepsJson(_pending.Revert));
      }
    }

    static string Busy() {
      lock (_pendGate) {
        if (_pending == null) return null;
        long left = (long)(_pending.Deadline - DateTime.UtcNow).TotalMilliseconds;
        return "a display change is still waiting to be kept or reverted (" + Math.Max(0, left / 1000) +
               " s left); keep or revert it first";
      }
    }

    static Pending Arm(string kind, List<Step> revert, List<Step> fallback, List<Step> keep, int ms, IDictionary change) {
      var p = new Pending();
      p.Token = Guid.NewGuid().ToString("N").Substring(0, 16);
      p.Kind = kind; p.Revert = revert; p.Fallback = fallback; p.Keep = keep; p.KeepMs = ms; p.Change = change;
      p.Deadline = DateTime.UtcNow.AddMilliseconds(ms);
      lock (_pendGate) {
        _pending = p;
        if (!_exitHooked) {
          _exitHooked = true;
          AppDomain.CurrentDomain.ProcessExit += delegate {
            string tok = null;
            lock (_pendGate) if (_pending != null) tok = _pending.Token;
            if (tok != null) Finish(tok, false, "exit");
          };
        }
        p.Timer = new Timer(delegate(object st) { Finish((string)st, false, "timeout"); }, p.Token, ms, Timeout.Infinite);
      }
      Features.Event("sysdisplay", Json.Obj("what", "pending", "token", p.Token, "kind", kind, "keepWithinMs", ms,
                                            "change", change, "revert", StepsJson(revert)));
      return p;
    }

    /// Keeps or reverts the pending change named by `token`. null + the event, or plain words.
    static string Finish(string token, bool keep, string why) {
      Pending p;
      lock (_pendGate) {
        if (_pending == null || _pending.Token != token) return "no display change is waiting with that token (it was already kept or reverted)";
        p = _pending; _pending = null;
        if (p.Timer != null) p.Timer.Dispose();
      }
      string err;
      lock (_applyGate) {
        if (keep) err = RunAll(p.Keep);
        else {
          err = RunAll(p.Revert);
          if (err != null && p.Fallback != null) {
            string e2 = RunAll(p.Fallback);
            err = e2 == null ? null : err + "; putting back the saved layout also failed: " + e2;
          }
        }
      }
      Features.Event("sysdisplay", Json.Obj("what", keep ? "kept" : "reverted", "token", token, "kind", p.Kind,
                                            "why", why, "ok", err == null, "reason", err));
      return err;
    }

    static string KeepCmd(Dictionary<string, object> req, ref object result) {
      try {
        string token = Json.GetString(req, "token");
        if (string.IsNullOrEmpty(token)) return "sysdisplay.keep needs token: the token the change answered";
        string kind;
        lock (_pendGate) kind = _pending != null && _pending.Token == token ? _pending.Kind : null;
        string e = Finish(token, true, "asked");
        if (e != null) return kind == null ? e : "the change stays, but saving it failed: " + e;
        result = Json.Obj("ok", true, "kept", true, "kind", kind);
        return null;
      } catch (Exception ex) { return "sysdisplay.keep failed: " + Why(ex); }
    }

    static string RevertCmd(Dictionary<string, object> req, ref object result) {
      try {
        string token = Json.GetString(req, "token");
        if (string.IsNullOrEmpty(token)) return "sysdisplay.revert needs token: the token the change answered";
        string kind;
        lock (_pendGate) kind = _pending != null && _pending.Token == token ? _pending.Kind : null;
        string e = Finish(token, false, "asked");
        if (e != null) return kind == null ? e : "Mantle tried to put the display back, but Windows refused: " + e;
        result = Json.Obj("ok", true, "reverted", true, "kind", kind);
        return null;
      } catch (Exception ex) { return "sysdisplay.revert failed: " + Why(ex); }
    }

    // ================================================================== sysdisplay.mode
    static string ModeCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.mode";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        int keepMs; e = KeepArg(req, C, out keepMs); if (e != null) return e;
        double w, h, hz = 0;
        e = Num(req, "width", C, 1, 65535, true, out w); if (e != null) return e;
        e = Num(req, "height", C, 1, 65535, true, out h); if (e != null) return e;
        bool hzGiven = Json.HasKey(req, "hz");
        if (hzGiven) { e = Num(req, "hz", C, 1, 1000, false, out hz); if (e != null) return e; }
        Disp d; List<Disp> ds;
        e = FreshDisplay(req, C, true, out d, out ds); if (e != null) return e;
        DEVMODE cur; e = CurrentMode(d.Gdi, out cur); if (e != null) return e;
        uint curDmdo = (cur.Fields & DM_DISPLAYORIENTATION) != 0 ? cur.Orientation : 0;
        uint dmdo = curDmdo;
        string on = Json.GetString(req, "orientation");
        if (on != null) {
          int o = OrientOf(on);
          if (o < 0) return C + " needs orientation: landscape, portrait, landscape-flipped or portrait-flipped";
          dmdo = (uint)o;
        }
        int curW = (int)(Tall(curDmdo) ? cur.Height : cur.Width), curH = (int)(Tall(curDmdo) ? cur.Width : cur.Height);
        uint bpp; string mr;
        List<int[]> modes = ModesOf(d.Gdi, out bpp, out mr);
        int chosen;
        string refuse = MatchMode(modes, (int)w, (int)h, hz, hzGiven, (int)cur.Frequency, out chosen);
        IDictionary before = Json.Obj("width", curW, "height", curH, "hz", (int)cur.Frequency, "orientation", OrientNames[Math.Min(curDmdo, 3u)]);
        bool same = refuse == null && curW == (int)w && curH == (int)h && chosen == (int)cur.Frequency && dmdo == curDmdo;
        Step apply = ModeStep(d.Key, d.Gdi, (int)w, (int)h, (uint)chosen, dmdo, cur.Bpp, 0);
        List<Step> revert = ModeRevert(d.Key, d.Gdi, curW, curH, cur.Frequency, curDmdo, cur.Bpp);
        if (refuse == null && !same) {
          Step test = ModeStep(d.Key, d.Gdi, (int)w, (int)h, (uint)chosen, dmdo, cur.Bpp, CDS_TEST);
          lock (_applyGate) refuse = RunStep(test);                        // CDS_TEST: changes nothing
        }
        if (dry) {
          IDictionary r = Dry(same || refuse != null ? new List<object>() : L(StepJson(apply)), before, refuse, false);
          r["changed"] = !same && refuse == null;
          r["revert"] = StepsJson(revert);
          r["keepWithinMs"] = keepMs;
          r["validatedBy"] = "ChangeDisplaySettingsEx CDS_TEST";
          result = r; return null;
        }
        if (Program.Passive) return Passive("changed a display to " + (int)w + " x " + (int)h + " at " + chosen + " Hz");
        if (refuse != null) return refuse;
        if (same) { result = Json.Obj("ok", true, "changed", false, "before", before); return null; }
        string busy = Busy(); if (busy != null) return busy;
        lock (_applyGate) {
          e = RunStep(apply);
          if (e != null) return "Windows refused the mode: " + e;
          DEVMODE now; string re = CurrentMode(d.Gdi, out now);
          bool tall = Tall(dmdo);
          bool ok = re == null && now.Width == (uint)(tall ? h : w) && now.Height == (uint)(tall ? w : h) && now.Frequency == (uint)chosen;
          if (!ok) {
            string back = RunAll(revert);
            if (back != null) RunStep(Simple("cds.reset", d.Key, d.Gdi));
            return "Windows accepted the mode but the display reads " + (re == null ? now.Width + " x " + now.Height + " at " + now.Frequency + " Hz" : "nothing") +
                   " straight after, so Mantle put it back";
          }
        }
        IDictionary change = Json.Obj("display", d.Key, "width", (int)w, "height", (int)h, "hz", chosen, "orientation", OrientNames[dmdo]);
        List<Step> keep = new List<Step> { ModeStep(d.Key, d.Gdi, (int)w, (int)h, (uint)chosen, dmdo, cur.Bpp, CDS_UPDATEREGISTRY) };
        List<Step> fallback = new List<Step> { Simple("cds.reset", d.Key, d.Gdi) };
        Pending p = Arm("mode", revert, fallback, keep, keepMs, change);
        result = Json.Obj("ok", true, "changed", true, "pending", true, "token", p.Token, "keepWithinMs", keepMs,
                          "before", before, "after", change, "revert", StepsJson(revert),
                          "note", "not saved yet: sysdisplay.keep saves it, otherwise it goes back in " + (keepMs / 1000) + " s");
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== sysdisplay.topology
    static string TopologyCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.topology";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        int keepMs; e = KeepArg(req, C, out keepMs); if (e != null) return e;
        string mode = Json.GetString(req, "mode");
        uint flag = TopoFlag(mode);
        if (flag == 0) return C + " needs mode: extend, clone, internal or external";
        Config db = Query(QDC_DATABASE_CURRENT);
        if (db.Err != 0) return "Windows did not report the current layout (error " + db.Err + ")";
        string cur = TopoName(db.Topology);
        Config snap = Query(QDC_ONLY_ACTIVE_PATHS);
        bool same = cur == mode;
        string refuse = same ? null : SdcWords(SetDisplayConfig(0, null, 0, null, SDC_VALIDATE | flag));   // validates only
        Step apply = TopoStep(mode, SDC_APPLY);
        List<Step> revert, fallback = null;
        if (cur != null) { revert = new List<Step> { TopoStep(cur, SDC_APPLY) }; if (snap.Err == 0) fallback = new List<Step> { SuppliedStep(snap) }; }
        else revert = new List<Step> { SuppliedStep(snap) };
        if (dry) {
          IDictionary r = Dry(same || refuse != null ? new List<object>() : L(StepJson(apply)), cur ?? "custom", refuse, false);
          r["changed"] = !same && refuse == null;
          r["revert"] = StepsJson(revert);
          r["keepWithinMs"] = keepMs;
          r["validatedBy"] = "SetDisplayConfig SDC_VALIDATE";
          result = r; return null;
        }
        if (Program.Passive) return Passive("switched the display layout to " + mode);
        if (refuse != null) return refuse;
        if (same) { result = Json.Obj("ok", true, "changed", false, "before", cur); return null; }
        string busy = Busy(); if (busy != null) return busy;
        lock (_applyGate) {
          e = RunStep(apply);
          if (e != null) return e;
          Config after = Query(QDC_DATABASE_CURRENT);
          if (after.Err != 0 || after.Topology != flag) {
            string back = RunAll(revert);
            if (back != null && fallback != null) RunAll(fallback);
            return "Windows accepted the layout but reports " + (after.Err != 0 ? "nothing" : (TopoName(after.Topology) ?? "a custom layout")) +
                   " straight after, so Mantle put it back";
          }
        }
        Pending p = Arm("topology", revert, fallback, new List<Step>(), keepMs, Json.Obj("topology", mode));
        result = Json.Obj("ok", true, "changed", true, "pending", true, "token", p.Token, "keepWithinMs", keepMs,
                          "before", cur ?? "custom", "after", mode, "revert", StepsJson(revert),
                          "note", "Windows saves a layout as it applies it; if it is not kept within " + (keepMs / 1000) + " s, Mantle switches back");
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== sysdisplay.primary / arrange
    static List<Rect> ActiveRects(List<Disp> ds) {
      var l = new List<Rect>();
      foreach (Disp d in ds) {
        if (!d.Active || !d.HasSource || d.Gdi == null) continue;
        bool dup = false;
        foreach (Rect r in l) if (r.Device == d.Gdi) dup = true;      // clone: one source, several targets
        if (dup) continue;
        var x = new Rect(); x.Key = d.Key; x.Device = d.Gdi; x.X = d.X; x.Y = d.Y; x.W = d.W; x.H = d.H; x.Primary = d.Primary;
        l.Add(x);
      }
      return l;
    }

    static IList RectsJson(List<Rect> rs) {
      var l = new List<object>();
      foreach (Rect r in rs) l.Add(Json.Obj("display", r.Key, "x", r.X, "y", r.Y, "width", r.W, "height", r.H, "primary", r.Primary));
      return l;
    }

    static string LayoutChange(string C, string kind, List<Rect> cur, List<Rect> plan, string planErr, bool dry, int keepMs, ref object result) {
      bool same = planErr == null && SameLayout(cur, plan);
      string refuse = planErr;
      if (refuse == null && !same)
        lock (_applyGate) refuse = RunAll(LayoutSteps(plan, CDS_TEST));   // CDS_TEST per display: changes nothing
      List<Step> apply = planErr == null ? LayoutSteps(plan, CDS_UPDATEREGISTRY | CDS_NORESET) : new List<Step>();
      List<Step> revert = LayoutSteps(cur, CDS_UPDATEREGISTRY | CDS_NORESET);
      Config snap = Query(QDC_ONLY_ACTIVE_PATHS);
      List<Step> fallback = snap.Err == 0 ? new List<Step> { SuppliedStep(snap) } : null;
      if (dry) {
        IDictionary r = Dry(same || refuse != null ? new List<object>() : StepsJson(apply), RectsJson(cur), refuse, false);
        r["changed"] = !same && refuse == null;
        r["after"] = planErr == null ? RectsJson(plan) : null;
        r["revert"] = StepsJson(revert);
        r["keepWithinMs"] = keepMs;
        r["validatedBy"] = "layout check (touching, no overlap) + ChangeDisplaySettingsEx CDS_TEST";
        result = r; return null;
      }
      if (Program.Passive) return Passive(kind == "primary" ? "changed the main display" : "moved the displays");
      if (refuse != null) return refuse;
      if (same) { result = Json.Obj("ok", true, "changed", false, "before", RectsJson(cur)); return null; }
      string busy = Busy(); if (busy != null) return busy;
      lock (_applyGate) {
        string e = RunAll(apply);
        if (e != null) { RunAll(revert); return "Windows refused the layout: " + e; }
        foreach (Rect r in plan) {
          DEVMODE now; string re = CurrentMode(r.Device, out now);
          if (re != null || now.PosX != r.X || now.PosY != r.Y) {
            string back = RunAll(revert);
            if (back != null && fallback != null) RunAll(fallback);
            return "Windows accepted the layout but a display reads a different position straight after, so Mantle put it back";
          }
        }
      }
      Pending p = Arm(kind, revert, fallback, new List<Step>(), keepMs, Json.Obj("layout", RectsJson(plan)));
      result = Json.Obj("ok", true, "changed", true, "pending", true, "token", p.Token, "keepWithinMs", keepMs,
                        "before", RectsJson(cur), "after", RectsJson(plan), "revert", StepsJson(revert),
                        "note", "saved as it applies; if it is not kept within " + (keepMs / 1000) + " s, Mantle puts the old layout back");
      return null;
    }

    static string PrimaryCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.primary";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        int keepMs; e = KeepArg(req, C, out keepMs); if (e != null) return e;
        Disp d; List<Disp> ds;
        e = FreshDisplay(req, C, true, out d, out ds); if (e != null) return e;
        List<Rect> cur = ActiveRects(ds), plan;
        string pe = PlanPrimary(cur, d.Key, out plan);
        return LayoutChange(C, "primary", cur, plan, pe, dry, keepMs, ref result);
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static string ArrangeCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.arrange";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        int keepMs; e = KeepArg(req, C, out keepMs); if (e != null) return e;
        List<Rect> want; e = RectsArg(req, "positions", C, out want); if (e != null) return e;
        string err, inactive;
        List<Disp> ds = ReadDisplays(out err, out inactive);
        if (ds == null) return err;
        List<Rect> cur = ActiveRects(ds), plan;
        string pe = PlanArrange(cur, want, out plan);
        return LayoutChange(C, "arrange", cur, plan, pe, dry, keepMs, ref result);
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    /// [{display, x, y, width?, height?, primary?}] -> Rects (width/height/primary only for decide's fakes).
    static string RectsArg(Dictionary<string, object> req, string key, string C, out List<Rect> rs) {
      rs = new List<Rect>();
      object o;
      if (!Json.TryGet(req, key, out o) || !(o is List<object>)) return C + " needs " + key + ": [{display, x, y}, ...]";
      foreach (object it in (List<object>)o) {
        var m = it as Dictionary<string, object>;
        if (m == null) return C + " needs " + key + ": [{display, x, y}, ...]";
        string k = Json.GetString(m, "display");
        if (string.IsNullOrEmpty(k)) return C + ": every entry in " + key + " needs display";
        double x, y;
        string e = Num(m, "x", C, -65536, 65536, true, out x); if (e != null) return e;
        e = Num(m, "y", C, -65536, 65536, true, out y); if (e != null) return e;
        var r = new Rect(); r.Key = k; r.Device = Json.GetString(m, "device") ?? k; r.X = (int)x; r.Y = (int)y;
        object v;
        if (Json.TryGet(m, "width", out v) && v is double) r.W = (int)(double)v;
        if (Json.TryGet(m, "height", out v) && v is double) r.H = (int)(double)v;
        r.Primary = Json.GetBool(m, "primary", false);
        rs.Add(r);
      }
      if (rs.Count > 16) return C + ": at most 16 displays";
      return null;
    }

    // ================================================================== sysdisplay.scale
    static string ScaleCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.scale";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        double pct; e = Num(req, "percent", C, 100, 500, true, out pct); if (e != null) return e;
        Disp d; List<Disp> ds;
        e = FreshDisplay(req, C, true, out d, out ds); if (e != null) return e;
        int mn, cu, mx, err;
        if (!DpiRead(d, out mn, out cu, out mx, out err)) return "Windows did not answer the scale read (error " + err + "), so nothing was changed";
        IDictionary info = ScaleInfo(mn, cu, mx);
        int rel;
        string refuse = ScaleRel(mn, mx, (int)pct, out rel);
        bool same = refuse == null && rel == cu;
        IDictionary write = Json.Obj("api", "DisplayConfigSetDeviceInfo", "type", SET_DPI_SCALE,
                                     "typeName", "set DPI scale (undocumented, used by SetDPI-style tools)",
                                     "display", d.Key, "scaleRel", rel, "percent", (int)pct);
        if (dry) {
          IDictionary r = Dry(same || refuse != null ? new List<object>() : L(write), info["percent"], refuse, false);
          r["changed"] = !same && refuse == null;
          r["validatedBy"] = "the allowed list Windows answered (type -3); Windows has no test-only call for scale";
          result = r; return null;
        }
        if (Program.Passive) return Passive("changed a display's scale to " + (int)pct + "%");
        if (refuse != null) return refuse;
        if (same) { result = Json.Obj("ok", true, "changed", false, "percent", (int)pct); return null; }
        lock (_applyGate) {
          int se = DevSet(SET_DPI_SCALE, d.SrcAdapter, d.SourceId, rel);
          if (se != 0) return "Windows refused the scale change (error " + se + ")";
          int mn2, cu2, mx2, err2;
          if (!DpiRead(d, out mn2, out cu2, out mx2, out err2)) return "the scale was set, but it could not be read back (error " + err2 + ")";
          if (-mn2 + cu2 != -mn + rel) {
            IDictionary now = ScaleInfo(mn2, cu2, mx2);
            return "the scale was set, but it reads " + now["percent"] + "% straight after";
          }
        }
        result = Json.Obj("ok", true, "changed", true, "percent", (int)pct, "before", info["percent"],
                          "signOutNeeded", false,
                          "note", "Windows applies this at once; apps that are not per-monitor DPI aware may look blurry or keep their old size until they are restarted");
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== sysdisplay.hdr
    static string HdrCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.hdr";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        bool on; e = BoolArg(req, "on", C, out on); if (e != null) return e;
        Disp d; List<Disp> ds;
        e = FreshDisplay(req, C, true, out d, out ds); if (e != null) return e;
        Color c = ReadColor(d);
        if (!c.Ok) return "Windows did not answer the HDR read (error " + c.Err + "), so nothing was changed";
        string refuse = null;
        if (on && !c.Supported) refuse = "this display does not report HDR support to Windows, so HDR cannot be turned on";
        else if (on && c.LimitedByPolicy) refuse = "Windows is limiting HDR on this display by policy (for example on battery power)";
        bool same = c.Enabled == on;
        int type = c.V2 ? SET_HDR_STATE : SET_ADVANCED_COLOR_STATE;
        IDictionary write = Json.Obj("api", "DisplayConfigSetDeviceInfo", "type", type,
                                     "typeName", c.V2 ? "DISPLAYCONFIG_SET_HDR_STATE" : "DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE",
                                     "display", d.Key, "value", on ? 1 : 0);
        if (dry) {
          IDictionary r = Dry(same || refuse != null ? new List<object>() : L(write), c.Enabled, refuse, false);
          r["changed"] = !same && refuse == null;
          result = r; return null;
        }
        if (Program.Passive) return Passive("turned HDR " + (on ? "on" : "off") + " for a display");
        if (refuse != null) return refuse;
        if (same) { result = Json.Obj("ok", true, "changed", false, "on", on); return null; }
        lock (_applyGate) {
          int se = DevSet(type, d.Adapter, d.TargetId, on ? 1 : 0);
          if (se != 0) return "Windows refused to turn HDR " + (on ? "on" : "off") + " (error " + se + ")";
        }
        Color back = ReadColor(d);
        if (!back.Ok || back.Enabled != on)
          return "Windows accepted the HDR switch, but it reads " + (back.Ok ? (back.Enabled ? "on" : "off") : "nothing") + " straight after";
        result = Json.Obj("ok", true, "changed", true, "on", on, "before", c.Enabled);
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== night light: strength + schedule
    // THE BLOB IS BOND COMPACT-BINARY v1 (Microsoft Bond: every field is a header byte - id in the top
    // 3 bits (6 = the id follows in one byte), type in the low 5 - then its value; a struct ends at
    // 0x00). Both night light blobs, as measured on Owen's machine 2026-09-28, decode that way exactly:
    //
    //   settings (43 bytes):  43 42 01 00  0a 02 01 00  2a 06 [d9 e5 eb cf 06]  2a 2b 0e 15 [21 bytes]  00 00 00
    //     "CB" v1 | field0 struct {bool true} | field1 struct { field0 uint64 = unix-seconds timestamp,
    //     field1 struct { field1 list<int8> of 21 = the INNER record } } | end
    //   inner (21 bytes):     43 42 01 00  ca 14 0e 15 00  ca 1e 0e 07 00  ca 32 00  ca 3c 00  00
    //     "CB" v1 | field20 struct {field0 int8 = 21} | field30 struct {field0 int8 = 7} | field50 {} | field60 {} | end
    //   (the state blob Display.cs switches has the same outer shape; its 0x13/0x15 is this list count.)
    //
    // MEANING: 20 = "set hours" start {0 hour, 1 minute}, 30 = its end, 50/60 = today's sunset/sunrise
    // (empty here: location is off). MEASURED here: fields 20/30 with an hour only, 50/60 empty.
    // NOT measured here (public reverse engineering of this blob, reported flagged `measured:false`):
    // field 0 bool = schedule on, field 10 bool (false) = sunset-to-sunrise, field 40 int16 (zigzag) =
    // colour temperature in kelvin (absent = Windows' default), and minute (sub-field 1).
    // WRITES are allowed only as an in-place change of the MEASURED layout: the set-hours start/end
    // hour (whole hours 1-23), plus the timestamp bump that makes Windows act (as Display.cs does).
    // Everything else - strength, schedule on/off/sunset, minutes, hour 0 - would add or drop a field
    // this machine has never shown, so it is refused with that reason and nothing is written.
    const string NightSettingsKey =
      @"Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\" +
      @"default$windows.data.bluelightreduction.settings\windows.data.bluelightreduction.settings";

    public sealed class BField { public int Id, Type; public long Value; public List<BField> Kids; }
    const int BT_STOP = 0, BT_BOOL = 2, BT_UINT64 = 6, BT_STRUCT = 10, BT_LIST = 11, BT_INT8 = 14, BT_INT16 = 15, BT_INT32 = 16;

    static bool ReadVarint(byte[] d, ref int at, int end, out long v) {
      v = 0;
      for (int i = 0; i < 10; i++) {
        if (at >= end) return false;
        byte b = d[at++];
        v |= (long)(b & 0x7f) << (7 * i);
        if ((b & 0x80) == 0) return true;
      }
      return false;
    }
    static void WriteVarint(List<byte> o, long v) {
      ulong u = (ulong)v;
      while (u >= 0x80) { o.Add((byte)(u | 0x80)); u >>= 7; }
      o.Add((byte)u);
    }

    /// Parses struct fields until STOP. null = fine; else what is wrong.
    static string ParseFields(byte[] d, ref int at, int end, List<BField> into, int depth) {
      if (depth > 4) return "the record nests too deep";
      while (true) {
        if (at >= end) return "the record ends without its end marker";
        byte h = d[at++];
        if (h == 0) return null;                                  // BT_STOP
        int type = h & 0x1f, id = h >> 5;
        if (id == 6) { if (at >= end) return "a field id is cut off"; id = d[at++]; }
        else if (id == 7) { if (at + 1 >= end) return "a field id is cut off"; id = d[at] | (d[at + 1] << 8); at += 2; }
        var f = new BField(); f.Id = id; f.Type = type;
        long v;
        switch (type) {
          case BT_BOOL: case BT_INT8:
            if (at >= end) return "a value is cut off";
            f.Value = type == BT_INT8 ? (long)(sbyte)d[at] : d[at]; at++; break;
          case BT_UINT64:
            if (!ReadVarint(d, ref at, end, out v)) return "a number is cut off"; f.Value = v; break;
          case BT_INT16: case BT_INT32:
            if (!ReadVarint(d, ref at, end, out v)) return "a number is cut off";
            f.Value = (long)((ulong)v >> 1) ^ -(v & 1); break;          // zigzag
          case BT_STRUCT:
            f.Kids = new List<BField>();
            string e = ParseFields(d, ref at, end, f.Kids, depth + 1);
            if (e != null) return e;
            break;
          default:
            return "field " + id + " has type " + type + ", which Mantle does not read";
        }
        into.Add(f);
      }
    }

    static void WriteFields(List<byte> o, List<BField> fs) {
      foreach (BField f in fs) {
        if (f.Id <= 5) o.Add((byte)((f.Id << 5) | f.Type));
        else if (f.Id <= 255) { o.Add((byte)((6 << 5) | f.Type)); o.Add((byte)f.Id); }
        else { o.Add((byte)((7 << 5) | f.Type)); o.Add((byte)(f.Id & 0xff)); o.Add((byte)(f.Id >> 8)); }
        switch (f.Type) {
          case BT_BOOL: case BT_INT8: o.Add((byte)f.Value); break;
          case BT_UINT64: WriteVarint(o, f.Value); break;
          case BT_INT16: case BT_INT32: WriteVarint(o, (f.Value << 1) ^ (f.Value >> 63)); break;
          case BT_STRUCT: WriteFields(o, f.Kids); break;
        }
      }
      o.Add(0);
    }

    static readonly byte[] OuterHead = { 0x43, 0x42, 0x01, 0x00, 0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06 };

    /// PURE. Splits the outer wrapper exactly as measured: head, 5-byte timestamp, 2a 2b 0e, count,
    /// inner bytes, 00 00 00. null = fine (ts, inner filled), else what differs.
    static string Outer(byte[] d, out long ts, out byte[] inner) {
      ts = 0; inner = null;
      if (d == null) return "no Data value";
      if (d.Length < 22) return d.Length + " bytes is too short";
      for (int i = 0; i < OuterHead.Length; i++) if (d[i] != OuterHead[i]) return "byte " + i + " of the header differs";
      for (int i = 10; i < 14; i++) if ((d[i] & 0x80) == 0) return "the timestamp is not a 5-byte number";
      if ((d[14] & 0x80) != 0) return "the timestamp is not a 5-byte number";
      int at = 10; ReadVarint(d, ref at, d.Length, out ts);
      if (d[15] != 0x2a || d[16] != 0x2b || d[17] != 0x0e) return "the inner record's tag differs";
      at = 18; long n;
      if (!ReadVarint(d, ref at, d.Length, out n) || at != 19) return "the inner record's length is not one byte";
      if (at + n + 3 != d.Length) return "the inner record's length (" + n + ") does not match the " + d.Length + " bytes";
      if (d[d.Length - 3] != 0 || d[d.Length - 2] != 0 || d[d.Length - 1] != 0) return "the record does not end the measured way";
      inner = new byte[n]; Array.Copy(d, at, inner, 0, (int)n);
      return null;
    }

    static byte[] Wrap(long ts, byte[] inner) {
      var o = new List<byte>(OuterHead);
      WriteVarint(o, ts);
      o.Add(0x2a); o.Add(0x2b); o.Add(0x0e);
      WriteVarint(o, inner.Length);
      o.AddRange(inner);
      o.Add(0); o.Add(0); o.Add(0);
      return o.ToArray();
    }

    sealed class Night {
      public long Ts; public List<BField> Fields; public string Layout;   // Layout: null = the measured one, else how it differs
      public byte[] Bytes;
    }

    /// PURE. Exact parse; the re-encoding must give back the very same bytes or it is refused.
    static string ParseNight(byte[] data, out Night n) {
      n = null;
      long ts; byte[] inner;
      string e = Outer(data, out ts, out inner);
      if (e != null) return e;
      if (inner.Length < 5 || inner[0] != 0x43 || inner[1] != 0x42 || inner[2] != 0x01 || inner[3] != 0x00) return "the inner record's header differs";
      int at = 4;
      var fs = new List<BField>();
      e = ParseFields(inner, ref at, inner.Length, fs, 0);
      if (e != null) return e;
      if (at != inner.Length) return "there are bytes after the inner record's end marker";
      byte[] again = EncodeNight(ts, fs);
      if (Hex(again) != Hex(data)) return "re-encoding the parsed record does not give back the same bytes";
      n = new Night(); n.Ts = ts; n.Fields = fs; n.Bytes = data; n.Layout = MeasuredLayout(fs);
      return null;
    }

    static byte[] EncodeNight(long ts, List<BField> fs) {
      var inner = new List<byte> { 0x43, 0x42, 0x01, 0x00 };
      WriteFields(inner, fs);
      return Wrap(ts, inner.ToArray());
    }

    /// null when `fs` is EXACTLY the layout measured on Owen's machine: 20{0 int8}, 30{0 int8},
    /// 50{}, 60{} in that order, hours 1-23. Else how it differs (writes are then refused).
    static string MeasuredLayout(List<BField> fs) {
      int[] ids = { 20, 30, 50, 60 };
      if (fs.Count != 4) return "it has " + fs.Count + " fields, not the 4 measured here";
      for (int i = 0; i < 4; i++) {
        BField f = fs[i];
        if (f.Id != ids[i] || f.Type != BT_STRUCT) return "field " + (i + 1) + " is " + f.Id + "/" + f.Type + ", not the measured " + ids[i];
        if (i < 2) {
          if (f.Kids.Count != 1 || f.Kids[0].Id != 0 || f.Kids[0].Type != BT_INT8) return "the set-hours " + (i == 0 ? "start" : "end") + " is not an hour alone (minutes or another field)";
          if (f.Kids[0].Value < 1 || f.Kids[0].Value > 23) return "the set-hours " + (i == 0 ? "start" : "end") + " hour is outside 1-23";
        } else if (f.Kids.Count != 0) return "the sunset/sunrise times are filled in (location is on), which was not measured here";
      }
      return null;
    }

    static BField Top(List<BField> fs, int id) { foreach (BField f in fs) if (f.Id == id) return f; return null; }
    static BField Kid(BField f, int id) { if (f == null || f.Kids == null) return null; foreach (BField k in f.Kids) if (k.Id == id) return k; return null; }

    static IDictionary TimeJson(BField f, bool measured) {
      if (f == null) return null;
      BField hh = Kid(f, 0), mm = Kid(f, 1);
      long h = hh == null ? 0 : hh.Value, m = mm == null ? 0 : mm.Value;
      bool empty = hh == null && mm == null;
      return Json.Obj("hour", empty ? null : (object)h, "minute", empty ? null : (object)m,
                      "text", empty ? null : h.ToString("00") + ":" + m.ToString("00"),
                      "measured", measured && mm == null);
    }

    /// Windows' Strength slider runs 0-100 over 6500 K (0) to 1200 K (100), 53 K a step
    /// (public reverse engineering; not measured here, since the field is absent on this machine).
    static int KelvinToPercent(long k) { return (int)Math.Max(0, Math.Min(100, Math.Round((6500.0 - k) / 53.0))); }

    static IDictionary NightJson(Night n) {
      BField sched = Top(n.Fields, 0), sunset = Top(n.Fields, 10), temp = Top(n.Fields, 40);
      bool schedOn = sched != null && sched.Type == BT_BOOL && sched.Value != 0;
      string schedule = !schedOn ? "off" : (sunset != null && sunset.Type == BT_BOOL && sunset.Value == 0 ? "sunset" : "hours");
      bool measured = n.Layout == null;
      var known = new HashSet<int> { 0, 10, 20, 30, 40, 50, 60 };
      var unknown = new List<object>();
      foreach (BField f in n.Fields) if (!known.Contains(f.Id)) unknown.Add(f.Id + "/" + f.Type);
      return Json.Obj(
        "schedule", Json.Obj("value", schedule, "measured", sched == null && sunset == null && measured,
                             "source", "field 0 (schedule on) and field 10 (sunset mode) of the settings blob",
                             "reason", sched == null && sunset == null
                               ? "the blob has no schedule field, which Bond reads as off"
                               : "read from fields this machine had not shown when Mantle's reader was measured (2026-09-28)"),
        "from", TimeJson(Top(n.Fields, 20), measured), "to", TimeJson(Top(n.Fields, 30), measured),
        "sunset", TimeJson(Top(n.Fields, 50), measured), "sunrise", TimeJson(Top(n.Fields, 60), measured),
        "strength", temp != null
          ? Json.Obj("percent", KelvinToPercent(temp.Value), "kelvin", temp.Value, "measured", false,
                     "source", "field 40 (colour temperature, kelvin)", "reason", "read from a field not measured on this machine; the percent mapping is public reverse engineering")
          : Json.Obj("percent", null, "kelvin", null, "measured", true, "source", "field 40 (absent)",
                     "reason", "the settings hold no strength, so Windows uses its default (the field appears once the Strength slider is moved)"),
        "unknownFields", unknown,
        "layout", measured ? "measured" : "unmeasured", "layoutReason", n.Layout,
        "updated", n.Ts);
    }

    public sealed class NightChange { public int From = -1, To = -1, FromMin = -1, ToMin = -1, Strength = -1; public string Schedule; }

    /// PURE. The bytes a change would write, or why it is refused. Only the measured layout is
    /// written, only its start/end hour changes, and the timestamp becomes max(now, old + 1).
    static string PlanNight(Night n, NightChange ch, long now, out byte[] next, out bool changed) {
      next = null; changed = false;
      if (ch.Strength >= 0)
        return n.Layout == null
          ? "strength is not stored in the night light settings on this machine (Windows keeps its default and writes a strength field only once its slider is moved); adding that field is a layout Mantle has not measured here, so nothing was written"
          : "the night light settings are not in the layout Mantle measured here (" + n.Layout + "), so nothing was written";
      if (ch.FromMin > 0 || ch.ToMin > 0)
        return "minutes are stored in a field this machine's night light settings have never contained, so only whole hours can be set; nothing was written";
      if ((ch.From == 0) || (ch.To == 0))
        return "midnight (hour 0) is stored by leaving the hour field out, a layout not measured here; pick 1-23, nothing was written";
      BField sched = Top(n.Fields, 0), sunset = Top(n.Fields, 10);
      bool schedOn = sched != null && sched.Value != 0;
      string curSched = !schedOn ? "off" : (sunset != null && sunset.Value == 0 ? "sunset" : "hours");
      if (ch.Schedule != null && ch.Schedule != curSched)
        return "turning the schedule " + (ch.Schedule == "off" ? "off" : "on (" + ch.Schedule + ")") +
               " adds or removes a field this machine's night light settings have not shown, a layout Mantle has not measured here, so nothing was written";
      if (n.Layout != null)
        return "the night light settings are not in the layout Mantle measured here (" + n.Layout + "), so nothing was written";
      var fs = new List<BField>();
      foreach (BField f in n.Fields) fs.Add(Clone(f));
      BField fh = Kid(Top(fs, 20), 0), th = Kid(Top(fs, 30), 0);
      if (ch.From > 0 && fh.Value != ch.From) { fh.Value = ch.From; changed = true; }
      if (ch.To > 0 && th.Value != ch.To) { th.Value = ch.To; changed = true; }
      if (!changed) return null;
      long ts = Math.Max(now, n.Ts + 1);
      if (ts < (1L << 28) || ts >= (1L << 35)) return "the clock (" + ts + ") does not fit the 5-byte timestamp, so nothing was written";
      next = EncodeNight(ts, fs);
      if (next.Length != n.Bytes.Length) { next = null; return "the new record would change size, which the measured layout never does; nothing was written"; }
      Night check;
      string e = ParseNight(next, out check);
      if (e != null || check.Layout != null) { next = null; return "the new record did not parse back as the measured layout; nothing was written"; }
      return null;
    }

    static BField Clone(BField f) {
      var c = new BField(); c.Id = f.Id; c.Type = f.Type; c.Value = f.Value;
      if (f.Kids != null) { c.Kids = new List<BField>(); foreach (BField k in f.Kids) c.Kids.Add(Clone(k)); }
      return c;
    }

    static byte[] ReadNightBytes(out string why) {
      why = null;
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(NightSettingsKey)) {
          if (k == null) { why = "Windows has no night light settings yet (night light has never been set up here)"; return null; }
          var b = k.GetValue("Data") as byte[];
          if (b == null) why = "the night light settings have no Data value";
          return b;
        }
      } catch (Exception ex) { why = "the night light settings could not be read: " + Why(ex); return null; }
    }

    static string NightCmd(Dictionary<string, object> req, ref object result) {
      try {
        IDictionary st = Display.NightLight();
        string why;
        byte[] b = ReadNightBytes(out why);
        IDictionary r;
        if (b == null) r = Json.Obj("ok", true, "present", false, "reason", why);
        else {
          Night n;
          string e = ParseNight(b, out n);
          if (e != null) r = Json.Obj("ok", true, "present", true, "settingsBytes", Hex(b), "roundTrip", false,
                                      "reason", "the night light settings are not in a layout Mantle can read (" + e + "), so strength and schedule are unknown");
          else {
            r = NightJson(n);
            r["ok"] = true; r["present"] = true; r["settingsBytes"] = Hex(b); r["roundTrip"] = true; r["reason"] = null;
            r["writable"] = Json.Obj("hours", n.Layout == null, "strength", false, "schedule", false,
                                     "why", n.Layout == null
                                       ? "only the set-hours start/end (whole hours) are in the layout measured here; strength and schedule would add fields not measured on this machine"
                                       : "the layout is not the one measured here (" + n.Layout + ")");
          }
        }
        r["on"] = st["on"]; r["onReason"] = st["reason"];
        r["source"] = @"HKCU\...\CloudStore\...\windows.data.bluelightreduction.settings (undocumented; exact parse)";
        result = r;
        return null;
      } catch (Exception ex) { return "sysdisplay.nightlight failed: " + Why(ex); }
    }

    static string NightChangeArg(Dictionary<string, object> req, string C, out NightChange ch) {
      ch = new NightChange();
      double v; string e;
      if (Json.HasKey(req, "strength")) { e = Num(req, "strength", C, 0, 100, true, out v); if (e != null) return e; ch.Strength = (int)v; }
      if (Json.HasKey(req, "schedule")) {
        string s = Json.GetString(req, "schedule");
        if (s != "off" && s != "sunset" && s != "hours") return C + " needs schedule: off, sunset or hours";
        ch.Schedule = s;
      }
      foreach (string k in new[] { "from", "to" }) {
        if (!Json.HasKey(req, k)) continue;
        string t = Json.GetString(req, k);
        int hh, mm;
        if (!HourMin(t, out hh, out mm)) return C + " needs " + k + ": \"HH:MM\" (24-hour)";
        if (k == "from") { ch.From = hh; ch.FromMin = mm; } else { ch.To = hh; ch.ToMin = mm; }
      }
      if (ch.Strength < 0 && ch.Schedule == null && ch.From < 0 && ch.To < 0) return C + " needs at least one of from, to, strength, schedule";
      return null;
    }

    static bool HourMin(string t, out int h, out int m) {
      h = m = 0;
      if (t == null) return false;
      string[] p = t.Split(':');
      if (p.Length != 2) return false;
      return int.TryParse(p[0], NumberStyles.None, CultureInfo.InvariantCulture, out h) && h >= 0 && h <= 23 &&
             int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out m) && m >= 0 && m <= 59 && p[1].Length == 2;
    }

    static long UnixNow() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds; }

    static string NightSetCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.nightlightSet";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        NightChange ch; e = NightChangeArg(req, C, out ch); if (e != null) return e;
        string why;
        byte[] b = ReadNightBytes(out why);
        if (b == null) return why + ", so nothing was written";
        Night n;
        e = ParseNight(b, out n);
        string refuse; byte[] next = null; bool changed = false;
        if (e != null) refuse = "the night light settings are not in a layout Mantle can read (" + e + "), so nothing was written";
        else refuse = PlanNight(n, ch, UnixNow(), out next, out changed);
        IDictionary write = next == null ? null
          : Json.Obj("api", "registry", "hive", "HKCU", "key", NightSettingsKey, "name", "Data", "type", "REG_BINARY",
                     "bytes", Hex(next), "before", Hex(b));
        if (dry) {
          IDictionary r = Dry(write == null ? new List<object>() : L(write), Hex(b), refuse, false);
          r["changed"] = changed && refuse == null;
          result = r; return null;
        }
        if (Program.Passive) return Passive("changed the night light schedule hours");
        if (refuse != null) return refuse;
        if (!changed) { result = Json.Obj("ok", true, "changed", false); return null; }
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(NightSettingsKey, true)) {
          if (k == null) return "the night light settings went away before the write, so nothing was written";
          var now = k.GetValue("Data") as byte[];
          if (now == null || Hex(now) != Hex(b)) return "Windows changed the night light settings meanwhile, so nothing was written; try again";
          k.SetValue("Data", next, RegistryValueKind.Binary);
        }
        byte[] back = ReadNightBytes(out why);
        if (back == null || Hex(back) != Hex(next)) return "the night light settings were written, but read back different straight after";
        Night nn; ParseNight(back, out nn);
        result = Json.Obj("ok", true, "changed", true, "after", nn == null ? null : NightJson(nn));
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    // ================================================================== Graphics (per-app GPU, global switches, HAGS)
    const string GpuPrefKey = @"Software\Microsoft\DirectX\UserGpuPreferences";
    const string GlobalValue = "DirectXUserGlobalSettings";
    static readonly string[] GlobalKeys = { "SwapEffectUpgradeEnable", "VRROptimizeEnable", "AutoHDREnable" };
    static readonly string[] GlobalWords = { "optimizations for windowed games", "variable refresh rate", "Auto HDR" };
    const string GfxKey = @"SYSTEM\CurrentControlSet\Control\GraphicsDrivers";
    static readonly string[] PrefNames = { "auto", "power-saving", "high-performance" };

    /// PURE. The value of `key` in "k=v;k=v;" data, or null.
    public static string GetField(string data, string key) {
      if (data == null) return null;
      foreach (string seg in data.Split(';')) {
        int eq = seg.IndexOf('=');
        if (eq > 0 && string.Equals(seg.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase)) return seg.Substring(eq + 1);
      }
      return null;
    }

    /// PURE. `data` with `key` set to `value`: an existing key keeps its spelling and position and
    /// every other field stays byte for byte; a missing key is appended as "key=value;".
    public static string SetField(string data, string key, string value) {
      if (data == null) data = "";
      string[] segs = data.Split(';');
      bool hit = false;
      for (int i = 0; i < segs.Length; i++) {
        int eq = segs[i].IndexOf('=');
        if (eq > 0 && string.Equals(segs[i].Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase)) {
          segs[i] = segs[i].Substring(0, eq + 1) + value; hit = true;
        }
      }
      if (hit) return string.Join(";", segs);
      string pre = data.Length == 0 || data.EndsWith(";") ? data : data + ";";
      return pre + key + "=" + value + ";";
    }

    static IDictionary ReadPrefValues(out string why) {
      why = null;
      var d = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(GpuPrefKey)) {
          if (k == null) { why = "no graphics preferences are set yet (Windows decides for every app)"; return d; }
          foreach (string n in k.GetValueNames()) {
            var s = k.GetValue(n) as string;
            if (s != null) d[n] = s;
          }
        }
      } catch (Exception ex) { why = "the graphics preferences could not be read: " + Why(ex); }
      return d;
    }

    static long? HagsReg(out string why) {
      why = null;
      try {
        using (RegistryKey b = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey k = b.OpenSubKey(GfxKey, false)) {
          if (k == null) { why = "the graphics drivers key is missing"; return null; }
          object v = k.GetValue("HwSchMode");
          if (v == null) { why = "not set: the driver's default applies"; return null; }
          if (v is int) return (long)(uint)(int)v;
          why = "HwSchMode is not a number"; return null;
        }
      } catch (Exception ex) { why = "could not be read: " + Why(ex); return null; }
    }

    static IDictionary HagsJson(List<Gpu> gs) {
      string why;
      long? reg = HagsReg(out why);
      bool anyCaps = false, supported = false, enabled = false, byDefault = false;
      foreach (Gpu g in gs) if (g.CapsOk && !g.Software) { anyCaps = true; supported |= g.HwSupported; enabled |= g.HwEnabled; byDefault |= g.HwDefault; }
      object setting = reg == 2 ? (object)true : (reg == 1 ? (object)false : (anyCaps ? (object)byDefault : null));
      // Only meaningful where a driver supports it: Owen's registry says 2 (on) while his only
      // hardware adapter answers 2.7=0x0 / 2.9=0x0 (measured 2026-09-28), i.e. the value is inert.
      bool restart = anyCaps && supported && setting is bool && (bool)setting != enabled;
      return Json.Obj("on", setting, "registry", reg, "registryReason", why,
                      "supported", anyCaps ? (object)supported : null, "enabledNow", anyCaps ? (object)enabled : null,
                      "restartPending", restart,
                      "source", @"HKLM\" + GfxKey + " HwSchMode (2 on, 1 off) + D3DKMT WDDM_2_7_CAPS",
                      "writable", anyCaps && supported, "needsAdmin", true, "elevate", "sysdisplay.gpuScheduling",
                      "reason", !anyCaps ? "no graphics driver here answers the GPU scheduling capability query"
                               : (!supported ? "no graphics adapter here supports hardware-accelerated GPU scheduling" : null));
    }

    static string GpuPrefsCmd(Dictionary<string, object> req, ref object result) {
      try {
        string why;
        IDictionary vals = ReadPrefValues(out why);
        var apps = new List<object>();
        string global = null;
        foreach (DictionaryEntry kv in vals) {
          string name = (string)kv.Key, data = (string)kv.Value;
          if (string.Equals(name, GlobalValue, StringComparison.OrdinalIgnoreCase)) { global = data; continue; }
          string p = GetField(data, "GpuPreference");
          int pi;
          bool okp = p != null && int.TryParse(p, NumberStyles.None, CultureInfo.InvariantCulture, out pi) && pi >= 0 && pi <= 2;
          int pref = okp ? int.Parse(p, CultureInfo.InvariantCulture) : -1;
          apps.Add(Json.Obj("app", name, "pref", okp ? (object)pref : null, "prefName", okp ? PrefNames[pref] : null,
                            "raw", data, "reason", okp ? null : "this entry has no GpuPreference Mantle can read"));
        }
        var g = Json.Obj("raw", global);
        for (int i = 0; i < GlobalKeys.Length; i++) {
          string v = GetField(global, GlobalKeys[i]);
          g[GlobalKeys[i]] = Json.Obj("on", v == "1" ? (object)true : (v == "0" ? (object)false : null), "words", GlobalWords[i],
                                      "reason", v == null ? "not set: Windows' default applies" : (v == "1" || v == "0" ? null : "not 0 or 1"));
        }
        string gw;
        List<Gpu> gs = ReadGpus(out gw);
        result = Json.Obj("ok", true, "apps", apps, "appsReason", why, "global", g,
                          "gpuScheduling", HagsJson(gs), "gpus", GpusJson(gs), "gpusReason", gw,
                          "source", @"HKCU\" + GpuPrefKey);
        return null;
      } catch (Exception ex) { return "sysdisplay.gpuPrefs failed: " + Why(ex); }
    }

    /// Writes ONE REG_SZ under UserGpuPreferences and reads it back. null = done.
    static string WritePref(string name, string data) {
      try {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(GpuPrefKey, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
          if (k == null) return "the graphics preferences key could not be opened for writing";
          k.SetValue(name, data, RegistryValueKind.String);
          var back = k.GetValue(name) as string;
          if (back != data) return "the preference was written but reads back different (another program may have changed it)";
        }
        return null;
      } catch (Exception ex) { return "Windows refused the write: " + Why(ex); }
    }

    static string GpuPrefSetCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.gpuPrefSet";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        double pv; e = Num(req, "pref", C, 0, 2, true, out pv); if (e != null) return e;
        string app = Json.GetString(req, "app");
        if (string.IsNullOrEmpty(app) || app.Length > 1024) return C + " needs app: an entry from sysdisplay.gpuPrefs, or the full path of an .exe";
        if (string.Equals(app, GlobalValue, StringComparison.OrdinalIgnoreCase)) return "that is Windows' global graphics settings, not an app (use sysdisplay.gpuGlobalSet)";
        string why;
        IDictionary vals = ReadPrefValues(out why);
        string name = null, before = null;
        foreach (DictionaryEntry kv in vals) if (string.Equals((string)kv.Key, app, StringComparison.OrdinalIgnoreCase)) { name = (string)kv.Key; before = (string)kv.Value; }
        if (name == null) {
          bool exe = app.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && Path.IsPathRooted(app) &&
                     app.IndexOfAny(Path.GetInvalidPathChars()) < 0 && File.Exists(app);
          if (!exe) return "that app is not in the list and is not the full path of an .exe that exists here";
          name = app;
        }
        string data = SetField(before, "GpuPreference", ((int)pv).ToString(CultureInfo.InvariantCulture));
        bool same = before == data;
        IDictionary write = Json.Obj("api", "registry", "hive", "HKCU", "key", GpuPrefKey, "name", name, "type", "REG_SZ",
                                     "value", data, "before", before);
        if (dry) {
          IDictionary r = Dry(same ? new List<object>() : L(write), before, null, false);
          r["changed"] = !same;
          result = r; return null;
        }
        if (Program.Passive) return Passive("set an app's graphics preference to " + PrefNames[(int)pv]);
        if (same) { result = Json.Obj("ok", true, "changed", false, "pref", (int)pv); return null; }
        e = WritePref(name, data);
        if (e != null) return e;
        result = Json.Obj("ok", true, "changed", true, "pref", (int)pv, "prefName", PrefNames[(int)pv], "raw", data,
                          "note", "the app picks it up the next time it starts");
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static string GpuGlobalSetCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.gpuGlobalSet";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        bool on; e = BoolArg(req, "on", C, out on); if (e != null) return e;
        string key = Json.GetString(req, "key");
        int ix = key == null ? -1 : Array.IndexOf(GlobalKeys, key);
        if (ix < 0) return C + " needs key: SwapEffectUpgradeEnable, VRROptimizeEnable or AutoHDREnable";
        string why;
        IDictionary vals = ReadPrefValues(out why);
        string before = null;
        foreach (DictionaryEntry kv in vals) if (string.Equals((string)kv.Key, GlobalValue, StringComparison.OrdinalIgnoreCase)) before = (string)kv.Value;
        string data = SetField(before, key, on ? "1" : "0");
        bool same = before == data;
        IDictionary write = Json.Obj("api", "registry", "hive", "HKCU", "key", GpuPrefKey, "name", GlobalValue, "type", "REG_SZ",
                                     "value", data, "before", before);
        if (dry) {
          IDictionary r = Dry(same ? new List<object>() : L(write), before, null, false);
          r["changed"] = !same;
          result = r; return null;
        }
        if (Program.Passive) return Passive("turned " + GlobalWords[ix] + " " + (on ? "on" : "off"));
        if (same) { result = Json.Obj("ok", true, "changed", false, "on", on); return null; }
        e = WritePref(GlobalValue, data);
        if (e != null) return e;
        result = Json.Obj("ok", true, "changed", true, "on", on, "raw", data, "note", "games pick it up the next time they start");
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    static IDictionary HagsWrite(bool on, long? before) {
      return Json.Obj("api", "registry", "hive", "HKLM", "key", GfxKey, "name", "HwSchMode", "type", "REG_DWORD",
                      "value", on ? 2 : 1, "before", before);
    }

    static string HagsSetCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.gpuSchedulingSet";
      try {
        bool dry; string e = DryArg(req, C, out dry); if (e != null) return e;
        bool on; e = BoolArg(req, "on", C, out on); if (e != null) return e;
        string why, gw;
        long? before = HagsReg(out why);
        List<Gpu> gs = ReadGpus(out gw);
        IDictionary h = HagsJson(gs);
        string refuse = h["reason"] as string;
        if (!on) refuse = null;                                   // turning it off is always allowed
        bool same = before == (on ? 2 : 1);
        bool admin = !IsAdmin();
        IDictionary write = HagsWrite(on, before);
        if (dry) {
          IDictionary r = Dry(same || refuse != null ? new List<object>() : L(write), before, refuse, admin && !same);
          r["changed"] = !same && refuse == null;
          r["elevate"] = "sysdisplay.gpuScheduling";
          r["restartNeeded"] = true;
          result = r; return null;
        }
        if (Program.Passive) return Passive("turned hardware-accelerated GPU scheduling " + (on ? "on" : "off"));
        if (refuse != null) return refuse;
        if (same) { result = Json.Obj("ok", true, "changed", false, "on", on); return null; }
        if (admin) {
          result = Json.Obj("ok", false, "needsAdmin", true, "elevate", "sysdisplay.gpuScheduling", "args", Json.Obj("on", on),
                            "writes", L(write),
                            "reason", "Windows will ask for administrator permission to turn hardware-accelerated GPU scheduling on or off");
          return null;
        }
        object r2 = null;
        var args = new Dictionary<string, object>(StringComparer.Ordinal); args["on"] = on;
        e = GpuSchedulingAction(args, ref r2);
        if (e != null) return e;
        result = r2;
        return null;
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }

    /// The elevated write (sidecar/ELEVATE.md): runs in the elevated copy after CheckGpuScheduling.
    /// Registry API only - no shell, nothing from args but the validated bool.
    [Elevated("sysdisplay.gpuScheduling", "CheckGpuScheduling", "turn hardware-accelerated GPU scheduling on or off")]
    static string GpuSchedulingAction(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      int want = on ? 2 : 1;
      string why;
      long? before = HagsReg(out why);
      try {
        using (RegistryKey b = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey k = b.OpenSubKey(GfxKey, true)) {
          if (k == null) return "Windows has no graphics drivers key to write, so nothing was changed";
          k.SetValue("HwSchMode", want, RegistryValueKind.DWord);
        }
      } catch (Exception ex) { return "Windows refused the change: " + Why(ex); }
      long? back = HagsReg(out why);
      if (back != want) return "the setting was written but reads back " + (back == null ? "missing" : back.ToString());
      result = Json.Obj("on", on, "before", before, "restartNeeded", true,
                        "note", "hardware-accelerated GPU scheduling changes after a restart");
      return null;
    }

    static string CheckGpuScheduling(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "on");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("on", out v) || !(v is bool)) return "on must be true or false";
      return null;
    }

    // ================================================================== sysdisplay.decide (PURE)
    // {what:'mode', modes:[[w,h,hz]...], width, height, hz?, currentHz?}
    // {what:'arrange', displays:[{display,x,y,width,height,primary}], positions:[{display,x,y}]}
    // {what:'primary', displays:[...], display}
    // {what:'scale', min, current, max, percent?}
    // {what:'revert', kind:'mode', display, device, width, height, hz, orientation, bpp}
    //                 {kind:'arrange'|'primary', displays:[...]}  {kind:'topology', topology}
    // {what:'night', bytes:hex, set?:{from,to,strength,schedule}, now?:unixSeconds}
    // {what:'field', data, key, value?}
    static string DecideCmd(Dictionary<string, object> req, ref object result) {
      const string C = "sysdisplay.decide";
      try {
        string what = Json.GetString(req, "what");
        string e;
        switch (what) {
          case "mode": {
            object o;
            if (!Json.TryGet(req, "modes", out o) || !(o is List<object>)) return C + " mode needs modes: [[width, height, hz], ...]";
            var modes = new List<int[]>();
            foreach (object m in (List<object>)o) {
              var a = m as List<object>;
              if (a == null || a.Count != 3 || !(a[0] is double) || !(a[1] is double) || !(a[2] is double)) return C + " mode: each mode is [width, height, hz]";
              modes.Add(new int[] { (int)(double)a[0], (int)(double)a[1], (int)(double)a[2] });
            }
            double w, h, hz = 0;
            e = Num(req, "width", C, 1, 65535, true, out w); if (e != null) return e;
            e = Num(req, "height", C, 1, 65535, true, out h); if (e != null) return e;
            bool given = Json.HasKey(req, "hz");
            if (given) { e = Num(req, "hz", C, 1, 1000, false, out hz); if (e != null) return e; }
            int chosen;
            string refuse = MatchMode(modes, (int)w, (int)h, hz, given, Json.GetInt(req, "currentHz", 0), out chosen);
            result = Json.Obj("ok", refuse == null, "hz", refuse == null ? (object)chosen : null, "reason", refuse);
            return null;
          }
          case "arrange": case "primary": {
            List<Rect> cur; e = RectsArg(req, "displays", C, out cur); if (e != null) return e;
            List<Rect> plan; string pe;
            if (what == "arrange") { List<Rect> want; e = RectsArg(req, "positions", C, out want); if (e != null) return e; pe = PlanArrange(cur, want, out plan); }
            else pe = PlanPrimary(cur, Json.GetString(req, "display"), out plan);
            result = Json.Obj("ok", pe == null, "reason", pe, "changed", pe == null && !SameLayout(cur, plan),
                              "layout", pe == null ? RectsJson(plan) : null,
                              "writes", pe == null ? LayoutStepsJson(plan) : null,
                              "revert", LayoutStepsJson(cur));
            return null;
          }
          case "scale": {
            int mn = Json.GetInt(req, "min", 0), cu = Json.GetInt(req, "current", 0), mx = Json.GetInt(req, "max", 0);
            IDictionary r = ScaleInfo(mn, cu, mx);
            if (Json.HasKey(req, "percent")) {
              int rel; string se = ScaleRel(mn, mx, Json.GetInt(req, "percent", 0), out rel);
              r["scaleRel"] = se == null ? (object)rel : null; r["refuse"] = se;
            }
            r["ok"] = true;
            result = r; return null;
          }
          case "revert": {
            string kind = Json.GetString(req, "kind");
            List<Step> steps;
            if (kind == "mode") {
              int o = OrientOf(Json.GetString(req, "orientation") ?? "landscape");
              if (o < 0) return C + " revert: orientation is landscape, portrait, landscape-flipped or portrait-flipped";
              steps = ModeRevert(Json.GetString(req, "display"), Json.GetString(req, "device"), Json.GetInt(req, "width", 0),
                                 Json.GetInt(req, "height", 0), (uint)Json.GetInt(req, "hz", 0), (uint)o, (uint)Json.GetInt(req, "bpp", 32));
            } else if (kind == "arrange" || kind == "primary") {
              List<Rect> cur; e = RectsArg(req, "displays", C, out cur); if (e != null) return e;
              steps = LayoutSteps(cur, CDS_UPDATEREGISTRY | CDS_NORESET);
            } else if (kind == "topology") {
              string t = Json.GetString(req, "topology");
              if (TopoFlag(t) == 0) return C + " revert: topology is internal, clone, extend or external";
              steps = new List<Step> { TopoStep(t, SDC_APPLY) };
            } else return C + " revert needs kind: mode, arrange, primary or topology";
            result = Json.Obj("ok", true, "revert", StepsJson(steps));
            return null;
          }
          case "night": {
            byte[] b = Unhex(Json.GetString(req, "bytes"));
            if (b == null) return C + " night needs bytes: the blob as hex";
            Night n;
            string pe = ParseNight(b, out n);
            if (pe != null) { result = Json.Obj("ok", false, "reason", pe); return null; }
            IDictionary r = NightJson(n);
            r["ok"] = true; r["roundTrip"] = Hex(EncodeNight(n.Ts, n.Fields)) == Hex(b);
            object so;
            if (Json.TryGet(req, "set", out so) && so is Dictionary<string, object>) {
              NightChange ch; e = NightChangeArg((Dictionary<string, object>)so, C, out ch); if (e != null) return e;
              double now = UnixNow();
              if (Json.HasKey(req, "now")) { e = Num(req, "now", C, 0, 34359738367.0, true, out now); if (e != null) return e; }
              byte[] next; bool changed;
              string refuse = PlanNight(n, ch, (long)now, out next, out changed);
              r["refuse"] = refuse; r["changed"] = changed && refuse == null; r["next"] = Hex(next);
              if (next != null) { Night nn; ParseNight(next, out nn); r["nextParsed"] = nn == null ? null : NightJson(nn); }
            }
            result = r; return null;
          }
          case "field": {
            string data = Json.GetString(req, "data"), key = Json.GetString(req, "key");
            if (string.IsNullOrEmpty(key)) return C + " field needs key";
            string val = Json.GetString(req, "value");
            result = Json.Obj("ok", true, "get", GetField(data, key), "set", val == null ? null : SetField(data, key, val));
            return null;
          }
        }
        return C + " needs what: mode, arrange, primary, scale, revert, night or field";
      } catch (Exception ex) { return C + " failed: " + Why(ex); }
    }
  }
}
