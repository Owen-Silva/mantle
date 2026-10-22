// SysPrivacy.cs - Settings > Privacy & security > App permissions for Mantle Settings (lane privacy,
// 2026-09-28). The page is ui/settings/sections/privacy.js, its main half
// lib/features/_settings-sections/privacy.js.
//
// WHY: the user wants Mantle Settings to replace Windows Settings outright, so every App permissions page
// (Location, Camera, Microphone, Contacts, ... Generative AI) is drawn natively from the same store
// Windows' own Settings reads: the CapabilityAccessManager ConsentStore.
//
//   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\<cap>  Value
//       "<X> access": the switch for EVERY user of this PC. Needs an administrator: it goes through the
//       [Elevated("privacy.deviceAccess")] broker action below, one UAC prompt per change.
//   HKCU\...\ConsentStore\<cap>                  Value  "Let apps access your <x>"      (Allow | Deny)
//   HKCU\...\ConsentStore\<cap>\NonPackaged      Value  "Let desktop apps access ..."   (Allow | Deny)
//   HKCU\...\ConsentStore\<cap>\<family name>    Value  one Store app: Allow | Deny | Prompt | not set
//       LastUsedTimeStart / LastUsedTimeStop (FILETIME) = "last accessed"; start after stop = in use now.
//   HKCU\...\ConsentStore\<cap>\NonPackaged\<path with # for \>  a desktop app that used it (no switch:
//       Windows has none per desktop app, only the NonPackaged switch for all of them).
//   HKLM\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy  LetAppsAccess<X> 0|1|2 (user decides |
//       force allow | force deny): a policy LOCKS the switches; the page says so on the row.
//
//   privacy.caps                         every known capability: device / user / desktop switch, policy,
//                                        app counts (for the overview)
//   privacy.cap {capability}             one capability with its apps (names, last used, in use now)
//   privacy.capSet {capability, scope, app?, allow, dryRun?}   scope user | desktop | app | device.
//                                        dryRun validates and reads everything and writes nothing;
//                                        device answers needsAdmin + elevate:{action,args} for real.
//
// A capability is named by its ConsentStore key and must be in CAPS (the whitelist): nothing from a
// request ever reaches a registry path unchecked. An app must be an EXISTING subkey of that capability.
//
// PRIVACY: nothing here logs. App names and paths go into replies only (the page shows them).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using Microsoft.Win32;

namespace Mantle {
  /// Registry pieces the privacy files share (strings, QWORDs, deletes), in SysCommon's style:
  /// reads never throw, writes are read back.
  static class PrivReg {
    public static string ReadStr(string hive, string key, string name, out string why) {
      object v = SysCommon.Read(hive, key, name, out why);
      if (v == null) return null;
      string s = v as string;
      if (s == null) { why = "not text (" + v.GetType().Name + ")"; return null; }
      return s;
    }

    public static bool KeyExists(string hive, string key) {
      try {
        using (RegistryKey b = SysCommon.Hive(hive))
        using (RegistryKey k = b.OpenSubKey(key, false)) return k != null;
      } catch (Exception) { return false; }
    }

    public static string[] SubKeys(string hive, string key, out string why) {
      why = null;
      try {
        using (RegistryKey b = SysCommon.Hive(hive))
        using (RegistryKey k = b.OpenSubKey(key, false)) {
          if (k == null) { why = "the key does not exist"; return new string[0]; }
          return k.GetSubKeyNames();
        }
      } catch (Exception ex) { why = "could not be read: " + SysCommon.Why(ex); return new string[0]; }
    }

