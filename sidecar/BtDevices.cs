// BtDevices.cs - the PAIRED Bluetooth devices behind the Bluetooth tile's '>' (qsx lane, 2026-09-23).
//
// Windows 11's quick settings has a '>' on its Bluetooth tile: the paired devices, inside the same
// panel, each with a type icon, Connected / Not connected, the battery where Windows knows it, and
// Connect / Disconnect on audio devices. This is the sidecar half of Mantle's copy of that list.
//
//   {cmd:"btdevices"} / {op:"list"}        the paired devices, one row per physical device, with the
//                                          radio's state and a reason for everything that is missing
//   {op:"watch", on:true|false}            a DeviceWatcher while the view is open; {ev:"btdevices"}
//                                          once a change settles. It lapses on its own LeaseMs after
//                                          the last renewal, so a view that dies cannot leave it on.
//   {op:"connect"|"disconnect", device}    audio devices only, through the Bluetooth audio driver's
//                                          own one-shot reconnect / disconnect. Refused in passive.
//
// THE LIST is Windows' association endpoints (AEP) for paired classic and LE devices, through
// Windows.Devices.Enumeration: the same objects Settings > Bluetooth & devices lists. A device
// paired over both classic and LE is two AEPs in one container, so rows are merged by container.
//
// CONNECT / DISCONNECT: Windows has no public "connect this paired device" call. The route here is
// the one the open-source ToothTray app uses: every Bluetooth audio device's sound endpoints sit on
// a kernel-streaming filter from Windows' own Bluetooth audio drivers, and that filter has a
// property set, KSPROPSETID_BtAudio, with two one-shot properties: KSPROPERTY_ONESHOT_RECONNECT
// and KSPROPERTY_ONESHOT_DISCONNECT. A GET of either IS the action. Reached through
// IMMDevice -> IDeviceTopology -> connector -> the filter's own IMMDevice -> IKsControl.
// NOT BluetoothSetServiceState: that tears the profile's driver down and reinstalls it.
//
// THE SUPPORT CHECK NEVER NAMES THE SET. Whether a filter offers KSPROPSETID_BtAudio is asked with
// KSPROPERTY_TYPE_SETSUPPORT and Set = GUID_NULL, which the kernel-streaming framework answers
// itself with the list of every property set the filter has; no driver handler runs. A request
// that named the BtAudio set could, in a driver that ignored the flags, BE the reconnect.
//
// NO SILENT FAILURES: every missing battery, every device without a connect route, every failed
// read says why, in words, in the reply.
//
// MEASURED on Owen's machine, 2026-09-23 (Windows 11 build 26200), all of it read-only:
//   - 4 paired devices, all classic: two WH-CH520 (class of device 4/1, a headset; Windows' category
//     "Communication.Headset.Bluetooth"), an Xbox Wireless Controller (5/2, "Input.Gaming") and an
//     Android TV (4/15, a video display: "Display"). A list is 71-100 ms cold and 26 ms warm.
//   - THE BATTERY, {104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2, sits on the headset's Hands-Free node
//     (BTHENUM\{0000111E-...}) and read 100 on both WH-CH520 while they were switched off. Every
//     profile node of every paired device reads present, connected or not, so presence cannot tell a
//     live level from the last one: a level is shown only while the AEP says connected.
//   - A disconnected headset's sound endpoints stay listed as UNPLUGGED (state 8) on their filters:
//     the stereo (A2DP) "src" filter with 10 property sets and the hands-free "bthhfpaudio" wave
//     filter with 9. All four filters list KSPROPSETID_BtAudio; each set list took 0-1 ms.
//   - A CONNECTED headset's hands-free endpoint can be DISABLED (state 2): the WH-CH520 playing
//     stereo had "Headset (2- WH-CH520)" disabled, its hands-free filter still there. So the filter
//     search takes disabled endpoints too (ROUTE_STATES), or a disconnect could miss that link.
//   - The watch's first push comes 0.3 s after it starts (Windows' first enumeration completing).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
#if MANTLE_WINMD
using Windows.Devices.Bluetooth;
using Windows.Devices.Enumeration;
#endif

namespace Mantle {
  static class BtDevices {
    const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    /// Called by Program's case, which has already checked `on` is a strict boolean.
    public static string Run(Dictionary<string, object> req, object id, bool passive, out object result) {
      result = null;
      string op = Json.GetString(req, "op");
      if (string.IsNullOrEmpty(op)) op = "list";
      if (op != "list" && op != "watch" && op != "connect" && op != "disconnect")
        return "btdevices: unknown op \"" + op + "\" (it does list, watch, connect, disconnect)";
      string device = null;
      if (op == "connect" || op == "disconnect") {
        device = Json.GetString(req, "device");
        if (string.IsNullOrEmpty(device)) return "btdevices " + op + " needs device: a row's id from the list";
        if (device.Length > 400) return "btdevices " + op + ": that device id is too long to be one";
        if (passive) return PassiveRefusal + ": btdevices " + op + " would " + op + " a real Bluetooth device";
      }
      if (op == "watch" && !Json.HasKey(req, "on")) return "btdevices watch needs on: true or false";
#if !MANTLE_WINMD
      result = Json.Obj("ok", false, "present", SafePresent(), "on", null, "devices", new ArrayList(),
                        "watching", false, "reason", Unavailable);
      return null;
#else
      long arrived = Stopwatch.GetTimestamp();
      int ttl = TtlOf(req);
      if (op == "watch") {
        bool on = Json.GetBool(req, "on", false);
        int lease = Json.GetInt(req, "leaseMs", LeaseMs);
        if (lease < 1000 || lease > LeaseMs) return "btdevices watch: leaseMs must be 1000-" + LeaseMs;
        Post(id, arrived, ttl, delegate { return Watch(on, lease); });
      } else if (op == "connect" || op == "disconnect") {
        bool connect = op == "connect";
        Post(id, arrived, ttl, delegate { return Toggle(device, connect); });
      } else {
        bool raw = Json.GetBool(req, "raw", false);
        Post(id, arrived, ttl, delegate { return List(raw); });
      }
      result = Program.Deferred;
      return null;
#endif
    }

    static bool SafePresent() {
      try { return Bluetooth.Present(); } catch (Exception) { return false; }
    }

#if !MANTLE_WINMD
    const string Unavailable =
      "the Bluetooth device list is not built into this sidecar: build.ps1 did not find the WinRT metadata " +
      "(System32\\WinMetadata\\Windows.Devices.winmd and its companions), so MANTLE_WINMD was not defined";
#else
    const int CallMs = 3000;          // one WinRT call
    const int DebounceMs = 250;       // a connect is a burst of Updated events; one list after it settles
    const int LeaseMs = 90000;        // a watch not renewed for this long stops itself
    const int TickMs = 5000;          // while watching: the lease, the radio, the battery clock
    const int BatteryEveryMs = 30000; // while watching with something connected: re-read batteries
    const int ConnectSettleMs = 12000;
    const int DisconnectSettleMs = 8000;
    const int SettlePollMs = 300;
    const int LastKeepMs = 120000;    // how long the last connect/disconnect outcome rides on the list

