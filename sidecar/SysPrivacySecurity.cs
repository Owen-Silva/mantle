// SysPrivacySecurity.cs - Settings > Privacy & security > Security, READ-ONLY, for Mantle Settings
// (lane privacy, 2026-09-28): Windows Security's status, Find my device, device encryption /
// BitLocker, and the Windows Search indexer.
//
// WHY READ-ONLY: every one of these belongs to something that refuses other programs on purpose:
//   - antivirus, real-time protection, firewall, tamper protection: Windows Security. Tamper
//     protection exists to block exactly what another program switching them would be. The page
//     says "changes belong to the Windows Security app" on each row;
//   - Find my device: kept for the whole PC with the Microsoft account (HKLM MdmCommon);
//   - encryption: needs an administrator AND a saved recovery key; a mistake locks the files away;
//   - the indexer: a Windows service (WSearch); Mantle's own search (Search.cs) reports on it.
//
//   privacy.security   { antivirus:[...], defender:{...}, firewall:{profiles, products}, findMyDevice,
//                        encryption, indexer }, each part with its own reason when it cannot be read.
//
// SOURCES (all readable by a standard user; MEASURED on Owen's desktop 2026-09-28):
//   root\SecurityCenter2 AntiVirusProduct / FirewallProduct (displayName, productState)
//   root\Microsoft\Windows\Defender MSFT_MpComputerStatus (RealTimeProtectionEnabled, IsTamperProtected..)
//   HKLM ...\SharedAccess\Parameters\FirewallPolicy\<Profile> EnableFirewall (+ the WindowsFirewall policy)
//   the shell property System.Volume.BitLockerProtection of the system drive (what Explorer's lock shows)
//
// PRIVACY: nothing here logs. Product names are replies only.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;

namespace Mantle {
  [MantleFeature]
  static class SysPrivacySecurity {
    public static void Register(FeatureTable t) {
      t.Add("privacy.security", Lanes.Slow, Security);   // WMI: ~100-600 ms
    }

    static IList Wmi(string ns, string query, out string why) {
      why = null;
      var list = new List<ManagementBaseObject>();
      try {
        var opts = new EnumerationOptions();
        opts.Timeout = TimeSpan.FromSeconds(8);
        opts.ReturnImmediately = false;
        using (var s = new ManagementObjectSearcher(new ManagementScope(ns), new ObjectQuery(query), opts))
          foreach (ManagementBaseObject o in s.Get()) list.Add(o);
      } catch (Exception ex) { why = "could not be read (" + SysCommon.Why(ex) + ")"; }
      return list;
    }

    static object Prop(ManagementBaseObject o, string name) {
      try { return o[name]; } catch (Exception) { return null; }
    }

    /// productState: byte 2 = scanner (0x10 on), byte 1 = definitions (0x00 up to date).
    static IList Products(string cls, out string why) {
      var outList = new List<object>();
      foreach (ManagementBaseObject o in Wmi(@"root\SecurityCenter2", "SELECT displayName, productState FROM " + cls, out why)) {
        object ps = Prop(o, "productState");
        long st = ps == null ? -1 : Convert.ToInt64(ps, CultureInfo.InvariantCulture);
        string name = Convert.ToString(Prop(o, "displayName"), CultureInfo.InvariantCulture);
        outList.Add(Json.Obj("name", name, "on", st < 0 ? null : (object)(((st >> 8) & 0x10) != 0),
                             "upToDate", st < 0 ? null : (object)((st & 0xFF) == 0),
                             "defender", name != null && name.IndexOf("Windows Defender", StringComparison.OrdinalIgnoreCase) >= 0,
                             "state", st < 0 ? null : "0x" + st.ToString("X6", CultureInfo.InvariantCulture)));
      }
      return outList;
    }

