// SysAbout.cs - Mantle Settings > System: About, Activation and Recovery, natively (lane sysset,
// 2026-09-28).
//
//   sysabout.get {}              device + Windows specs (registry and kernel32 only: fast, no WMI)
//   sysabout.activation {}       activation state (WMI SoftwareLicensingProduct: 1-3 s, so its own call)
//   sysabout.recovery {}         Windows RE, "Go back", what each recovery action needs
//   sysabout.advancedStartup {dryRun?}   restart NOW into the boot options menu (the page confirms first)
//   system.productKey {key}      [Elevated] "Change product key" (SoftwareLicensingService.InstallProductKey)
//   system.networkReset {}       [Elevated] Settings' "Network reset" (netcfg.exe -d, fixed arguments)
//   Rename this PC is the elevate lane's system.renamePc (Elevate.cs); this file only points at it.
//
// READ-ONLY, WITH MICROSOFT'S REASON (the honest list):
//   - "Reset this PC", "Go back" and "Fix problems using Windows Update" are run by Windows' own
//     recovery engine and Windows Update; no API lets another program drive them (Mantle can only
//     start Windows' own flow, which is not Mantle's to replace).
//   - Microsoft-account digital-licence linking lives in Microsoft's activation service.
//
// ADVANCED STARTUP uses the DOCUMENTED InitiateShutdown(SHUTDOWN_RESTART | SHUTDOWN_RESTART_BOOTOPTIONS),
// which needs only SeShutdownPrivilege (every interactive user holds it); it RESTARTS the PC, so the
// page must confirm first. Tests only ever send dryRun.
//
// PRIVACY: the device ID and product ID are shown on the page (Windows' About shows them too);
// nothing here logs. The product key never comes back from any command.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Mantle {
  [MantleFeature]
  static class SysAbout {
    const string NtKey = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORYSTATUSEX { public uint Length, Load; public ulong Total, Avail, TotalPage, AvailPage, TotalVirtual, AvailVirtual, AvailExtended; }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);
    [DllImport("kernel32.dll")] static extern bool GetPhysicallyInstalledSystemMemory(out ulong kb);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint InitiateShutdown(string machine, string message, uint grace, uint flags, uint reason);

    public static void Register(FeatureTable t) {
      t.Add("sysabout.get", Lanes.Slow, Get);
      t.Add("sysabout.activation", Lanes.Slow, Activation);
      t.Add("sysabout.recovery", Lanes.Slow, Recovery);
      t.Add("sysabout.advancedStartup", Lanes.Slow, AdvancedStartup);
    }

    static string S(string hive, string key, string name) { string w; object v = SysCommon.Read(hive, key, name, out w); return v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture); }

    /// PURE: Windows 11 still says "Windows 10" in ProductName (known since 21H2); build >= 22000 is 11.
    public static string ProductName(string raw, int build) {
      if (raw == null) return null;
      return build >= 22000 ? raw.Replace("Windows 10", "Windows 11") : raw;
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      try {
        int build; int.TryParse(S("HKLM", NtKey, "CurrentBuild") ?? "0", out build);
        string ubr = S("HKLM", NtKey, "UBR");
        string installRaw = S("HKLM", NtKey, "InstallDate");
        long installSec;
        string installed = long.TryParse(installRaw ?? "", out installSec)
          ? new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(installSec).ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
        var ms = new MEMORYSTATUSEX { Length = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)) };
        bool memOk = GlobalMemoryStatusEx(ref ms);
        ulong kb;
        bool instOk = GetPhysicallyInstalledSystemMemory(out kb);
        int touches = GetSystemMetrics(95 /* SM_MAXIMUMTOUCHES */), digitizer = GetSystemMetrics(94 /* SM_DIGITIZER */);
        string pen = (digitizer & 0x40) == 0 ? "No pen" : "Pen support";
        string touch = touches > 0 ? "touch support with " + touches + " touch points" : "no touch input";
        string arch = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "";
        long diskTotal = 0;
        foreach (DriveInfo d in DriveInfo.GetDrives()) { try { if (d.DriveType == DriveType.Fixed && d.IsReady) diskTotal += d.TotalSize; } catch (Exception) { } }
        result = Json.Obj(
          "ok", true,
          "device", Json.Obj(
            "name", Environment.MachineName,
            "manufacturer", S("HKLM", @"HARDWARE\DESCRIPTION\System\BIOS", "SystemManufacturer"),
            "model", S("HKLM", @"HARDWARE\DESCRIPTION\System\BIOS", "SystemProductName"),
            "processor", (S("HKLM", @"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString") ?? "").Trim(),
            "cores", Environment.ProcessorCount,
            "ramInstalledBytes", instOk ? (object)(long)(kb * 1024) : null,
            "ramUsableBytes", memOk ? (object)(long)ms.Total : null,
            "storageBytes", diskTotal,
            "deviceId", S("HKLM", @"SOFTWARE\Microsoft\SQMClient", "MachineId"),
            "productId", S("HKLM", NtKey, "ProductId"),
            "systemType", (Environment.Is64BitOperatingSystem ? "64-bit operating system, " : "32-bit operating system, ") +
                          (arch.Equals("ARM64", StringComparison.OrdinalIgnoreCase) ? "ARM-based processor" : "x64-based processor"),
            "penTouch", pen + " and " + touch),
          "windows", Json.Obj(
            "edition", ProductName(S("HKLM", NtKey, "ProductName"), build),
            "editionId", S("HKLM", NtKey, "EditionID"),
            "version", S("HKLM", NtKey, "DisplayVersion"),
            "installed", installed,
            "build", build + (ubr != null ? "." + ubr : ""),
            "experience", ExperiencePack()),
          "rename", Json.Obj("elevate", "system.renamePc", "does", "rename this PC", "rules",
                             "letters, numbers and hyphens, 1 to 15 characters, not only numbers"));
        return null;
      } catch (Exception ex) { return "sysabout.get failed: " + SysCommon.Why(ex); }
    }

    /// "Windows Feature Experience Pack": the version in the Client.CBS system app's manifest.
    static string ExperiencePack() {
      try {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy");
        string man = Path.Combine(dir, "AppxManifest.xml");
        if (!File.Exists(man)) return null;
        string head = File.ReadAllText(man);
        Match m = Regex.Match(head, "<Identity[^>]*\\sVersion=\"([0-9.]+)\"");
        return m.Success ? "Windows Feature Experience Pack " + m.Groups[1].Value : null;
      } catch (Exception) { return null; }
    }

    static readonly string[] LicenseWords = { "Not activated", "Activated", "Grace period (out of box)", "Grace period (hardware changed)",
                                              "Grace period (not genuine)", "Not activated (notification mode)", "Grace period (extended)" };

    static string Activation(Dictionary<string, object> req, ref object result) {
      try {
        using (var s = new ManagementObjectSearcher("root\\cimv2",
            "SELECT Description, LicenseStatus, GracePeriodRemaining, ProductKeyChannel FROM SoftwareLicensingProduct " +
            "WHERE ApplicationID = '55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL")) {
          foreach (ManagementObject o in s.Get()) {
            using (o) {
              int st = Convert.ToInt32(o["LicenseStatus"] ?? -1);
              result = Json.Obj("ok", true,
                "activated", st == 1,
                "state", st >= 0 && st < LicenseWords.Length ? LicenseWords[st] : "Unknown (" + st + ")",
                "channel", o["ProductKeyChannel"] as string,
                "description", o["Description"] as string,
                "graceMinutes", o["GracePeriodRemaining"] == null ? null : (object)Convert.ToInt64(o["GracePeriodRemaining"]),
                "changeKey", Json.Obj("elevate", "system.productKey", "does", ProductKeyAdmin.Does),
                "digitalLicenceWhy", "Linking a digital licence to a Microsoft account happens in Microsoft's activation service; Windows gives other programs no way to do it");
              return null;
            }
          }
        }
        result = Json.Obj("ok", true, "activated", false, "state", "No Windows product key is installed", "changeKey",
                          Json.Obj("elevate", "system.productKey", "does", ProductKeyAdmin.Does));
        return null;
      } catch (Exception ex) {
        result = Json.Obj("ok", false, "reason", "Windows' licensing service did not answer: " + SysCommon.Why(ex));
        return null;
      }
    }

    static string Recovery(Dictionary<string, object> req, ref object result) {
      try {
        string sys = Environment.GetFolderPath(Environment.SpecialFolder.System);
        string re = null, reWhy = null;
        try {
          string xml = File.ReadAllText(Path.Combine(sys, @"Recovery\ReAgent.xml"));
          Match m = Regex.Match(xml, "<InstallState\\s+state=\"(\\d+)\"");
          re = m.Success ? (m.Groups[1].Value == "1" ? "on" : "off") : null;
          if (re == null) reWhy = "Windows RE's settings file has a layout Mantle does not know";
        } catch (Exception ex) { reWhy = "Windows RE's settings could not be read: " + SysCommon.Why(ex); }
        string sysDrive = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        bool old = Directory.Exists(Path.Combine(sysDrive, "Windows.old"));
        const string engine = "Windows' own recovery engine runs this; no API lets another program drive it";
        result = Json.Obj("ok", true,
          "windowsRE", re, "windowsREWhy", reWhy,
          "advancedStartup", Json.Obj("writable", re == "on", "why", re == "on" ? null : "Windows RE is not turned on, so there is no boot options menu to restart into"),
          "goBack", Json.Obj("available", old, "writable", false, "why", old ? engine : "there is no previous version of Windows on this PC to go back to"),
          "reset", Json.Obj("writable", false, "why", engine),
          "fixWithUpdate", Json.Obj("writable", false, "why", "reinstalling the current version comes from Windows Update; no API lets another program start it"),
          "networkReset", Json.Obj("elevate", "system.networkReset", "does", NetResetAdmin.Does, "note", "removes and reinstalls every network adapter, then the PC must restart"),
          "troubleshooters", Json.Obj("writable", false, "why", "Windows 11's troubleshooters now run inside Microsoft's Get Help app; there is no API for them"));
        return null;
      } catch (Exception ex) { return "sysabout.recovery failed: " + SysCommon.Why(ex); }
    }

    static string AdvancedStartup(Dictionary<string, object> req, ref object result) {
      const uint SHUTDOWN_RESTART = 0x4, SHUTDOWN_RESTART_BOOTOPTIONS = 0x400, SHUTDOWN_FORCE_OTHERS = 0x1;
      uint flags = SHUTDOWN_RESTART | SHUTDOWN_RESTART_BOOTOPTIONS | SHUTDOWN_FORCE_OTHERS;
      var writes = SysCommon.List(Json.Obj("api", "InitiateShutdown", "flags", "SHUTDOWN_RESTART | SHUTDOWN_RESTART_BOOTOPTIONS | SHUTDOWN_FORCE_OTHERS",
                                           "grace", 0, "reason", "SHTDN_REASON_FLAG_PLANNED"));
      if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, null, null, false); return null; }
      if (Program.Passive) return SysCommon.Passive("restarted the PC into the boot options menu");
      string perr = SysCommon.EnablePrivilege("SeShutdownPrivilege");
      if (perr != null) return "Windows did not restart: " + perr;
      uint rc = InitiateShutdown(null, null, 0, flags, 0x80000000 /* SHTDN_REASON_FLAG_PLANNED */);
      if (rc != 0) return "Windows did not restart (error " + rc + ")";
      result = Json.Obj("ok", true, "note", "Restarting into the boot options menu now.");
      return null;
    }

    /// "Change product key": the licensing service's documented WMI method (what slmgr /ipk calls).
    static class ProductKeyAdmin {
      public const string Does = "change the Windows product key";
      [Elevated("system.productKey", "Check", Does)]
      static string Install(Dictionary<string, object> args, ref object result) {
        string key = ((string)args["key"]).ToUpperInvariant();
        try {
          using (var svc = new ManagementClass("root\\cimv2", "SoftwareLicensingService", null)) {
            foreach (ManagementObject o in svc.GetInstances()) {
              using (o) {
                o.InvokeMethod("InstallProductKey", new object[] { key });
                o.InvokeMethod("RefreshLicenseStatus", null);
              }
              break;
            }
          }
        } catch (Exception ex) { return "Windows did not accept that product key (" + SysCommon.Why(ex) + ")"; }
        result = Json.Obj("ok", true, "note", "The key is installed. Windows activates it online on its own; Activation shows the state.");
        return null;
      }
      static string Check(Dictionary<string, object> args) {
        string why = Elevate.OnlyKeys(args, "key");
        if (why != null) return why;
        object v;
        if (!args.TryGetValue("key", out v) || !(v is string)) return "a product key is needed";
        return Regex.IsMatch((string)v, "^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){4}$") ? null
             : "a product key is 25 letters and numbers in five groups of five, like XXXXX-XXXXX-XXXXX-XXXXX-XXXXX";
      }
    }

    /// Settings' "Network reset": netcfg.exe -d (Windows offers no API for it). Run by its FIXED path
    /// under System32 with FIXED arguments, as sidecar/ELEVATE.md allows; nothing comes from the args.
    static class NetResetAdmin {
      public const string Does = "reset every network adapter";
      [Elevated("system.networkReset", "Check", Does)]
      static string Reset(Dictionary<string, object> args, ref object result) {
        string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "netcfg.exe");
        if (!File.Exists(exe)) return "Windows' network configuration tool is missing, so nothing was reset";
        var psi = new System.Diagnostics.ProcessStartInfo(exe, "-d") { UseShellExecute = false, CreateNoWindow = true };
        using (var p = System.Diagnostics.Process.Start(psi)) {
          if (!p.WaitForExit(60000)) return "Windows' network reset did not finish in 60 s; it may still be running";
          if (p.ExitCode != 0) return "Windows' network reset failed (exit " + p.ExitCode + ")";
        }
        result = Json.Obj("ok", true, "restartNeeded", true, "note", "Network adapters were reset. Restart the PC to finish.");
        return null;
      }
      static string Check(Dictionary<string, object> args) { return Elevate.OnlyKeys(args); }
    }
  }
}