    /// Writes one REG_SZ into an EXISTING key (never creates one) and reads it back. null = done.
    public static string WriteStr(string hive, string key, string name, string value, bool create) {
      if (hive == "HKLM" && !SysCommon.Elevated()) return "needs administrator: Windows keeps this for the whole PC (HKLM)";
      try {
        using (RegistryKey b = SysCommon.Hive(hive))
        using (RegistryKey k = create ? b.CreateSubKey(key, RegistryKeyPermissionCheck.ReadWriteSubTree) : b.OpenSubKey(key, true)) {
          if (k == null) return "the settings key does not exist, so nothing was written";
          k.SetValue(name, value, RegistryValueKind.String);
        }
      } catch (Exception ex) { return "Windows refused the write: " + SysCommon.Why(ex); }
      string why;
      string back = ReadStr(hive, key, name, out why);
      if (back == null) return "the value was written but could not be read back (" + why + ")";
      if (back != value) return "the value was written but reads back as " + back + " (another program may have put it back)";
      return null;
    }

    public static string WriteQword(string hive, string key, string name, long value) {
      try {
        using (RegistryKey b = SysCommon.Hive(hive))
        using (RegistryKey k = b.CreateSubKey(key, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
          if (k == null) return "the settings key could not be opened for writing";
          k.SetValue(name, value, RegistryValueKind.QWord);
        }
      } catch (Exception ex) { return "Windows refused the write: " + SysCommon.Why(ex); }
      string why;
      object back = SysCommon.Read(hive, key, name, out why);
      if (!(back is long) || (long)back != value) return "the value was written but does not read back the same";
      return null;
    }

    public static string Delete(string hive, string key, string name) {
      try {
        using (RegistryKey b = SysCommon.Hive(hive))
        using (RegistryKey k = b.OpenSubKey(key, true)) {
          if (k == null) return null;                     // nothing to delete
          k.DeleteValue(name, false);
        }
      } catch (Exception ex) { return "Windows refused to clear it: " + SysCommon.Why(ex); }
      string why;
      return SysCommon.Read(hive, key, name, out why) == null ? null : "the value was cleared but is still there";
    }

    /// A FILETIME QWORD as ms since 1970, or null.
    public static object Ms(object v) {
      if (!(v is long)) return null;
      long ft = (long)v;
      if (ft <= 116444736000000000L) return null;
      return (double)((ft - 116444736000000000L) / 10000L);
    }
  }

  [MantleFeature]
  static class SysPrivacy {
    public static void Register(FeatureTable t) {
      t.Add("privacy.caps", Lanes.Slow, Caps);
      t.Add("privacy.cap", Lanes.Slow, Cap);          // resolves app names (manifests): up to ~1 s cold
      t.Add("privacy.capSet", Lanes.Slow, CapSet);
    }

    public const string Store = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
    public const string StoreLm = @"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
    public const string AppPrivacy = @"SOFTWARE\Policies\Microsoft\Windows\AppPrivacy";
    public const string DeviceDoes = "change a privacy permission for everyone who uses this PC";

    // The whitelist: ConsentStore key, the AppPrivacy policy's <X> (null = none), has a desktop switch.
    sealed class CapDef { public string Key; public string Policy; public bool Desktop; }
    static readonly CapDef[] CAPS = new CapDef[] {
      C("location", "Location", true), C("webcam", "Camera", true), C("microphone", "Microphone", true),
      C("userNotificationListener", "Notifications", false), C("userAccountInformation", "AccountInfo", false),
      C("contacts", "Contacts", false), C("appointments", "Calendar", false), C("phoneCall", "Phone", false),
      C("phoneCallHistory", "CallHistory", false), C("email", "Email", false), C("userDataTasks", "Tasks", false),
      C("chat", "Messaging", false), C("radios", "Radios", false), C("bluetoothSync", "TrustedDevices", false),
      C("appDiagnostics", "DiagnosticInfo", false), C("documentsLibrary", null, false), C("downloadsFolder", null, false),
      C("musicLibrary", null, false), C("picturesLibrary", null, false), C("videosLibrary", null, false),
      C("broadFileSystemAccess", null, false), C("graphicsCaptureProgrammatic", "GraphicsCaptureProgrammatic", true),
      C("graphicsCaptureWithoutBorder", "GraphicsCaptureWithoutBorder", true), C("systemAIModels", "SystemAIModels", false),
      C("humanPresence", "HumanPresence", false),
    };
    static CapDef C(string k, string p, bool d) { var c = new CapDef(); c.Key = k; c.Policy = p; c.Desktop = d; return c; }

