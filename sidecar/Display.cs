// Display.cs - `brightness` and `nightlight`: the two display switches the
// stock Quick Settings panel owns.
//
// BRIGHTNESS goes through WMI's root\wmi namespace, which moves a LAPTOP
// PANEL's backlight. IT IS NOT UNIVERSAL: an external monitor never answers
// there - it needs DDC/CI through the Monitor Configuration API (dxva2), which
// Mantle does not drive yet - so a machine with no internal panel active is a
// "present:false with the reason" answer and a muted slider, not an error.
// The user's machine is a laptop: one internal BOE panel, WMI answers with 101
// levels, and a same-value WmiSetBrightness took effect (measured 2026-09-23).
//
// A WMI query costs tens of milliseconds idle and a few hundred under the user's
// load, so Brightness() is a FRESH read that only ever runs on a background
// thread or the slow lane: QuickSettings.cs caches it and answers the panel
// from the cache (2026-09-22; it used to be a 2 s cache here, read on the
// message-loop thread, where it queued behind Bluetooth).
//
// NIGHT LIGHT has no API at all. Its state lives in an UNDOCUMENTED CloudStore
// blob, which Windows watches: Settings' own toggle is a new blob written there.
// Until 2026-09-23 this was read-only and the tile did nothing when clicked (the user:
// "some of them don't even actually do anything"). SetNightLight now writes the
// blob the way Settings does - ONLY when the one in the registry has exactly the
// layout measured here, changing only the two bytes that differ between off and
// on and the timestamp that makes Windows notice. Any other layout is refused
// WITH the reason and nothing is written, because a blob Windows cannot parse is
// the "display stuck in a state no UI fixes" risk this used to avoid entirely.
//
// BRIGHTNESS SETS (2026-09-23): 48-88 ms each, measured, because every set ran
// a fresh WMI query for the methods object and another for the read-back. Both
// objects are now kept between sets, and the sets run on their own lane (Lanes.cs,
// "qs") so a dragged slider never waits behind an icon load.
using System;
using System.Collections;
using System.Management;
using Microsoft.Win32;

namespace Mantle {
  static class Display {
    // -------------------------------------------------------------- brightness

    public static IDictionary Brightness() {
      int level = 0;
      bool present = false;
      string reason = null;
      try {
        using (var searcher = new ManagementObjectSearcher("root\\wmi", "SELECT * FROM WmiMonitorBrightness"))
        using (ManagementObjectCollection got = searcher.Get()) {
          foreach (ManagementObject mo in got) {
            using (mo) {
              object cur = mo["CurrentBrightness"];
              if (cur == null) continue;
              level = Convert.ToInt32(cur);
              present = true;
              break;   // the first monitor that answers is the one the slider drives
            }
          }
        }
        if (!present)
          reason = "no display on this machine reports a backlight Windows can set " +
                   "(an external monitor needs DDC/CI, which Mantle does not drive yet)";
      } catch (ManagementException me) {
        reason = "WMI would not answer the brightness query (" + me.Message.Trim() + ")";
      } catch (Exception ex) {
        reason = "the brightness could not be read (" + ex.GetType().Name + ": " + ex.Message + ")";
      }

      if (level < 0) level = 0;
      if (level > 100) level = 100;
      return Json.Obj("ok", true, "present", present, "level", level, "reason", reason);
    }

    /// WmiSetBrightness(timeout, level). The timeout is the fade in seconds; 0
    /// means "now", which is what a slider wants. `readBack` is the fresh read
    /// taken afterwards, for the cache; the return value is the reply.
    public static IDictionary SetBrightness(int level, out IDictionary readBack) {
      if (level < 0) level = 0;
      if (level > 100) level = 100;
      string reason = null;
      bool done = false;
      long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
      try {
        lock (_setLock) {
          // One try with the kept object; if WMI has dropped it (a monitor change, a service
          // restart), look it up again once.
          for (int attempt = 0; attempt < 2 && !done; attempt++) {
            if (_methods == null) _methods = First("WmiMonitorBrightnessMethods");
            if (_methods == null) break;
            try {
              _methods.InvokeMethod("WmiSetBrightness", new object[] { (uint)0, (byte)level });
              done = true;
            } catch (ManagementException) {
              if (attempt == 1) throw;
              Drop(ref _methods);
            }
          }
        }
        if (!done)
          reason = "no display on this machine accepts a brightness change from Windows " +
                   "(an external monitor needs DDC/CI, which Mantle does not drive yet)";
      } catch (ManagementException me) {
        reason = "WMI refused the brightness change (" + me.Message.Trim() + ")";
      } catch (Exception ex) {
        reason = "the brightness could not be changed (" + ex.GetType().Name + ": " + ex.Message + ")";
      }

      long setMs = Lanes.MsSince(t0);
      var now = done ? QuickRead() : Brightness();
      readBack = Json.Obj();
      foreach (DictionaryEntry e in now) readBack[e.Key] = e.Value;
      if (!done) {
        now["ok"] = false;
        now["reason"] = reason;
      }
      now["setMs"] = setMs;
      now["ms"] = Lanes.MsSince(t0);
      return now;
    }