    // ------------------------------------------------------------------ properties

    const string P_CONNECTED = "System.Devices.Aep.IsConnected";
    const string P_CONTAINER = "System.Devices.Aep.ContainerId";
    const string P_ADDRESS = "System.Devices.Aep.DeviceAddress";
    const string P_PROTOCOL = "System.Devices.Aep.ProtocolId";
    const string P_COD_MAJOR = "System.Devices.Aep.Bluetooth.Cod.Major";
    const string P_COD_MINOR = "System.Devices.Aep.Bluetooth.Cod.Minor";
    const string P_APPEARANCE = "System.Devices.Aep.Bluetooth.Le.Appearance";
    const string P_CATEGORY = "System.Devices.Aep.Category";
    // On a device node (not the AEP). The GUID-PID form: this key has no canonical name.
    const string P_BATTERY = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";
    const string P_NODE_CONTAINER = "System.Devices.ContainerId";
    const string P_NODE_PRESENT = "{540B947E-8B40-45BC-A8A2-6A0B894CBDA2} 5";   // DEVPKEY_Device_IsPresent

    static readonly string[] AepProps = new string[] {
      P_CONNECTED, P_CONTAINER, P_ADDRESS, P_PROTOCOL, P_COD_MAJOR, P_COD_MINOR, P_APPEARANCE, P_CATEGORY
    };
    static readonly string[] NodeProps = new string[] { P_BATTERY, P_NODE_CONTAINER, P_NODE_PRESENT };

    static readonly Guid LeProtocol = new Guid("bb7bb05e-5972-42b5-94fc-76eaa7084d49");

    static string _aqs;
    static string Aqs() {
      if (_aqs != null) return _aqs;
      string a = null, b = null;
      try { a = BluetoothDevice.GetDeviceSelectorFromPairingState(true); } catch (Exception) { }
      try { b = BluetoothLEDevice.GetDeviceSelectorFromPairingState(true); } catch (Exception) { }
      if (string.IsNullOrEmpty(a))
        a = "System.Devices.Aep.ProtocolId:=\"{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}\" AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#True";
      if (string.IsNullOrEmpty(b))
        b = "System.Devices.Aep.ProtocolId:=\"{bb7bb05e-5972-42b5-94fc-76eaa7084d49}\" AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#True";
      _aqs = "(" + a + ") OR (" + b + ")";
      return _aqs;
    }

    // ------------------------------------------------------------------ pool jobs

    delegate IDictionary Work();

    static int TtlOf(Dictionary<string, object> req) {
      object raw;
      if (req.TryGetValue("ttl", out raw) && raw is double) {
        double d = (double)raw;
        if (d > 0 && d < int.MaxValue) return (int)d;
      }
      return 0;
    }

