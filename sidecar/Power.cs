// Power.cs - `power`: the battery pill in Mantle's bar.
//
// One Win32 call, no WMI, no polling cost worth measuring - which matters
// because the bar asks for this on a timer for as long as it is up.
//
// THE UNKNOWNS ARE REPORTED AS UNKNOWN. Windows uses 255 for "I do not know
// the percentage" and 0xFFFFFFFF for "I have not watched the discharge long
// enough to estimate a runtime". A shell that renders those as 255% or as
// 71,582,788 minutes is the kind of thing people screenshot, so both come back
// as null and the UI shows nothing rather than nonsense.
//
// BATTERY SAVER IS READ-ONLY for now. There IS an API to turn it on
// (PowerSetActiveOverlayScheme / the undocumented battery-saver COM), but
// nothing stable enough to hold a switch, so `power {saver:...}` answers
// "not available yet" instead of pretending. An honest refusal beats a toggle
// that silently does nothing.
using System;
using System.Collections;

namespace Mantle {
  static class Power {
    public static IDictionary Read() {
      Win32.SYSTEM_POWER_STATUS s;
      if (!Win32.GetSystemPowerStatus(out s))
        return Json.Obj("ok", false, "onBattery", false, "percent", null, "minutesLeft", null,
                        "saver", false,
                        "reason", "Windows would not report the power status (Win32 error " +
                                  System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")");

      // BatteryFlag bit 7 (128) means "no system battery" - a desktop.
      bool hasBattery = (s.BatteryFlag & 128) == 0;
      bool onBattery = s.ACLineStatus == 0;
      object percent = s.BatteryLifePercent <= 100 ? (object)(int)s.BatteryLifePercent : null;
      object minutes = s.BatteryLifeTime != 0xFFFFFFFF ? (object)(int)(s.BatteryLifeTime / 60) : null;
      bool saver = s.SystemStatusFlag == 1;

      string reason = null;
      if (!hasBattery) reason = "this machine has no battery, so it is always on mains power";
      else if (percent == null) reason = "Windows does not know the battery percentage yet";
      else if (onBattery && minutes == null) reason = "Windows has not estimated the remaining time yet";

      return Json.Obj("ok", true, "onBattery", onBattery, "percent", percent, "minutesLeft", minutes,
                      "saver", saver, "hasBattery", hasBattery, "reason", reason);
    }
  }
}
