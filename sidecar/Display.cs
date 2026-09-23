// Display.cs - `brightness` and `nightlight`: the two display switches the
// stock Quick Settings panel owns.
//
// BRIGHTNESS goes through WMI's root\wmi namespace, which is the only
// user-mode way to move a monitor's backlight. IT IS NOT UNIVERSAL: a laptop
// panel answers, and so does an external monitor whose cable and firmware
// support DDC/CI - but a desktop monitor that does not is a "present:false
// with the reason" answer, not an error. Owen's machine is a desktop, so this
// is the expected path here and the panel must render a disabled control with
// an explanation rather than a broken slider.
//
// A WMI query costs tens of milliseconds idle and a few hundred under Owen's
// load, so Brightness() is a FRESH read that only ever runs on a background
// thread or the slow lane: QuickSettings.cs caches it and answers the panel
// from the cache (2026-09-22; it used to be a 2 s cache here, read on the
// message-loop thread, where it queued behind Bluetooth).
//
// NIGHT LIGHT has no API at all. Its state lives in an UNDOCUMENTED CloudStore
// blob, and this reads a byte pattern out of it - which is why it is READ-ONLY.
// Writing that blob means forging a timestamped protobuf and poking the
// CloudStore, and getting it wrong leaves the user's display stuck in a state
// no UI will fix. So `nightlight` reports, and says plainly that Mantle cannot
// switch it yet, which is the honest answer rather than a button that silently
// does nothing.
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
          reason = "no monitor on this machine reports a controllable backlight " +
                   "(a desktop monitor without DDC/CI support cannot be dimmed from Windows)";
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
      try {
        using (var searcher = new ManagementObjectSearcher("root\\wmi", "SELECT * FROM WmiMonitorBrightnessMethods"))
        using (ManagementObjectCollection got = searcher.Get()) {
          foreach (ManagementObject mo in got) {
            using (mo) {
              mo.InvokeMethod("WmiSetBrightness", new object[] { (uint)0, (byte)level });
              done = true;
            }
          }
        }
        if (!done)
          reason = "no monitor on this machine accepts a brightness change " +
                   "(a desktop monitor without DDC/CI support cannot be dimmed from Windows)";
      } catch (ManagementException me) {
        reason = "WMI refused the brightness change (" + me.Message.Trim() + ")";
      } catch (Exception ex) {
        reason = "the brightness could not be changed (" + ex.GetType().Name + ": " + ex.Message + ")";
      }

      var now = Brightness();
      readBack = Json.Obj();
      foreach (DictionaryEntry e in now) readBack[e.Key] = e.Value;
      if (!done) {
        now["ok"] = false;
        now["reason"] = reason;
      }
      return now;
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

          return Json.Obj("ok", true, "present", true, "on", markerA,
                          "reason", "night light can be read but not switched from Mantle yet");
        }
      } catch (Exception ex) {
        return Json.Obj("ok", false, "present", false, "on", false,
                        "reason", "the night light state could not be read (" + ex.Message + ")");
      }
    }
  }
}
