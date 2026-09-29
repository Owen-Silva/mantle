// NetAdapters.cs - Settings > Network & internet > Advanced network settings and Ethernet: every
// network adapter, its addresses, DNS, driver and traffic, and the two administrator switches
// (adapter on/off, DNS servers). Lane net2, 2026-09-28.
//
//   netadapt.list {}                        every visible adapter, INCLUDING disabled ones
//   netadapt.plan {adapter, on? | dns?}     the dry run of an administrator change (never elevates)
//   [Elevated] network.setAdapterEnabled {adapter, on}      CM_Enable/CM_Disable_DevNode
//   [Elevated] network.setDns {adapter, servers[]}          SetInterfaceDnsSettings ([] = automatic)
//
// WHY THE REGISTRY + NetworkInterface: .NET's NetworkInterface lists only adapters that are on,
// and Settings lists disabled ones too (that is where you turn them back on). The adapter class
// key (Control\Class\{4d36e972...}) names every installed adapter with its driver, the Network
// key names its connection ("Wi-Fi", "Ethernet 2"), cfgmgr32 says whether it is disabled, and
// NetworkInterface adds the live half (status, speed, addresses, bytes). No process launches.
// DNS "manual vs automatic" is Tcpip's own NameServer value (DHCP's lands in DhcpNameServer).
//
// PRIVACY: adapter names, addresses and MACs go in replies (the page shows them), never in a log.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class NetAdapters {
    const string ClassKey = @"SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}";
    const string NetKey = @"SYSTEM\CurrentControlSet\Control\Network\{4D36E972-E325-11CE-BFC1-08002BE10318}";
    const string TcpKey = @"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\";
    const string Tcp6Key = @"SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces\";
    const uint NCF_PHYSICAL = 0x4, NCF_HIDDEN = 0x8;
    const int CR_SUCCESS = 0, CM_PROB_DISABLED = 22, CR_ACCESS_DENIED = 0x33;
    const uint DN_HAS_PROBLEM = 0x400, DN_STARTED = 0x8;
    const uint CM_DISABLE_UI_NOT_OK = 0x4, CM_DISABLE_PERSIST = 0x8;
    static readonly Regex GuidRx = new Regex(@"^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$");

    static class Native {
      [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
      public static extern int CM_Locate_DevNodeW(out uint devInst, string deviceId, uint flags);
      [DllImport("cfgmgr32.dll")] public static extern int CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);
      [DllImport("cfgmgr32.dll")] public static extern int CM_Disable_DevNode(uint devInst, uint flags);
      [DllImport("cfgmgr32.dll")] public static extern int CM_Enable_DevNode(uint devInst, uint flags);
      [DllImport("iphlpapi.dll")] public static extern uint SetInterfaceDnsSettings(Guid iface, ref DNS_INTERFACE_SETTINGS s);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DNS_INTERFACE_SETTINGS {
      public uint Version;
      public ulong Flags;
      [MarshalAs(UnmanagedType.LPWStr)] public string Domain;
      [MarshalAs(UnmanagedType.LPWStr)] public string NameServer;
      [MarshalAs(UnmanagedType.LPWStr)] public string SearchList;
      public uint RegistrationEnabled, RegisterAdapterName, EnableLLMNR, QueryAdapterName;
      [MarshalAs(UnmanagedType.LPWStr)] public string ProfileNameServer;
    }

    public static void Register(FeatureTable t) {
      t.Add("netadapt.list", Lanes.Slow, List);
      t.Add("netadapt.plan", Lanes.Slow, Plan);
    }

    // ------------------------------------------------------------------ reads

    /// One installed adapter from the class key: null when it is hidden or has no connection.
    sealed class Installed {
      public string Guid, Desc, Instance, Provider, Version, Date, Conn;
      public uint Chars;
      public int IfType;
    }

    static List<Installed> InstalledAdapters(out string why) {
      why = null;
      var list = new List<Installed>();
      try {
        using (RegistryKey cls = Registry.LocalMachine.OpenSubKey(ClassKey)) {
          if (cls == null) { why = "Windows' adapter list could not be opened"; return list; }
          foreach (string sub in cls.GetSubKeyNames()) {
            if (sub.Length != 4) continue;
            try {
              using (RegistryKey k = cls.OpenSubKey(sub)) {
                if (k == null) continue;
                var a = new Installed();
                a.Guid = k.GetValue("NetCfgInstanceId") as string;
                if (a.Guid == null || !GuidRx.IsMatch(a.Guid)) continue;
                object ch = k.GetValue("Characteristics");
                a.Chars = ch is int ? (uint)(int)ch : 0;
                if ((a.Chars & NCF_HIDDEN) != 0) continue;
                a.Desc = k.GetValue("DriverDesc") as string;
                a.Instance = k.GetValue("DeviceInstanceID") as string;
                a.Provider = k.GetValue("ProviderName") as string;
                a.Version = k.GetValue("DriverVersion") as string;
                a.Date = k.GetValue("DriverDate") as string;
                object it = k.GetValue("*IfType");
                a.IfType = it is int ? (int)it : 0;
                a.Conn = ConnName(a.Guid);
                if (a.Conn == null) continue;           // no connection: not a network adapter Settings shows
                list.Add(a);
              }
            } catch (Exception) { }                     // one unreadable key never hides the rest
          }
        }
      } catch (Exception ex) { why = "Windows' adapter list could not be read (" + SysCommon.Why(ex) + ")"; }
      return list;
    }

    static string ConnName(string guid) {
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(NetKey + "\\" + guid + "\\Connection")) {
          return k == null ? null : k.GetValue("Name") as string;
        }
      } catch (Exception) { return null; }
    }

    /// "on" | "off" (disabled) | "missing" (unplugged USB adapter) | "unknown".
    static string DeviceState(string instance) {
      if (string.IsNullOrEmpty(instance)) return "unknown";
      uint dn, st, prob;
      if (Native.CM_Locate_DevNodeW(out dn, instance, 0) != CR_SUCCESS) return "missing";
      if (Native.CM_Get_DevNode_Status(out st, out prob, dn, 0) != CR_SUCCESS) return "unknown";
      if ((st & DN_HAS_PROBLEM) != 0 && prob == CM_PROB_DISABLED) return "off";
      return "on";
    }

    static string Kind(Installed a, NetworkInterface ni) {
      if (a.IfType == 71 || (ni != null && ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211)) return "wifi";
      string d = (a.Desc ?? "").ToLowerInvariant();
      if (d.Contains("bluetooth")) return "bluetooth";
      if ((a.Chars & NCF_PHYSICAL) == 0) return "virtual";
      if (a.IfType == 6 || (ni != null && ni.NetworkInterfaceType == NetworkInterfaceType.Ethernet)) return "ethernet";
      return "other";
    }

    static string RegString(string key, string name) {
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(key)) {
          return k == null ? null : k.GetValue(name) as string;
        }
      } catch (Exception) { return null; }
    }

    static List<object> Split(string s) {
      var l = new List<object>();
      if (string.IsNullOrEmpty(s)) return l;
      foreach (string p in s.Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries)) l.Add(p);
      return l;
    }

    /// The live half of one adapter by its GUID (or null when Windows has it off).
    public static NetworkInterface Live(string guid) {
      try {
        foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
          if (string.Equals(ni.Id, guid, StringComparison.OrdinalIgnoreCase)) return ni;
      } catch (Exception) { }
      return null;
    }

    static string Mac(NetworkInterface ni) {
      try {
        byte[] b = ni.GetPhysicalAddress().GetAddressBytes();
        if (b.Length == 0) return null;
        var parts = new string[b.Length];
        for (int i = 0; i < b.Length; i++) parts[i] = b[i].ToString("X2", CultureInfo.InvariantCulture);
        return string.Join(":", parts);
      } catch (Exception) { return null; }
    }

    /// Addresses, gateway, DNS (and whether it was typed in or came from DHCP), DHCP, MAC and bytes.
    /// Shared with NetWifi's properties of the connected network.
    public static IDictionary Addressing(string guid, NetworkInterface ni) {
      var v4 = new List<object>(); var v6 = new List<object>(); var gw = new List<object>();
      var dns4 = new List<object>(); var dns6 = new List<object>();
      bool? dhcp = null;
      string why = null;
      long rx = -1, tx = -1;
      if (ni != null) {
        try {
          IPInterfaceProperties ip = ni.GetIPProperties();
          foreach (UnicastIPAddressInformation u in ip.UnicastAddresses) {
            if (u.Address.AddressFamily == AddressFamily.InterNetwork) v4.Add(u.Address.ToString() + (u.IPv4Mask != null ? " / " + u.IPv4Mask : ""));
            else if (u.Address.AddressFamily == AddressFamily.InterNetworkV6) v6.Add(u.Address.ToString());
          }
          foreach (GatewayIPAddressInformation g in ip.GatewayAddresses) gw.Add(g.Address.ToString());
          foreach (IPAddress d in ip.DnsAddresses) (d.AddressFamily == AddressFamily.InterNetworkV6 ? dns6 : dns4).Add(d.ToString());
          try { IPv4InterfaceProperties p4 = ip.GetIPv4Properties(); if (p4 != null) dhcp = p4.IsDhcpEnabled; } catch (Exception) { }
          IPInterfaceStatistics st = ni.GetIPStatistics();
          rx = st.BytesReceived; tx = st.BytesSent;
        } catch (Exception ex) { why = "Windows did not give this adapter's addresses (" + SysCommon.Why(ex) + ")"; }
      } else {
        why = "the adapter is off or has no connection, so it has no addresses";
      }
      string manual4 = RegString(TcpKey + guid, "NameServer");
      string manual6 = RegString(Tcp6Key + guid, "NameServer");
      bool dnsManual = !string.IsNullOrEmpty(manual4) || !string.IsNullOrEmpty(manual6);
      return Json.Obj("ipv4", v4, "ipv6", v6, "gateway", gw, "dns4", dns4, "dns6", dns6,
                      "dnsManual", dnsManual, "manualDns", Split(manual4 + " " + manual6),
                      "dhcp", dhcp, "mac", ni != null ? Mac(ni) : null,
                      "bytesIn", rx >= 0 ? (object)rx : null, "bytesOut", tx >= 0 ? (object)tx : null,
                      "reason", why);
    }

    /// The driver half of one adapter by its GUID (for NetWifi's properties too).
    public static IDictionary Driver(string guid) {
      string why;
      foreach (Installed a in InstalledAdapters(out why))
        if (string.Equals(a.Guid, guid, StringComparison.OrdinalIgnoreCase))
          return Json.Obj("description", a.Desc, "provider", a.Provider, "version", a.Version, "date", a.Date, "name", a.Conn);
      return null;
    }

    static string List(Dictionary<string, object> req, ref object result) {
      string why;
      List<Installed> all = InstalledAdapters(out why);
      if (why != null && all.Count == 0) return why;
      var items = new List<object>();
      foreach (Installed a in all) {
        string state = DeviceState(a.Instance);
        if (state == "missing") continue;                // an unplugged adapter Settings does not list either
        NetworkInterface ni = state == "off" ? null : Live(a.Guid);
        string status = state == "off" ? "disabled"
          : ni == null ? "unknown"
          : ni.OperationalStatus == OperationalStatus.Up ? "connected"
          : "disconnected";
        long speed = -1;
        try { if (ni != null && ni.OperationalStatus == OperationalStatus.Up) speed = ni.Speed; } catch (Exception) { }
        items.Add(Json.Obj(
          "adapter", a.Guid, "name", a.Conn, "description", a.Desc, "kind", Kind(a, ni),
          "physical", (a.Chars & NCF_PHYSICAL) != 0, "enabled", state != "off", "status", status,
          "speedBps", speed >= 0 ? (object)speed : null,
          "driver", Json.Obj("provider", a.Provider, "version", a.Version, "date", a.Date),
          "addressing", Addressing(a.Guid, ni),
          "canToggle", !string.IsNullOrEmpty(a.Instance),
          "toggleWhy", string.IsNullOrEmpty(a.Instance) ? "Windows did not say which device this adapter is, so Mantle cannot switch it" : null));
      }
      result = Json.Obj("ok", true, "adapters", items, "elevated", SysCommon.Elevated(), "reason", why);
      return null;
    }

    // ------------------------------------------------------------------ administrator changes

    static string AdapterArg(Dictionary<string, object> args, out string guid) {
      guid = null;
      object v;
      if (!args.TryGetValue("adapter", out v) || !(v is string)) return "which adapter? (adapter: its {GUID})";
      guid = (string)v;
      return GuidRx.IsMatch(guid) ? null : "adapter must be the adapter's {GUID}";
    }

    static string ServersArg(Dictionary<string, object> args, out List<string> v4, out List<string> v6) {
      v4 = new List<string>(); v6 = new List<string>();
      object v;
      if (!args.TryGetValue("servers", out v) || !(v is List<object>)) return "servers must be a list of DNS server addresses ([] = automatic, from DHCP)";
      var l = (List<object>)v;
      if (l.Count > 8) return "at most 8 DNS servers";
      foreach (object o in l) {
        string s = o as string;
        IPAddress ip;
        // IPAddress.TryParse takes legacy short forms ("1.1.1" = 1.1.0.1): an IPv4 must be a dotted quad.
        if (s == null || s.Length > 45 || !IPAddress.TryParse(s, out ip) || s.IndexOf('%') >= 0 ||
            (ip.AddressFamily == AddressFamily.InterNetwork && !Regex.IsMatch(s, @"^\d{1,3}(\.\d{1,3}){3}$")))
          return "\"" + (s ?? "?") + "\" is not an IP address (like 1.1.1.1 or 2606:4700:4700::1111)";
        if (ip.AddressFamily == AddressFamily.InterNetwork) { if (v4.Count >= 4) return "at most 4 IPv4 DNS servers"; v4.Add(ip.ToString()); }
        else { if (v6.Count >= 4) return "at most 4 IPv6 DNS servers"; v6.Add(ip.ToString()); }
      }
      return null;
    }

    static string CheckEnabled(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "adapter", "on");
      if (why != null) return why;
      string guid;
      why = AdapterArg(args, out guid);
      if (why != null) return why;
      object on;
      return args.TryGetValue("on", out on) && on is bool ? null : "on must be true or false";
    }

    static string CheckDns(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "adapter", "servers");
      if (why != null) return why;
      string guid;
      why = AdapterArg(args, out guid);
      if (why != null) return why;
      List<string> v4, v6;
      return ServersArg(args, out v4, out v6);
    }

    static Installed Find(string guid) {
      string why;
      foreach (Installed a in InstalledAdapters(out why))
        if (string.Equals(a.Guid, guid, StringComparison.OrdinalIgnoreCase)) return a;
      return null;
    }

    /// The dry run of either administrator change: validation + every read, no prompt, no change.
    static string Plan(Dictionary<string, object> req, ref object result) {
      bool dns = req.ContainsKey("servers");
      var args = new Dictionary<string, object>();
      foreach (string k in new[] { "adapter", "on", "servers" }) if (req.ContainsKey(k)) args[k] = req[k];
      string why = dns ? CheckDns(args) : CheckEnabled(args);
      if (why != null) return "netadapt.plan: " + why;
      Installed a = Find((string)args["adapter"]);
      if (a == null) return "netadapt.plan: Windows has no network adapter with that GUID";
      if (dns) {
        List<string> v4, v6;
        ServersArg(args, out v4, out v6);
        string to = v4.Count + v6.Count == 0 ? "automatic (from DHCP)" : string.Join(", ", v4.ToArray()) + (v6.Count > 0 ? (v4.Count > 0 ? ", " : "") + string.Join(", ", v6.ToArray()) : "");
        result = Json.Obj("ok", true, "dryRun", true, "action", "network.setDns", "adapter", a.Guid, "elevated", true,
                          "would", "set the DNS servers of " + a.Conn + " to " + to + " after an administrator prompt", "reason", null);
        return null;
      }
      bool on = (bool)args["on"];
      string state = DeviceState(a.Instance);
      if (state == "missing") return "netadapt.plan: that adapter is not plugged in";
      bool now = state != "off";
      result = Json.Obj("ok", true, "dryRun", true, "action", "network.setAdapterEnabled", "adapter", a.Guid, "enabledNow", now,
                        "elevated", true, "would", now == on ? "change nothing: " + a.Conn + " is already " + (on ? "on" : "off")
                          : (on ? "turn " + a.Conn + " back on" : "turn " + a.Conn + " off (every connection on it drops until it is turned on again)") +
                            " after an administrator prompt", "reason", null);
      return null;
    }

    static class Admin {
      [Elevated("network.setAdapterEnabled", "CheckEnabled", "turn this network adapter on or off")]
      static string SetEnabled(Dictionary<string, object> args, ref object result) {
        // CM_Disable_DevNode / CM_Enable_DevNode: the same device switch Settings' "Disable" uses.
        Installed a = Find((string)args["adapter"]);
        if (a == null || string.IsNullOrEmpty(a.Instance)) return "Windows has no network adapter with that GUID";
        bool on = (bool)args["on"];
        uint dn;
        int cr = Native.CM_Locate_DevNodeW(out dn, a.Instance, 0);
        if (cr != CR_SUCCESS) return "Windows could not find that adapter (CM error " + cr + ")";
        cr = on ? Native.CM_Enable_DevNode(dn, 0) : Native.CM_Disable_DevNode(dn, CM_DISABLE_UI_NOT_OK | CM_DISABLE_PERSIST);
        if (cr == CR_ACCESS_DENIED) return "Windows refused: switching an adapter needs an administrator (CM error 0x33)";
        if (cr != CR_SUCCESS) return "Windows did not turn the adapter " + (on ? "on" : "off") + " (CM error 0x" + cr.ToString("X", CultureInfo.InvariantCulture) + ")";
        result = Json.Obj("adapter", a.Guid, "on", on, "note", null);
        return null;
      }
      static string CheckEnabled(Dictionary<string, object> args) { return NetAdapters.CheckEnabled(args); }

      [Elevated("network.setDns", "CheckDns", "change this adapter's DNS servers")]
      static string SetDns(Dictionary<string, object> args, ref object result) {
        // SetInterfaceDnsSettings (Windows 10 2004+): the documented call behind Settings' DNS editor.
        // An empty list clears the typed-in servers, so DHCP's apply again ("Automatic").
        List<string> v4, v6;
        string why = ServersArg(args, out v4, out v6);
        if (why != null) return why;
        Guid g = new Guid((string)args["adapter"]);
        bool clear = v4.Count + v6.Count == 0;
        uint rc = Set(g, false, clear || v4.Count > 0 ? string.Join(",", v4.ToArray()) : null);
        if (rc == 0) rc = Set(g, true, clear || v6.Count > 0 ? string.Join(",", v6.ToArray()) : null);
        if (rc != 0) return "Windows did not change the DNS servers (error " + rc + ")";
        result = Json.Obj("adapter", (string)args["adapter"], "servers", SysCommon.List(v4.ToArray()), "note", null);
        return null;
      }
      static uint Set(Guid g, bool v6, string servers) {
        if (servers == null) return 0;                    // that family was not asked about
        var s = new DNS_INTERFACE_SETTINGS();
        s.Version = 1;
        s.Flags = 0x2 | (v6 ? 0x1UL : 0UL);               // DNS_SETTING_NAMESERVER (| DNS_SETTING_IPV6)
        s.NameServer = servers;
        return Native.SetInterfaceDnsSettings(g, ref s);
      }
      static string CheckDns(Dictionary<string, object> args) { return NetAdapters.CheckDns(args); }
    }
  }
}