    static CapDef Find(string key) {
      if (string.IsNullOrEmpty(key)) return null;
      foreach (CapDef c in CAPS) if (c.Key == key) return c;
      return null;
    }
    public static bool Known(string key) { return Find(key) != null; }

    static string Allow(string v) { return v == "Allow" || v == "Deny" || v == "Prompt" ? v : null; }

    /// The policy on one capability: null when none, else {value, force:'allow'|'deny'|null, words}.
    static IDictionary Policy(CapDef c) {
      if (c.Key == "location") {
        string w0;
        long? off = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors", "DisableLocation", out w0);
        if (off == 1) return Json.Obj("value", 2, "force", "deny", "words", "a policy on this PC turns location off for everyone (LocationAndSensors DisableLocation = 1)");
      }
      if (c.Policy == null) return null;
      string why;
      long? v = SysCommon.ReadNumber("HKLM", AppPrivacy, "LetAppsAccess" + c.Policy, out why);
      if (v == null || v == 0) return null;
      string force = v == 1 ? "allow" : v == 2 ? "deny" : null;
      return Json.Obj("value", v.Value, "force", force,
                      "words", "a policy on this PC sets it (AppPrivacy LetAppsAccess" + c.Policy + " = " + v.Value +
                               (force == "allow" ? ", Force Allow" : force == "deny" ? ", Force Deny" : "") + ")");
    }

    static IDictionary Summary(CapDef c, bool withApps) {
      string why;
      bool present = PrivReg.KeyExists("HKCU", Store + "\\" + c.Key) || PrivReg.KeyExists("HKLM", StoreLm + "\\" + c.Key);
      string dev = Allow(PrivReg.ReadStr("HKLM", StoreLm + "\\" + c.Key, "Value", out why));
      string devWhy = dev == null ? why : null;
      string usr = Allow(PrivReg.ReadStr("HKCU", Store + "\\" + c.Key, "Value", out why));
      string usrWhy = usr == null ? why : null;
      string desk = null, deskWhy = null;
      if (c.Desktop) { desk = Allow(PrivReg.ReadStr("HKCU", Store + "\\" + c.Key + "\\NonPackaged", "Value", out why)); deskWhy = desk == null ? why : null; }
      var o = (IDictionary)Json.Obj("ok", true, "capability", c.Key, "present", present, "hasDesktop", c.Desktop,
                                    "device", dev, "deviceWhy", devWhy, "user", usr, "userWhy", usrWhy,
                                    "desktop", desk, "desktopWhy", deskWhy, "policy", Policy(c),
                                    "elevated", SysCommon.Elevated(),
                                    "reason", present ? null : "Windows on this PC keeps no permission store for this yet: no app has asked for it");
      if (!withApps) {
        string sw;
        string[] subs = PrivReg.SubKeys("HKCU", Store + "\\" + c.Key, out sw);
        int apps = 0, inUse = 0;
        var keys = new List<string>();
        foreach (string s in subs) {
          if (s != "NonPackaged") { apps++; keys.Add(Store + "\\" + c.Key + "\\" + s); continue; }
          foreach (string d in PrivReg.SubKeys("HKCU", Store + "\\" + c.Key + "\\NonPackaged", out sw)) keys.Add(Store + "\\" + c.Key + "\\NonPackaged\\" + d);
        }
        foreach (string k in keys) {
          string w;
          if (InUse(SysCommon.Read("HKCU", k, "LastUsedTimeStart", out w), SysCommon.Read("HKCU", k, "LastUsedTimeStop", out w))) inUse++;
        }
        o["apps"] = apps;
        o["inUse"] = inUse;
      }
      return o;
    }

