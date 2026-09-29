// NetMisc.cs - Settings > Network & internet: VPN, Dial-up and Airplane mode (lane net2, 2026-09-28).
//
//   netvpn.list {}                               VPN + dial-up entries (yours and every user's),
//                                                server, type, connected
//   netvpn.connect {entry, on, dryRun}           connect with the saved sign-in / disconnect
//   netair.get {}                                airplane mode, and whether Mantle can switch it
//   netair.set {on, dryRun}                      airplane mode on/off
//
// VPN ENTRIES are Windows' RAS phonebooks (rasphone.pbk, one per user and one for all users): an
// INI file per entry with its type and server, which is what Settings lists. "Connected" is a PPP
// interface of the same name (NetworkInterface). Connect / disconnect run rasdial.exe by its fixed
// System32 path with the checked entry name: Windows' own dialer, using the saved sign-in. Adding a
// VPN is not here (RasSetEntryProperties: left for a later lane).
//
// AIRPLANE MODE is the Radio Management service: HKLM\...\RadioManagement\SystemRadioState says it
// (1 = airplane on), and its COM object (RadioManagementAPI, IRadioManager, what the quick-settings
// tile uses; undocumented but registered for any user) switches it. The get proves the object can
// be created and read as this user before the page offers the switch.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class NetMisc {
    public static void Register(FeatureTable t) {
      t.Add("netvpn.list", Lanes.Slow, VpnList);
      t.Add("netvpn.connect", Lanes.Slow, VpnConnect);
      t.Add("netair.get", Lanes.Slow, AirGet);
      t.Add("netair.set", Lanes.Slow, AirSet);
    }

    // ------------------------------------------------------------------ VPN / dial-up

    sealed class Entry { public string Name, Server, Kind, Book; public int Strategy; }

    static string[] Books() {
      return new[] {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Network\Connections\Pbk\rasphone.pbk"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Microsoft\Network\Connections\Pbk\rasphone.pbk") };
    }

    static List<Entry> Entries(out string why) {
      why = null;
      var l = new List<Entry>();
      string[] books = Books();
      for (int b = 0; b < books.Length; b++) {
        if (!File.Exists(books[b])) continue;
        try {
          Entry e = null;
          foreach (string raw in File.ReadAllLines(books[b])) {
            string line = raw.Trim();
            if (line.StartsWith("[") && line.EndsWith("]")) { e = new Entry { Name = line.Substring(1, line.Length - 2), Book = b == 0 ? "user" : "allUsers", Kind = "vpn" }; l.Add(e); continue; }
            if (e == null) continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string k = line.Substring(0, eq), v = line.Substring(eq + 1);
            if (k == "Type") e.Kind = v == "1" ? "dialup" : v == "2" ? "vpn" : v == "5" ? "broadband" : "other";
            else if (k == "PhoneNumber" && e.Server == null && v.Length > 0) e.Server = v;
            else if (k == "VpnStrategy") int.TryParse(v, out e.Strategy);
          }
        } catch (Exception ex) { why = "a VPN phonebook could not be read (" + SysCommon.Why(ex) + ")"; }
      }
      return l;
    }

    static string Strategy(int s) {
      switch (s) {
        case 1: case 2: return "PPTP"; case 3: case 4: return "L2TP/IPsec"; case 5: case 6: return "SSTP";
        case 7: case 8: return "IKEv2"; default: return "Automatic";
      }
    }

    static bool Connected(string name) {
      try {
        foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
          if (ni.NetworkInterfaceType == NetworkInterfaceType.Ppp && ni.Name == name && ni.OperationalStatus == OperationalStatus.Up) return true;
      } catch (Exception) { }
      return false;
    }

    static string VpnList(Dictionary<string, object> req, ref object result) {
      string why;
      var items = new List<object>();
      foreach (Entry e in Entries(out why))
        items.Add(Json.Obj("entry", e.Name, "kind", e.Kind, "server", e.Server, "type", e.Kind == "vpn" ? Strategy(e.Strategy) : null,
                           "allUsers", e.Book == "allUsers", "connected", Connected(e.Name)));
      result = Json.Obj("ok", true, "entries", items, "reason", why);
      return null;
    }

    static string VpnConnect(Dictionary<string, object> req, ref object result) {
      const string cmd = "netvpn.connect";
      string name = Json.GetString(req, "entry");
      if (string.IsNullOrEmpty(name)) return cmd + " needs entry: a VPN connection's name";
      bool on;
      string err = SysCommon.Bool(req, "on", cmd, out on);
      if (err != null) return err;
      bool dry = Json.GetBool(req, "dryRun", false);
      string why;
      Entry hit = null;
      foreach (Entry e in Entries(out why)) if (e.Name == name) { hit = e; break; }
      if (hit == null) return cmd + ": Windows has no VPN connection with that name";
      if (name.IndexOf('"') >= 0 || name.IndexOf('\\') >= 0) return cmd + ": Mantle cannot dial a connection whose name has a quote or backslash in it";
      string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "rasdial.exe");
      if (!File.Exists(exe)) return cmd + ": Windows' dialer (rasdial) is missing";
      bool now = Connected(name);
      string would = now == on ? "change nothing: it is already " + (on ? "connected" : "disconnected")
                               : on ? "connect this VPN with its saved sign-in" : "disconnect this VPN";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "would", would, "connected", now, "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      if (now != on) {
        var psi = new ProcessStartInfo(exe, "\"" + name + "\"" + (on ? "" : " /disconnect"));
        psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.RedirectStandardOutput = true;
        using (Process p = Process.Start(psi)) {
          p.StandardOutput.ReadToEnd();
          if (!p.WaitForExit(60000)) return cmd + ": Windows did not finish within 60 s";
          if (p.ExitCode == 691) return cmd + ": the VPN refused the saved user name or password (error 691)";
          if (p.ExitCode == 703) return cmd + ": this VPN needs a sign-in typed in each time, which Mantle cannot do yet (error 703)";
          if (p.ExitCode != 0) return cmd + ": Windows could not " + (on ? "connect" : "disconnect") + " (RAS error " + p.ExitCode + ")";
        }
      }
      result = Json.Obj("ok", true, "now", Connected(name), "reason", null);
      return null;
    }

    // ------------------------------------------------------------------ airplane mode

    [ComImport, Guid("DB3AFBFB-08E6-46C6-AA70-BF9A34C30AB7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IRadioManager {
      [PreserveSig] int IsRMSupported(out int supported);
      [PreserveSig] int GetUIRadioInstances([MarshalAs(UnmanagedType.IUnknown)] out object instances);
      [PreserveSig] int GetSystemRadioState(out int radiosOn, out int switchState, out int changeReason);
      [PreserveSig] int SetSystemRadioState(int radiosOn);
    }
    static readonly Guid RadioManagementApi = new Guid("581333F6-28DB-41BE-BC7A-FF201F12F3F6");

    static IRadioManager Manager(out string why) {
      why = null;
      try {
        Type t = Type.GetTypeFromCLSID(RadioManagementApi, false);
        if (t == null) { why = "Windows' radio management is not registered on this PC"; return null; }
        return (IRadioManager)Activator.CreateInstance(t);
      } catch (Exception ex) { why = "Windows' radio management could not be opened (" + SysCommon.Why(ex) + ")"; return null; }
    }

    static int? RegState() {
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\RadioManagement\SystemRadioState")) {
          object v = k == null ? null : k.GetValue("");
          return v is int ? (int?)(int)v : null;
        }
      } catch (Exception) { return null; }
    }

    static string AirGet(Dictionary<string, object> req, ref object result) {
      int? reg = RegState();
      string why;
      IRadioManager m = Manager(out why);
      bool? airplane = reg.HasValue ? (bool?)(reg.Value != 0) : null;
      bool canSet = false;
      bool? agrees = null;
      if (m != null) {
        try {
          int on, sw, rs;
          int hr = m.GetSystemRadioState(out on, out sw, out rs);
          if (hr == 0) {
            canSet = true;
            bool api = on == 0;                 // radios off = airplane mode on
            if (airplane.HasValue) agrees = airplane.Value == api;
            airplane = api;
          } else why = "Windows' radio management would not say the airplane state (0x" + hr.ToString("X8") + ")";
        } catch (Exception ex) { why = "Windows' radio management could not be read (" + SysCommon.Why(ex) + ")"; }
        finally { Marshal.ReleaseComObject(m); }
      }
      if (airplane == null && why == null) why = "Windows did not say whether airplane mode is on";
      result = Json.Obj("ok", true, "airplane", airplane, "canSet", canSet, "registryAgrees", agrees,
                        "reason", canSet ? null : why ?? "Mantle cannot switch airplane mode on this PC");
      return null;
    }

    static string AirSet(Dictionary<string, object> req, ref object result) {
      bool on;
      string err = SysCommon.Bool(req, "on", "netair.set", out on);
      if (err != null) return err;
      bool dry = Json.GetBool(req, "dryRun", false);
      string why;
      IRadioManager m = Manager(out why);
      if (m == null) return "netair.set: " + why;
      try {
        int radios, sw, rs;
        int hr = m.GetSystemRadioState(out radios, out sw, out rs);
        if (hr != 0) return "netair.set: Windows' radio management would not say the airplane state (0x" + hr.ToString("X8") + ")";
        bool now = radios == 0;
        string would = now == on ? "change nothing: airplane mode is already " + (on ? "on" : "off")
                                 : on ? "turn airplane mode on (Wi-Fi, Bluetooth and mobile data go off)" : "turn airplane mode off (radios go back to how they were)";
        if (dry) { result = Json.Obj("ok", true, "dryRun", true, "would", would, "airplaneNow", now, "reason", null); return null; }
        if (Program.Passive) return SysCommon.Passive(would);
        if (now != on) {
          hr = m.SetSystemRadioState(on ? 0 : 1);
          if (hr != 0) return "netair.set: Windows did not switch airplane mode (0x" + hr.ToString("X8") + ")";
        }
        hr = m.GetSystemRadioState(out radios, out sw, out rs);
        result = Json.Obj("ok", true, "now", hr == 0 ? (object)(radios == 0) : null, "reason", null);
        return null;
      } finally { Marshal.ReleaseComObject(m); }
    }
  }
}
