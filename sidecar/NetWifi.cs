// NetWifi.cs - Settings > Network & internet > Wi-Fi: the KNOWN networks (saved profiles) and the
// connected network's properties. Lane net2, 2026-09-28. The list of networks in range, connect and
// disconnect stay in Wlan.cs (the bar's quick settings use them).
//
//   netwifi.known {iface?}                                   every saved profile, read from its XML
//   netwifi.forget {profile, iface?, dryRun}                  WlanDeleteProfile
//   netwifi.set {profile, iface?, autoConnect?, hidden?, randomMac?, metered?, dryRun}
//        autoConnect/hidden/randomMac: WlanGetProfile -> edit the XML -> WlanSetProfile
//        metered: netsh wlan set profileparameter cost= (Windows has no API for a profile's cost)
//   netwifi.props {iface?}                                   the connected network: SSID, protocol,
//        security, band, channel, link speed, addresses, DNS (typed in or DHCP), MAC, driver
//
// MEASURED ON OWEN'S PC (read-only probe, 2026-09-28): 46 saved profiles, every one carrying
// MacRandomization{v3}/enableRandomization (all false) + randomizationSeed; none carries a cost
// element, and granted access 0x70023 (WLAN_WRITE_ACCESS) on all 46, so a normal user may edit
// and delete them. The key stays protected (encrypted by the Wi-Fi service): profiles are read
// WITHOUT WLAN_PROFILE_GET_PLAINTEXT_KEY, so no key ever reaches this process in plain text, and
// every dry run's XML has keyMaterial replaced by REDACTED.
//
// PRIVACY: SSIDs and profile names go in replies (the page shows them), never in a log line.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Xml;

namespace Mantle {
  [MantleFeature]
  static class NetWifi {
    const uint PROFILE_GROUP_POLICY = 1, PROFILE_USER = 2;
    const uint WRITE_BITS = 0x70023;          // WLAN_WRITE_ACCESS
    const uint OP_CURRENT_CONNECTION = 7, OP_CHANNEL = 8;