    static string Caps(Dictionary<string, object> req, ref object result) {
      var list = new List<object>();
      foreach (CapDef c in CAPS) list.Add(Summary(c, false));
      result = Json.Obj("ok", true, "caps", list, "elevated", SysCommon.Elevated(), "reason", null);
      return null;
    }

    static string Cap(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "capability");
      CapDef c = Find(key);
      if (c == null) return "privacy.cap needs capability: one of Windows' permission names (e.g. \"webcam\")";
      IDictionary o = Summary(c, true);
      var apps = new List<object>();
      int hidden = 0;
      string why;
      foreach (string sub in PrivReg.SubKeys("HKCU", Store + "\\" + c.Key, out why)) {
        if (sub == "NonPackaged") continue;
        string k = Store + "\\" + c.Key + "\\" + sub;
        string w;
        string[] nm = PackageName(sub);
        if (nm[1] != "1") { hidden++; continue; }        // Windows lists installed apps only
        object start = SysCommon.Read("HKCU", k, "LastUsedTimeStart", out w);
        object stop = SysCommon.Read("HKCU", k, "LastUsedTimeStop", out w);
        apps.Add(Json.Obj("app", sub, "kind", "packaged", "name", nm[0], "value", Allow(PrivReg.ReadStr("HKCU", k, "Value", out w)),
                          "lastUsed", PrivReg.Ms(stop) ?? PrivReg.Ms(start), "inUse", InUse(start, stop)));
      }
      var desk = new List<object>();
      if (PrivReg.KeyExists("HKCU", Store + "\\" + c.Key + "\\NonPackaged")) {
        string w2;
        foreach (string sub in PrivReg.SubKeys("HKCU", Store + "\\" + c.Key + "\\NonPackaged", out w2)) {
          string k = Store + "\\" + c.Key + "\\NonPackaged\\" + sub;
          string w;
          object start = SysCommon.Read("HKCU", k, "LastUsedTimeStart", out w);
          object stop = SysCommon.Read("HKCU", k, "LastUsedTimeStop", out w);
          string path = sub.Replace('#', '\\');
          desk.Add(Json.Obj("app", sub, "kind", "desktop", "name", DesktopName(path), "path", path,
                            "lastUsed", PrivReg.Ms(stop) ?? PrivReg.Ms(start), "inUse", InUse(start, stop)));
        }
      }
      o["apps"] = apps;
      o["desktopApps"] = desk;
      o["hiddenApps"] = hidden;
      o["appsWhy"] = why;
      result = o;
      return null;
    }

    static bool InUse(object start, object stop) {
      if (!(start is long) || (long)start <= 0) return false;
      return !(stop is long) || (long)stop == 0 || (long)start > (long)stop;
    }

    // ------------------------------------------------------------------ writes

    static readonly Regex AppRe = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._\-]{1,199}$");

    static string CapSet(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "capability");
      CapDef c = Find(key);
      if (c == null) return "privacy.capSet needs capability: one of Windows' permission names (e.g. \"webcam\")";
      string scope = Json.GetString(req, "scope");
      if (scope != "user" && scope != "desktop" && scope != "app" && scope != "device")
        return "privacy.capSet needs scope: \"user\", \"desktop\", \"app\" or \"device\"";
      bool allow;
      string bad = SysCommon.Bool(req, "allow", "privacy.capSet", out allow);
      if (bad != null) return bad;
      bool dry = Json.GetBool(req, "dryRun", false);
      string val = allow ? "Allow" : "Deny";

      IDictionary pol = Policy(c);
      if (pol != null && pol["force"] != null)
        return "Read only: " + (string)pol["words"] + ", so Windows ignores any other choice";