    /// One job on a pool thread (MTA: WinRT enumeration and CoreAudio are both free-threaded, and
    /// a connect that waits 12 s for Windows' verdict must not hold any lane). A caller that has
    /// already given up is told so instead of having the work done for nobody.
    static void Post(object id, long arrivedTs, int ttlMs, Work work) {
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        long waited = Lanes.MsSince(arrivedTs);
        if (ttlMs > 0 && waited >= ttlMs) {
          Program.ReplyFromWorker(id, false, null, "expired: \"btdevices\" waited " + waited + " ms, past the caller's " +
                                  ttlMs + " ms deadline, so it was skipped rather than run for nobody");
          return;
        }
        IDictionary r;
        try {
          r = work();
        } catch (Exception ex) {
          r = Json.Obj("ok", false, "reason", "the Bluetooth device request failed inside Mantle (" + Why(ex) + ")");
        }
        Program.ReplyFromWorker(id, true, r, null);
      });
    }

    static string Why(Exception ex) {
      if (ex is AggregateException && ex.InnerException != null) ex = ex.InnerException;
      string msg = (ex.Message ?? "").Trim();
      int nl = msg.IndexOfAny(new[] { '\r', '\n' });
      if (nl > 0) msg = msg.Substring(0, nl).Trim();
      msg = msg.TrimEnd('.', ' ');   // Windows' text ends in a full stop; the reason goes on after it
      return "HRESULT 0x" + ex.HResult.ToString("X8") + (msg.Length > 0 ? ": " + msg : "");
    }

    static string Hr(int hr) { return "HRESULT 0x" + hr.ToString("X8"); }

    // ------------------------------------------------------------------ one row

    sealed class Row {
      public string Id, Name, Container, Address;
      public bool Connected, Le, Classic;
      public int CodMajor = -1, CodMinor = -1, Appearance = -1;
      public string[] Category;
      public string Kind = "other", KindFrom;
      public int Battery = -1;
      public string BatteryWhy;
      public bool Audio, CanConnect;
      public string ConnectWhy;
      public readonly List<string> Filters = new List<string>();
      public ArrayList RawAep, RawNodes, RawEndpoints, RawKs;
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
      if (s == null) return null;
      Guid g;
      return Guid.TryParse(s, out g) ? g.ToString("D") : null;
    }

    static string Show(object v) {
      if (v == null) return null;
      var arr = v as Array;
      if (arr != null && !(v is string)) {
        var parts = new List<string>();
        foreach (var x in arr) parts.Add(Convert.ToString(x, CultureInfo.InvariantCulture));
        return "[" + string.Join(", ", parts.ToArray()) + "]";
      }
      return Convert.ToString(v, CultureInfo.InvariantCulture) + " (" + v.GetType().Name + ")";
    }

    /// The type icon. Classic devices say what they are in their Class of Device (major / minor
    /// fields of the Bluetooth assigned numbers); LE devices in their GAP Appearance. Anything
    /// else is "other": a guess from the name would be wrong for every device that is not one.
    static void Classify(Row r) {
      if (r.CodMajor >= 0) {
        string k = FromCod(r.CodMajor, r.CodMinor < 0 ? 0 : r.CodMinor);
        if (k != null) { r.Kind = k; r.KindFrom = "class"; return; }
      }
      if (r.Appearance > 0) {
        string k = FromAppearance(r.Appearance);
        if (k != null) { r.Kind = k; r.KindFrom = "appearance"; return; }
      }
      // Windows' own category for the AEP (measured: "Communication.Headset.Bluetooth",
      // "Input.Gaming", "Display"), for a device whose class or appearance says nothing usable.
      if (r.Category != null) {
        string k = FromCategory(r.Category);
        if (k != null) { r.Kind = k; r.KindFrom = "category"; return; }
      }
      r.Kind = "other";
      r.KindFrom = null;
    }

    internal static string FromCategory(string[] cats) {
      foreach (var c0 in cats) {
        string c = (c0 ?? "").ToLowerInvariant();
        if (c.Contains("headset") || c.Contains("headphone") || c.Contains("earbud")) return "headphones";
        if (c.Contains("speaker")) return "speaker";
        if (c.Contains("keyboard")) return "keyboard";
        if (c.Contains("mouse")) return "mouse";
        if (c.Contains("gaming") || c.Contains("gamepad") || c.Contains("joystick")) return "gamepad";
        if (c.Contains("phone")) return "phone";
      }
      return null;
    }

    internal static string FromCod(int major, int minor) {
      switch (major) {
        case 2: return "phone";
        case 4:   // audio / video
          switch (minor) {
            case 1: case 2: case 6: return "headphones";   // wearable headset, hands-free, headphones
            case 5: case 7: case 10: return "speaker";     // loudspeaker, portable audio, HiFi
            default: return null;
          }
        case 5: { // peripheral: bits 5-4 keyboard / pointing, bits 3-0 the sub-type
          int kp = (minor >> 4) & 3, sub = minor & 0xF;
          if (kp == 1 || kp == 3) return "keyboard";
          if (kp == 2) return "mouse";
          if (sub == 1 || sub == 2) return "gamepad";      // joystick, gamepad
          return null;
        }
        default: return null;
      }
    }

    internal static string FromAppearance(int appearance) {
      int cat = appearance >> 6, sub = appearance & 0x3F;
      switch (cat) {
        case 1: return "phone";
        case 15:  // HID
          if (sub == 1) return "keyboard";
          if (sub == 2) return "mouse";
          if (sub == 3 || sub == 4) return "gamepad";
          return null;
        case 33: return "speaker";      // audio sink: speaker, soundbar, bookshelf ...
        case 37: return "headphones";   // wearable audio: earbud, headset, headphones, neckband
        default: return null;
      }
    }

    // ------------------------------------------------------------------ the list

    static readonly object _listLock = new object();

    static IDictionary List(bool raw) {
      lock (_listLock) return ListLocked(raw);
    }

    static IDictionary ListLocked(bool raw) {
      long t0 = Stopwatch.GetTimestamp();
      var ms = Json.Obj();

      // The radio first: no adapter means there is nothing to list, and "off" is the view's state.
      IDictionary radio;
      try { radio = Bluetooth.Read(); } catch (Exception ex) {
        radio = Json.Obj("ok", false, "present", SafePresent(), "on", false, "via", null,
                         "reason", "the Bluetooth radio could not be read (" + Why(ex) + ")");
      }
      ms["radio"] = Lanes.MsSince(t0);
      bool present = radio["present"] is bool && (bool)radio["present"];
      bool radioOk = radio["ok"] is bool && (bool)radio["ok"];
      object on = radioOk ? radio["on"] : null;
      string radioReason = radio["reason"] as string;
      if (!present) {
        return Reply(true, false, false, radioReason ?? "this machine has no Bluetooth radio", new ArrayList(), ms, t0,
                     "no Bluetooth radio");
      }

      long t1 = Stopwatch.GetTimestamp();
      DeviceInformationCollection col;
      string err = WinRt.Await(DeviceInformation.FindAllAsync(Aqs(), AepProps, DeviceInformationKind.AssociationEndpoint),
                               CallMs, "Windows' paired-device list", out col);
      ms["paired"] = Lanes.MsSince(t1);
      if (err != null) {
        return Reply(false, true, on, radioReason, new ArrayList(), ms, t0, err);
      }

      var rows = new List<Row>();
      var byKey = new Dictionary<string, Row>(StringComparer.OrdinalIgnoreCase);
      foreach (DeviceInformation di in col) {
        var p = di.Properties;
        string container = GuidText(Prop(p, P_CONTAINER));
        object proto = Prop(p, P_PROTOCOL);
        bool le = proto is Guid && (Guid)proto == LeProtocol;
        string key = container ?? di.Id;
        Row r;
        if (!byKey.TryGetValue(key, out r)) {
          r = new Row();
          r.Id = di.Id;
          r.Name = di.Name;
          r.Container = container;
          byKey[key] = r;
          rows.Add(r);
        } else if (!le && r.Le && !r.Classic) {
          // A dual-mode device: the classic entry is the one Settings names and connects.
          r.Id = di.Id;
          if (!string.IsNullOrEmpty(di.Name)) r.Name = di.Name;
        }
        if (le) r.Le = true; else r.Classic = true;
        if (Prop(p, P_CONNECTED) is bool && (bool)Prop(p, P_CONNECTED)) r.Connected = true;
        if (r.Address == null) r.Address = Prop(p, P_ADDRESS) as string;
        if (!le) {
          r.CodMajor = IntOr(Prop(p, P_COD_MAJOR), r.CodMajor);
          r.CodMinor = IntOr(Prop(p, P_COD_MINOR), r.CodMinor);
        } else {
          r.Appearance = IntOr(Prop(p, P_APPEARANCE), r.Appearance);
        }
        var cat = Prop(p, P_CATEGORY) as string[];
        if (cat != null && cat.Length > 0) r.Category = cat;
        if (string.IsNullOrEmpty(r.Name)) r.Name = "Unnamed device";
        if (raw) {
          if (r.RawAep == null) r.RawAep = new ArrayList();
          var d = Json.Obj("id", di.Id, "name", di.Name, "kind", di.Kind.ToString());
          foreach (var kv in p) d[kv.Key] = Show(kv.Value);
          r.RawAep.Add(d);
        }
      }
      foreach (var r in rows) Classify(r);

      long t2 = Stopwatch.GetTimestamp();
      string berr = Batteries(rows, raw);
      ms["battery"] = Lanes.MsSince(t2);

      long t3 = Stopwatch.GetTimestamp();
      string aerr = AudioPaths(rows, raw);
      ms["audio"] = Lanes.MsSince(t3);

      rows.Sort(delegate (Row a, Row b) {
        if (a.Connected != b.Connected) return a.Connected ? -1 : 1;
        int c = string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase);
        return c != 0 ? c : string.CompareOrdinal(a.Id, b.Id);
      });
      var list = new ArrayList();
      foreach (var r in rows) {
        if (berr != null && r.Connected && r.Battery < 0) r.BatteryWhy = "the battery could not be read: " + berr;
        if (aerr != null && !r.CanConnect && r.ConnectWhy == null) r.ConnectWhy = aerr;
        list.Add(RowJson(r, raw));
      }
      return Reply(true, true, on, radioReason, list, ms, t0, null);
    }

    static IDictionary Reply(bool ok, bool present, object on, string radioReason, ArrayList devices,
                             IDictionary ms, long t0, string reason) {
      ms["total"] = Lanes.MsSince(t0);
      return Json.Obj("ok", ok, "present", present, "on", on, "radioReason", radioReason,
                      "devices", devices, "busy", Busy(), "last", Last(),
                      "watching", Watching(), "watchReason", _watchReason,
                      "reason", reason, "ms", ms);
    }

    static IDictionary RowJson(Row r, bool raw) {
      string batteryWhy = r.BatteryWhy;
      object battery = null;
      if (!r.Connected) batteryWhy = null;          // Windows shows no battery for a device that is not connected
      else if (r.Battery >= 0) { battery = r.Battery; batteryWhy = null; }
      else if (batteryWhy == null) batteryWhy = "this device does not report its battery to Windows";
      var d = Json.Obj("id", r.Id, "name", r.Name, "kind", r.Kind, "kindFrom", r.KindFrom,
                       "connected", r.Connected, "battery", battery, "batteryWhy", batteryWhy,
                       "audio", r.Audio, "canConnect", r.CanConnect,
                       "connectWhy", r.CanConnect ? null : (r.ConnectWhy ?? NoRouteWhy(r)),
                       "le", r.Le && !r.Classic, "address", r.Address,
                       "cod", r.CodMajor >= 0 ? (object)Json.Obj("major", r.CodMajor, "minor", r.CodMinor < 0 ? 0 : r.CodMinor) : null,
                       "appearance", r.Appearance > 0 ? (object)r.Appearance : null,
                       "category", r.Category);
      if (raw) {
        d["container"] = r.Container;
        d["filters"] = new ArrayList(r.Filters);
        d["rawAep"] = r.RawAep;
        d["rawNodes"] = r.RawNodes;
        d["rawEndpoints"] = r.RawEndpoints;
        d["rawKs"] = r.RawKs;
      }
      return d;
    }

    static string NoRouteWhy(Row r) {
      if (!r.Audio)
        return "Mantle can connect and disconnect audio devices only; Windows connects this one itself when it is used";
      return "Windows gives Mantle no Bluetooth audio control for this device's sound";
    }

    // ------------------------------------------------------------------ batteries

    /// The battery lives on a device NODE, not the AEP: the Hands-Free node (BTHENUM\{0000111E-...})
    /// of a classic headset carries {104EA319-...} 2, the value Windows' own list shows. One query
    /// for every paired device's container. Every node keeps the LAST value it saw, and a paired
    /// device's nodes stay present while it is off (measured: see the top), so presence only
    /// drops a removed pairing's leftovers; RowJson shows a level only while connected.
    static string Batteries(List<Row> rows, bool raw) {
      var byContainer = new Dictionary<string, Row>(StringComparer.OrdinalIgnoreCase);
      var sb = new StringBuilder();
      foreach (var r in rows) {
        if (r.Container == null || byContainer.ContainsKey(r.Container)) continue;
        byContainer[r.Container] = r;
        if (sb.Length > 0) sb.Append(" OR ");
        sb.Append("System.Devices.ContainerId:=\"{").Append(r.Container).Append("}\"");
      }
      if (sb.Length == 0) return null;
      DeviceInformationCollection col;
      string err = WinRt.Await(DeviceInformation.FindAllAsync(sb.ToString(), NodeProps, DeviceInformationKind.Device),
                               CallMs, "the devices' battery levels", out col);
      if (err != null) return err;
      foreach (DeviceInformation di in col) {
        var p = di.Properties;
        string container = GuidText(Prop(p, P_NODE_CONTAINER));
        Row r;
        if (container == null || !byContainer.TryGetValue(container, out r)) continue;
        object pres = Prop(p, P_NODE_PRESENT);
        bool present = pres is bool && (bool)pres;
        int level = IntOr(Prop(p, P_BATTERY), -1);
        if (raw) {
          if (r.RawNodes == null) r.RawNodes = new ArrayList();
          r.RawNodes.Add(Json.Obj("id", di.Id, "name", di.Name, "present", Show(pres), "battery", Show(Prop(p, P_BATTERY))));
        }
        if (present && level >= 0 && level <= 100 && level > r.Battery) r.Battery = level;
      }
      return null;
    }

    // ------------------------------------------------------------------ the audio route (KS)

    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_IDeviceTopology = new Guid("2A07407E-6497-4A18-9787-32F79BD0D98F");
    static readonly Guid IID_IKsControl = new Guid("28F54685-06FD-11D2-B27A-00A0C9223196");
    static readonly Guid KSPROPSETID_BtAudio = new Guid("7FA06C40-B8F6-4C7E-8556-E8C33A12E54D");
    const uint KSPROPERTY_TYPE_GET = 0x1;
    const uint KSPROPERTY_TYPE_SETSUPPORT = 0x100;
    const uint KSPROPERTY_ONESHOT_RECONNECT = 0;
    const uint KSPROPERTY_ONESHOT_DISCONNECT = 1;
    const int E_ALL = 2;                          // EDataFlow eAll
    // Which sound endpoints lead to a device's filters: connected (active), switched off or out of
    // range (unplugged), AND disabled. Measured 2026-09-23: with the WH-CH520 connected and playing,
    // its hands-free endpoint was DISABLED (state 2) while its filter stayed present; a disconnect that
    // skipped that filter could leave the hands-free link up. Not-present endpoints have no filter.
    const int STATE_ACTIVE = 1, STATE_DISABLED = 2, STATE_UNPLUGGED = 8;
    const int ROUTE_STATES = STATE_ACTIVE | STATE_DISABLED | STATE_UNPLUGGED;
    const int CLSCTX_ALL = 23;
    const int STGM_READ = 0;
    const ushort VT_LPWSTR = 31, VT_CLSID = 72;

    static readonly PROPERTYKEY PKEY_Device_ContainerId =
      new PROPERTYKEY(new Guid("8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C"), 2);
    static readonly PROPERTYKEY PKEY_Device_FriendlyName =
      new PROPERTYKEY(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY {
      public Guid fmtid;
      public uint pid;
      public PROPERTYKEY(Guid f, uint p) { fmtid = f; pid = p; }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT {
      public ushort vt;
      public ushort r1, r2, r3;
      public IntPtr p1;
      public IntPtr p2;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KSPROPERTY {
      public Guid Set;
      public uint Id;
      public uint Flags;
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
      [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
      [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
      [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
      [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
      [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
      [PreserveSig] int GetCount(out uint count);
      [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
      [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
      [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
      [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
      [PreserveSig] int GetCount(out uint count);
      [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
      [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
      [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
      [PreserveSig] int Commit();
    }

    /// devicetopology.h, in vtable order. Only GetConnector is called.
    [ComImport, Guid("2A07407E-6497-4A18-9787-32F79BD0D98F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDeviceTopology {
      [PreserveSig] int GetConnectorCount(out uint count);
      [PreserveSig] int GetConnector(uint index, out IConnector connector);
      [PreserveSig] int GetSubunitCount(out uint count);
      [PreserveSig] int GetSubunit(uint index, out IntPtr subunit);
      [PreserveSig] int GetPartById(uint id, out IntPtr part);
      [PreserveSig] int GetDeviceId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetSignalPath(IntPtr from, IntPtr to, int rejectMixedPaths, out IntPtr parts);
    }

    /// devicetopology.h, in vtable order. Only GetDeviceIdConnectedTo is called.
    [ComImport, Guid("9C2C4058-23F5-41DE-877A-DF3AF236A09E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IConnector {
      [PreserveSig] int GetType(out int type);
      [PreserveSig] int GetDataFlow(out int flow);
      [PreserveSig] int ConnectTo(IntPtr other);
      [PreserveSig] int Disconnect();
      [PreserveSig] int IsConnected(out int connected);
      [PreserveSig] int GetConnectedTo(out IntPtr other);
      [PreserveSig] int GetConnectorIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
      [PreserveSig] int GetDeviceIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [ComImport, Guid("28F54685-06FD-11D2-B27A-00A0C9223196"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IKsControl {
      [PreserveSig] int KsProperty(IntPtr property, uint propertyLength, IntPtr data, uint dataLength, out uint returned);
      [PreserveSig] int KsMethod(IntPtr method, uint methodLength, IntPtr data, uint dataLength, out uint returned);
      [PreserveSig] int KsEvent(IntPtr ev, uint eventLength, IntPtr data, uint dataLength, out uint returned);
    }

    static class KsNative {
      [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT pv);
    }

    static void ReleaseAll(List<object> rcws) {
      for (int i = rcws.Count - 1; i >= 0; i--) {
        try { if (rcws[i] != null && Marshal.IsComObject(rcws[i])) Marshal.ReleaseComObject(rcws[i]); } catch (Exception) { }
      }
      rcws.Clear();
    }

    static IMMDeviceEnumerator NewEnumerator(List<object> rcws) {
      Type t = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
      var en = (IMMDeviceEnumerator)Activator.CreateInstance(t);
      rcws.Add(en);
      return en;
    }

    static object ReadProp(IMMDevice dev, PROPERTYKEY key, List<object> rcws) {
      IPropertyStore store;
      if (dev.OpenPropertyStore(STGM_READ, out store) != 0 || store == null) return null;
      rcws.Add(store);
      var pv = new PROPVARIANT();
      try {
        if (store.GetValue(ref key, out pv) != 0) return null;
        if (pv.vt == VT_LPWSTR && pv.p1 != IntPtr.Zero) return Marshal.PtrToStringUni(pv.p1);
        if (pv.vt == VT_CLSID && pv.p1 != IntPtr.Zero) return (Guid)Marshal.PtrToStructure(pv.p1, typeof(Guid));
        return null;
      } finally {
        KsNative.PropVariantClear(ref pv);
      }
    }

    /// The KS filter a sound endpoint sits on: its topology's connector 0, and the device on the
    /// other end of it. The same for a connected and an unplugged endpoint.
    static string FilterOf(IMMDevice ep, List<object> rcws, out string why) {
      why = null;
      Guid iid = IID_IDeviceTopology;
      object o;
      int hr = ep.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
      if (hr != 0 || o == null) { why = "its sound device has no topology (" + Hr(hr) + ")"; return null; }
      rcws.Add(o);
      var topo = (IDeviceTopology)o;
      IConnector con;
      hr = topo.GetConnector(0, out con);
      if (hr != 0 || con == null) { why = "its sound device has no connector (" + Hr(hr) + ")"; return null; }
      rcws.Add(con);
      string fid;
      hr = con.GetDeviceIdConnectedTo(out fid);
      if (hr != 0 || string.IsNullOrEmpty(fid)) { why = "its sound device is not connected to a driver filter (" + Hr(hr) + ")"; return null; }
      return fid;
    }

    static IKsControl OpenKs(IMMDeviceEnumerator en, string filterId, List<object> rcws, out string why) {
      why = null;
      IMMDevice dev;
      int hr = en.GetDevice(filterId, out dev);
      if (hr != 0 || dev == null) { why = "Windows did not open its audio driver's filter (" + Hr(hr) + ")"; return null; }
      rcws.Add(dev);
      Guid iid = IID_IKsControl;
      object o;
      hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
      if (hr != 0 || o == null) { why = "its audio driver's filter takes no control requests (" + Hr(hr) + ")"; return null; }
      rcws.Add(o);
      return (IKsControl)o;
    }

    /// KSPROPERTY_TYPE_SETSUPPORT with Set = GUID_NULL: the framework's own list of every property
    /// set the filter supports. Asked twice: once for the size, once for the GUIDs.
    static string SupportedSets(IKsControl ks, out List<Guid> sets, out int hrOut) {
      sets = new List<Guid>();
      hrOut = 0;
      var prop = new KSPROPERTY();
      prop.Set = Guid.Empty;
      prop.Id = 0;
      prop.Flags = KSPROPERTY_TYPE_SETSUPPORT;
      int size = Marshal.SizeOf(typeof(KSPROPERTY));
      IntPtr p = Marshal.AllocHGlobal(size);
      IntPtr buf = IntPtr.Zero;
      try {
        Marshal.StructureToPtr(prop, p, false);
        uint need;
        int hr = ks.KsProperty(p, (uint)size, IntPtr.Zero, 0, out need);
        hrOut = hr;
        if (need == 0 || need > 64 * 16 || need % 16 != 0)
          return "its audio driver's filter did not list its property sets (" + Hr(hr) + ", " + need + " bytes)";
        buf = Marshal.AllocHGlobal((int)need);
        uint got;
        hr = ks.KsProperty(p, (uint)size, buf, need, out got);
        hrOut = hr;
        if (hr != 0) return "its audio driver's filter did not list its property sets (" + Hr(hr) + ")";
        var bytes = new byte[16];
        for (int off = 0; off + 16 <= got; off += 16) {
          Marshal.Copy(IntPtr.Add(buf, off), bytes, 0, 16);
          sets.Add(new Guid(bytes));
        }
        return null;
      } finally {
        Marshal.FreeHGlobal(p);
        if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
      }
    }

    sealed class Support { public bool Yes; public string Why; public int Sets; public int SizeHr; public long Ms; }
    static readonly Dictionary<string, Support> _support = new Dictionary<string, Support>(StringComparer.OrdinalIgnoreCase);

    /// Whether a filter offers KSPROPSETID_BtAudio. A filter's property sets are fixed by its
    /// driver, so an answer is kept for the process; a failure to ask is not, and is asked again.
    static Support Supports(IMMDeviceEnumerator en, string filterId, List<object> rcws) {
      lock (_support) {
        Support s;
        if (_support.TryGetValue(filterId, out s)) return s;
      }
      var r = new Support();
      long t0 = Stopwatch.GetTimestamp();
      string why;
      IKsControl ks = OpenKs(en, filterId, rcws, out why);
      if (ks == null) { r.Why = why; return r; }
      List<Guid> sets;
      int hr;
      string err = SupportedSets(ks, out sets, out hr);
      r.Ms = Lanes.MsSince(t0);
      if (err != null) { r.Why = err; return r; }
      r.Sets = sets.Count;
      r.SizeHr = hr;
      r.Yes = sets.Contains(KSPROPSETID_BtAudio);
      if (!r.Yes) r.Why = "its audio driver offers no Bluetooth connect or disconnect (" + sets.Count + " property sets, none of them KSPROPSETID_BtAudio)";
      lock (_support) _support[filterId] = r;
      return r;
    }

    /// For every paired device: its sound endpoints (matched by container), the filters under them,
    /// and whether any filter offers the one-shot connect and disconnect.
    static string AudioPaths(List<Row> rows, bool raw) {
      var byContainer = new Dictionary<string, Row>(StringComparer.OrdinalIgnoreCase);
      foreach (var r in rows) if (r.Container != null) byContainer[r.Container] = r;
      if (byContainer.Count == 0) return null;
      var rcws = new List<object>();
      try {
        IMMDeviceEnumerator en = NewEnumerator(rcws);
        IMMDeviceCollection all;
        int hr = en.EnumAudioEndpoints(E_ALL, ROUTE_STATES, out all);
        if (hr != 0 || all == null) return "Windows' sound devices could not be listed (" + Hr(hr) + ")";
        rcws.Add(all);
        uint n;
        all.GetCount(out n);
        var pathWhy = new Dictionary<Row, string>();
        for (uint i = 0; i < n; i++) {
          IMMDevice ep;
          if (all.Item(i, out ep) != 0 || ep == null) continue;
          rcws.Add(ep);
          object c = ReadProp(ep, PKEY_Device_ContainerId, rcws);
          string container = c is Guid ? ((Guid)c).ToString("D") : null;
          Row row;
          if (container == null || !byContainer.TryGetValue(container, out row)) continue;
          row.Audio = true;
          string why;
          string fid = FilterOf(ep, rcws, out why);
          if (raw) {
            if (row.RawEndpoints == null) row.RawEndpoints = new ArrayList();
            int state;
            ep.GetState(out state);
            row.RawEndpoints.Add(Json.Obj("name", ReadProp(ep, PKEY_Device_FriendlyName, rcws), "state", state,
                                          "filter", fid, "why", why));
          }
          if (fid == null) { pathWhy[row] = why; continue; }
          if (!row.Filters.Contains(fid)) row.Filters.Add(fid);
        }
        foreach (var row in rows) {
          if (!row.Audio) continue;
          string firstWhy = null;
          foreach (var fid in row.Filters) {
            Support s = Supports(en, fid, rcws);
            if (s.Yes) row.CanConnect = true;
            else if (firstWhy == null) firstWhy = s.Why;
            if (raw) {
              if (row.RawKs == null) row.RawKs = new ArrayList();
              row.RawKs.Add(Json.Obj("filter", fid, "btAudio", s.Yes, "sets", s.Sets, "ms", s.Ms, "why", s.Why));
            }
          }
          if (!row.CanConnect) {
            string pw;
            pathWhy.TryGetValue(row, out pw);
            row.ConnectWhy = "Windows gives Mantle no way to connect this one: " + (firstWhy ?? pw ?? "no driver filter under its sound devices");
          }
        }
        return null;
      } catch (Exception ex) {
        return "Windows' sound devices could not be read (" + Why(ex) + ")";
      } finally {
        ReleaseAll(rcws);
      }
    }

    // ------------------------------------------------------------------ connect / disconnect

    static readonly object _opLock = new object();
    static string _busyDevice, _busyOp, _busyName;
    static long _busySinceTs;
    static IDictionary _last;
    static long _lastTs;

    static object Busy() {
      lock (_opLock) {
        if (_busyDevice == null) return null;
        return Json.Obj("device", _busyDevice, "name", _busyName, "op", _busyOp, "ms", Lanes.MsSince(_busySinceTs));
      }
    }

    static object Last() {
      lock (_opLock) {
        if (_last == null) return null;
        long ago = Lanes.MsSince(_lastTs);
        if (ago > LastKeepMs) return null;
        var d = Json.Obj();
        foreach (DictionaryEntry e in _last) d[e.Key] = e.Value;
        d["agoMs"] = ago;
        return d;
      }
    }

    static IDictionary Toggle(string deviceId, bool connect) {
      string op = connect ? "connect" : "disconnect";
      lock (_opLock) {
        if (_busyDevice != null)
          // The other device's name goes in its own field, never in the reason: reasons reach the log
          // (secreview2 2026-09-27); the row can show busyName if it wants to.
          return Json.Obj("ok", false, "op", op, "device", deviceId, "busyName", _busyName,
                          "reason", "Mantle is still " + (_busyOp == "connect" ? "connecting" : "disconnecting") +
                                    " another device; wait for it to finish");
        _busyDevice = deviceId;
        _busyOp = op;
        _busyName = null;
        _busySinceTs = Stopwatch.GetTimestamp();
      }
      IDictionary r = null;
      try {
        r = ToggleWork(deviceId, connect);
      } catch (Exception ex) {
        r = Json.Obj("ok", false, "op", op, "device", deviceId, "reason", "the " + op + " failed inside Mantle (" + Why(ex) + ")");
      } finally {
        lock (_opLock) {
          _busyDevice = null;
          _busyOp = null;
          _busyName = null;
          if (r != null) {
            _last = Json.Obj("device", deviceId, "name", r["name"], "op", op, "ok", r["ok"], "reason", r["reason"]);
            _lastTs = Stopwatch.GetTimestamp();
          }
        }
      }
      Nudge("after a " + op);
      return r;
    }

    static bool ReadConnected(string deviceId, out string name, out string container, out string err) {
      name = null;
      container = null;
      DeviceInformation di;
      err = WinRt.Await(DeviceInformation.CreateFromIdAsync(deviceId, AepProps, DeviceInformationKind.AssociationEndpoint),
                        CallMs, "the device", out di);
      if (err != null || di == null) { if (err == null) err = "Windows returned no device"; return false; }
      name = di.Name;
      container = GuidText(Prop(di.Properties, P_CONTAINER));
      object c = Prop(di.Properties, P_CONNECTED);
      return c is bool && (bool)c;
    }

    static IDictionary ToggleWork(string deviceId, bool connect) {
      string op = connect ? "connect" : "disconnect";
      long t0 = Stopwatch.GetTimestamp();
      string name, container, err;
      bool now = ReadConnected(deviceId, out name, out container, out err);
      if (err != null)
        return Json.Obj("ok", false, "op", op, "device", deviceId, "name", null, "connected", null,
                        "reason", "Windows does not know that Bluetooth device (" + err + ")");
      lock (_opLock) _busyName = name;
      if (now == connect)
        return Json.Obj("ok", true, "op", op, "device", deviceId, "name", name, "connected", now, "already", true, "reason", null);
      if (connect) {
        IDictionary radio = Bluetooth.Read();
        if (radio["on"] is bool && !(bool)radio["on"])
          return Json.Obj("ok", false, "op", op, "device", deviceId, "name", name, "connected", false,
                          "reason", "Bluetooth is off, so nothing can connect");
      }
      if (container == null)
        return Json.Obj("ok", false, "op", op, "device", deviceId, "name", name, "connected", now,
                        "reason", "Windows gives this device no container, so Mantle cannot find its sound devices");

      // The one-shot, on every supporting filter under the device's sound endpoints (a headset
      // has two: stereo music and hands-free).
      int sent = 0, leftOut = 0;
      var failures = new List<string>();
      var rcws = new List<object>();
      try {
        IMMDeviceEnumerator en = NewEnumerator(rcws);
        IMMDeviceCollection all;
        int hr = en.EnumAudioEndpoints(E_ALL, ROUTE_STATES, out all);
        if (hr != 0 || all == null)
          return Json.Obj("ok", false, "op", op, "device", deviceId, "name", name, "connected", now,
                          "reason", "Windows' sound devices could not be listed (" + Hr(hr) + ")");
        rcws.Add(all);
        uint n;
        all.GetCount(out n);
        var filters = new List<string>();
        var enabled = new List<string>();   // filters with at least one sound endpoint that is not disabled
        for (uint i = 0; i < n; i++) {
          IMMDevice ep;
          if (all.Item(i, out ep) != 0 || ep == null) continue;
          rcws.Add(ep);
          object c = ReadProp(ep, PKEY_Device_ContainerId, rcws);
          if (!(c is Guid) || !string.Equals(((Guid)c).ToString("D"), container, StringComparison.OrdinalIgnoreCase)) continue;
          string why;
          string fid = FilterOf(ep, rcws, out why);
          if (fid == null) continue;
          if (!filters.Contains(fid)) filters.Add(fid);
          int st;
          if (ep.GetState(out st) == 0 && st != STATE_DISABLED && !enabled.Contains(fid)) enabled.Add(fid);
        }
        // A DISCONNECT goes to every filter, so no link of the device stays up. A CONNECT leaves out
        // a filter whose every endpoint is disabled: someone who switched a headset's hands-free
        // endpoint off in Sound settings did not ask for that link back. With nothing else, all.
        List<string> targets = connect && enabled.Count > 0 ? enabled : filters;
        leftOut = filters.Count - targets.Count;
        foreach (var fid in targets) {
          Support s = Supports(en, fid, rcws);
          if (!s.Yes) continue;
          string why;
          IKsControl ks = OpenKs(en, fid, rcws, out why);
          if (ks == null) { failures.Add(why); continue; }
          int khr = OneShot(ks, connect ? KSPROPERTY_ONESHOT_RECONNECT : KSPROPERTY_ONESHOT_DISCONNECT);
          if (khr == 0) sent++;
          else failures.Add("the driver answered " + Hr(khr));
        }
        if (filters.Count == 0)
          return Json.Obj("ok", false, "op", op, "device", deviceId, "name", name, "connected", now,
                          "reason", "Windows lists no sound device for " + name + ", so Mantle has no way to " + op + " it");
      } finally {
        ReleaseAll(rcws);
      }
      if (sent == 0)
        return Json.Obj("ok", false, "op", op, "device", deviceId, "name", name, "connected", now,
                        "reason", failures.Count > 0 ? "Windows refused the " + op + ": " + string.Join("; ", failures.ToArray())
                                                     : "none of " + name + "'s sound devices offers a Bluetooth " + op);

      // Windows' verdict: the AEP's own IsConnected, the same flag the list shows.
      int settle = connect ? ConnectSettleMs : DisconnectSettleMs;
      long waitFrom = Stopwatch.GetTimestamp();
      while (Lanes.MsSince(waitFrom) < settle) {
        Thread.Sleep(SettlePollMs);
        string n2, c2, e2;
        bool c = ReadConnected(deviceId, out n2, out c2, out e2);
        if (e2 == null) now = c;
        if (now == connect) break;
      }
      bool ok = now == connect;
      return Json.Obj("ok", ok, "op", op, "device", deviceId, "name", name, "connected", now, "sent", sent, "leftOut", leftOut,
                      "failures", failures.Count > 0 ? new ArrayList(failures) : null,
                      "waitedMs", Lanes.MsSince(waitFrom), "ms", Lanes.MsSince(t0),
                      "reason", ok ? null
                        : connect ? "Windows asked " + name + " to connect, but it was still not connected after " + (settle / 1000) +
                                    " s (it may be off, out of range, or connected to another device)"
                                  : "Windows asked " + name + " to disconnect, but it was still connected after " + (settle / 1000) + " s");
    }

    /// THE ACTION: a GET of the one-shot property. Only ever called from ToggleWork.
    static int OneShot(IKsControl ks, uint which) {
      var prop = new KSPROPERTY();
      prop.Set = KSPROPSETID_BtAudio;
      prop.Id = which;
      prop.Flags = KSPROPERTY_TYPE_GET;
      int size = Marshal.SizeOf(typeof(KSPROPERTY));
      IntPtr p = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(prop, p, false);
        uint got;
        return ks.KsProperty(p, (uint)size, IntPtr.Zero, 0, out got);
      } finally {
        Marshal.FreeHGlobal(p);
      }
    }

    // ------------------------------------------------------------------ the watch

    static readonly object _wlock = new object();
    static DeviceWatcher _watcher;           // under _wlock
    static bool _ready;                      // EnumerationCompleted seen, under _wlock
    static long _leaseUntilTs;               // under _wlock
    static int _leaseMs = LeaseMs;           // under _wlock
    static Timer _debounce, _tick;           // under _wlock
    static string _pendingWhy;               // under _wlock
    static string _lastSig;                  // under _wlock
    static long _lastBatteryTs;              // under _wlock
    static object _lastRadio;                // under _wlock
    static bool _anyConnected;               // under _wlock: the last list had a connected device
    static int _events;                      // Interlocked
    static volatile string _watchReason;

    static bool Watching() { lock (_wlock) return _watcher != null; }

    static IDictionary Watch(bool on, int leaseMs) {
      lock (_wlock) {
        if (!on) {
          bool was = _watcher != null;
          StopLocked(null);
          return Json.Obj("ok", true, "watching", false, "stopped", was, "reason", null);
        }
        _leaseMs = leaseMs;
        _leaseUntilTs = Stopwatch.GetTimestamp() + (long)leaseMs * Stopwatch.Frequency / 1000;
        if (_watcher != null)
          return Json.Obj("ok", true, "watching", true, "started", false, "leaseMs", leaseMs, "events", _events, "reason", null);
        DeviceWatcher w;
        try {
          w = DeviceInformation.CreateWatcher(Aqs(), AepProps, DeviceInformationKind.AssociationEndpoint);
          w.Added += delegate (DeviceWatcher s, DeviceInformation d) { Event(s, "a device was paired"); };
          w.Updated += delegate (DeviceWatcher s, DeviceInformationUpdate u) { Event(s, "a device changed"); };
          w.Removed += delegate (DeviceWatcher s, DeviceInformationUpdate u) { Event(s, "a device was removed"); };
          w.EnumerationCompleted += delegate (DeviceWatcher s, object o) { Ready(s); };
          w.Stopped += delegate (DeviceWatcher s, object o) { Stopped(s); };
          w.Start();
        } catch (Exception ex) {
          _watchReason = "Windows' device watcher did not start (" + Why(ex) + ")";
          return Json.Obj("ok", false, "watching", false, "reason", _watchReason);
        }
        _watcher = w;
        _ready = false;
        _lastSig = null;
        _lastRadio = null;
        _lastBatteryTs = Stopwatch.GetTimestamp();
        _anyConnected = false;
        _watchReason = null;
        _debounce = new Timer(Flush, null, Timeout.Infinite, Timeout.Infinite);
        // A short (test) lease is checked often enough to lapse on time.
        int tickMs = Math.Min(TickMs, Math.Max(500, leaseMs / 2));
        _tick = new Timer(Tick, null, tickMs, tickMs);
        return Json.Obj("ok", true, "watching", true, "started", true, "leaseMs", leaseMs, "events", _events, "reason", null);
      }
    }

    /// Under _wlock. why: null for a plain stop, else the reason told to the view.
    static void StopLocked(string why) {
      if (_watcher == null) return;
      var w = _watcher;
      _watcher = null;
      _ready = false;
      if (_debounce != null) { _debounce.Dispose(); _debounce = null; }
      if (_tick != null) { _tick.Dispose(); _tick = null; }
      _watchReason = why;
      try {
        if (w.Status == DeviceWatcherStatus.Started || w.Status == DeviceWatcherStatus.EnumerationCompleted) w.Stop();
      } catch (Exception) { }
    }

    static void Event(DeviceWatcher s, string why) {
      Interlocked.Increment(ref _events);
      lock (_wlock) {
        if (s != _watcher || !_ready) return;
      }
      Nudge(why);
    }

    static void Ready(DeviceWatcher s) {
      lock (_wlock) {
        if (s != _watcher) return;
        _ready = true;
      }
      Nudge("the watch is ready");
    }

    static void Stopped(DeviceWatcher s) {
      string why = null;
      lock (_wlock) {
        if (s != _watcher) return;       // our own Stop
        DeviceWatcherStatus st = DeviceWatcherStatus.Stopped;
        try { st = s.Status; } catch (Exception) { }
        why = "Windows stopped the device watcher (status " + st + ")";
        StopLocked(why);
      }
      Program.EmitLog("warn", "btdevices: " + why);
      Program.Emit(Json.Obj("ev", "btdevices", "why", "the watch stopped", "watching", false, "watchReason", why));
    }

    /// Something may have changed: list once it settles (DebounceMs after the last nudge).
    static void Nudge(string why) {
      lock (_wlock) {
        if (_watcher == null || _debounce == null) return;
        _pendingWhy = why;
        _debounce.Change(DebounceMs, Timeout.Infinite);
      }
    }

    static void Flush(object unused) {
      string why;
      lock (_wlock) {
        if (_watcher == null || !_ready) return;
        why = _pendingWhy;
        _pendingWhy = null;
      }
      IDictionary r;
      try { r = List(false); } catch (Exception ex) {
        r = Json.Obj("ok", false, "reason", "the Bluetooth devices could not be re-read (" + Why(ex) + ")");
      }
      string sig = Signature(r);
      bool any = false;
      var devs = r["devices"] as ArrayList;
      if (devs != null) foreach (IDictionary d in devs) if (d["connected"] is bool && (bool)d["connected"]) any = true;
      lock (_wlock) {
        if (_watcher == null) return;
        _anyConnected = any;
        if (sig == _lastSig) return;
        _lastSig = sig;
        _lastRadio = r["on"];
      }
      var ev = Json.Obj("ev", "btdevices", "why", why ?? "a change");
      foreach (DictionaryEntry e in r) ev[e.Key] = e.Value;
      Program.Emit(ev);
    }

    /// Everything the view draws, and nothing that moves on its own (timings, ages).
    static string Signature(IDictionary r) {
      var sb = new StringBuilder();
      sb.Append(r["ok"]).Append('|').Append(r["present"]).Append('|').Append(r["on"]).Append('|').Append(r["reason"]).Append('|');
      var busy = r["busy"] as IDictionary;
      if (busy != null) sb.Append(busy["device"]).Append(busy["op"]);
      sb.Append('|');
      var last = r["last"] as IDictionary;
      if (last != null) sb.Append(last["device"]).Append(last["op"]).Append(last["ok"]);
      sb.Append('|');
      var devs = r["devices"] as ArrayList;
      if (devs != null) {
        foreach (IDictionary d in devs) {
          sb.Append(d["id"]).Append(',').Append(d["name"]).Append(',').Append(d["kind"]).Append(',')
            .Append(d["connected"]).Append(',').Append(d["battery"]).Append(',').Append(d["batteryWhy"]).Append(',')
            .Append(d["canConnect"]).Append(',').Append(d["connectWhy"]).Append(';');
        }
      }
      return sb.ToString();
    }

    /// Every TickMs while watching: end a lapsed lease; notice the radio switching (no AEP event
    /// says so when nothing is connected); re-read batteries every BatteryEveryMs while
    /// something is connected (a battery level changes no AEP property, so no event says so).
    static void Tick(object unused) {
      bool battery = false;
      lock (_wlock) {
        if (_watcher == null) return;
        if (Stopwatch.GetTimestamp() > _leaseUntilTs) {
          StopLocked("the watch lapsed: nothing renewed it for " + (_leaseMs / 1000.0) + " s");
          Program.EmitLog("info", "btdevices: the watch lapsed (" + (_leaseMs / 1000.0) + " s without a renewal) and stopped itself");
          return;
        }
        if (Lanes.MsSince(_lastBatteryTs) >= BatteryEveryMs && _anyConnected) {
          _lastBatteryTs = Stopwatch.GetTimestamp();
          battery = true;
        }
      }
      object radioOn = null;
      try {
        IDictionary radio = Bluetooth.Read();
        radioOn = radio["ok"] is bool && (bool)radio["ok"] ? radio["on"] : null;
      } catch (Exception) { }
      bool radioMoved;
      lock (_wlock) radioMoved = _lastRadio != null && !object.Equals(_lastRadio, radioOn);
      if (radioMoved) Nudge("the radio switched");
      else if (battery) Nudge("battery re-read");
    }
#endif
  }
}
