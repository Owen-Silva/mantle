// SysAppsMore.cs - the rest of Settings > Apps for Mantle Settings (lane appsacct, 2026-09-29):
// Default apps, Optional features, Apps for websites, Video playback, Advanced app settings.
// (Installed apps is SysApps.cs; Startup apps stays Startup.cs, untouched.)
//
//   apps.defaults                   which app opens each file type and link type NOW: the shell's own
//                                   answer (AssocQueryString: friendly app name + ProgId), for the common
//                                   types plus every type this account has chosen an app for. READ-ONLY:
//                                   the User Choice Protection Driver (UCPD.sys) lets only Windows' own
//                                   Settings write those choices; the answer says whether it runs here.
//   apps.features                   Optional features (the Features on Demand in Windows' own capability
//                                   index, installed = CBS state 112) and the classic Windows features
//                                   (WMI Win32_OptionalFeature). READ-ONLY: adding or removing needs an
//                                   administrator and Windows Update (DISM), which Mantle does not drive.
//   apps.websites                   apps that open links for websites (each Store app's AppUriHandlers,
//                                   validated or not). READ-ONLY with the reason.
//   apps.video / apps.videoSet {name, on, dryRun?}   Video playback: HKCU VideoSettings (4 values).
//   apps.advanced / apps.advancedSet {name:'share', value 0-2, dryRun?}   Advanced app settings: where
//                                   to get apps + archive apps (HKLM: read-only with the reason), Share
//                                   across devices (HKCU CDP: written), app execution aliases (read).
// Every write names a value from a FIXED table below (never from the request), is read back, dryRun
// answers what it would write, and passive refuses it.
//
// PRIVACY: nothing here logs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysAppsMore {
    public static void Register(FeatureTable t) {
      t.Add("apps.defaults", Lanes.Slow, Defaults);
      t.Add("apps.features", Lanes.Slow, Features);
      t.Add("apps.websites", Lanes.Slow, Websites);
      t.Add("apps.video", Lanes.Slow, Video);
      t.Add("apps.videoSet", Lanes.Slow, VideoSet);
      t.Add("apps.advanced", Lanes.Slow, Advanced);
      t.Add("apps.advancedSet", Lanes.Slow, AdvancedSet);
    }

    // ------------------------------------------------------------------ default apps
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern int AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder outBuf, ref int outLen);
    const int FRIENDLYDOCNAME = 3, FRIENDLYAPPNAME = 4, PROGID = 20, IS_PROTOCOL = 0x1000, INIT_IGNOREUNKNOWN = 0x400, NOTRUNCATE = 0x20;

    static string Assoc(string what, int str, bool protocol) {
      int flags = INIT_IGNOREUNKNOWN | NOTRUNCATE | (protocol ? IS_PROTOCOL : 0);
      var sb = new StringBuilder(512);
      int n = sb.Capacity;
      try {
        int hr = AssocQueryString(flags, str, what, null, sb, ref n);
        if (hr != 0) return null;
        string s = sb.ToString().Trim();
        return s.Length == 0 ? null : s;
      } catch (Exception) { return null; }
    }

    static readonly string[] FILES = { ".htm", ".html", ".pdf", ".svg", ".txt", ".md", ".json", ".xml", ".csv", ".log", ".js", ".ts", ".css", ".py", ".ps1", ".bat",
      ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".ico", ".mp4", ".mkv", ".mov", ".avi", ".webm", ".mp3", ".wav", ".flac", ".m4a", ".ogg",
      ".zip", ".7z", ".rar", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf", ".eml", ".ics", ".url" };
    static readonly string[] LINKS = { "http", "https", "mailto", "tel", "callto", "ftp", "webcal", "microsoft-edge", "ms-screenclip", "steam", "discord", "spotify", "zoommtg" };
    const string FILEEXTS = @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts";
    const string URLS = @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations";

    static bool Chosen(string key) {
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.OpenSubKey(key, false)) {
          if (k == null) return false;
          foreach (string s in k.GetSubKeyNames()) if (s.StartsWith("UserChoice", StringComparison.OrdinalIgnoreCase)) return true;
        }
      } catch (Exception) { }
      return false;
    }
    static List<string> ChosenKeys(string root, bool files) {
      var out1 = new List<string>();
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.OpenSubKey(root, false)) {
          if (k == null) return out1;
          foreach (string s in k.GetSubKeyNames()) {
            if (files && !s.StartsWith(".")) continue;
            if (s.Length > 40) continue;
            if (Chosen(root + "\\" + s)) out1.Add(s.ToLowerInvariant());
          }
        }
      } catch (Exception) { }
      return out1;
    }

    public static IDictionary Ucpd() {
      string st = null; bool running = false;
      try { using (var sc = new ServiceController("UCPD")) { st = sc.Status.ToString(); running = sc.Status == ServiceControllerStatus.Running; } }
      catch (Exception) { st = null; }
      string w;
      long? start = SysCommon.ReadNumber("HKLM", @"SYSTEM\CurrentControlSet\Services\UCPD", "Start", out w);
      string why = running || (start != null && start.Value != 4)
        ? "Read only: Windows' User Choice Protection Driver (UCPD.sys) runs on this PC and blocks every program except Windows' own Settings from changing default apps. That is Microsoft's lock, not a Mantle limit."
        : "Read only: Windows signs each default-app choice with a hash that only its own Settings computes, so a choice any other program writes is thrown away.";
      return Json.Obj("present", start != null || st != null, "running", running, "state", st, "readOnly", why);
    }

    static IDictionary One(string name, bool link) {
      string app = Assoc(name, FRIENDLYAPPNAME, link);
      string prog = Assoc(name, PROGID, link);
      string doc = link ? null : Assoc(name, FRIENDLYDOCNAME, false);
      return Json.Obj("name", name, "kind", link ? "link" : "file", "app", app, "progId", prog, "type", doc,
                      "chosen", Chosen((link ? URLS : FILEEXTS) + "\\" + name));
    }

    static string Defaults(Dictionary<string, object> req, ref object result) {
      var files = new SortedSet<string>(StringComparer.Ordinal);
      foreach (string f in FILES) files.Add(f);
      foreach (string f in ChosenKeys(FILEEXTS, true)) files.Add(f);
      var links = new List<string>(LINKS);
      foreach (string l in ChosenKeys(URLS, false)) if (!links.Contains(l)) links.Add(l);
      var fi = new List<object>();
      foreach (string f in files) { if (fi.Count >= 400) break; fi.Add(One(f, false)); }
      var li = new List<object>();
      foreach (string l in links) { if (li.Count >= 120) break; IDictionary x = One(l, true); if (x["app"] != null || (bool)x["chosen"]) li.Add(x); }
      result = Json.Obj("ok", true, "files", fi, "links", li, "browser", One("http", true)["app"], "mail", One("mailto", true)["app"], "pdf", One(".pdf", false)["app"],
                        "ucpd", Ucpd());
      return null;
    }

    // ------------------------------------------------------------------ optional features
    static readonly Dictionary<string, string> CAPS = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
      { "App.StepsRecorder", "Steps Recorder" }, { "Browser.InternetExplorer", "Internet Explorer mode" }, { "Hello.Face", "Windows Hello Face" },
      { "Language.Basic", "Language: basic typing" }, { "Language.Handwriting", "Language: handwriting" }, { "Language.OCR", "Language: optical character recognition" },
      { "Language.Speech", "Language: speech recognition" }, { "Language.TextToSpeech", "Language: text-to-speech" }, { "MathRecognizer", "Math Recognizer" },
      { "Media.WindowsMediaPlayer", "Windows Media Player Legacy" }, { "Microsoft.Windows.Notepad", "Notepad (system)" }, { "Microsoft.Windows.Notepad.System", "Notepad (system)" },
      { "Microsoft.Windows.PowerShell.ISE", "Windows PowerShell ISE" }, { "Microsoft.Windows.WordPad", "WordPad" }, { "Microsoft.Windows.MSPaint", "Paint (system)" },
      { "OpenSSH.Client", "OpenSSH Client" }, { "OpenSSH.Server", "OpenSSH Server" }, { "Print.Management.Console", "Print Management" },
      { "Windows.Client.ShellComponents", "Windows shell components" }, { "WMIC", "WMIC" }, { "VBSCRIPT", "VBScript" }, { "Microsoft.Wallpapers.Extended", "Extended wallpapers" },
      { "DirectX.Configuration.Database", "DirectX Configuration Database" }, { "Print.Fax.Scan", "Windows Fax and Scan" }, { "Rsat", "Remote Server Administration Tools" },
      { "Microsoft.Windows.Ethernet.Client", "Ethernet drivers" }, { "Microsoft.Windows.Wifi.Client", "Wi-Fi drivers" }, { "Tools.Graphics.DirectX", "Graphics Tools" },
    };
    const string CBS = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing";

    static string CapLabel(string key) {
      string k = key;
      int dot = k.LastIndexOf('.');
      string s;
      if (CAPS.TryGetValue(k, out s)) return s;
      // "Hello.Face.20134" / "Language.Basic~~~en-US": the family name, then what follows
      foreach (var kv in CAPS)
        if (k.StartsWith(kv.Key + ".", StringComparison.OrdinalIgnoreCase) || k.StartsWith(kv.Key + "~", StringComparison.OrdinalIgnoreCase))
          return kv.Value + " (" + k.Substring(kv.Key.Length + 1).Replace('.', ' ').Replace("~", " ").Trim() + ")";
      return dot > 0 ? k.Replace('.', ' ') : k;
    }

    static List<object> Capabilities(out string why) {
      why = null;
      var items = new List<object>();
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey idx = b.OpenSubKey(CBS + @"\CapabilityIndex", false))
        using (RegistryKey pk = b.OpenSubKey(CBS + @"\Packages", false)) {
          if (idx == null || pk == null) { why = "Windows' capability index could not be opened"; return items; }
          foreach (string cap in idx.GetSubKeyNames()) {
            bool installed = false, pending = false;
            try {
              using (RegistryKey c = idx.OpenSubKey(cap, false)) {
                if (c == null) continue;
                foreach (string pkg in c.GetValueNames()) {
                  if (pkg.IndexOf("~~", StringComparison.Ordinal) < 0 || pkg.Length > 200) continue;   // language parts ride along
                  using (RegistryKey p = pk.OpenSubKey(pkg, false)) {
                    if (p == null) continue;
                    object v = p.GetValue("CurrentState", null);
                    int st = v is int ? (int)v : -1;
                    if (st == 0x70 || st == 0x80) installed = true;
                    else if (st == 0x60) pending = true;   // install pending (0x50 is superseded)
                  }
                }
              }
            } catch (Exception) { }
            items.Add(Json.Obj("name", cap, "label", CapLabel(cap), "installed", installed, "pending", !installed && pending));
          }
        }
      } catch (Exception ex) { why = "Windows' capability index could not be read: " + SysCommon.Why(ex); }
      return items;
    }

    static List<object> WindowsFeatures(out string why) {
      why = null;
      var items = new List<object>();
      try {
        using (var s = new ManagementObjectSearcher(@"root\cimv2", "SELECT Name, Caption, InstallState FROM Win32_OptionalFeature")) {
          s.Options.Timeout = TimeSpan.FromSeconds(20);
          foreach (ManagementObject o in s.Get()) {
            using (o) {
              int st = Convert.ToInt32(o["InstallState"] ?? 0, CultureInfo.InvariantCulture);
              string name = o["Name"] as string, cap = o["Caption"] as string;
              if (string.IsNullOrEmpty(name)) continue;
              items.Add(Json.Obj("name", name, "label", string.IsNullOrEmpty(cap) ? name : cap, "state", st == 1 ? "enabled" : st == 3 ? "absent" : "disabled"));
            }
          }
        }
      } catch (Exception ex) { why = "Windows' feature list (WMI) could not be read: " + SysCommon.Why(ex); }
      return items;
    }

    const string FEATURES_WHY = "Read only: adding or removing a feature needs an administrator and Windows Update (DISM downloads it), and Windows only lets its own Settings or DISM do that. Mantle lists what is installed.";

    static string Features(Dictionary<string, object> req, ref object result) {
      string cw, fw;
      List<object> caps = Capabilities(out cw);
      List<object> feats = WindowsFeatures(out fw);
      result = Json.Obj("ok", true, "capabilities", caps, "capabilitiesWhy", cw, "features", feats, "featuresWhy", fw, "readOnly", FEATURES_WHY);
      return null;
    }

    // ------------------------------------------------------------------ apps for websites
    const string APPDATA = @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData";
    const string WEBSITES_WHY = "Read only: Windows keeps this switch in each app's own link-handler record and changes it only through its own Settings; there is no documented setting another program may write.";

    static string Websites(Dictionary<string, object> req, ref object result) {
      var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      try {
        Type t = SysApps.WinRt("Windows.Management.Deployment.PackageManager", "Windows.Management");
        object pm = t == null ? null : Activator.CreateInstance(t);
        if (pm != null) {
          foreach (object p in (IEnumerable)t.GetMethod("FindPackagesForUser", new[] { typeof(string) }).Invoke(pm, new object[] { "" })) {
            try {
              object pid = p.GetType().GetProperty("Id").GetValue(p, null);
              string fam = pid.GetType().GetProperty("FamilyName").GetValue(pid, null) as string;
              string dn = p.GetType().GetProperty("DisplayName").GetValue(p, null) as string;
              if (fam != null && !string.IsNullOrWhiteSpace(dn) && !names.ContainsKey(fam)) names[fam] = dn;
            } catch (Exception) { }
          }
        }
      } catch (Exception) { }
      var items = new List<object>();
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey root = b.OpenSubKey(APPDATA, false)) {
          if (root != null) {
            foreach (string fam in root.GetSubKeyNames()) {
              try {
                using (RegistryKey h = root.OpenSubKey(fam + @"\AppUriHandlers", false)) {
                  if (h == null) continue;
                  var hosts = new List<object>();
                  int ok = 0;
                  foreach (string host in h.GetSubKeyNames()) {
                    if (host.Length > 120) continue;
                    bool valid = false;
                    using (RegistryKey x = h.OpenSubKey(host, false)) valid = x != null && x.GetValue("LastSuccessfulValidationTime", null) != null;
                    if (valid) ok++;
                    hosts.Add(Json.Obj("host", host, "validated", valid));
                  }
                  if (hosts.Count == 0) continue;
                  string dn;
                  if (!names.TryGetValue(fam, out dn)) dn = fam.Split('_')[0];
                  items.Add(Json.Obj("key", SysApps.KeyOf("u", fam), "name", dn, "hosts", hosts, "validated", ok));
                }
              } catch (Exception) { }
            }
          }
        }
      } catch (Exception ex) { result = Json.Obj("ok", false, "reason", "The apps for websites could not be read: " + SysCommon.Why(ex)); return null; }
      items.Sort((x, y) => string.Compare((string)((IDictionary)x)["name"], (string)((IDictionary)y)["name"], StringComparison.CurrentCultureIgnoreCase));
      result = Json.Obj("ok", true, "items", items, "readOnly", WEBSITES_WHY);
      return null;
    }

    // ------------------------------------------------------------------ video playback (HKCU)
    const string VIDEO = @"Software\Microsoft\Windows\CurrentVersion\VideoSettings";
    // name -> value name, what it is, Windows' default when the value is missing
    static readonly string[][] VIDEO_VALUES = {
      new[] { "hdr", "EnableHDRForPlayback", "Stream HDR video", "0" },
      new[] { "enhance", "EnableAutoEnhanceDuringPlayback", "Automatically process video to enhance it", "0" },
      new[] { "quality", "VideoQualityOnBattery", "On battery, optimize for video quality (off = battery life)", "0" },
      new[] { "lowres", "AllowLowResolution", "On battery, play video at a lower resolution", "0" },
    };
    static string[] VideoRow(string name) {
      foreach (string[] r in VIDEO_VALUES) if (r[0] == name) return r;
      return null;
    }
    static IDictionary VideoState() {
      var o = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string[] r in VIDEO_VALUES) {
        string why;
        long? v = SysCommon.ReadNumber("HKCU", VIDEO, r[1], out why);
        o[r[0]] = Json.Obj("on", v == null ? r[3] == "1" : v.Value != 0, "set", v != null, "value", r[1], "label", r[2]);
      }
      return o;
    }
    static string Video(Dictionary<string, object> req, ref object result) {
      result = Json.Obj("ok", true, "values", VideoState(), "note", "Windows reads these when a video starts, so a change applies to the next video you play");
      return null;
    }
    static string VideoSet(Dictionary<string, object> req, ref object result) {
      string name = Json.GetString(req, "name");
      string[] row = name == null ? null : VideoRow(name);
      if (row == null) return "apps.videoSet needs name: hdr, enhance, quality or lowres";
      bool on;
      string e = SysCommon.Bool(req, "on", "apps.videoSet", out on);
      if (e != null) return e;
      string w;
      object before = SysCommon.Read("HKCU", VIDEO, row[1], out w);
      var writes = SysCommon.List(SysCommon.RegWrite("HKCU", VIDEO, row[1], on ? 1 : 0, false, before));
      string would = "turn \"" + row[2] + "\" " + (on ? "on" : "off") + " (HKCU VideoSettings " + row[1] + " = " + (on ? 1 : 0) + ")";
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary d = SysCommon.Dry(writes, before, null, false);
        d["would"] = would;
        result = d;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would.Replace("turn", "turned"));
      string bad = SysCommon.WriteNumber("HKCU", VIDEO, row[1], on ? 1 : 0, false);
      if (bad != null) return "apps.videoSet: " + bad;
      result = Json.Obj("ok", true, "now", on, "values", VideoState());
      return null;
    }

    // ------------------------------------------------------------------ advanced app settings
    const string CDP = @"Software\Microsoft\Windows\CurrentVersion\CDP";
    static readonly string[] SHARE_WORDS = { "Off", "My devices only", "Everyone nearby" };
    static readonly Dictionary<string, string> AIC = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
      { "Anywhere", "Anywhere" }, { "Recommendations", "Anywhere, but let me know if there's a comparable app in the Microsoft Store" },
      { "PreferStore", "Anywhere, but warn me before installing an app that's not from the Microsoft Store" }, { "StoreOnly", "The Microsoft Store only" },
    };

    static IDictionary AdvancedState() {
      string w;
      object aic = SysCommon.Read("HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer", "AicEnabled", out w);
      object pol = SysCommon.Read("HKLM", @"SOFTWARE\Policies\Microsoft\Windows Defender\SmartScreen", "ConfigureAppInstallControl", out w);
      string aicS = aic as string, polS = pol as string, words;
      string eff = polS ?? aicS ?? "Anywhere";
      if (!AIC.TryGetValue(eff, out words)) words = eff;
      string sourceWhy = polS != null ? "Read only: a policy on this PC sets it (SmartScreen ConfigureAppInstallControl)"
        : "Read only here: Windows keeps it for the whole PC (HKLM Explorer AicEnabled), which needs an administrator; Mantle has no administrator action for it";

      string sid = null;
      try { using (WindowsIdentity wi = WindowsIdentity.GetCurrent()) sid = wi.User == null ? null : wi.User.Value; } catch (Exception) { }
      long? arch = sid == null ? null : SysCommon.ReadNumber("HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\InstallService\Stubification\" + sid, "EnableAppOffloading", out w);
      long? archPol = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\Appx", "AllowAutomaticAppArchiving", out w);

      long? share = SysCommon.ReadNumber("HKCU", CDP, "RomeSdkChannelUserAuthzPolicy", out w);
      long? sharePol = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\System", "EnableCdp", out w);

      var aliases = new List<object>();
      string aliasWhy = null;
      try {
        string dir = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\WindowsApps");
        if (Directory.Exists(dir)) {
          foreach (string f in Directory.GetFiles(dir, "*.exe")) { if (aliases.Count >= 200) break; aliases.Add(System.IO.Path.GetFileName(f)); }
          aliases.Sort((a, b) => string.Compare((string)a, (string)b, StringComparison.OrdinalIgnoreCase));
        }
      } catch (Exception ex) { aliasWhy = "The alias folder could not be read: " + SysCommon.Why(ex); }

      return Json.Obj(
        "source", Json.Obj("value", eff, "words", words, "set", aicS != null || polS != null, "policy", polS != null, "readOnly", sourceWhy),
        "archive", Json.Obj("on", archPol != null ? archPol.Value != 0 : arch == null || arch.Value != 0, "set", arch != null, "policy", archPol != null,
          "readOnly", archPol != null ? "Read only: a policy on this PC sets it (Appx AllowAutomaticAppArchiving)"
            : "Read only here: Windows keeps it with the Store install service for this account under HKLM, which needs an administrator"),
        "share", Json.Obj("value", share == null ? 1 : Math.Max(0, Math.Min(2, share.Value)), "set", share != null,
          "locked", sharePol == 0 ? "Read only: a policy on this PC turns the Connected Devices Platform off (System EnableCdp = 0)" : null),
        "aliases", aliases, "aliasWhy", aliasWhy,
        "aliasReadOnly", "Read only: turning an alias off removes Windows' own app-execution link for it, which only Windows' Settings manages");
    }

    static string Advanced(Dictionary<string, object> req, ref object result) {
      IDictionary st = AdvancedState();
      st["ok"] = true;
      result = st;
      return null;
    }

    static string AdvancedSet(Dictionary<string, object> req, ref object result) {
      string name = Json.GetString(req, "name");
      if (name != "share") return "apps.advancedSet needs name: share (the other advanced settings are read only)";
      long v;
      string e = SysCommon.Number(req, "value", "apps.advancedSet", 0, 2, out v);
      if (e != null) return e;
      IDictionary st = AdvancedState();
      string locked = (string)((IDictionary)st["share"])["locked"];
      if (locked != null) return locked;
      string w;
      object b1 = SysCommon.Read("HKCU", CDP, "RomeSdkChannelUserAuthzPolicy", out w);
      object b2 = SysCommon.Read("HKCU", CDP, "CdpSessionUserAuthzPolicy", out w);
      var writes = SysCommon.List(SysCommon.RegWrite("HKCU", CDP, "RomeSdkChannelUserAuthzPolicy", v, false, b1),
                                  SysCommon.RegWrite("HKCU", CDP, "CdpSessionUserAuthzPolicy", v, false, b2));
      string would = "set Share across devices to " + SHARE_WORDS[v] + " (HKCU CDP RomeSdkChannelUserAuthzPolicy and CdpSessionUserAuthzPolicy = " + v + ")";
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary d = SysCommon.Dry(writes, b1, null, false);
        d["would"] = would;
        result = d;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      string bad = SysCommon.WriteNumber("HKCU", CDP, "RomeSdkChannelUserAuthzPolicy", v, false) ?? SysCommon.WriteNumber("HKCU", CDP, "CdpSessionUserAuthzPolicy", v, false);
      if (bad != null) return "apps.advancedSet: " + bad;
      result = Json.Obj("ok", true, "now", v, "words", SHARE_WORDS[v]);
      return null;
    }
  }
}
