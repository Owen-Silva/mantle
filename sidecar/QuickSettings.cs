// QuickSettings.cs - the Quick Settings READS, served from a cache so they
// never wait on the hardware, and the SWITCHES, which keep that cache honest.
//
// WHY (live, 2026-09-22): main.js's panel asks for volume, wifi, bluetooth,
// brightness, night light and power every ~2 s while it is open. Bluetooth was
// a powershell.exe launch (~3 s under load), brightness a WMI query and wifi a
// WLAN RPC (~120 ms p50, 340 ms max, measured under load) - all on the one
// command thread, where every button press queued behind them. Opening the
// panel once under load was enough to put the sidecar permanently behind.
//
// NOW: those three reads come from a `Cached` (Lanes.cs). A read answers at
// once with the last value plus `ageMs` (and `stale:true` once it is older
// than its fresh window), and kicks ONE background refresh if the value is
// old. So while the panel is open the hardware is asked about once per fresh
// window, and while it is closed it is not asked at all.
//
// A SWITCH runs on the slow lane, reads the hardware back itself and Put()s
// that read into the cache, so main.js's read-back straight after a qs.set
// shows the new state rather than a stale one (a slider that springs back
// would be lying). Put() also outranks any refresh that was already in flight.
//
// volume, nightlight and power are NOT here: each is a single in-process call
// (CoreAudio, one registry value, GetSystemPowerStatus) that answers in
// milliseconds, and the volume slider needs its answer to be the live one.
using System;
using System.Collections;
using System.Threading;

namespace Mantle {
  static class QuickSettings {
    // How old an answer may be before a read triggers a refresh. Bluetooth is
    // a few ms once its helper is warm; the helper start is what costs.
    const int WifiFreshMs = 2000;
    const int BluetoothFreshMs = 3000;
    const int BrightnessFreshMs = 3000;

    static readonly Cached _wifi = new Cached("wifi", WifiFreshMs, Network.Read);
    static readonly Cached _bluetooth = new Cached("bluetooth", BluetoothFreshMs, Mantle.Bluetooth.Read);
    static readonly Cached _brightness = new Cached("brightness", BrightnessFreshMs, Display.Brightness);

    /// A few seconds after start, read all three once in the background, so
    /// the first time Owen opens the panel it already has real answers rather
    /// than placeholders. After that, only reads keep them fresh.
    public static void WarmUp() {
      try {
        var t = new Thread(delegate () {
          Thread.Sleep(1500);
          _wifi.Refresh();
          _brightness.Refresh();
          _bluetooth.Refresh();
        });
        t.IsBackground = true;
        t.Name = "mantle-qs-warmup";
        t.Start();
      } catch (Exception ex) {
        Program.EmitLog("warn", "quick settings: the start-up read could not be scheduled (" + ex.Message + ")");
      }
    }

    // ----------------------------------------------------------------- reads
    // ui lane. Never block.

    public static IDictionary Wifi() {
      return _wifi.Get() ?? Pending(_wifi, "Wi-Fi",
        "present", true, "on", false, "connected", false, "ssid", null, "signal", 0, "band", null);
    }

    public static IDictionary Bluetooth() {
      return _bluetooth.Get() ?? Pending(_bluetooth, "Bluetooth",
        "present", true, "on", false, "via", "powershell");
    }

    public static IDictionary Brightness() {
      return _brightness.Get() ?? Pending(_brightness, "the screen brightness",
        "present", true, "level", 0);
    }

    /// Nothing has been read yet (the first seconds after start). The shape is
    /// the real one so no caller trips over a missing key, but ok:false and
    /// pending:true say plainly that these are not readings.
    static IDictionary Pending(Cached c, string what, params object[] shape) {
      var d = Json.Obj("ok", false, "pending", true);
      for (int i = 0; i + 1 < shape.Length; i += 2) d[(string)shape[i]] = shape[i + 1];
      d["ageMs"] = null;
      d["stale"] = true;
      d["reason"] = what + " is still being read for the first time (" + c.PendingMs() +
                    " ms so far); it answers from a cache that a background thread fills";
      return d;
    }

    // -------------------------------------------------------------- switches
    // slow lane. They block; that is what the slow lane is for.

    public static IDictionary SetWifi(bool want) {
      IDictionary back;
      var reply = Network.Set(want, out back);
      return Settle(_wifi, reply, back);
    }

    public static IDictionary SetBluetooth(bool want) {
      IDictionary back;
      var reply = Mantle.Bluetooth.Set(want, out back);
      return Settle(_bluetooth, reply, back);
    }

    public static IDictionary SetBrightness(int level) {
      IDictionary back;
      var reply = Display.SetBrightness(level, out back);
      return Settle(_brightness, reply, back);
    }

    static IDictionary Settle(Cached c, IDictionary reply, IDictionary back) {
      if (back != null) c.Put(back);
      else c.Refresh();          // the switch failed before it could read back
      reply["ageMs"] = 0;
      reply["stale"] = false;
      return reply;
    }

    public static IDictionary Snapshot() {
      var bt = _bluetooth.Snapshot();
      foreach (DictionaryEntry e in Mantle.Bluetooth.HostSnapshot()) bt[e.Key] = e.Value;
      return Json.Obj("wifi", _wifi.Snapshot(), "bluetooth", bt, "brightness", _brightness.Snapshot());
    }
  }
}
