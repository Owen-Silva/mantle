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
// A SWITCH runs on the qs lane, reads the hardware back itself and Put()s
// that read into the cache, so main.js's read-back straight after a qs.set
// shows the new state rather than a stale one (a slider that springs back
// would be lying). Put() also outranks any refresh that was already in flight.
//
// volume, nightlight and power are NOT cached: each is a single in-process
// call (CoreAudio, one registry value, GetSystemPowerStatus) that answers in
// milliseconds, and the volume slider needs its answer to be the live one.
//
// THE WATCH (2026-09-23, bottom of this file) pushes every part except volume
// the moment it changes, while main holds a lease on it (the panel is open).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
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
    // qs lane (Lanes.cs). They block; that is what the lane is for.

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
      Interlocked.Exchange(ref _brightnessSetTs, Stopwatch.GetTimestamp());
      IDictionary back;
      var reply = Display.SetBrightness(level, out back);
      return Settle(_brightness, reply, back);
    }

    /// Not cached (one registry value), so there is nothing to settle; the reply
    /// is Display's own read-back.
    public static IDictionary SetNightLight(bool want) {
      var reply = Display.SetNightLight(want);
      reply["ageMs"] = 0;
      reply["stale"] = false;
      if (!(reply["ok"] is bool) || !(bool)reply["ok"]) reply["read"] = Display.NightLight();
      return reply;
    }

    /// A Wi-Fi connect or disconnect from the network list (Wlan.cs) has just
    /// read the state back: the tile's next read is that state, not a cached
    /// answer from before the switch (a tile still naming the old network
    /// would be lying for up to WifiFreshMs).
    public static void WifiChanged(IDictionary readBack) {
      if (readBack == null) { _wifi.Refresh(); return; }
      var copy = Json.Obj();
      foreach (DictionaryEntry e in readBack) copy[e.Key] = e.Value;
      _wifi.Put(copy);
    }

    /// The network readout (NetState.cs) shares the panel's Wi-Fi read: while the panel is
    /// open the watch reads it every second, and a second WLAN query from the readout would
    /// double the load for the same answer. A fresh read goes into the cache for the tile.
    public static IDictionary WifiRecent(int maxAgeMs) {
      IDictionary v = _wifi.PeekFresh(maxAgeMs);
      if (v != null) return v;
      int gen = _wifi.Gen();
      v = Network.Read();
      if (v != null) {
        var copy = Json.Obj();
        foreach (DictionaryEntry e in v) copy[e.Key] = e.Value;
        _wifi.Offer(gen, copy);
      }
      return v;
    }

    /// `read` on a refused switch: the part as it reads now, with its own ok and reason, so main can
    /// draw a refused tile live (unchanged, with the refusal) rather than dead.
    static IDictionary Settle(Cached c, IDictionary reply, IDictionary back) {
      if (back != null) c.Put(back);
      else c.Refresh();          // the switch failed before it could read back
      reply["ageMs"] = 0;
      reply["stale"] = false;
      if (back != null && (!(reply["ok"] is bool) || !(bool)reply["ok"])) {
        var read = Json.Obj();
        foreach (DictionaryEntry e in back) read[e.Key] = e.Value;
        reply["read"] = read;
      }
      return reply;
    }

    public static IDictionary Snapshot() {
      var bt = _bluetooth.Snapshot();
      foreach (DictionaryEntry e in Mantle.Bluetooth.HostSnapshot()) bt[e.Key] = e.Value;
      return Json.Obj("wifi", _wifi.Snapshot(), "bluetooth", bt, "brightness", _brightness.Snapshot(),
                      "watch", WatchSnapshot());
    }

    // ============================================================= the watch
    //
    // WHY (2026-09-23): Owen, live on 1c6afe3, wants the panel "way more
    // responsive". A change made elsewhere - a brightness key, Windows' own
    // flyout, the Wi-Fi dropping - reached the open panel only through main's
    // full six-part re-read every 2 s, answered from caches up to 3 s old: 2 to
    // 5 s late. While main holds a lease (the panel is open), this thread
    // re-reads each part on its own period and pushes {ev:"qs", part, state}
    // the moment one differs, so a change made anywhere shows within about a
    // second and main does not poll at all.
    //
    // THE LEASE is what stops it: main renews it while the panel is open and
    // ends it when the panel closes; a main that died or forgot costs at most
    // MaxLeaseMs of reads, never a poll that runs forever.
    //
    // Periods, from what one fresh read costs (Owen's machine, 2026-09-23;
    // ping's caches.watch.readMs has the live numbers):
    //   nightlight  one registry value, 0-1 ms                    every 250 ms
    //   power       GetSystemPowerStatus, 0-4 ms                  every 250 ms
    //   brightness  the kept WMI object re-read, 2-66 ms          every 1000 ms,
    //               and at once on WmiMonitorBrightnessEvent; never within
    //               1.5 s of a set (a dragged slider's own replies say it)
    //   bluetooth   the radio through WinRT, 12-28 ms             every 1000 ms
    //   wifi        a WLAN handle, interface list and query, 53-95 ms  every 1000 ms
    //   volume      CoreAudio, 2-4 ms                             every 1000 ms
    // Volume is pushed by CoreAudio itself (VolumeWatch.cs); it is read here too because a
    // same-value write, the only kind a test may make, never fires that callback, so the
    // callback could not be proven on Owen's machine (2026-09-23) - this is the backstop.
    const int MaxLeaseMs = 120000;
    static readonly string[] WatchParts = { "nightlight", "power", "volume", "brightness", "bluetooth", "wifi" };
    const int BrightnessQuietMs = 1500;
    static long _brightnessSetTs;        // Stopwatch ticks of the last brightness set
    static int _brightnessEvent;         // WmiMonitorBrightnessEvent arrived: read it now
    static volatile string _brightnessEvents;
    static readonly object _watchLock = new object();
    static Thread _watchThread;
    static long _leaseEndTs;            // Stopwatch ticks; 0 = no lease
    static bool _watchAll;              // push every part on the next pass
    static readonly AutoResetEvent _watchWake = new AutoResetEvent(false);
    static int _watchPushes, _watchPasses;
    static volatile string _watchError;
    static readonly Dictionary<string, string> _sig = new Dictionary<string, string>(StringComparer.Ordinal);
    static readonly Dictionary<string, long> _readMs = new Dictionary<string, long>(StringComparer.Ordinal);

    /// qswatch {on, leaseMs}. On starts the thread or renews the lease; a start, or
    /// an on after the lease had lapsed, pushes every part once so main's snapshot
    /// is whole again. Off ends the lease and the thread exits on its next pass.
    public static IDictionary Watch(bool on, int leaseMs) {
      if (leaseMs < 1000) leaseMs = 1000;
      if (leaseMs > MaxLeaseMs) leaseMs = MaxLeaseMs;
      Thread start = null;
      lock (_watchLock) {
        long now = Stopwatch.GetTimestamp();
        if (!on) {
          _leaseEndTs = 0;
        } else {
          if (_leaseEndTs <= now) _watchAll = true;
          _leaseEndTs = now + (long)leaseMs * Stopwatch.Frequency / 1000;
          if (_watchThread == null) {
            start = new Thread(WatchLoop);
            start.IsBackground = true;
            start.Name = "mantle-qs-watch";
            _watchThread = start;
            _watchError = null;
          }
        }
      }
      if (start != null) start.Start();
      else _watchWake.Set();
      var snap = WatchSnapshot();
      snap["ok"] = true;
      snap["started"] = start != null;
      snap["leaseMs"] = on ? leaseMs : 0;
      return snap;
    }

    static IDictionary WatchSnapshot() {
      bool watching;
      long leftMs;
      lock (_watchLock) {
        watching = _watchThread != null && _leaseEndTs > 0;
        leftMs = watching ? Math.Max(0, (_leaseEndTs - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency) : 0;
      }
      var readMs = Json.Obj();
      lock (_sig) { foreach (var kv in _readMs) readMs[kv.Key] = kv.Value; }
      return Json.Obj("watching", watching, "leaseLeftMs", leftMs, "brightnessEvents", _brightnessEvents,
                      "pushes", Thread.VolatileRead(ref _watchPushes), "passes", Thread.VolatileRead(ref _watchPasses),
                      "readMs", readMs, "error", _watchError);
    }

    static int EveryMs(string part) {
      switch (part) {
        case "nightlight": case "power": return 250;
        default: return 1000;
      }
    }

    static void WatchLoop() {
      var clock = Stopwatch.StartNew();
      var due = new Dictionary<string, long>(StringComparer.Ordinal);
      string listen = Display.ListenBrightness(true, delegate (object s, System.Management.EventArrivedEventArgs e) {
        Interlocked.Exchange(ref _brightnessEvent, 1);
        _watchWake.Set();
      });
      _brightnessEvents = listen ?? "listening";
      if (listen != null) Program.EmitLog("warn", "quick settings: " + listen);
      try {
        for (;;) {
          bool all;
          lock (_watchLock) {
            if (_leaseEndTs == 0 || Stopwatch.GetTimestamp() >= _leaseEndTs) {
              _watchThread = null;
              _leaseEndTs = 0;
              break;
            }
            all = _watchAll;
            _watchAll = false;
          }
          if (all) {
            lock (_sig) _sig.Clear();
            due.Clear();
          }
          Interlocked.Increment(ref _watchPasses);
          if (Interlocked.Exchange(ref _brightnessEvent, 0) == 1) due["brightness"] = 0;
          long soonest = long.MaxValue;
          foreach (string part in WatchParts) {
            long at;
            if (!due.TryGetValue(part, out at) || clock.ElapsedMilliseconds >= at) {
              long quiet = part == "brightness" ? BrightnessQuietMs - Lanes.MsSince(Interlocked.Read(ref _brightnessSetTs)) : 0;
              if (quiet > 0) {
                at = clock.ElapsedMilliseconds + quiet;          // a slider is moving it: its replies say it
              } else {
                Poll(part);
                at = clock.ElapsedMilliseconds + EveryMs(part);
              }
              due[part] = at;
            }
            if (at < soonest) soonest = at;
          }
          long wait = soonest - clock.ElapsedMilliseconds;
          if (wait < 5) wait = 5;
          if (wait > 250) wait = 250;
          _watchWake.WaitOne((int)wait);
        }
      } catch (Exception ex) {
        // NO SILENT FAILURES: main hears it (and goes back to reading on open),
        // the log says it, and ping's caches.watch.error keeps it.
        lock (_watchLock) { _watchThread = null; _leaseEndTs = 0; }
        _watchError = ex.GetType().Name + ": " + ex.Message;
        Program.EmitLog("warn", "quick settings: the watch stopped (" + _watchError + ")");
        Program.Emit(Json.Obj("ev", "qs", "part", null, "ok", false,
                              "reason", "the quick settings watch stopped (" + _watchError + ")"));
      } finally {
        Display.ListenBrightness(false, null);
        _brightnessEvents = null;
      }
    }

    /// One fresh read of one part; pushed only if it differs from the last push.
    static void Poll(string part) {
      long t0 = Stopwatch.GetTimestamp();
      IDictionary v;
      Cached c = null;
      int gen = 0;
      switch (part) {
        case "nightlight": v = Display.NightLight(); break;
        case "power": v = Power.Read(); break;
        case "volume": {
          int lvl; bool muted;
          Volume.Apply(null, null, out lvl, out muted);
          v = Json.Obj("ok", true, "level", lvl, "muted", muted);
          break;
        }
        case "brightness": c = _brightness; gen = c.Gen(); v = Display.QuickRead(); break;
        case "bluetooth": c = _bluetooth; gen = c.Gen(); v = Mantle.Bluetooth.Read(); break;
        default: c = _wifi; gen = c.Gen(); v = Network.Read(); break;
      }
      long ms = Lanes.MsSince(t0);
      lock (_sig) _readMs[part] = ms;
      if (v == null) return;
      // A switch landed while this read was in flight: its read-back is newer
      // (and main already has it from the qs.set reply), so this one is dropped.
      if (c != null && !c.Offer(gen, v)) return;
      string sig = Signature(part, v);
      lock (_sig) {
        string old;
        if (_sig.TryGetValue(part, out old) && old == sig) return;
        _sig[part] = sig;
      }
      Interlocked.Increment(ref _watchPushes);
      var state = Json.Obj();
      foreach (DictionaryEntry e in v) state[e.Key] = e.Value;
      state["ageMs"] = 0;
      state["stale"] = false;
      Program.Emit(Json.Obj("ev", "qs", "part", part, "state", state, "readMs", ms));
    }

    /// What the panel shows of a part. Wi-Fi's signal counts in bars, not percent,
    /// so a signal wobbling by a point is not a push every second.
    static string Signature(string part, IDictionary v) {
      string[] keys;
      switch (part) {
        case "wifi": keys = new[] { "ok", "present", "on", "connected", "ssid", "band", "reason" }; break;
        case "brightness": keys = new[] { "ok", "present", "level", "reason" }; break;
        case "power": keys = new[] { "ok", "present", "saver", "percent", "ac", "charging", "reason" }; break;
        case "volume": keys = new[] { "ok", "level", "muted" }; break;
        default: keys = new[] { "ok", "present", "on", "reason" }; break;   // bluetooth, nightlight
      }
      var sb = new StringBuilder();
      foreach (string k in keys)
        sb.Append(k).Append('=').Append(Convert.ToString(v[k], CultureInfo.InvariantCulture)).Append('|');
      if (part == "wifi") {
        int signal = 0;
        try { signal = v["signal"] == null ? 0 : Convert.ToInt32(v["signal"], CultureInfo.InvariantCulture); } catch (Exception) { }
        sb.Append("bars=").Append(signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : signal > 0 ? 1 : 0);
      }
      return sb.ToString();
    }
  }
}