    // Two locks, so the watch's read (QuickSettings, every second while the panel is open)
    // never holds up a set from a dragged slider. MEASURED 2026-09-23 with one shared lock:
    // sets took 46-260 ms while the watch was reading, 7 ms when it was not.
    static readonly object _setLock = new object(), _readLock = new object();
    static ManagementObject _methods, _current;   // kept between calls (see the header)

    static ManagementObject First(string cls) {
      using (var searcher = new ManagementObjectSearcher("root\\wmi", "SELECT * FROM " + cls))
      using (ManagementObjectCollection got = searcher.Get()) {
        foreach (ManagementObject mo in got) return mo;
      }
      return null;
    }

    static void Drop(ref ManagementObject mo) {
      if (mo != null) { try { mo.Dispose(); } catch (Exception) { } }
      mo = null;
    }

    /// The read-back after a set: the kept WmiMonitorBrightness instance, re-fetched (one WMI
    /// round trip instead of a query). Falls back to the full read if WMI dropped it.
    public static IDictionary QuickRead() {
      try {
        lock (_readLock) {
          if (_current == null) _current = First("WmiMonitorBrightness");
          if (_current != null) {
            _current.Get();
            object cur = _current["CurrentBrightness"];
            if (cur != null) {
              int level = Math.Max(0, Math.Min(100, Convert.ToInt32(cur)));
              return Json.Obj("ok", true, "present", true, "level", level, "reason", null);
            }
          }
        }
      } catch (Exception) {
        lock (_readLock) Drop(ref _current);
      }
      return Brightness();
    }

    // --------------------------------------------------- brightness change events
    // WmiMonitorBrightnessEvent fires when the level changes from anywhere: the brightness
    // keys, Windows' own slider, adaptive brightness. QuickSettings' watch listens while
    // its lease is held, so a key press shows in the open panel at once rather than at
    // the next once-a-second read (a WMI read costs 2-66 ms here, too much to do 4x a second).
    static ManagementEventWatcher _events;

    /// Start (with the handler) or stop listening. Returns null, or why it could not listen.
    public static string ListenBrightness(bool on, EventArrivedEventHandler onEvent) {
      lock (_readLock) {
        if (_events != null) {
          try { _events.Stop(); } catch (Exception) { }
          try { _events.Dispose(); } catch (Exception) { }
          _events = null;
        }
        if (!on) return null;
        try {
          var w = new ManagementEventWatcher(new ManagementScope("root\\wmi"),
                                             new WqlEventQuery("SELECT * FROM WmiMonitorBrightnessEvent"));
          w.EventArrived += onEvent;
          w.Start();
          _events = w;
          return null;
        } catch (Exception ex) {
          return "brightness changes are read once a second, because WMI would not report them (" +
                 ex.GetType().Name + ": " + ex.Message.Trim() + ")";
        }
      }
    }

    // -------------------------------------------------------------- night light

    const string NightLightKey =
      @"Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\" +
      @"default$windows.data.bluelightreduction.bluelightreductionstate\" +
      @"windows.data.bluelightreduction.bluelightreductionstate";

