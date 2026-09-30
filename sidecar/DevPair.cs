// DevPair.cs - find, pair and remove Bluetooth devices inside Mantle Settings (devnet lane, 2026-09-28).
//
// WHAT: the backend of Settings > Bluetooth & devices > "Add device" and "Remove device", plus the
// three toggles on its Devices page. Windows' own Settings does all of this in-process; so does Mantle,
// never handing off to Windows' Settings app or its "Add a device" dialog.
//
//   devpair.scan {on, leaseMs?}          a DeviceWatcher over UNPAIRED classic + LE Bluetooth devices.
//                                        Pushes {ev:"devpair", kind:"found"|"updated"|"removed"|"done"|"stopped"}.
//                                        It lapses by itself after its lease, so a dead page cannot leave
//                                        the radio scanning; the page renews by sending on:true again.
//   devpair.list                         the found set of the running (or the last) scan
//   devpair.pair {device, dryRun?}       Pairing.Custom with Mantle answering the ceremony: a pairing is a
//                                        SESSION. {ev:"devpair", kind:"confirm", session, how, pin?} goes to
//                                        the page, which answers with devpair.respond {session, accept, pin?}.
//                                        The pair request itself answers (deferred) with Windows' verdict.
//   devpair.respond / devpair.cancel     answer / abandon the pairing session
//   devpair.unpair {device, dryRun?}     remove a PAIRED device: every paired AEP of its container
//   devpair.options / devpair.setOption  the Devices page toggles (Swift Pair, discovery mode, metered)
//
// The paired list, connect / disconnect and battery live in BtDevices.cs, the radio in Bluetooth.cs.
// Nothing here repeats them.
//
// WHERE THE TOGGLES LIVE (verified 2026-09-28 by READS only, Windows 11 build 26200; re-read on 26300):
//   - "Show notifications to connect using Swift Pair" = HKCU\Software\Microsoft\Windows\CurrentVersion
//     \Bluetooth, DWORD QuickPair. SettingsHandlers_Devices.dll holds the class BluetoothQuickPairToggle,
//     the value name "QuickPair" and the key text "software\microsoft\windows\CurrentVersion\Bluetooth";
//     the Swift Pair agent in Microsoft.Bluetooth.UserService.dll (a PER-USER service) holds the same key
//     text and a "quickpairsettingswatcheradapter". The HIVE is HKCU because the HKLM key of that name
//     grants Users and even Administrators only ReadKey (TrustedInstaller owns it), and Settings writes
//     the toggle without a shield. On this machine the HKCU key does not exist: both toggles are at
//     Windows' defaults (Swift Pair on, discovery Default).
//   - "Bluetooth devices discovery: Default / Advanced" = the same key, DWORD AdvancedDiscoveryMode
//     (1 = Advanced). SettingsHandlers_Devices.dll (BluetoothDiscoveryModeDropdown) and DevicesFlowBroker.dll
//     (the "Add a device" flow, which obeys it) both hold that value name next to the same key text.
//   - "Download over metered connections" = HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\DeviceSetup,
//     DWORD CostedNetworkPolicy (1 = allowed). The value name and key text are in DeviceSetupManagerAPI.dll,
//     the client of the Device Setup Manager service (DsmSvc). The key grants Users only ReadKey, so a
//     write needs an administrator: the [Elevated] action devpair.meteredDownload (ELEVATE.md). The
//     value is absent here (Windows' default: off). Windows' own toggle reaches it through DsmSvc's
//     private COM interface, which is undocumented, so Mantle asks for the prompt instead.
//   - WM_SETTINGCHANGE: SettingsHandlers_Devices.dll imports no SendMessageTimeout, SendNotifyMessage or
//     BroadcastSystemMessage, so Windows does NOT broadcast after these writes, and neither does Mantle.
//
// PAIRING CEREMONIES: confirmOnly, confirmPinMatch and providePin wait for the page (a deferral, a 60 s
// timeout that says no and says so). displayPin is accepted AT ONCE, as Microsoft's own pairing sample
// does: the PIN is typed on the OTHER device, so there is nothing for this side to decide; the page
// shows the PIN and can still devpair.cancel. A typed PIN is a secret: it leaves the request dictionary
// before anything else runs and is never logged, echoed or put in an error.
//
// PRIVACY: device names and addresses go into replies and events only (the page shows them), never
// into a log line. Logs carry counts and kinds.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Threading;
using Microsoft.Win32;
#if MANTLE_WINMD
using Windows.Devices.Bluetooth;
using Windows.Devices.Enumeration;
#endif

namespace Mantle {
  [MantleFeature]
  static class DevPair {
    public static void Register(FeatureTable t) {
      t.Add("devpair.scan", Lanes.Slow, Scan);
      t.Add("devpair.list", Lanes.Ui, ListFound);
      t.Add("devpair.pair", Lanes.Slow, Pair);
      t.Add("devpair.respond", Lanes.Slow, Respond);
      t.Add("devpair.cancel", Lanes.Slow, Cancel);
      t.Add("devpair.unpair", Lanes.Slow, Unpair);
      t.Add("devpair.options", Lanes.Slow, Options);
      t.Add("devpair.setOption", Lanes.Slow, SetOption);
    }

    const int ScanLeaseMaxMs = 60000;      // a scan not renewed for this long stops itself
    const int ScanLeaseDefaultMs = 30000;
    const int ScanLeaseMinMs = 1000;
    const int CallMs = 5000;               // one WinRT lookup
    const int CeremonyMs = 60000;          // how long a confirm / PIN step waits for the page
    const int PairTotalMs = 180000;        // the whole PairAsync, ceremonies included
    const int UnpairMs = 20000;
    const int UpdateEveryMs = 1000;        // at most one "updated" push per device per second (signal churn)
    const int MaxIdLen = 400;

    // ------------------------------------------------------------------ small helpers

    delegate string Job(out object result);