    static IDictionary Defender() {
      string why;
      IList l = Wmi(@"root\Microsoft\Windows\Defender",
                    "SELECT AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, IsTamperProtected, AntivirusSignatureLastUpdated FROM MSFT_MpComputerStatus", out why);
      if (l.Count == 0) return Json.Obj("ok", false, "reason", "Microsoft Defender's status " + (why ?? "was not reported (another antivirus may have replaced it)"));
      var o = (ManagementBaseObject)l[0];
      object sig = null;
      try {
        string s = Prop(o, "AntivirusSignatureLastUpdated") as string;
        if (!string.IsNullOrEmpty(s)) sig = (double)(long)(ManagementDateTimeConverter.ToDateTime(s).ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
      } catch (Exception) { sig = null; }
      return Json.Obj("ok", true, "service", Prop(o, "AMServiceEnabled"), "antivirus", Prop(o, "AntivirusEnabled"),
                      "realTime", Prop(o, "RealTimeProtectionEnabled"), "tamper", Prop(o, "IsTamperProtected"),
                      "signaturesUpdated", sig, "reason", null);
    }

    static IDictionary Firewall() {
      var profiles = new List<object>();
      string[][] P = new string[][] { new[] { "domain", "DomainProfile", "DomainProfile" }, new[] { "private", "StandardProfile", "PrivateProfile" }, new[] { "public", "PublicProfile", "PublicProfile" } };
      foreach (string[] p in P) {
        string w, pw;
        long? v = SysCommon.ReadNumber("HKLM", @"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\" + p[1], "EnableFirewall", out w);
        long? pol = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\WindowsFirewall\" + p[2], "EnableFirewall", out pw);
        long? eff = pol ?? v;
        profiles.Add(Json.Obj("profile", p[0], "on", eff == null ? null : (object)(eff.Value != 0), "policy", pol != null,
                              "reason", eff == null ? "could not be read (" + w + ")" : null));
      }
      string why;
      IList prods = Products("FirewallProduct", out why);
      return Json.Obj("profiles", profiles, "products", prods, "productsWhy", why);
    }

    // ---- the system drive's BitLocker state, as Explorer shows it (no administrator needed)
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
      [PreserveSig] int GetCount(out uint c);
      [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
      [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
      [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
      [PreserveSig] int Commit();
    }
    static class Native {
      [DllImport("propsys.dll", CharSet = CharSet.Unicode)] public static extern int PSGetPropertyKeyFromName(string name, out PROPERTYKEY key);
      [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
      public static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bind, int flags, ref Guid iid, out IPropertyStore store);
      [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT v);
    }

    static readonly string[] BL = { null, "on", "off", "encrypting", "decrypting", "suspended", "on (locked)", "on (waiting to finish)", "waiting for activation" };

    static IDictionary Encryption() {
      string drive = (Environment.GetEnvironmentVariable("SystemDrive") ?? "C:") + "\\";
      string w;
      string ed = PrivReg.ReadStr("HKLM", @"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "EditionID", out w);
      bool home = ed != null && ed.StartsWith("Core", StringComparison.OrdinalIgnoreCase);
      long? prevent = SysCommon.ReadNumber("HKLM", @"SYSTEM\CurrentControlSet\Control\BitLocker", "PreventDeviceEncryption", out w);
      int state = -1;
      string why = null;
      IPropertyStore ps = null;
      try {
        PROPERTYKEY key;
        int hr = Native.PSGetPropertyKeyFromName("System.Volume.BitLockerProtection", out key);
        if (hr != 0) why = "Windows does not know the BitLocker property here (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")";
        else {
          Guid iid = typeof(IPropertyStore).GUID;
          hr = Native.SHGetPropertyStoreFromParsingName(drive, IntPtr.Zero, 0, ref iid, out ps);
          if (hr != 0 || ps == null) why = "the system drive's properties could not be read (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")";
          else {
            PROPVARIANT v;
            hr = ps.GetValue(ref key, out v);
            if (hr != 0) why = "the BitLocker state could not be read (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")";
            else if (v.vt == 0) why = "Windows reports no BitLocker state for the system drive (this PC may not support encryption)";
            else state = (int)((long)v.p & 0xFFFFFFFF);
            Native.PropVariantClear(ref v);
          }
        }
      } catch (Exception ex) { why = "the BitLocker state could not be read (" + SysCommon.Why(ex) + ")"; }
      finally { if (ps != null) Marshal.ReleaseComObject(ps); }
      string words = state >= 1 && state < BL.Length ? BL[state] : state >= 0 ? "state " + state : null;
      return Json.Obj("kind", home ? "device" : "bitlocker", "edition", ed, "state", state < 0 ? null : (object)state, "words", words,
                      "on", state == 1 || state == 6 || state == 7, "prevented", prevent == 1, "reason", why);
    }

    static IDictionary FindMyDevice() {
      string w, w2;
      long? v = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Microsoft\MdmCommon\SettingValues", "LocationSyncEnabled", out w);
      string loc = PrivReg.ReadStr("HKLM", SysPrivacy.StoreLm + "\\location", "Value", out w2);
      return Json.Obj("on", v == null ? null : (object)(v.Value == 1), "locationOn", loc == null ? null : (object)(loc == "Allow"),
                      "reason", v == null ? "Windows has not stored a Find my device choice on this PC (" + w + ")" : null);
    }

    static IDictionary Indexer() {
      try {
        IDictionary s = Search.Status();
        return Json.Obj("service", s["service"], "startType", s["startType"], "running", s["serviceOk"], "reason", s["reason"]);
      } catch (Exception ex) { return Json.Obj("service", null, "running", null, "reason", "the indexer's state could not be read (" + SysCommon.Why(ex) + ")"); }
    }

    static string Security(Dictionary<string, object> req, ref object result) {
      string avWhy;
      IList av = Products("AntiVirusProduct", out avWhy);
      result = Json.Obj("ok", true, "antivirus", av, "antivirusWhy", avWhy ?? (av.Count == 0 ? "Windows Security reports no antivirus" : null),
                        "defender", Defender(), "firewall", Firewall(), "encryption", Encryption(),
                        "findMyDevice", FindMyDevice(), "indexer", Indexer(), "reason", null);
      return null;
    }
  }
}
