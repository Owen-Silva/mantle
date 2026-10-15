// AppPowerGpu.cs - the graphics half of App power (sidecar/AppPower.cs; lane mantle-power-sidecar,
// 2026-10-14): how many real GPUs this PC has, whether Windows lets Mantle lower a process's graphics
// priority, and Windows' own per-app GPU choice (Settings > System > Display > Graphics).
//
// GPUS: DXGI's adapter list without the software ones (Microsoft Basic Render Driver, vendor 0x1414)
// and remote ones. This PC (2026-10-14): one Intel UHD, so gpus = 1 and the graphics preference row
// stays hidden (it only means something with 2+ GPUs).
//
// GRAPHICS PREFERENCE: HKCU\Software\Microsoft\DirectX\UserGpuPreferences, value <full exe path> =
// "GpuPreference=1;" (power saving) / "GpuPreference=2;" (high performance) / no GpuPreference
// (Windows decides). Windows keeps other settings in the same string (SwapEffectUpgradeEnable=1;):
// only GpuPreference is changed, and the value is deleted only when nothing else is left in it.
// MANTLE_APPPOWER_TEST_REGROOT (a key under HKCU\Software\Mantle-test) replaces the real key for tests.
//
// C# 5 (see build.ps1).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  static partial class AppPower {
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
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IDXGIFactory1 factory);

    static readonly object _capsLock = new object();
    static int _gpus = -1; static int _gpusAt; static string _gpusWhy;
    static int _gpuLowState = -1;   // -1 not probed, 0 no, 1 yes
    static string _gpuLowWhy;
    static string _gpuLowCode;   // the NTSTATUS behind _gpuLowWhy, for Mantle's log only (never on screen)

    static int CountGpus(out string why) {
      why = null;
      lock (_capsLock) {
        if (_gpus >= 0 && unchecked(Environment.TickCount - _gpusAt) < 60000) { why = _gpusWhy; return _gpus; }
        int n = 0;
        IDXGIFactory1 f = null;
        try {
          Guid iid = typeof(IDXGIFactory1).GUID;
          int hr = CreateDXGIFactory1(ref iid, out f);
          if (hr != 0 || f == null) { why = "Windows did not list the graphics adapters (0x" + hr.ToString("X8") + ")"; }
          else {
            for (uint i = 0; i < 16; i++) {
              IDXGIAdapter1 a;
              if (f.EnumAdapters1(i, out a) != 0 || a == null) break;   // DXGI_ERROR_NOT_FOUND ends the list
              try {
                DXGI_ADAPTER_DESC1 d;
                if (a.GetDesc1(out d) == 0 && (d.Flags & 0x3) == 0 && d.VendorId != 0x1414) n++;   // not SOFTWARE / REMOTE / Microsoft's
              } finally { Marshal.ReleaseComObject(a); }
            }
          }
        } catch (Exception ex) {
          why = "Windows did not list the graphics adapters (" + ex.GetType().Name + ")";
        } finally { if (f != null) Marshal.ReleaseComObject(f); }
        _gpus = n; _gpusAt = Environment.TickCount; _gpusWhy = why;
        return n;
      }
    }

    /// Whether this sidecar, as a normal user, may change a process's graphics priority. Probed once,
    /// on itself, with the value it already has (nothing changes); sidecar/test-apppower.js then
    /// lowers a throwaway process for real and reads it back.
    internal static bool GpuLowWorks() {
      lock (_capsLock) {
        if (_gpuLowState >= 0) return _gpuLowState == 1;
        int cur;
        IntPtr me = N.GetCurrentProcess();
        int rc = N.D3DKMTGetProcessSchedulingPriorityClass(me, out cur);
        if (rc == 0) rc = N.D3DKMTSetProcessSchedulingPriorityClass(me, cur);
        if (rc == 0) { _gpuLowState = 1; _gpuLowWhy = null; _gpuLowCode = null; }
        else {
          _gpuLowState = 0;
          uint st = unchecked((uint)rc);
          _gpuLowWhy = st == 0xC0000061 || st == 0xC0000022 || st == 0xC0000005
            ? "Windows only lets administrators change graphics priority"
            : "Windows would not change graphics priority on this PC";
          _gpuLowCode = "0x" + st.ToString("X8");
        }
        return _gpuLowState == 1;
      }
    }

    static string CapsCmd(Dictionary<string, object> req, ref object result) {
      string why;
      int gpus = CountGpus(out why);
      bool low = GpuLowWorks();
      string lowWhy, lowCode;
      lock (_capsLock) { lowWhy = _gpuLowWhy; lowCode = _gpuLowCode; }
      result = Json.Obj("ok", true, "gpus", gpus, "gpusWhy", why, "gpuLow", low, "gpuLowWhy", low ? null : lowWhy, "gpuLowCode", low ? null : lowCode, "gpuPref", gpus >= 2);
      return null;
    }

    // ---------------------------------------------------------------- graphics preference
    const string GpuPrefKey = "Software\\Microsoft\\DirectX\\UserGpuPreferences";
    const string TestRegParent = "Software\\Mantle-test";

    static string GpuPrefCmd(Dictionary<string, object> req, ref object result) {
      string path = Json.GetString(req, "path");
      string pref = (Json.GetString(req, "pref") ?? "").Trim().ToLowerInvariant();
      bool dry = Json.GetBool(req, "dryRun", false);
      if (string.IsNullOrEmpty(path) || path.Length > 1024 || !System.IO.Path.IsPathRooted(path) || path.IndexOf('\0') >= 0)
        return "apppower.gpupref needs the app's full exe path";
      if (pref != "default" && pref != "saving" && pref != "performance") return "pref must be default, saving or performance";
      string root = Environment.GetEnvironmentVariable("MANTLE_APPPOWER_TEST_REGROOT");
      string keyPath = GpuPrefKey;
      if (!string.IsNullOrEmpty(root)) {
        root = root.Trim().TrimEnd('\\');
        if (root.StartsWith("HKCU\\", StringComparison.OrdinalIgnoreCase)) root = root.Substring(5);
        if (!root.StartsWith(TestRegParent + "\\", StringComparison.OrdinalIgnoreCase) || root.IndexOf("..", StringComparison.Ordinal) >= 0)
          return "MANTLE_APPPOWER_TEST_REGROOT must be a key under HKCU\\Software\\Mantle-test";
        keyPath = root;
      } else if (Program.Passive && !dry) {
        return FeatureTable.PassiveRefusal + ": would have changed Windows' graphics preference for an app";
      }
      RegistryKey k = null;
      try {
        k = dry ? Registry.CurrentUser.OpenSubKey(keyPath, false) : Registry.CurrentUser.CreateSubKey(keyPath);
        if (k == null && !dry) return "Windows would not open the graphics preference key";
        string old = k == null ? null : k.GetValue(path) as string;
        string next = WithPref(old, pref);
        if (!dry) {
          if (next == null) { if (old != null) k.DeleteValue(path, false); }
          else if (next != old) k.SetValue(path, next, RegistryValueKind.String);
        }
        result = Json.Obj("ok", true, "pref", pref, "before", PrefOf(old), "dryRun", dry ? (object)true : null);
        return null;
      } catch (Exception ex) {
        return "Windows would not change the graphics preference (" + ex.GetType().Name + ")";
      } finally { if (k != null) k.Close(); }
    }

    static string PrefOf(string v) {
      foreach (string part in (v ?? "").Split(';')) {
        string p = part.Trim();
        if (p.StartsWith("GpuPreference=", StringComparison.OrdinalIgnoreCase)) {
          string x = p.Substring(14);
          return x == "1" ? "saving" : x == "2" ? "performance" : "default";
        }
      }
      return "default";
    }

    /// The registry string with GpuPreference set (or removed for "default"); null = delete the value.
    static string WithPref(string old, string pref) {
      var keep = new List<string>();
      foreach (string part in (old ?? "").Split(';')) {
        string p = part.Trim();
        if (p.Length == 0 || p.StartsWith("GpuPreference=", StringComparison.OrdinalIgnoreCase)) continue;
        keep.Add(p);
      }
      if (pref == "saving") keep.Add("GpuPreference=1");
      else if (pref == "performance") keep.Add("GpuPreference=2");
      if (keep.Count == 0) return null;
      return string.Join(";", keep) + ";";
    }
  }
}