    /// THE BYTE PATTERN, measured on this machine (2026-09-21): the blob is 41
    /// bytes with 0x13 at offset 18 when night light is OFF, and 43 bytes with
    /// 0x15 there (and an extra 0x10 0x00 inserted at offset 23) when it is ON.
    /// Both markers are checked and they must agree; when they do not, the
    /// answer is "unknown" WITH the bytes' length in the reason rather than a
    /// coin flip - a wrong state in the panel is worse than a blank one.
    /// THE SWITCH (2026-09-23). The layout it accepts, byte for byte, as measured on the user's
    /// machine (41 bytes, off):
    ///   43 42 01 00 0a 02 01 00 2a 06 [5-byte timestamp] 2a 2b 0e [13] 43 42 01 00 d0 0a 02 ...
    /// On is the same with [15] as the length byte at offset 18 and "10 00" inserted at 23.
    /// The timestamp is Unix seconds as a 5-byte varint; a new one is what makes Windows act on
    /// the value (the same bytes written again are ignored). Anything else is refused unwritten.
    public static IDictionary SetNightLight(bool want) {
      long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(NightLightKey, true)) {
          if (k == null)
            return NightLightRefused("Windows has no night light state to switch yet (it has never been turned on here); " +
                                     "turn it on once in Settings > Display > Night light");
          var data = k.GetValue("Data") as byte[];
          string bad = NightLightLayout(data);
          if (bad != null)
            return NightLightRefused("the night light state is not in the layout Mantle knows (" + bad +
                                     "), so nothing was written; Windows' own switch still works");
          bool isOn = data.Length == 43;
          byte[] next;
          if (want == isOn) next = (byte[])data.Clone();
          else if (want) {
            next = new byte[43];
            Array.Copy(data, 0, next, 0, 23);
            next[23] = 0x10; next[24] = 0x00;
            Array.Copy(data, 23, next, 25, 18);
            next[18] = 0x15;
          } else {
            next = new byte[41];
            Array.Copy(data, 0, next, 0, 23);
            Array.Copy(data, 25, next, 23, 18);
            next[18] = 0x13;
          }
          long secs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
          long old = Varint5(data, 10);
          if (secs <= old) secs = old + 1;                   // strictly newer, even with a clock set back
          if (!PutVarint5(next, 10, secs))
            return NightLightRefused("the clock (" + secs + ") does not fit the state's 5-byte timestamp, so nothing was written");
          k.SetValue("Data", next, RegistryValueKind.Binary);
        }
      } catch (Exception ex) {
        return NightLightRefused("the night light state could not be written (" + ex.GetType().Name + ": " + ex.Message + ")");
      }
      IDictionary now = NightLight();
      bool on = now["on"] is bool && (bool)now["on"];
      if (on != want) {
        now["ok"] = false;
        now["reason"] = "Mantle wrote night light " + (want ? "on" : "off") + ", but the state reads " + (on ? "on" : "off") + " straight after";
      }
      now["ms"] = Lanes.MsSince(t0);
      return now;
    }

    static IDictionary NightLightRefused(string why) {
      IDictionary now = NightLight();
      now["ok"] = false;
      now["reason"] = why;
      return now;
    }

    /// null when `data` is exactly the off or on layout above, else what is wrong with it.
    static string NightLightLayout(byte[] data) {
      if (data == null) return "no Data value";
      if (data.Length != 41 && data.Length != 43) return data.Length + " bytes, not 41 or 43";
      byte[] head = { 0x43, 0x42, 0x01, 0x00, 0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06 };
      for (int i = 0; i < head.Length; i++) if (data[i] != head[i]) return "byte " + i + " of the header differs";
      for (int i = 10; i < 14; i++) if ((data[i] & 0x80) == 0) return "the timestamp is not a 5-byte varint";
      if ((data[14] & 0x80) != 0) return "the timestamp is not a 5-byte varint";
      if (data[15] != 0x2a || data[16] != 0x2b || data[17] != 0x0e) return "the inner record's tag differs";
      if (data[19] != 0x43 || data[20] != 0x42 || data[21] != 0x01 || data[22] != 0x00) return "the inner header differs";
      bool on = data.Length == 43;
      if (data[18] != (on ? 0x15 : 0x13)) return "the inner length byte is " + data[18] + " for a " + data.Length + "-byte state";
      if (on && (data[23] != 0x10 || data[24] != 0x00)) return "the on marker is missing from a 43-byte state";
      int rest = on ? 25 : 23;
      if (data[rest] != 0xd0 || data[rest + 1] != 0x0a || data[rest + 2] != 0x02) return "the record after the marker differs";
      return null;
    }

    static long Varint5(byte[] d, int at) {
      long v = 0;
      for (int i = 0; i < 5; i++) v |= (long)(d[at + i] & 0x7f) << (7 * i);
      return v;
    }

    static bool PutVarint5(byte[] d, int at, long v) {
      if (v < (1L << 28) || v >= (1L << 35)) return false;   // exactly five bytes, or the layout shifts
      for (int i = 0; i < 5; i++) {
        byte b = (byte)((v >> (7 * i)) & 0x7f);
        if (i < 4) b |= 0x80;
        d[at + i] = b;
      }
      return true;
    }

    public static IDictionary NightLight() {
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(NightLightKey)) {
          if (k == null)
            return Json.Obj("ok", true, "present", false, "on", false,
                            "reason", "this machine has no night light state in the registry " +
                                      "(the feature has never been switched on, or this Windows does not have it)");
          var data = k.GetValue("Data") as byte[];
          if (data == null || data.Length < 25)
            return Json.Obj("ok", true, "present", false, "on", false,
                            "reason", "the night light state value is missing or too short to read");

          bool markerA = data[18] == 0x15;                        // 0x13 = off, 0x15 = on
          bool markerB = data[23] == 0x10 && data[24] == 0x00;    // the two bytes only present when on
          if (markerA != markerB)
            return Json.Obj("ok", true, "present", true, "on", markerA,
                            "reason", "the two markers in the night light blob disagree (" + data.Length +
                                      " bytes); Windows may have changed the format, so this reading is a guess");

          return Json.Obj("ok", true, "present", true, "on", markerA, "reason", null);
        }
      } catch (Exception ex) {
        return Json.Obj("ok", false, "present", false, "on", false,
                        "reason", "the night light state could not be read (" + ex.Message + ")");
      }
    }
  }
}