    /// One job on a pool thread (MTA: WinRT enumeration and pairing are free-threaded, and a pairing
    /// that waits a minute for the page must hold no lane). The reply is deferred.
    static void Post(object rid, string what, Job job) {
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        object res = null;
        string err;
        try { err = job(out res); } catch (Exception ex) {
          err = what + " failed inside Mantle (" + Why(ex) + ")";
        }
        Program.ReplyFromWorker(rid, err == null, err == null ? res : null, err);
      });
    }

    static object Rid(Dictionary<string, object> req) { return req.ContainsKey("id") ? req["id"] : null; }

    internal static string Why(Exception ex) {
      if (ex is AggregateException && ex.InnerException != null) ex = ex.InnerException;
      string msg = (ex.Message ?? "").Trim();
      int nl = msg.IndexOfAny(new[] { '\r', '\n' });
      if (nl > 0) msg = msg.Substring(0, nl).Trim();
      msg = msg.TrimEnd('.', ' ');
      return "HRESULT 0x" + ex.HResult.ToString("X8") + (msg.Length > 0 ? ": " + msg : "");
    }

    /// dryRun must be a real boolean when present: a string "false" must not turn a write into a dry run
    /// (or the other way round).
    static string DryRunOf(Dictionary<string, object> req, string cmd, out bool dry) {
      dry = false;
      object v;
      if (!req.TryGetValue("dryRun", out v) || v == null) return null;
      if (!(v is bool)) return cmd + ": dryRun must be true or false";
      dry = (bool)v;
      return null;
    }

    static string DeviceArg(Dictionary<string, object> req, string cmd, out string device) {
      device = null;
      object v;
      if (!req.TryGetValue("device", out v) || v == null)
        return cmd + " needs device: a device id from devpair.list (to pair) or btdevices' list (to unpair)";
      if (!(v is string)) return cmd + ": device must be a device id string";
      device = ((string)v).Trim();
      if (device.Length == 0) return cmd + ": device is empty";
      if (device.Length > MaxIdLen) return cmd + ": that device id is too long to be one";
      return null;
    }

    static string NewToken() {
      var b = new byte[8];
      using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(b);
      return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
    }

    // ------------------------------------------------------------------ the Devices page toggles

    const string BtKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Bluetooth";
    const string DsKeyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\DeviceSetup";
    const string V_QUICKPAIR = "QuickPair";
    const string V_DISCOVERY = "AdvancedDiscoveryMode";
    const string V_METERED = "CostedNetworkPolicy";

    /// A DWORD, or null when the value (or its key) is not there. `err` says why a read failed.
    static object ReadDword(RegistryHive hive, string path, string name, out string err) {
      err = null;
      try {
        using (var root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
        using (var k = root.OpenSubKey(path, false)) {
          if (k == null) return null;
          object v = k.GetValue(name, null);
          if (v == null) return null;
          if (v is int) return (int)v;
          err = "the value " + name + " is a " + k.GetValueKind(name) + ", not the DWORD Windows writes";
          return null;
        }
      } catch (Exception ex) {
        err = "the registry could not be read (" + Why(ex) + ")";
        return null;
      }
    }

    static string Options(Dictionary<string, object> req, ref object result) {
      var list = new ArrayList();
      string e1, e2, e3;
      object qp = ReadDword(RegistryHive.CurrentUser, BtKeyPath, V_QUICKPAIR, out e1);
      object dm = ReadDword(RegistryHive.CurrentUser, BtKeyPath, V_DISCOVERY, out e2);
      object mt = ReadDword(RegistryHive.LocalMachine, DsKeyPath, V_METERED, out e3);
      list.Add(Json.Obj(
        "key", "swiftPair", "label", "Show notifications to connect using Swift Pair", "type", "bool",
        "value", qp == null ? true : (object)((int)qp != 0), "stored", qp, "isDefault", qp == null,
        "where", @"HKCU\" + BtKeyPath + " " + V_QUICKPAIR + " (DWORD, 1 on, 0 off)", "scope", "user", "admin", false,
        "broadcast", false,
        "reason", e1 ?? (qp == null ? "no value stored: Windows' default, on" : null)));
      list.Add(Json.Obj(
        "key", "discoveryMode", "label", "Bluetooth devices discovery", "type", "choice",
        "choices", new ArrayList { "default", "advanced" },
        "value", dm != null && (int)dm != 0 ? "advanced" : "default", "stored", dm, "isDefault", dm == null,
        "where", @"HKCU\" + BtKeyPath + " " + V_DISCOVERY + " (DWORD, 1 Advanced, 0 Default)", "scope", "user", "admin", false,
        "broadcast", false,
        "reason", e2 ?? (dm == null ? "no value stored: Windows' default, Default" : null)));
      list.Add(Json.Obj(
        "key", "meteredDownload", "label", "Download over metered connections", "type", "bool",
        "value", mt != null && (int)mt != 0, "stored", mt, "isDefault", mt == null,
        "where", @"HKLM\" + DsKeyPath + " " + V_METERED + " (DWORD, 1 on, 0 off)", "scope", "machine", "admin", true,
        "elevate", "devpair.meteredDownload", "broadcast", false,
        "reason", e3 ?? (mt == null ? "no value stored: Windows' default, off" : null)));
      result = Json.Obj("ok", e1 == null && e2 == null && e3 == null, "options", list,
                        "reason", e1 ?? e2 ?? e3);
      return null;
    }

    static string SetOption(Dictionary<string, object> req, ref object result) {
      const string cmd = "devpair.setOption";
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      string key = Json.GetString(req, "key");
      if (string.IsNullOrEmpty(key)) return cmd + " needs key: swiftPair, discoveryMode or meteredDownload";
      object v;
      if (!req.TryGetValue("value", out v) || v == null) return cmd + " needs value";
      string err;
      if (key == "swiftPair" || key == "meteredDownload") {
        if (!(v is bool)) return cmd + ": " + key + " takes value true or false";
      } else if (key == "discoveryMode") {
        if (!(v is string) || ((string)v != "default" && (string)v != "advanced"))
          return cmd + ": discoveryMode takes value \"default\" or \"advanced\"";
      } else {
        return cmd + ": unknown key \"" + key + "\" (it takes swiftPair, discoveryMode, meteredDownload)";
      }

      if (key == "meteredDownload") {
        bool on = (bool)v;
        object cur = ReadDword(RegistryHive.LocalMachine, DsKeyPath, V_METERED, out err);
        bool now = cur != null && (int)cur != 0;
        var elev = Json.Obj("action", "devpair.meteredDownload", "args", Json.Obj("on", on));
        string would = "set HKLM\\" + DsKeyPath + " " + V_METERED + " to " + (on ? 1 : 0) +
                       " (download over metered connections " + (on ? "on" : "off") + ", for every user)" +
                       (now == on ? ", which it already is" : "") + ", through one administrator prompt";
        if (dry) {
          result = Json.Obj("dryRun", true, "would", would, "key", key, "value", on, "current", now,
                            "needsAdmin", true, "elevate", elev, "reason", err);
          return null;
        }
        if (Program.Passive) return FeatureTable.PassiveRefusal + ": devpair.setOption would " + would;
        result = Json.Obj("ok", false, "key", key, "value", now, "needsAdmin", true, "elevate", elev,
                          "reason", "this is a machine-wide setting, so it needs an administrator: ask elevate for " +
                                    "devpair.meteredDownload {on}; nothing was changed");
        return null;
      }

      string name = key == "swiftPair" ? V_QUICKPAIR : V_DISCOVERY;
      int want = key == "swiftPair" ? ((bool)v ? 1 : 0) : ((string)v == "advanced" ? 1 : 0);
      object before = ReadDword(RegistryHive.CurrentUser, BtKeyPath, name, out err);
      string words = key == "swiftPair" ? "Swift Pair notifications " + ((bool)v ? "on" : "off")
                                        : "Bluetooth discovery " + ((string)v == "advanced" ? "Advanced" : "Default");
      string plan = "set HKCU\\" + BtKeyPath + " " + name + " to " + want + " (" + words + ")" +
                    (before is int && (int)before == want ? ", which it already is" : "");
      if (dry) {
        result = Json.Obj("dryRun", true, "would", plan, "key", key, "value", v, "stored", before,
                          "needsAdmin", false, "broadcast", false, "reason", err);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": devpair.setOption would " + plan;
      try {
        using (var root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
        using (var k = root.CreateSubKey(BtKeyPath)) {
          k.SetValue(name, want, RegistryValueKind.DWord);
        }
      } catch (Exception ex) {
        return "Windows did not save " + words + " (" + Why(ex) + ")";
      }
      string after;
      object now2 = ReadDword(RegistryHive.CurrentUser, BtKeyPath, name, out after);
      bool ok = now2 is int && (int)now2 == want;
      result = Json.Obj("ok", ok, "key", key, "value", v, "stored", now2, "before", before, "broadcast", false,
                        "reason", ok ? null : "the value read back as " + (now2 ?? "missing") + (after != null ? " (" + after + ")" : ""));
      return null;
    }

    // The elevated half of "Download over metered connections" (ELEVATE.md). Runs in the elevated copy.
    [Elevated("devpair.meteredDownload", "CheckMetered", "change whether devices download their software over metered connections")]
    static string MeteredDownload(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      string err;
      object before = ReadDword(RegistryHive.LocalMachine, DsKeyPath, V_METERED, out err);
      try {
        using (var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (var k = root.CreateSubKey(DsKeyPath)) {
          k.SetValue(V_METERED, on ? 1 : 0, RegistryValueKind.DWord);
        }
      } catch (Exception ex) {
        return "Windows did not change the metered-download setting (" + Why(ex) + ")";
      }
      object after = ReadDword(RegistryHive.LocalMachine, DsKeyPath, V_METERED, out err);
      result = Json.Obj("key", "meteredDownload", "value", on, "before", before, "stored", after);
      return null;
    }

    static string CheckMetered(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "on");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("on", out v) || !(v is bool)) return "on must be true or false";
      return null;
    }

#if !MANTLE_WINMD
    const string Unavailable =
      "Bluetooth pairing is not built into this sidecar: build.ps1 did not find the WinRT metadata " +
      "(System32\\WinMetadata\\Windows.Devices.winmd), so MANTLE_WINMD was not defined";
    static string Scan(Dictionary<string, object> req, ref object result) { return Unavailable; }
    static string ListFound(Dictionary<string, object> req, ref object result) { return Unavailable; }
    static string Pair(Dictionary<string, object> req, ref object result) { req.Remove("pin"); return Unavailable; }
    static string Respond(Dictionary<string, object> req, ref object result) { req.Remove("pin"); return Unavailable; }
    static string Cancel(Dictionary<string, object> req, ref object result) { return Unavailable; }
    static string Unpair(Dictionary<string, object> req, ref object result) { return Unavailable; }
#else
    // ------------------------------------------------------------------ AEP properties

    const string P_CONTAINER = "System.Devices.Aep.ContainerId";
    const string P_PROTOCOL = "System.Devices.Aep.ProtocolId";
    const string P_PAIRED = "System.Devices.Aep.IsPaired";
    const string P_PRESENT = "System.Devices.Aep.IsPresent";
    const string P_CANPAIR = "System.Devices.Aep.CanPair";
    const string P_SIGNAL = "System.Devices.Aep.SignalStrength";
    const string P_CONNECTABLE = "System.Devices.Aep.Bluetooth.Le.IsConnectable";
    const string P_COD_MAJOR = "System.Devices.Aep.Bluetooth.Cod.Major";
    const string P_COD_MINOR = "System.Devices.Aep.Bluetooth.Cod.Minor";
    const string P_APPEARANCE = "System.Devices.Aep.Bluetooth.Le.Appearance";
    const string P_CATEGORY = "System.Devices.Aep.Category";

    static readonly string[] ScanProps = new string[] {
      P_CONTAINER, P_PROTOCOL, P_PAIRED, P_PRESENT, P_CANPAIR, P_SIGNAL, P_CONNECTABLE,
      P_COD_MAJOR, P_COD_MINOR, P_APPEARANCE, P_CATEGORY
    };
    static readonly string[] IdProps = new string[] { P_CONTAINER, P_PROTOCOL, P_PAIRED };

    static readonly Guid ClassicProtocol = new Guid("e0cbf06c-cd8b-4647-bb8a-263b43f0f974");
    static readonly Guid LeProtocol = new Guid("bb7bb05e-5972-42b5-94fc-76eaa7084d49");

    static string Selector(bool paired) {
      string a = null, b = null;
      try { a = BluetoothDevice.GetDeviceSelectorFromPairingState(paired); } catch (Exception) { }
      try { b = BluetoothLEDevice.GetDeviceSelectorFromPairingState(paired); } catch (Exception) { }
      string flag = paired ? "True" : "False";
      if (string.IsNullOrEmpty(a))
        a = "System.Devices.Aep.ProtocolId:=\"{" + ClassicProtocol.ToString("D") + "}\" AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#" + flag;
      if (string.IsNullOrEmpty(b))
        b = "System.Devices.Aep.ProtocolId:=\"{" + LeProtocol.ToString("D") + "}\" AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#" + flag;
      return "(" + a + ") OR (" + b + ")";
    }

    static object Prop(IReadOnlyDictionary<string, object> p, string key) {
      object v;
      return p != null && p.TryGetValue(key, out v) ? v : null;
    }

    static int IntOr(object v, int dflt) {
      if (v == null) return dflt;
      try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch (Exception) { return dflt; }
    }

    static string GuidText(object v) {
      if (v is Guid) return ((Guid)v).ToString("D");
      var s = v as string;
      Guid g;
      return s != null && Guid.TryParse(s, out g) ? g.ToString("D") : null;
    }

    /// "classic", "le", or null for an AEP of another protocol.
    static string ProtocolOf(IReadOnlyDictionary<string, object> p) {
      object v = Prop(p, P_PROTOCOL);
      Guid g = Guid.Empty;
      if (v is Guid) g = (Guid)v;
      else if (v is string) Guid.TryParse((string)v, out g);
      if (g == ClassicProtocol) return "classic";
      if (g == LeProtocol) return "le";
      return null;
    }

    /// The page's icon: audio | input | phone | computer | display | other. Classic devices say what
    /// they are in their Class of Device, LE devices in their GAP Appearance, then Windows' category.
    internal static string KindOf(IReadOnlyDictionary<string, object> p) {
      int major = IntOr(Prop(p, P_COD_MAJOR), -1), minor = IntOr(Prop(p, P_COD_MINOR), 0);
      switch (major) {
        case 1: return "computer";
        case 2: return "phone";
        case 4:   // audio / video (Bluetooth assigned numbers)
          if (minor == 14 || minor == 15) return "display";            // video monitor, video display + loudspeaker
          if ((minor >= 1 && minor <= 8 && minor != 3) || minor == 10) return "audio";
          break;
        case 5: return "input";   // peripheral: keyboard, pointing device, gamepad, remote
      }
      int app = IntOr(Prop(p, P_APPEARANCE), 0);
      if (app > 0) {
        switch (app >> 6) {
          case 1: return "phone";
          case 2: return "computer";
          case 5: return "display";
          case 6: case 15: return "input";          // remote control, HID
          case 33: case 34: case 37: return "audio"; // audio sink, audio source, wearable audio
        }
      }
      var cats = Prop(p, P_CATEGORY) as string[];
      if (cats != null) {
        foreach (var c0 in cats) {
          string c = (c0 ?? "").ToLowerInvariant();
          if (c.Contains("audio") || c.Contains("headset") || c.Contains("headphone") || c.Contains("speaker")) return "audio";
          if (c.StartsWith("input") || c.Contains("keyboard") || c.Contains("mouse") || c.Contains("gaming")) return "input";
          if (c.Contains("phone")) return "phone";
          if (c.Contains("computer")) return "computer";
          if (c.Contains("display") || c.Contains("television")) return "display";
        }
      }
      return "other";
    }

    // ------------------------------------------------------------------ the scan

    sealed class Found {
      public DeviceInformation Info;
      public string Id, Name, Kind, Protocol;
      public object Signal, Present, Connectable;
      public bool CanPair, Shown;
      public long LastPushTs;
    }

    static readonly object _slock = new object();
    static DeviceWatcher _watcher;                 // under _slock
    static Timer _lease;                           // under _slock
    static int _leaseMs;                           // under _slock
    static bool _enumerated;                       // under _slock: EnumerationCompleted seen
    static string _scanReason;                     // under _slock: why the last scan stopped / failed
    static DateTime _scanStarted, _scanStopped;    // under _slock (UTC)
    static readonly Dictionary<string, Found> _found = new Dictionary<string, Found>(StringComparer.OrdinalIgnoreCase);

    /// Windows hides a nameless LE advertiser and a device it knows is not present; so does Mantle.
    static bool Visible(Found f) {
      return !string.IsNullOrWhiteSpace(f.Name) && !(f.Present is bool && !(bool)f.Present);
    }

    static void Fill(Found f) {
      var p = f.Info.Properties;
      f.Id = f.Info.Id;
      f.Name = (f.Info.Name ?? "").Trim();
      f.Protocol = ProtocolOf(p) ?? "other";
      f.Kind = KindOf(p);
      f.Signal = Prop(p, P_SIGNAL);
      f.Present = Prop(p, P_PRESENT);
      f.Connectable = Prop(p, P_CONNECTABLE);
      bool can = false;
      try { can = f.Info.Pairing.CanPair; } catch (Exception) {
        object c = Prop(p, P_CANPAIR);
        can = c is bool && (bool)c;
      }
      f.CanPair = can;
    }

    static IDictionary DeviceJson(Found f) {
      return Json.Obj("device", f.Id, "name", f.Name, "kind", f.Kind, "protocol", f.Protocol,
                      "signal", f.Signal, "canPair", f.CanPair, "present", f.Present,
                      "connectable", f.Connectable);
    }

    /// Under _slock.
    static void Counts(out int shown, out int nameless, out int away) {
      shown = 0; nameless = 0; away = 0;
      foreach (var f in _found.Values) {
        if (Visible(f)) shown++;
        else if (string.IsNullOrWhiteSpace(f.Name)) nameless++;
        else away++;
      }
    }

    static void Push(string kind, IDictionary extra) {
      var o = Json.Obj("kind", kind);
      if (extra != null) foreach (DictionaryEntry kv in extra) o[kv.Key] = kv.Value;
      Features.Event("devpair", o);
    }

    static string Scan(Dictionary<string, object> req, ref object result) {
      const string cmd = "devpair.scan";
      object v;
      if (!req.TryGetValue("on", out v) || !(v is bool)) return cmd + " needs on: true or false";
      bool on = (bool)v;
      int lease = ScanLeaseDefaultMs;
      if (req.TryGetValue("leaseMs", out v) && v != null) {
        if (!(v is double)) return cmd + ": leaseMs must be a number of milliseconds";
        double d = (double)v;
        if (d < ScanLeaseMinMs || d > ScanLeaseMaxMs || d != Math.Floor(d))
          return cmd + ": leaseMs must be a whole number from " + ScanLeaseMinMs + " to " + ScanLeaseMaxMs;
        lease = (int)d;
      }
      Post(Rid(req), cmd, delegate (out object r) { r = on ? StartScan(lease) : StopScan("the page stopped it"); return null; });
      result = Program.Deferred;
      return null;
    }

    static IDictionary StartScan(int leaseMs) {
      // The radio first: an off radio finds nothing, and the page should say so, not spin.
      object radioOn = null;
      string radioWhy = null;
      try {
        IDictionary radio = Bluetooth.Read();
        bool present = radio["present"] is bool && (bool)radio["present"];
        if (!present) return Json.Obj("ok", false, "scanning", false, "radioOn", null,
                                      "reason", (radio["reason"] as string) ?? "this machine has no Bluetooth radio");
        radioOn = radio["on"];
        if (radioOn is bool && !(bool)radioOn)
          return Json.Obj("ok", false, "scanning", false, "radioOn", false,
                          "reason", "Bluetooth is off, so no device can be found: turn it on first");
        radioWhy = radio["reason"] as string;
      } catch (Exception ex) {
        radioWhy = "the Bluetooth radio could not be read (" + Why(ex) + "); scanning anyway";
      }
      lock (_slock) {
        _leaseMs = leaseMs;
        if (_watcher != null) {
          _lease.Change(leaseMs, Timeout.Infinite);
          int s0, n0, a0;
          Counts(out s0, out n0, out a0);
          return Json.Obj("ok", true, "scanning", true, "started", false, "leaseMs", leaseMs, "radioOn", radioOn,
                          "found", s0, "nameless", n0, "away", a0, "enumerated", _enumerated, "reason", radioWhy);
        }
        DeviceWatcher w;
        try {
          w = DeviceInformation.CreateWatcher(Selector(false), ScanProps, DeviceInformationKind.AssociationEndpoint);
          w.Added += delegate (DeviceWatcher s, DeviceInformation d) { OnAdded(s, d); };
          w.Updated += delegate (DeviceWatcher s, DeviceInformationUpdate u) { OnUpdated(s, u); };
          w.Removed += delegate (DeviceWatcher s, DeviceInformationUpdate u) { OnRemoved(s, u); };
          w.EnumerationCompleted += delegate (DeviceWatcher s, object o) { OnEnumerated(s); };
          w.Stopped += delegate (DeviceWatcher s, object o) { OnStopped(s); };
          _found.Clear();
          _enumerated = false;
          _watcher = w;
          w.Start();
        } catch (Exception ex) {
          _watcher = null;
          _scanReason = "Windows' device watcher did not start (" + Why(ex) + ")";
          return Json.Obj("ok", false, "scanning", false, "radioOn", radioOn, "reason", _scanReason);
        }
        _scanReason = null;
        _scanStarted = DateTime.UtcNow;
        _lease = new Timer(LeaseLapsed, w, leaseMs, Timeout.Infinite);
        return Json.Obj("ok", true, "scanning", true, "started", true, "leaseMs", leaseMs, "radioOn", radioOn,
                        "found", 0, "nameless", 0, "away", 0, "enumerated", false, "reason", radioWhy);
      }
    }

    /// Stops the scan; `why` goes to the page with the "stopped" push. The found set is kept for list.
    static IDictionary StopScan(string why) {
      bool was;
      int shown, nameless, away;
      lock (_slock) {
        was = StopLocked(why);
        Counts(out shown, out nameless, out away);
      }
      if (was) {
        Program.EmitLog("info", "devpair: scan stopped (" + why + "), " + shown + " shown, " + nameless + " nameless");
        Push("stopped", Json.Obj("found", shown, "nameless", nameless, "away", away, "reason", why));
      }
      return Json.Obj("ok", true, "scanning", false, "stopped", was, "found", shown, "nameless", nameless,
                      "away", away, "reason", null);
    }

    /// Under _slock. True when a watcher was running.
    static bool StopLocked(string why) {
      if (_watcher == null) return false;
      var w = _watcher;
      _watcher = null;
      _scanReason = why;
      _scanStopped = DateTime.UtcNow;
      if (_lease != null) { _lease.Dispose(); _lease = null; }
      try {
        if (w.Status == DeviceWatcherStatus.Started || w.Status == DeviceWatcherStatus.EnumerationCompleted) w.Stop();
      } catch (Exception) { }
      return true;
    }

    static void LeaseLapsed(object state) {
      lock (_slock) {
        if (_watcher == null || !ReferenceEquals(state, _watcher)) return;
      }
      StopScan("the scan lapsed: nothing renewed it for " + (_leaseMs / 1000.0) + " s");
    }

    static void OnAdded(DeviceWatcher s, DeviceInformation d) {
      IDictionary push = null;
      lock (_slock) {
        if (s != _watcher) return;
        var f = new Found();
        f.Info = d;
        Fill(f);
        _found[f.Id] = f;
        if (Visible(f)) {
          f.Shown = true;
          f.LastPushTs = Stopwatch.GetTimestamp();
          push = DeviceJson(f);
        }
      }
      if (push != null) Push("found", Json.Obj("device", push));
    }

    static void OnUpdated(DeviceWatcher s, DeviceInformationUpdate u) {
      string kind = null;
      IDictionary push = null;
      lock (_slock) {
        if (s != _watcher) return;
        Found f;
        if (!_found.TryGetValue(u.Id, out f)) return;
        string oldName = f.Name;
        bool oldCan = f.CanPair;
        try { f.Info.Update(u); } catch (Exception) { return; }
        Fill(f);
        bool vis = Visible(f);
        if (vis && !f.Shown) kind = "found";
        else if (!vis && f.Shown) kind = "removed";
        else if (vis) {
          bool big = oldName != f.Name || oldCan != f.CanPair;
          if (big || Lanes.MsSince(f.LastPushTs) >= UpdateEveryMs) kind = "updated";
        }
        if (kind == null) return;
        f.Shown = vis;
        f.LastPushTs = Stopwatch.GetTimestamp();
        push = DeviceJson(f);
      }
      Push(kind, Json.Obj("device", push));
    }

    static void OnRemoved(DeviceWatcher s, DeviceInformationUpdate u) {
      IDictionary push = null;
      lock (_slock) {
        if (s != _watcher) return;
        Found f;
        if (!_found.TryGetValue(u.Id, out f)) return;
        _found.Remove(u.Id);
        if (f.Shown) push = DeviceJson(f);
      }
      if (push != null) Push("removed", Json.Obj("device", push));
    }

    static void OnEnumerated(DeviceWatcher s) {
      int shown, nameless, away;
      lock (_slock) {
        if (s != _watcher) return;
        _enumerated = true;
        Counts(out shown, out nameless, out away);
      }
      Program.EmitLog("info", "devpair: first pass done, " + shown + " shown, " + nameless + " nameless, " + away + " away");
      Push("done", Json.Obj("found", shown, "nameless", nameless, "away", away, "scanning", true,
                            "note", "Windows keeps looking until the scan stops or lapses"));
    }

    static void OnStopped(DeviceWatcher s) {
      string why;
      int shown, nameless, away;
      lock (_slock) {
        if (s != _watcher) return;          // our own Stop
        DeviceWatcherStatus st = DeviceWatcherStatus.Stopped;
        try { st = s.Status; } catch (Exception) { }
        why = st == DeviceWatcherStatus.Aborted ? "Windows aborted the scan (the radio may have switched off)"
                                                : "Windows stopped the scan (status " + st + ")";
        StopLocked(why);
        Counts(out shown, out nameless, out away);
      }
      Program.EmitLog("warn", "devpair: " + why);
      Push("stopped", Json.Obj("found", shown, "nameless", nameless, "away", away, "reason", why));
    }

    static string ListFound(Dictionary<string, object> req, ref object result) {
      lock (_slock) {
        var list = new ArrayList();
        var sorted = new List<Found>();
        foreach (var f in _found.Values) if (Visible(f)) sorted.Add(f);
        sorted.Sort(delegate (Found a, Found b) {
          int c = string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase);
          return c != 0 ? c : string.CompareOrdinal(a.Id, b.Id);
        });
        foreach (var f in sorted) list.Add(DeviceJson(f));
        int shown, nameless, away;
        Counts(out shown, out nameless, out away);
        bool never = _scanStarted == DateTime.MinValue;
        result = Json.Obj("ok", true, "scanning", _watcher != null, "enumerated", _enumerated,
                          "devices", list, "nameless", nameless, "away", away,
                          "startedAt", never ? null : (object)_scanStarted.ToString("o", CultureInfo.InvariantCulture),
                          "stoppedAt", _watcher != null || _scanStopped == DateTime.MinValue ? null
                                       : (object)_scanStopped.ToString("o", CultureInfo.InvariantCulture),
                          "reason", never ? "no scan has run since Mantle started: send devpair.scan {on:true}"
                                          : (_watcher == null ? _scanReason : null));
      }
      return null;
    }

    // ------------------------------------------------------------------ pairing

    sealed class Session {
      public string Token, Device, Name;
      public DevicePairingRequestedEventArgs Args;     // a ceremony waiting for the page (under _plock)
      public Windows.Foundation.Deferral Deferral;     // under _plock
      public string How;
      public Timer Timer;
      public bool Cancelled, TimedOut;
      public string Answer;                            // "accepted" / "rejected" / "timed out" / "cancelled"
      public Windows.Foundation.IAsyncOperation<DevicePairingResult> Op;
      public int Ceremonies;
    }

    static readonly object _plock = new object();
    static Session _pairing;                           // under _plock: at most one at a time

    const DevicePairingKinds Offered = DevicePairingKinds.ConfirmOnly | DevicePairingKinds.DisplayPin |
                                       DevicePairingKinds.ConfirmPinMatch | DevicePairingKinds.ProvidePin;

    static string HowOf(DevicePairingKinds k) {
      switch (k) {
        case DevicePairingKinds.ConfirmOnly: return "confirmOnly";
        case DevicePairingKinds.DisplayPin: return "displayPin";
        case DevicePairingKinds.ConfirmPinMatch: return "confirmPinMatch";
        case DevicePairingKinds.ProvidePin: return "providePin";
        default: return null;
      }
    }

    static readonly string[] OfferedNames = new string[] { "confirmOnly", "displayPin", "confirmPinMatch", "providePin" };

    static string StatusWords(DevicePairingResultStatus s) {
      switch (s) {
        case DevicePairingResultStatus.Paired: return "paired";
        case DevicePairingResultStatus.AlreadyPaired: return "it was already paired";
        case DevicePairingResultStatus.NotReadyToPair: return "the device is not ready to pair: put it in pairing mode and try again";
        case DevicePairingResultStatus.NotPaired: return "the device did not pair";
        case DevicePairingResultStatus.ConnectionRejected: return "the device refused the connection";
        case DevicePairingResultStatus.TooManyConnections: return "the device has too many connections";
        case DevicePairingResultStatus.HardwareFailure: return "the Bluetooth hardware failed";
        case DevicePairingResultStatus.AuthenticationTimeout: return "the device did not finish the check in time";
        case DevicePairingResultStatus.AuthenticationNotAllowed: return "the device does not allow this kind of pairing";
        case DevicePairingResultStatus.AuthenticationFailure: return "the check failed (a wrong PIN, or the codes did not match)";
        case DevicePairingResultStatus.NoSupportedProfiles: return "Windows supports none of this device's services";
        case DevicePairingResultStatus.ProtectionLevelCouldNotBeMet: return "the device cannot pair securely enough";
        case DevicePairingResultStatus.AccessDenied: return "Windows denied access to the device";
        case DevicePairingResultStatus.InvalidCeremonyData: return "the PIN or confirmation was not valid";
        case DevicePairingResultStatus.PairingCanceled: return "the pairing was cancelled";
        case DevicePairingResultStatus.OperationAlreadyInProgress: return "Windows is already pairing this device";
        case DevicePairingResultStatus.RequiredHandlerNotRegistered: return "Windows needed a way to ask that Mantle does not offer";
        case DevicePairingResultStatus.RejectedByHandler: return "Mantle said no to the device";
        case DevicePairingResultStatus.RemoteDeviceHasAssociation: return "the device is paired with something else";
        case DevicePairingResultStatus.Failed: return "the pairing failed";
        default: return "Windows answered " + s;
      }
    }

    static string Pair(Dictionary<string, object> req, ref object result) {
      req.Remove("pin");   // a PIN never rides on a pair request; if one was sent, it goes before anything reads it
      const string cmd = "devpair.pair";
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      string device;
      why = DeviceArg(req, cmd, out device);
      if (why != null) return why;
      object rid = Rid(req);
      if (dry) {
        Post(rid, cmd, delegate (out object r) { return PairPlan(device, out r); });
        result = Program.Deferred;
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": devpair.pair would pair this PC with a real Bluetooth device";
      Session s;
      lock (_plock) {
        if (_pairing != null)
          return cmd + ": another pairing is in progress (session " + _pairing.Token + "); finish or cancel it first, one at a time";
        s = new Session();
        s.Token = NewToken();
        s.Device = device;
        _pairing = s;
      }
      Post(rid, cmd, delegate (out object r) { return RunPairing(s, out r); });
      result = Program.Deferred;
      return null;
    }

    static string Resolve(string device, string[] props, out DeviceInformation di) {
      di = null;
      string err = WinRt.Await(DeviceInformation.CreateFromIdAsync(device, props, DeviceInformationKind.AssociationEndpoint),
                               CallMs, "Windows' lookup of that device", out di);
      if (err != null) return "no Bluetooth device with that id could be found (" + err + ")";
      if (di == null) return "no Bluetooth device with that id could be found";
      if (ProtocolOf(di.Properties) == null) return "that id is not a Bluetooth device";
      return null;
    }

    static string PairPlan(string device, out object r) {
      r = null;
      DeviceInformation di;
      string err = Resolve(device, ScanProps, out di);
      if (err != null) return "devpair.pair: " + err;
      var pairing = di.Pairing;
      bool paired = pairing.IsPaired, can = pairing.CanPair;
      string name = (di.Name ?? "").Trim();
      string would;
      if (paired) would = "do nothing: this device is already paired";
      else if (!can) would = "not pair: Windows says this device cannot be paired right now (out of range, or not in pairing mode)";
      else would = "pair with this " + ProtocolOf(di.Properties) + " device, asking you to confirm (or show / type a PIN) " +
                   "when the device asks for it";
      var cer = new ArrayList();
      foreach (var n in OfferedNames) cer.Add(n);
      r = Json.Obj("dryRun", true, "would", would, "device", di.Id, "name", name, "kind", KindOf(di.Properties),
                   "protocol", ProtocolOf(di.Properties), "canPair", can, "isPaired", paired,
                   "protectionLevel", pairing.ProtectionLevel.ToString(),
                   "ceremonies", cer, "ceremonyTimeoutMs", CeremonyMs,
                   "note", "the device, not Windows, picks one of these ceremonies when the pairing starts; displayPin is accepted at once " +
                           "(the PIN is typed on the device), the others wait for devpair.respond",
                   "reason", paired || !can ? would : null);
      return null;
    }

    static string RunPairing(Session s, out object r) {
      r = null;
      DeviceInformationCustomPairing custom = null;
      Windows.Foundation.TypedEventHandler<DeviceInformationCustomPairing, DevicePairingRequestedEventArgs> handler = null;
      try {
        DeviceInformation di;
        string err = Resolve(s.Device, ScanProps, out di);
        if (err != null) return "devpair.pair: " + err;
        s.Name = (di.Name ?? "").Trim();
        var pairing = di.Pairing;
        if (pairing.IsPaired) {
          r = Json.Obj("ok", true, "session", s.Token, "device", s.Device, "name", s.Name, "status", "AlreadyPaired",
                       "words", StatusWords(DevicePairingResultStatus.AlreadyPaired), "ceremony", null, "reason", null);
          return null;
        }
        if (!pairing.CanPair) {
          r = Json.Obj("ok", false, "session", s.Token, "device", s.Device, "name", s.Name, "status", null,
                       "reason", "Windows says this device cannot be paired right now: bring it close and put it in pairing mode");
          return null;
        }
        Program.EmitLog("info", "devpair: pairing session " + s.Token + " started (" + ProtocolOf(di.Properties) + ")");
        custom = pairing.Custom;
        handler = delegate (DeviceInformationCustomPairing snd, DevicePairingRequestedEventArgs a) { OnRequested(s, a); };
        custom.PairingRequested += handler;
        var op = custom.PairAsync(Offered, DevicePairingProtectionLevel.Default);
        lock (_plock) {
          s.Op = op;
          if (s.Cancelled) { try { op.Cancel(); } catch (Exception) { } }
        }
        DevicePairingResult res;
        err = WinRt.Await(op, PairTotalMs, "Windows' pairing", out res);
        string answer;
        lock (_plock) answer = s.Answer;
        if (err != null) {
          bool cancelled;
          lock (_plock) cancelled = s.Cancelled;
          r = Json.Obj("ok", false, "session", s.Token, "device", s.Device, "name", s.Name,
                       "status", cancelled ? "PairingCanceled" : null, "ceremony", s.How, "answer", answer,
                       "reason", cancelled ? "the pairing was cancelled" : err);
          return null;
        }
        DevicePairingResultStatus st = res.Status;
        bool ok = st == DevicePairingResultStatus.Paired || st == DevicePairingResultStatus.AlreadyPaired;
        string words = StatusWords(st);
        bool timedOut;
        lock (_plock) timedOut = s.TimedOut;
        if (timedOut && !ok) words = "nobody answered within " + (CeremonyMs / 1000) + " s, so Mantle said no to the device";
        Program.EmitLog(ok ? "info" : "warn", "devpair: pairing session " + s.Token + " ended: " + st);
        r = Json.Obj("ok", ok, "session", s.Token, "device", s.Device, "name", s.Name, "status", st.ToString(),
                     "words", words, "protectionLevel", ok ? (object)res.ProtectionLevelUsed.ToString() : null,
                     "ceremony", s.How, "answer", answer, "reason", ok ? null : words);
        return null;
      } finally {
        if (custom != null && handler != null) { try { custom.PairingRequested -= handler; } catch (Exception) { } }
        Windows.Foundation.Deferral left = null;
        lock (_plock) {
          if (s.Timer != null) { s.Timer.Dispose(); s.Timer = null; }
          left = s.Deferral;
          s.Deferral = null;
          s.Args = null;
          if (_pairing == s) _pairing = null;
        }
        if (left != null) { try { left.Complete(); } catch (Exception) { } }
        Push("ended", Json.Obj("session", s.Token));
      }
    }

    /// Windows asks: take a deferral, tell the page, wait for devpair.respond (or the timeout).
    static void OnRequested(Session s, DevicePairingRequestedEventArgs a) {
      DevicePairingKinds kind = a.PairingKind;
      string how = HowOf(kind);
      string pin = null;
      if (kind == DevicePairingKinds.DisplayPin || kind == DevicePairingKinds.ConfirmPinMatch) {
        try { pin = a.Pin; } catch (Exception) { }
      }
      if (how == null) {
        // Only the four offered kinds should arrive; anything else is said no to, and said.
        lock (_plock) { s.Answer = "rejected"; s.How = kind.ToString(); }
        Push("confirm", Json.Obj("session", s.Token, "how", kind.ToString(), "needsAnswer", false,
                                 "reason", "the device asked for a kind of pairing Mantle does not offer (" + kind + "), so Mantle said no"));
        return;   // no Accept: Windows answers RejectedByHandler
      }
      if (kind == DevicePairingKinds.DisplayPin) {
        // The PIN is typed on the other device: accept now (Microsoft's sample does the same).
        try { a.Accept(); } catch (Exception) { }
        lock (_plock) { s.How = how; s.Ceremonies++; s.Answer = "accepted"; }
        Push("confirm", Json.Obj("session", s.Token, "how", how, "pin", pin, "needsAnswer", false, "device", s.Device,
                                 "name", s.Name, "note", "type this PIN on the device; devpair.cancel stops the pairing"));
        return;
      }
      Windows.Foundation.Deferral d = null;
      try { d = a.GetDeferral(); } catch (Exception) { }
      bool drop = false;
      lock (_plock) {
        if (_pairing != s || s.Cancelled) drop = true;
        else {
          s.Args = a;
          s.Deferral = d;
          s.How = how;
          s.Ceremonies++;
          s.Timer = new Timer(CeremonyTimeout, s, CeremonyMs, Timeout.Infinite);
        }
      }
      if (drop) { if (d != null) { try { d.Complete(); } catch (Exception) { } } return; }
      Push("confirm", Json.Obj("session", s.Token, "how", how, "pin", pin, "needsAnswer", true, "device", s.Device,
                               "name", s.Name, "timeoutMs", CeremonyMs));
    }

    static void CeremonyTimeout(object state) {
      var s = (Session)state;
      Windows.Foundation.Deferral d;
      lock (_plock) {
        if (s.Args == null) return;
        d = s.Deferral;
        s.Args = null;
        s.Deferral = null;
        s.TimedOut = true;
        s.Answer = "timed out";
      }
      if (d != null) { try { d.Complete(); } catch (Exception) { } }   // completed without Accept = no
      Program.EmitLog("info", "devpair: pairing session " + s.Token + " timed out waiting for an answer");
      Push("timeout", Json.Obj("session", s.Token,
                               "reason", "nobody answered within " + (CeremonyMs / 1000) + " s, so Mantle said no to the device"));
    }

    static string SessionArg(Dictionary<string, object> req, string cmd, out string session) {
      session = null;
      object v;
      if (!req.TryGetValue("session", out v) || v == null) return cmd + " needs session: the session from the confirm event";
      if (!(v is string)) return cmd + ": session must be a string";
      session = (string)v;
      if (session.Length == 0 || session.Length > 64) return cmd + ": that is not a pairing session";
      return null;
    }

    static string Respond(Dictionary<string, object> req, ref object result) {
      // The PIN is a secret: out of the request before anything else can see or log it.
      object pinObj;
      if (req.TryGetValue("pin", out pinObj)) req.Remove("pin");
      const string cmd = "devpair.respond";
      string session;
      string why = SessionArg(req, cmd, out session);
      if (why != null) return why;
      object v;
      if (!req.TryGetValue("accept", out v) || !(v is bool)) return cmd + " needs accept: true or false";
      bool accept = (bool)v;
      string pin = null;
      if (pinObj != null) {
        if (!(pinObj is string)) return cmd + ": the PIN must be text";
        pin = (string)pinObj;
      }
      DevicePairingRequestedEventArgs a;
      Windows.Foundation.Deferral d;
      string how;
      lock (_plock) {
        var s = _pairing;
        if (s == null || s.Token != session) return cmd + ": no pairing session by that name is running (it finished, timed out or never started)";
        if (s.Args == null) return cmd + ": that pairing is not waiting for an answer right now";
        how = s.How;
        if (accept && how == "providePin") {
          if (string.IsNullOrEmpty(pin)) return cmd + ": this device needs its PIN: send pin with accept true";
          if (pin.Length > 16) return cmd + ": a Bluetooth PIN is at most 16 characters";
          foreach (char c in pin) if (c < 0x20 || c > 0x7E) return cmd + ": a Bluetooth PIN uses plain letters and digits";
        }
        a = s.Args;
        d = s.Deferral;
        s.Args = null;
        s.Deferral = null;
        if (s.Timer != null) { s.Timer.Dispose(); s.Timer = null; }
        s.Answer = accept ? "accepted" : "rejected";
      }
      // The WinRT calls run on a pool (MTA) thread, where the event arrived: this lane is STA.
      Post(Rid(req), cmd, delegate (out object r) {
        r = null;
        string err = null;
        try {
          if (accept) {
            if (how == "providePin") a.Accept(pin); else a.Accept();
          }
        } catch (Exception ex) {
          err = "Windows did not take the answer (" + Why(ex) + ")";
        } finally {
          if (d != null) { try { d.Complete(); } catch (Exception) { } }
        }
        pin = null;
        if (err != null) return cmd + ": " + err;
        r = Json.Obj("ok", true, "session", session, "answered", accept ? "accepted" : "rejected", "how", how,
                     "note", "devpair.pair answers with Windows' verdict");
        return null;
      });
      result = Program.Deferred;
      return null;
    }

    static string Cancel(Dictionary<string, object> req, ref object result) {
      const string cmd = "devpair.cancel";
      string session;
      string why = SessionArg(req, cmd, out session);
      if (why != null) return why;
      Windows.Foundation.Deferral d;
      Windows.Foundation.IAsyncOperation<DevicePairingResult> op;
      lock (_plock) {
        var s = _pairing;
        if (s == null || s.Token != session) return cmd + ": no pairing session by that name is running (it finished, timed out or never started)";
        s.Cancelled = true;
        s.Answer = "cancelled";
        d = s.Deferral;
        s.Args = null;
        s.Deferral = null;
        if (s.Timer != null) { s.Timer.Dispose(); s.Timer = null; }
        op = s.Op;
      }
      Post(Rid(req), cmd, delegate (out object r) {
        if (d != null) { try { d.Complete(); } catch (Exception) { } }
        if (op != null) { try { op.Cancel(); } catch (Exception) { } }
        r = Json.Obj("ok", true, "session", session, "cancelled", true,
                     "note", "devpair.pair answers with how the pairing ended");
        return null;
      });
      result = Program.Deferred;
      return null;
    }

    // ------------------------------------------------------------------ unpair

    static string Unpair(Dictionary<string, object> req, ref object result) {
      const string cmd = "devpair.unpair";
      bool dry;
      string why = DryRunOf(req, cmd, out dry);
      if (why != null) return why;
      string device;
      why = DeviceArg(req, cmd, out device);
      if (why != null) return why;
      bool passive = Program.Passive;
      Post(Rid(req), cmd, delegate (out object r) { return RunUnpair(device, dry, passive, out r); });
      result = Program.Deferred;
      return null;
    }

    /// A device paired over classic AND LE is two AEPs in one container (BtDevices merges them into one
    /// row, keeping the classic id). Removing the device means removing both, so every paired Bluetooth
    /// AEP in the container is unpaired, and the reply says what happened to each.
    static string RunUnpair(string device, bool dry, bool passive, out object r) {
      r = null;
      const string cmd = "devpair.unpair";
      DeviceInformation di;
      string err = Resolve(device, IdProps, out di);
      if (err != null) return cmd + ": " + err;
      string name = (di.Name ?? "").Trim();
      string container = GuidText(Prop(di.Properties, P_CONTAINER));
      var targets = new List<DeviceInformation>();
      if (container != null) {
        DeviceInformationCollection col;
        err = WinRt.Await(DeviceInformation.FindAllAsync(Selector(true), IdProps, DeviceInformationKind.AssociationEndpoint),
                          CallMs, "Windows' paired-device list", out col);
        if (err != null) return cmd + ": " + err;
        foreach (DeviceInformation x in col)
          if (string.Equals(GuidText(Prop(x.Properties, P_CONTAINER)), container, StringComparison.OrdinalIgnoreCase)) targets.Add(x);
      }
      if (targets.Count == 0 && di.Pairing.IsPaired) targets.Add(di);
      if (targets.Count == 0) return cmd + ": that device is not paired, so there is nothing to remove";
      var plan = new ArrayList();
      foreach (var x in targets)
        plan.Add(Json.Obj("device", x.Id, "protocol", ProtocolOf(x.Properties), "paired", x.Pairing.IsPaired));
      string would = "remove the pairing of this device (" + targets.Count + " Windows " +
                     (targets.Count == 1 ? "entry" : "entries: its classic and LE halves") +
                     "); it would have to be paired again to use it";
      if (dry) {
        r = Json.Obj("dryRun", true, "would", would, "device", device, "name", name, "container", container,
                     "entries", plan, "reason", null);
        return null;
      }
      if (passive) return FeatureTable.PassiveRefusal + ": devpair.unpair would " + would;
      var outcome = new ArrayList();
      bool allOk = true;
      string firstWhy = null;
      foreach (var x in targets) {
        DeviceUnpairingResult res;
        string e = WinRt.Await(x.Pairing.UnpairAsync(), UnpairMs, "Windows' unpairing", out res);
        string status = e == null ? res.Status.ToString() : null;
        bool ok = e == null && (res.Status == DeviceUnpairingResultStatus.Unpaired ||
                                res.Status == DeviceUnpairingResultStatus.AlreadyUnpaired);
        string words = e ?? UnpairWords(res.Status);
        if (!ok) { allOk = false; if (firstWhy == null) firstWhy = words; }
        outcome.Add(Json.Obj("device", x.Id, "protocol", ProtocolOf(x.Properties), "status", status, "words", words, "ok", ok));
      }
      Program.EmitLog(allOk ? "info" : "warn", "devpair: unpair of " + targets.Count + " entries " + (allOk ? "done" : "failed"));
      r = Json.Obj("ok", allOk, "device", device, "name", name, "entries", outcome, "reason", firstWhy);
      return null;
    }

    static string UnpairWords(DeviceUnpairingResultStatus s) {
      switch (s) {
        case DeviceUnpairingResultStatus.Unpaired: return "removed";
        case DeviceUnpairingResultStatus.AlreadyUnpaired: return "it was already removed";
        case DeviceUnpairingResultStatus.OperationAlreadyInProgress: return "Windows is already removing this device";
        case DeviceUnpairingResultStatus.AccessDenied: return "Windows denied access to the device";
        case DeviceUnpairingResultStatus.Failed: return "Windows could not remove the device";
        default: return "Windows answered " + s;
      }
    }
#endif
  }
}