    static class Native {
      [DllImport("wlanapi.dll")] public static extern uint WlanOpenHandle(uint c, IntPtr r, out uint n, out IntPtr h);
      [DllImport("wlanapi.dll")] public static extern uint WlanCloseHandle(IntPtr h, IntPtr r);
      [DllImport("wlanapi.dll")] public static extern uint WlanEnumInterfaces(IntPtr h, IntPtr r, out IntPtr list);
      [DllImport("wlanapi.dll")] public static extern uint WlanQueryInterface(IntPtr h, ref Guid g, uint op, IntPtr r, out uint size, out IntPtr data, IntPtr vt);
      [DllImport("wlanapi.dll")] public static extern uint WlanGetProfileList(IntPtr h, ref Guid g, IntPtr r, out IntPtr list);
      [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)]
      public static extern uint WlanGetProfile(IntPtr h, ref Guid g, string name, IntPtr r, out IntPtr xml, ref uint flags, out uint access);
      [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)]
      public static extern uint WlanSetProfile(IntPtr h, ref Guid g, uint flags, string xml, string sd, bool overwrite, IntPtr r, out uint reason);
      [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)]
      public static extern uint WlanDeleteProfile(IntPtr h, ref Guid g, string name, IntPtr r);
      [DllImport("wlanapi.dll")]
      public static extern uint WlanGetNetworkBssList(IntPtr h, ref Guid g, IntPtr ssid, int bssType, bool sec, IntPtr r, out IntPtr list);
      [DllImport("wlanapi.dll")] public static extern void WlanFreeMemory(IntPtr p);
    }

    public static void Register(FeatureTable t) {
      t.Add("netwifi.known", Lanes.Slow, Known);
      t.Add("netwifi.forget", Lanes.Slow, Forget);
      t.Add("netwifi.set", Lanes.Slow, Set);
      t.Add("netwifi.props", Lanes.Slow, Props);
    }

    // ------------------------------------------------------------------ plumbing

    sealed class Iface { public Guid G; public string Desc; public uint State; }

    static IntPtr Open(out string why) {
      uint neg; IntPtr h;
      uint rc = Native.WlanOpenHandle(2, IntPtr.Zero, out neg, out h);
      why = rc == 0 ? null : rc == 1062 ? "the Wi-Fi service (WLAN AutoConfig) is not running" : "the Wi-Fi service did not answer (error " + rc + ")";
      return rc == 0 ? h : IntPtr.Zero;
    }

    static List<Iface> Ifaces(IntPtr h) {
      var l = new List<Iface>();
      IntPtr list;
      if (Native.WlanEnumInterfaces(h, IntPtr.Zero, out list) != 0 || list == IntPtr.Zero) return l;
      try {
        int n = Marshal.ReadInt32(list);
        for (int i = 0; i < n; i++) {
          IntPtr p = new IntPtr(list.ToInt64() + 8 + (long)i * 532);
          var b = new byte[16];
          Marshal.Copy(p, b, 0, 16);
          l.Add(new Iface { G = new Guid(b), Desc = Marshal.PtrToStringUni(new IntPtr(p.ToInt64() + 16)), State = (uint)Marshal.ReadInt32(p, 528) });
        }
      } finally { Native.WlanFreeMemory(list); }
      return l;
    }

    /// The interface asked for (iface: its {GUID}), else the connected one, else the first.
    static string Pick(IntPtr h, Dictionary<string, object> req, out Iface f) {
      f = null;
      string want = Json.GetString(req, "iface");
      List<Iface> all = Ifaces(h);
      if (all.Count == 0) return "none";
      foreach (Iface x in all) {
        if (want != null) { if (string.Equals(x.G.ToString("B"), want, StringComparison.OrdinalIgnoreCase)) { f = x; return null; } }
        else if (x.State == 1) { f = x; return null; }
      }
      if (want != null) return "there is no Wi-Fi adapter with that GUID";
      f = all[0];
      return null;
    }

    sealed class Conn {
      public string Profile, Ssid, Bssid;
      public uint Phy, Quality, Rx, Tx, Auth, Cipher, State;
      public byte[] SsidRaw;
    }

    /// WLAN_CONNECTION_ATTRIBUTES (604 bytes): null when not connected.
    static Conn Current(IntPtr h, Guid g) {
      uint size; IntPtr d;
      if (Native.WlanQueryInterface(h, ref g, OP_CURRENT_CONNECTION, IntPtr.Zero, out size, out d, IntPtr.Zero) != 0 || d == IntPtr.Zero) return null;
      try {
        if (size < 604) return null;
        var c = new Conn();
        c.State = (uint)Marshal.ReadInt32(d, 0);
        c.Profile = Marshal.PtrToStringUni(new IntPtr(d.ToInt64() + 8));
        int len = Math.Min(32, Marshal.ReadInt32(d, 520));
        c.SsidRaw = new byte[Math.Max(0, len)];
        Marshal.Copy(new IntPtr(d.ToInt64() + 524), c.SsidRaw, 0, c.SsidRaw.Length);
        c.Ssid = Text(c.SsidRaw);
        var mac = new byte[6];
        Marshal.Copy(new IntPtr(d.ToInt64() + 560), mac, 0, 6);
        c.Bssid = BitConverter.ToString(mac).Replace('-', ':');
        c.Phy = (uint)Marshal.ReadInt32(d, 568);
        c.Quality = (uint)Marshal.ReadInt32(d, 576);
        c.Rx = (uint)Marshal.ReadInt32(d, 580);
        c.Tx = (uint)Marshal.ReadInt32(d, 584);
        c.Auth = (uint)Marshal.ReadInt32(d, 596);
        c.Cipher = (uint)Marshal.ReadInt32(d, 600);
        return c;
      } finally { Native.WlanFreeMemory(d); }
    }

    static string Text(byte[] b) {
      try { return new UTF8Encoding(false, true).GetString(b); } catch (Exception) { return null; }
    }

    static XmlElement Kid(XmlNode n, string local) {
      if (n == null) return null;
      foreach (XmlNode c in n.ChildNodes) if (c is XmlElement && c.LocalName == local) return (XmlElement)c;
      return null;
    }
    static string KidText(XmlNode n, params string[] path) {
      foreach (string p in path) { n = Kid(n, p); if (n == null) return null; }
      return n.InnerText;
    }

    sealed class Saved { public string Name, Xml; public uint Flags, Access; }

    static List<Saved> Profiles(IntPtr h, Guid g, out string why) {
      why = null;
      var l = new List<Saved>();
      IntPtr list;
      uint rc = Native.WlanGetProfileList(h, ref g, IntPtr.Zero, out list);
      if (rc != 0) { why = "Windows did not list the saved networks (error " + rc + ")"; return l; }
      try {
        int n = Marshal.ReadInt32(list);
        for (int i = 0; i < n; i++) {
          IntPtr p = new IntPtr(list.ToInt64() + 8 + (long)i * 516);
          var s = new Saved { Name = Marshal.PtrToStringUni(p), Flags = (uint)Marshal.ReadInt32(p, 512) };
          s.Xml = GetXml(h, g, s.Name, out s.Access);
          l.Add(s);
        }
      } finally { Native.WlanFreeMemory(list); }
      return l;
    }

    static string GetXml(IntPtr h, Guid g, string name, out uint access) {
      IntPtr x; uint fl = 0;
      access = 0;
      if (Native.WlanGetProfile(h, ref g, name, IntPtr.Zero, out x, ref fl, out access) != 0 || x == IntPtr.Zero) return null;
      try { return Marshal.PtrToStringUni(x); } finally { Native.WlanFreeMemory(x); }
    }

    static string SecurityWords(string auth, string enc, bool transition, bool oneX) {
      switch (auth ?? "") {
        case "open": return enc == "WEP" ? "WEP" : "Open";
        case "shared": return "Shared key (WEP)";
        case "OWE": return "Enhanced Open (OWE)";
        case "WPAPSK": return "WPA-Personal";
        case "WPA2PSK": return "WPA2-Personal";
        case "WPA3SAE": return transition ? "WPA2/WPA3-Personal" : "WPA3-Personal";
        case "WPA": return "WPA-Enterprise";
        case "WPA2": return "WPA2-Enterprise";
        case "WPA3": case "WPA3ENT192": case "WPA3ENT": return "WPA3-Enterprise";
        default: return oneX ? auth + " (enterprise)" : auth;
      }
    }

    static IDictionary Describe(Saved s, string connectedProfile) {
      var doc = new XmlDocument();
      try { doc.LoadXml(s.Xml); } catch (Exception) {
        return Json.Obj("profile", s.Name, "ssid", null, "reason", "Windows gave a profile Mantle could not read");
      }
      XmlElement root = doc.DocumentElement;
      string ssid = KidText(root, "SSIDConfig", "SSID", "name");
      string hex = KidText(root, "SSIDConfig", "SSID", "hex");
      string nb = KidText(root, "SSIDConfig", "nonBroadcast");
      string mode = KidText(root, "connectionMode");
      XmlElement ae = Kid(Kid(Kid(root, "MSM"), "security"), "authEncryption");
      string auth = KidText(ae, "authentication"), enc = KidText(ae, "encryption");
      bool transition = KidText(ae, "transitionMode") == "true", oneX = KidText(ae, "useOneX") == "true";
      XmlElement mr = Kid(root, "MacRandomization");
      string rnd = mr == null ? null : KidText(mr, "enableRandomization") != "true" ? "off" : KidText(mr, "randomizeEveryday") == "true" ? "daily" : "on";
      bool policy = (s.Flags & PROFILE_GROUP_POLICY) != 0;
      bool canEdit = !policy && (s.Access & WRITE_BITS) == WRITE_BITS;
      return Json.Obj(
        "profile", s.Name, "ssid", ssid, "hex", hex, "security", SecurityWords(auth, enc, transition, oneX),
        "auth", auth, "encryption", enc, "enterprise", oneX,
        "autoConnect", mode == "auto", "hidden", nb == "true", "randomMac", rnd,
        "randomMacWhy", rnd == null ? "this saved network has no setting of its own, so Windows' default applies" : null,
        "keySaved", Kid(Kid(Kid(root, "MSM"), "security"), "sharedKey") != null,
        "allUsers", (s.Flags & PROFILE_USER) == 0, "policy", policy,
        "connected", connectedProfile != null && connectedProfile == s.Name,
        "canEdit", canEdit,
        "editWhy", policy ? "your organization's policy set up this network, so only it can change it"
                  : canEdit ? null : "Windows does not let this account change this saved network (it belongs to another user or an administrator)");
    }

    static string NoWifi(ref object result, string what) {
      result = Json.Obj("ok", true, "present", false, what, new List<object>(), "reason", "This PC has no Wi-Fi adapter");
      return null;
    }

    // ------------------------------------------------------------------ netwifi.known

    static string Known(Dictionary<string, object> req, ref object result) {
      string why;
      IntPtr h = Open(out why);
      if (h == IntPtr.Zero) return "netwifi.known: " + why;
      try {
        Iface f;
        string perr = Pick(h, req, out f);
        if (perr == "none") return NoWifi(ref result, "profiles");
        if (perr != null) return "netwifi.known: " + perr;
        Conn c = Current(h, f.G);
        List<Saved> all = Profiles(h, f.G, out why);
        var items = new List<object>();
        foreach (Saved s in all) {
          if (s.Xml == null) { items.Add(Json.Obj("profile", s.Name, "ssid", null, "reason", "Windows did not hand over this saved network")); continue; }
          items.Add(Describe(s, c == null ? null : c.Profile));
        }
        result = Json.Obj("ok", why == null, "present", true, "iface", f.G.ToString("B"), "adapter", f.Desc,
                          "profiles", items, "reason", why);
        return null;
      } finally { Native.WlanCloseHandle(h, IntPtr.Zero); }
    }

    // ------------------------------------------------------------------ writes

    static string ProfileArg(Dictionary<string, object> req, string cmd, out string profile) {
      profile = Json.GetString(req, "profile");
      if (string.IsNullOrEmpty(profile)) return cmd + " needs profile: a saved network's profile name";
      if (profile.Length > 255) return cmd + ": a profile name is at most 255 characters";
      return null;
    }

    /// Opens the interface and finds the saved profile. On success h is open (the caller closes it).
    static string Resolve(Dictionary<string, object> req, string cmd, string profile, out IntPtr h, out Iface f, out Saved s) {
      h = IntPtr.Zero; f = null; s = null;
      string why;
      h = Open(out why);
      if (h == IntPtr.Zero) return cmd + ": " + why;
      string perr = Pick(h, req, out f);
      if (perr == "none") return cmd + ": this PC has no Wi-Fi adapter";
      if (perr != null) return cmd + ": " + perr;
      List<Saved> all = Profiles(h, f.G, out why);
      if (why != null) return cmd + ": " + why;
      foreach (Saved x in all) if (x.Name == profile) { s = x; break; }
      if (s == null) return cmd + ": Windows has no saved network with that profile name";
      if (s.Xml == null) return cmd + ": Windows did not hand over that saved network";
      if ((s.Flags & PROFILE_GROUP_POLICY) != 0) return cmd + ": your organization's policy set up this network, so only it can change it";
      if ((s.Access & WRITE_BITS) != WRITE_BITS) return cmd + ": Windows does not let this account change this saved network";
      return null;
    }

    static string Forget(Dictionary<string, object> req, ref object result) {
      string profile;
      string err = ProfileArg(req, "netwifi.forget", out profile);
      if (err != null) return err;
      bool dry = Json.GetBool(req, "dryRun", false);
      IntPtr h = IntPtr.Zero; Iface f; Saved s;
      try {
        err = Resolve(req, "netwifi.forget", profile, out h, out f, out s);
        if (err != null) return err;
        Conn c = Current(h, f.G);
        bool on = c != null && c.Profile == profile;
        string would = "forget this saved network" + (on ? " (Wi-Fi disconnects from it now)" : "") + ": its password is deleted and it no longer connects by itself";
        if (dry) { result = Json.Obj("ok", true, "dryRun", true, "would", would, "connected", on, "reason", null); return null; }
        if (Program.Passive) return SysCommon.Passive(would);
        uint rc = Native.WlanDeleteProfile(h, ref f.G, profile, IntPtr.Zero);
        if (rc != 0) return "netwifi.forget: Windows did not forget the network (error " + rc + ")";
        result = Json.Obj("ok", true, "forgotten", true, "now", null, "reason", null);
        return null;
      } finally { if (h != IntPtr.Zero) Native.WlanCloseHandle(h, IntPtr.Zero); }
    }

    const string V1 = "http://www.microsoft.com/networking/WLAN/profile/v1";
    const string V3 = "http://www.microsoft.com/networking/WLAN/profile/v3";

    static XmlElement Ensure(XmlDocument doc, XmlElement parent, string local, string ns, XmlNode before) {
      XmlElement e = Kid(parent, local);
      if (e != null) return e;
      e = doc.CreateElement(local, ns);
      if (before != null) parent.InsertBefore(e, before); else parent.AppendChild(e);
      return e;
    }

    /// Replaces every keyMaterial's text: a dry run's XML never carries the (protected) key.
    public static string Redact(string xml) {
      var doc = new XmlDocument();
      doc.LoadXml(xml);
      foreach (XmlNode n in doc.GetElementsByTagName("keyMaterial", V1)) n.InnerText = "REDACTED";
      return doc.OuterXml;
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      const string cmd = "netwifi.set";
      string profile;
      string err = ProfileArg(req, cmd, out profile);
      if (err != null) return err;
      bool dry = Json.GetBool(req, "dryRun", false);
      bool? auto = null, hidden = null, metered = null;
      string rnd = null;
      bool b;
      if (req.ContainsKey("autoConnect")) { err = SysCommon.Bool(req, "autoConnect", cmd, out b); if (err != null) return err; auto = b; }
      if (req.ContainsKey("hidden")) { err = SysCommon.Bool(req, "hidden", cmd, out b); if (err != null) return err; hidden = b; }
      if (req.ContainsKey("metered")) { err = SysCommon.Bool(req, "metered", cmd, out b); if (err != null) return err; metered = b; }
      if (req.ContainsKey("randomMac")) {
        rnd = Json.GetString(req, "randomMac");
        if (rnd != "off" && rnd != "on" && rnd != "daily") return cmd + " needs randomMac: off, on or daily";
      }
      if (auto == null && hidden == null && metered == null && rnd == null) return cmd + " needs something to change: autoConnect, hidden, randomMac or metered";
      if (metered != null && (auto != null || hidden != null || rnd != null)) return cmd + ": change metered on its own (Windows keeps it apart from the profile)";
      if (metered != null && (profile.IndexOf('"') >= 0 || profile.IndexOf('\\') >= 0)) return cmd + ": Mantle cannot mark a network metered when its profile name has a quote or backslash in it";

      IntPtr h = IntPtr.Zero; Iface f; Saved s;
      try {
        err = Resolve(req, cmd, profile, out h, out f, out s);
        if (err != null) return err;
        if (metered != null) return Metered(profile, metered.Value, dry, ref result);

        var doc = new XmlDocument();
        doc.LoadXml(s.Xml);
        XmlElement root = doc.DocumentElement;
        var changes = new List<object>();
        if (auto != null) {
          XmlElement m = Ensure(doc, root, "connectionMode", V1, Kid(root, "MSM"));
          string want = auto.Value ? "auto" : "manual";
          if (m.InnerText != want) { changes.Add(auto.Value ? "connect automatically when in range" : "stop connecting automatically"); m.InnerText = want; }
        }
        if (hidden != null) {
          XmlElement sc = Kid(root, "SSIDConfig");
          if (sc == null) return cmd + ": this saved network has no SSID section, so Mantle cannot change it";
          XmlElement nb = Ensure(doc, sc, "nonBroadcast", V1, null);
          string want = hidden.Value ? "true" : "false";
          if (nb.InnerText != want) { changes.Add(hidden.Value ? "connect even if the network is not broadcasting its name" : "connect only when the network broadcasts its name"); nb.InnerText = want; }
        }
        if (rnd != null) {
          XmlElement mr = Kid(root, "MacRandomization");
          if (mr == null) { mr = doc.CreateElement("MacRandomization", V3); root.AppendChild(mr); }
          string ns = mr.NamespaceURI;
          XmlElement en = Ensure(doc, mr, "enableRandomization", ns, mr.FirstChild);
          string wantEn = rnd == "off" ? "false" : "true";
          string wasWord = en.InnerText != "true" ? "off" : KidText(mr, "randomizeEveryday") == "true" ? "daily" : "on";
          en.InnerText = wantEn;
          XmlElement ev = Kid(mr, "randomizeEveryday");
          if (rnd == "daily") { if (ev == null) { ev = doc.CreateElement("randomizeEveryday", ns); mr.InsertAfter(ev, en); } ev.InnerText = "true"; }
          else if (ev != null) ev.InnerText = "false";
          if (wasWord != rnd) changes.Add("use " + (rnd == "off" ? "this PC's own hardware address" : rnd == "on" ? "a random hardware address" : "a random hardware address that changes daily") + " on this network");
        }
        string xml = doc.OuterXml;
        string would = changes.Count == 0 ? "change nothing: the saved network already has these settings"
                                          : string.Join("; ", Array.ConvertAll(changes.ToArray(), delegate (object o) { return (string)o; }));
        if (dry) {
          result = Json.Obj("ok", true, "dryRun", true, "would", would, "changes", changes, "xml", Redact(xml), "reason", null);
          return null;
        }
        if (Program.Passive) return SysCommon.Passive(would);
        if (changes.Count > 0) {
          uint why2;
          uint rc = Native.WlanSetProfile(h, ref f.G, (s.Flags & PROFILE_USER), xml, null, true, IntPtr.Zero, out why2);
          xml = null;
          if (rc != 0) return cmd + ": Windows refused the changed profile (error " + rc + (why2 != 0 ? ", " + Wlan.ReasonText(why2) : "") + ")";
        }
        uint acc;
        string back = GetXml(h, f.G, profile, out acc);
        Conn c = Current(h, f.G);
        result = Json.Obj("ok", true, "now", back == null ? null : Describe(new Saved { Name = profile, Xml = back, Flags = s.Flags, Access = acc }, c == null ? null : c.Profile), "reason", null);
        return null;
      } finally { if (h != IntPtr.Zero) Native.WlanCloseHandle(h, IntPtr.Zero); }
    }

    /// A profile's cost lives outside its XML; netsh is the only way Windows offers to set it. Run
    /// by its fixed System32 path, the argument built from the checked profile name (no quotes).
    static string Metered(string profile, bool on, bool dry, ref object result) {
      string would = on ? "mark this network as metered (Windows and apps then hold back downloads on it)" : "stop treating this network as metered";
      string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "netsh.exe");
      if (!File.Exists(exe)) return "netwifi.set: Windows' netsh tool is missing, so Mantle cannot change the metered setting";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "would", would, "via", "netsh wlan set profileparameter cost=" + (on ? "Fixed" : "Unrestricted"), "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      var psi = new ProcessStartInfo(exe, "wlan set profileparameter name=\"" + profile + "\" cost=" + (on ? "Fixed" : "Unrestricted"));
      psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
      using (Process p = Process.Start(psi)) {
        p.StandardOutput.ReadToEnd();
        if (!p.WaitForExit(10000)) return "netwifi.set: Windows did not finish changing the metered setting within 10 s";
        if (p.ExitCode != 0) return "netwifi.set: Windows did not change the metered setting (netsh exit " + p.ExitCode + ")";
      }
      result = Json.Obj("ok", true, "now", Json.Obj("metered", on), "reason", null);
      return null;
    }

    // ------------------------------------------------------------------ netwifi.props

    static string Protocol(uint phy) {
      switch (phy) {
        case 4: return "802.11a"; case 5: return "802.11b"; case 6: return "802.11g";
        case 7: return "Wi-Fi 4 (802.11n)"; case 8: return "Wi-Fi 5 (802.11ac)"; case 9: return "802.11ad";
        case 10: return "Wi-Fi 6 (802.11ax)"; case 11: return "Wi-Fi 7 (802.11be)";
        default: return null;
      }
    }
    static string AuthWords(uint a) {
      switch (a) {
        case 1: return "Open"; case 2: return "Shared key (WEP)"; case 3: return "WPA-Enterprise"; case 4: return "WPA-Personal";
        case 6: return "WPA2-Enterprise"; case 7: return "WPA2-Personal"; case 8: case 11: return "WPA3-Enterprise";
        case 9: return "WPA3-Personal"; case 10: return "Enhanced Open (OWE)";
        default: return null;
      }
    }
    static string CipherWords(uint c) {
      switch (c) {
        case 0: return "None"; case 1: case 5: case 0x100: return "WEP"; case 2: return "TKIP"; case 4: return "AES (CCMP)";
        case 8: return "GCMP"; case 9: return "GCMP-256";
        default: return null;
      }
    }

    /// The connected BSS's centre frequency (kHz) from Windows' cached BSS list, 0 when unknown.
    static uint Frequency(IntPtr h, Guid g, string bssid) {
      IntPtr list;
      if (Native.WlanGetNetworkBssList(h, ref g, IntPtr.Zero, 3, false, IntPtr.Zero, out list) != 0 || list == IntPtr.Zero) return 0;
      try {
        int n = Marshal.ReadInt32(list, 4);
        for (int i = 0; i < n; i++) {
          IntPtr e = new IntPtr(list.ToInt64() + 8 + (long)i * 360);
          var mac = new byte[6];
          Marshal.Copy(new IntPtr(e.ToInt64() + 40), mac, 0, 6);
          if (BitConverter.ToString(mac).Replace('-', ':') == bssid) return (uint)Marshal.ReadInt32(e, 92);
        }
        return 0;
      } finally { Native.WlanFreeMemory(list); }
    }

    static string Band(uint khz, int channel) {
      if (khz >= 5925000 && khz <= 7125000) return "6 GHz";
      if (khz >= 4900000 && khz < 5925000) return "5 GHz";
      if (khz >= 2400000 && khz < 2500000) return "2.4 GHz";
      if (khz == 0 && channel >= 1 && channel <= 14) return "2.4 GHz";
      if (khz == 0 && channel >= 32 && channel <= 177) return "5 GHz";
      return null;
    }

    static string Props(Dictionary<string, object> req, ref object result) {
      string why;
      IntPtr h = Open(out why);
      if (h == IntPtr.Zero) return "netwifi.props: " + why;
      try {
        Iface f;
        string perr = Pick(h, req, out f);
        if (perr == "none") { result = Json.Obj("ok", true, "present", false, "connected", false, "reason", "This PC has no Wi-Fi adapter"); return null; }
        if (perr != null) return "netwifi.props: " + perr;
        string guid = f.G.ToString("B");
        Conn c = Current(h, f.G);
        IDictionary drv = NetAdapters.Driver(guid);
        IDictionary addr = NetAdapters.Addressing(guid, c == null ? null : NetAdapters.Live(guid));
        if (c == null || c.State != 1) {
          result = Json.Obj("ok", true, "present", true, "connected", false, "iface", guid, "adapter", f.Desc, "driver", drv, "addressing", addr,
                            "reason", "Wi-Fi is not connected to a network");
          return null;
        }
        int channel = 0;
        uint size; IntPtr d;
        if (Native.WlanQueryInterface(h, ref f.G, OP_CHANNEL, IntPtr.Zero, out size, out d, IntPtr.Zero) == 0 && d != IntPtr.Zero) {
          channel = Marshal.ReadInt32(d);
          Native.WlanFreeMemory(d);
        }
        uint khz = Frequency(h, f.G, c.Bssid);
        result = Json.Obj(
          "ok", true, "present", true, "connected", true, "iface", guid, "adapter", f.Desc,
          "ssid", c.Ssid, "profile", c.Profile, "bssid", c.Bssid,
          "protocol", Protocol(c.Phy), "security", AuthWords(c.Auth), "cipher", CipherWords(c.Cipher),
          "band", Band(khz, channel), "channel", channel > 0 ? (object)channel : null, "frequencyMHz", khz > 0 ? (object)(khz / 1000) : null,
          "signal", c.Quality, "rxMbps", c.Rx / 1000, "txMbps", c.Tx / 1000,
          "driver", drv, "addressing", addr, "reason", null);
        return null;
      } finally { Native.WlanCloseHandle(h, IntPtr.Zero); }
    }
  }
}