      string hive = "HKCU", k = Store + "\\" + c.Key, what;
      if (scope == "desktop") {
        if (!c.Desktop) return "privacy.capSet: " + c.Key + " has no desktop-apps switch (Windows has none for it)";
        k += "\\NonPackaged";
        what = "let desktop apps use " + c.Key;
      } else if (scope == "app") {
        string app = Json.GetString(req, "app");
        if (string.IsNullOrEmpty(app) || app == "NonPackaged" || !AppRe.IsMatch(app))
          return "privacy.capSet needs app: a Store app's family name from privacy.cap";
        string sw;
        bool found = false;
        foreach (string s in PrivReg.SubKeys("HKCU", k, out sw)) if (string.Equals(s, app, StringComparison.OrdinalIgnoreCase)) { app = s; found = true; }
        if (!found) return "privacy.capSet: that app is not in Windows' list for " + c.Key + " (it has never asked), so there is nothing to switch";
        k += "\\" + app;
        what = "let this app use " + c.Key;
      } else if (scope == "device") {
        hive = "HKLM"; k = StoreLm + "\\" + c.Key;
        what = "let apps use " + c.Key + " for everyone on this PC";
      } else what = "let apps use " + c.Key;

      string w;
      string before = PrivReg.ReadStr(hive, k, "Value", out w);
      if (!PrivReg.KeyExists(hive, k)) return "privacy.capSet: Windows has no permission store for " + c.Key + " here yet (no app has asked), so there is nothing to switch";
      string would = (scope == "device" ? "ask for administrator permission to " + DeviceDoes + ", then " : "") +
                     "set \"" + what + "\" from " + (before ?? "not set") + " to " + val;
      var writes = SysCommon.List(Json.Obj("api", "registry", "hive", hive, "key", k, "name", "Value", "type", "REG_SZ", "value", val, "before", before));
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "capability", c.Key, "scope", scope, "from", before, "to", val,
                          "would", would, "writes", writes, "needsAdmin", scope == "device" && !SysCommon.Elevated(), "reason", null);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": privacy.capSet would " + would;
      if (scope == "device" && !SysCommon.Elevated()) {
        result = Json.Obj("ok", false, "needsAdmin", true, "elevate", Json.Obj("action", "privacy.deviceAccess", "args", Json.Obj("capability", c.Key, "on", allow)),
                          "reason", "Windows will ask for administrator permission to " + DeviceDoes);
        return null;
      }
      string err = PrivReg.WriteStr(hive, k, "Value", val, false);
      if (err != null) return "privacy.capSet: " + err;
      result = Json.Obj("ok", true, "dryRun", false, "capability", c.Key, "scope", scope, "from", before, "to", val, "now", allow,
                        "note", "Apps see the change the next time they ask Windows");
      return null;
    }

    // ------------------------------------------------------------------ the administrator action

    [Elevated("privacy.deviceAccess", "CheckDeviceAccess", DeviceDoes)]
    static string DeviceAccess(Dictionary<string, object> args, ref object result) {
      string cap = (string)args["capability"];
      bool on = (bool)args["on"];
      string k = StoreLm + "\\" + cap;
      if (!PrivReg.KeyExists("HKLM", k)) return "Windows has no permission store for " + cap + " on this PC, so nothing was changed";
      string err = PrivReg.WriteStr("HKLM", k, "Value", on ? "Allow" : "Deny", false);
      if (err != null) return "Windows did not change it (" + err + ")";
      result = Json.Obj("capability", cap, "now", on, "value", on, "note", "Every account on this PC now " + (on ? "may choose" : "is blocked") + " for this permission");
      return null;
    }

    static string CheckDeviceAccess(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "capability", "on");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("capability", out v) || !(v is string) || !Known((string)v)) return "capability must be one of Windows' permission names";
      if (!args.TryGetValue("on", out v) || !(v is bool)) return "on must be true or false";
      return null;
    }

    // ------------------------------------------------------------------ names

    static class Native {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
      public static extern int GetPackagesByPackageFamily(string family, ref uint count, IntPtr[] fullNames, ref uint bufferLength, IntPtr buffer);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
      public static extern int GetPackagePathByFullName(string fullName, ref uint pathLength, StringBuilder path);
      [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
      public static extern int SHLoadIndirectString(string source, StringBuilder outBuf, int cch, IntPtr reserved);
    }

    static readonly object _lock = new object();
    static readonly Dictionary<string, string[]> _names = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);

    /// A family name -> [display name, "1" installed for this user | "0"]. Cached.
    static string[] PackageName(string family) {
      lock (_lock) { string[] hit; if (_names.TryGetValue(family, out hit)) return hit; }
      string fallback = family.Split('_')[0];
      string[] r = new string[] { fallback, "0" };
      try {
        uint count = 0, len = 0;
        int rc = Native.GetPackagesByPackageFamily(family, ref count, null, ref len, IntPtr.Zero);
        if ((rc == 0 || rc == 122) && count > 0 && len > 0) {
          IntPtr buf = Marshal.AllocHGlobal((int)len * 2);
          try {
            var names = new IntPtr[count];
            if (Native.GetPackagesByPackageFamily(family, ref count, names, ref len, buf) == 0 && count > 0) {
              string full = Marshal.PtrToStringUni(names[0]);
              r = new string[] { ManifestName(full) ?? fallback, "1" };
            }
          } finally { Marshal.FreeHGlobal(buf); }
        }
      } catch (Exception) { /* the fallback name stands */ }
      lock (_lock) { _names[family] = r; }
      return r;
    }

    static string ManifestName(string full) {
      try {
        uint len = 0;
        Native.GetPackagePathByFullName(full, ref len, null);
        if (len == 0) return null;
        var sb = new StringBuilder((int)len + 1);
        if (Native.GetPackagePathByFullName(full, ref len, sb) != 0) return null;
        string man = Path.Combine(sb.ToString(), "AppxManifest.xml");
        if (!File.Exists(man)) return null;
        var doc = new XmlDocument();
        doc.XmlResolver = null;
        doc.Load(man);
        XmlNode dn = doc.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Properties']/*[local-name()='DisplayName']");
        XmlNode idn = doc.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']/@Name");
        if (dn == null) return null;
        string d = dn.InnerText.Trim();
        if (!d.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase)) return d.Length > 0 ? d : null;
        string res = d.Substring(12), name = idn != null ? idn.Value : "";
        var tries = new List<string>();
        if (res.StartsWith("//", StringComparison.Ordinal)) tries.Add("ms-resource:" + res);
        else if (res.StartsWith("/", StringComparison.Ordinal)) tries.Add("ms-resource://" + name + res);
        else {
          if (res.IndexOf('/') < 0) tries.Add("ms-resource://" + name + "/resources/" + res);
          tries.Add("ms-resource://" + name + "/" + res);
        }
        foreach (string t in tries) {
          var o = new StringBuilder(512);
          if (Native.SHLoadIndirectString("@{" + full + "?" + t + "}", o, o.Capacity, IntPtr.Zero) == 0 && o.Length > 0) return o.ToString();
        }
      } catch (Exception) { }
      return null;
    }

    static string DesktopName(string path) {
      lock (_lock) { string[] hit; if (_names.TryGetValue("\\" + path, out hit)) return hit[0]; }
      string n = null;
      try {
        if (File.Exists(path)) {
          string d = FileVersionInfo.GetVersionInfo(path).FileDescription;
          if (!string.IsNullOrEmpty(d) && d.Trim().Length > 0) n = d.Trim();
        }
      } catch (Exception) { }
      if (n == null) { try { n = Path.GetFileNameWithoutExtension(path); } catch (Exception) { n = path; } }
      lock (_lock) { _names["\\" + path] = new string[] { n, "1" }; }
      return n;
    }
  }
}
