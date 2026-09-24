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
//
// ONE READING FOR BOTH (2026-09-23). The panel's footer read this while the
// bar's own readout read Win32_Battery, and the two could disagree on screen
// at the same moment (71 % beside 72 %; "Plugged in" beside a bolt). This is
// now Battery.Read(): the same call, the same fields, plus `power`'s older
// names (onBattery, minutesLeft, hasBattery), which it still carries.
using System;
using System.Collections;

namespace Mantle {
  static class Power {
    public static IDictionary Read() {
      return Battery.Read();
    }
  }
}
