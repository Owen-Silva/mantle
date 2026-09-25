// Battery.cs - `battery`: the bar's battery readout, read from the place Windows'
// own battery icon reads it, and pushed the moment it changes.
//
// WHY THIS REPLACED THE WMI QUERY (2026-09-23). Owen: "there are problems with
// it showing how charged my computer is". The bar spawned PowerShell for
// Win32_Battery (lib/sys-stats.js), and that disagreed with Windows in four
// ways, all measured on this laptop the same day:
//   - THE NUMBER. At 25,520 of 35,610 mWh (71.7 %) Win32_Battery said 71 and
//     GetSystemPowerStatus, the number Windows shows, said 72: WMI truncates.
//   - CHARGING. BatteryStatus 2 was read as "charging". It means "on AC", and a
//     laptop held at a charge limit (Lenovo Vantage conservation mode) is on
//     AC and NOT charging - it got a bolt anyway.
//   - STALE. A 60 s cache read on a 5 s clock tick with the bar up and a 5 min
//     one with it down: plugging in showed nothing for up to a minute.
//   - GONE FOR GOOD. One slow PowerShell start (killed at 5 s, no output) read
//     as "this machine reports no battery", and the readout never came back
//     for the rest of the session.
// GetSystemPowerStatus is the call Windows documents for this and costs
// microseconds; CallNtPowerInformation(SystemBatteryState) adds the charger's
// own charging flag and the capacities, so the arithmetic can be checked.
//
// PUSHED, NOT POLLED. `battery {watch:true}` gives this process one more hidden
// top-level window (a broadcast never reaches a message-only one) that hears
// WM_POWERBROADCAST: PBT_APMPOWERSTATUSCHANGE, which Windows broadcasts when the
// power status changes; resume from sleep; and PBT_POWERSETTINGCHANGE for the
// three settings registered here (AC/DC source, percentage, battery saver).
// Each one re-reads, and an event goes out only when something shown changed.
// A 30 s re-check backs that up, because no documented notification promises
// to cover a charging flip on its own (a charge limit stopping the charge at an
// unchanged percentage), and none at all covers Windows' first time-left
// estimate after an unplug. It says so on the wire (via:"recheck"). Measured on
// a real unplug here, 2026-09-23: the unplug arrived via "status" (the
// broadcast) in the same second, the estimate 32 s later via "recheck", and
// every percentage step on the way from 81 to 90 via "percent".
//
// THE UNKNOWNS STAY UNKNOWN. A percentage of 255, an ACLineStatus of 255 and a
// lifetime of 0xFFFFFFFF (-1 read signed) come back as null, never as 255 % or
// 1,193,046 hours. Windows sends that lifetime on AC (measured while charging
// at 72 %) and for a while after an unplug (32 s on the unplug measured here).
//
// Reading and listening change nothing on the machine, so both work in
// --passive (the harness proves the notification path there).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mantle {
  static class BatteryNative {
    /// winnt.h SYSTEM_BATTERY_STATE: four BOOLEANs, Spare1[3], Tag, then six
    /// DWORDs - 32 bytes. Rate is declared DWORD but is signed in practice
    /// ("a negative rate indicates discharging"), so it is read as int.
    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEM_BATTERY_STATE {
      public byte AcOnLine;
      public byte BatteryPresent;
      public byte Charging;
      public byte Discharging;
      public byte Spare1a, Spare1b, Spare1c;
      public byte Tag;
      public uint MaxCapacity;        // mWh, the full-charge capacity
      public uint RemainingCapacity;  // mWh
      public int Rate;                // mW, negative while discharging
      public uint EstimatedTime;      // seconds
      public uint DefaultAlert1;
      public uint DefaultAlert2;
    }

    public const int SystemBatteryState = 5;          // POWER_INFORMATION_LEVEL

    [DllImport("powrprof.dll")]
    public static extern uint CallNtPowerInformation(int level, IntPtr input, uint inputLength,
                                                     out SYSTEM_BATTERY_STATE output, uint outputLength);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid setting, int flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterPowerSettingNotification(IntPtr handle);

    public const int DEVICE_NOTIFY_WINDOW_HANDLE = 0;
    public const int WM_POWERBROADCAST = 0x0218;
    public const int PBT_APMRESUMESUSPEND = 0x0007;
    public const int PBT_APMPOWERSTATUSCHANGE = 0x000A;
    public const int PBT_APMRESUMEAUTOMATIC = 0x0012;
    public const int PBT_POWERSETTINGCHANGE = 0x8013;

    public static readonly Guid GUID_ACDC_POWER_SOURCE = new Guid("5D3E9A59-E9D5-4B00-A6BD-FF34FF516548");
    public static readonly Guid GUID_BATTERY_PERCENTAGE_REMAINING = new Guid("A7AD8041-B45A-4CAE-87A3-EECBB468A9E1");
    public static readonly Guid GUID_POWER_SAVING_STATUS = new Guid("E00958C0-C213-4ACE-AC77-FECCED2EEEA5");
  }

  static class Battery {
    public const int RecheckMs = 30000;

    /// One reading. Always an object; ok:false only when Windows refused to say.
    public static IDictionary Read() {
      Win32.SYSTEM_POWER_STATUS s;
      if (!Win32.GetSystemPowerStatus(out s)) {
        int err = Marshal.GetLastWin32Error();
        return Json.Obj("ok", false, "present", null, "percent", null, "ac", null, "charging", false,
                        "secondsLeft", null, "saver", false,
                        "onBattery", false, "minutesLeft", null, "hasBattery", null,
                        "reason", "Windows would not report the power status (GetSystemPowerStatus failed, Win32 error " +
                                  err + ")");
      }
      BatteryNative.SYSTEM_BATTERY_STATE b;
      uint nt = BatteryNative.CallNtPowerInformation(BatteryNative.SystemBatteryState, IntPtr.Zero, 0, out b,
                                                     (uint)Marshal.SizeOf(typeof(BatteryNative.SYSTEM_BATTERY_STATE)));
      bool haveNt = nt == 0;

      // BatteryFlag 255 is "unknown" for the whole byte, so none of its bits
      // mean anything then; the kernel's own BatteryPresent answers instead.
      bool flagKnown = s.BatteryFlag != 255;
      object present = flagKnown ? (object)((s.BatteryFlag & 128) == 0)
                     : haveNt ? (object)(b.BatteryPresent != 0) : null;
      object percent = s.BatteryLifePercent <= 100 ? (object)(int)s.BatteryLifePercent : null;
      object ac = s.ACLineStatus == 1 ? (object)true : s.ACLineStatus == 0 ? (object)false : null;
      bool onBattery = s.ACLineStatus == 0;
      bool charging = flagKnown && (s.BatteryFlag & 8) != 0;
      bool low = flagKnown && (s.BatteryFlag & 2) != 0;
      bool critical = flagKnown && (s.BatteryFlag & 4) != 0;
      // Windows 11 Energy saver is invisible to SystemStatusFlag (Windows 10 battery saver only), 2026-09-25.
      bool saver = s.SystemStatusFlag == 1 || PowerMode.SaverStatus() >= 1;
      // A time left only on battery and only once Windows has one: on AC it
      // sends 0xFFFFFFFF, and so it does for a while after an unplug (32 s, measured).
      object seconds = onBattery && s.BatteryLifeTime != 0xFFFFFFFF ? (object)(long)s.BatteryLifeTime : null;

      object capacity = null;
      if (haveNt && b.BatteryPresent != 0 && b.MaxCapacity > 0)
        capacity = Json.Obj("remaining", (long)b.RemainingCapacity, "full", (long)b.MaxCapacity, "rate", b.Rate);

      string reason = null;
      if (present == null) reason = "Windows cannot tell whether this machine has a battery";
      else if (!(bool)present) reason = "this machine has no battery, so it always runs on mains power";
      else if (percent == null) reason = "Windows does not know the battery percentage yet";
      else if (ac == null) reason = "Windows does not know whether the charger is plugged in";
      else if (onBattery && seconds == null) reason = "Windows has not estimated the time left yet";

      // What Windows actually said, for the harness and for anyone debugging a
      // disagreement. The page never shows these; lifeTime is the raw DWORD.
      IDictionary raw = Json.Obj("acLine", (int)s.ACLineStatus, "flag", (int)s.BatteryFlag,
                                 "lifePercent", (int)s.BatteryLifePercent, "statusFlag", (int)s.SystemStatusFlag,
                                 "lifeTime", (long)s.BatteryLifeTime,
                                 "nt", haveNt ? null : "0x" + nt.ToString("X8", CultureInfo.InvariantCulture),
                                 "ntCharging", haveNt ? (object)(b.Charging != 0) : null,
                                 "ntDischarging", haveNt ? (object)(b.Discharging != 0) : null,
                                 "ntEstimatedTime", haveNt ? (object)(long)b.EstimatedTime : null);

      return Json.Obj("ok", true, "present", present, "percent", percent, "ac", ac, "charging", charging,
                      "secondsLeft", seconds, "saver", saver, "low", low, "critical", critical,
                      "capacity", capacity,
                      // `power`'s older names: the quick-settings panel and an older main read these.
                      "onBattery", onBattery,
                      "minutesLeft", seconds == null ? null : (object)((long)seconds / 60),
                      "hasBattery", present,
                      "raw", raw, "reason", reason);
    }

    // ------------------------------------------------------------ the watch
    // Everything below runs on the message-loop thread: `battery` is a ui-lane
    // command, the window's WndProc and the Forms timer both run there.

    sealed class PowerWindow : NativeWindow {
      public PowerWindow() {
        CreateParams cp = new CreateParams();
        cp.Caption = "Mantle battery watch";
        cp.Style = unchecked((int)0x80000000);        // WS_POPUP: no frame, and it is never shown
        cp.ExStyle = 0x00000080 | 0x08000000;         // WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        CreateHandle(cp);
      }

      protected override void WndProc(ref Message m) {
        if (m.Msg == BatteryNative.WM_POWERBROADCAST) {
          // Never let a throw out of here: an exception in a WndProc goes to
          // the thread-exception path, and a power broadcast is not worth that.
          try { Battery.OnBroadcast(m.WParam.ToInt64(), m.LParam); }
          catch (Exception ex) { Program.EmitLog("warn", "battery: a power notification could not be handled (" + ex.Message + ")"); }
          m.Result = new IntPtr(1);
          return;
        }
        base.WndProc(ref m);
      }
    }

    static PowerWindow _win;
    static readonly List<IntPtr> _regs = new List<IntPtr>();
    static readonly List<string> _registered = new List<string>();
    static System.Windows.Forms.Timer _recheck;
    static string _watchReason;
    static string _lastSig;
    static int _events;

    /// Start or stop the pushes. Idempotent both ways. The reply is a reading
    /// plus what the watch could and could not arm, with the reason.
    public static IDictionary Watch(bool on) {
      if (!on) {
        Stop();
        IDictionary off = Read();
        off["watching"] = false;
        off["registered"] = new List<string>();
        off["watchReason"] = null;
        return off;
      }
      if (_win == null) {
        _win = new PowerWindow();
        _registered.Clear();
        var failed = new List<string>();
        Register(BatteryNative.GUID_ACDC_POWER_SOURCE, "ac", failed);
        Register(BatteryNative.GUID_BATTERY_PERCENTAGE_REMAINING, "percent", failed);
        Register(BatteryNative.GUID_POWER_SAVING_STATUS, "saver", failed);
        _watchReason = failed.Count == 0 ? null
          : "Windows would not register " + string.Join(", ", failed.ToArray()) +
            ", so those changes arrive only with the " + (RecheckMs / 1000) + " s re-check";
        if (_watchReason != null) Program.EmitLog("warn", "battery: " + _watchReason);
        _recheck = new System.Windows.Forms.Timer();
        _recheck.Interval = RecheckMs;
        _recheck.Tick += delegate (object sender, EventArgs e) {
          try { Check("recheck"); }
          catch (Exception ex) { Program.EmitLog("warn", "battery: the re-check failed (" + ex.Message + ")"); }
        };
        _recheck.Start();
      }
      IDictionary r = Read();
      r["watching"] = true;
      r["registered"] = new List<string>(_registered);
      r["watchReason"] = _watchReason;
      r["events"] = _events;
      return r;
    }

    static void Register(Guid setting, string name, List<string> failed) {
      Guid g = setting;
      IntPtr h = BatteryNative.RegisterPowerSettingNotification(_win.Handle, ref g, BatteryNative.DEVICE_NOTIFY_WINDOW_HANDLE);
      if (h == IntPtr.Zero) failed.Add(name + " (Win32 error " + Marshal.GetLastWin32Error() + ")");
      else { _regs.Add(h); _registered.Add(name); }
    }

    static void Stop() {
      foreach (IntPtr h in _regs) BatteryNative.UnregisterPowerSettingNotification(h);
      _regs.Clear();
      _registered.Clear();
      if (_recheck != null) { _recheck.Stop(); _recheck.Dispose(); _recheck = null; }
      if (_win != null) { _win.DestroyHandle(); _win = null; }
      _watchReason = null;
      _lastSig = null;
    }

    static void OnBroadcast(long what, IntPtr data) {
      if (what == BatteryNative.PBT_APMPOWERSTATUSCHANGE) Check("status");
      else if (what == BatteryNative.PBT_APMRESUMEAUTOMATIC || what == BatteryNative.PBT_APMRESUMESUSPEND) Check("resume");
      else if (what == BatteryNative.PBT_POWERSETTINGCHANGE && data != IntPtr.Zero) {
        // POWERBROADCAST_SETTING starts with the setting's GUID.
        Guid g = (Guid)Marshal.PtrToStructure(data, typeof(Guid));
        Check(g == BatteryNative.GUID_ACDC_POWER_SOURCE ? "ac"
            : g == BatteryNative.GUID_BATTERY_PERCENTAGE_REMAINING ? "percent"
            : g == BatteryNative.GUID_POWER_SAVING_STATUS ? "saver" : "setting");
      }
    }

    /// Re-read, and push only when something the bar shows has changed. The
    /// time left is in the signature only as known/unknown: its value moves on
    /// every read while unplugged, and pushing that would be a poll by another
    /// name. It rides along with the next real change.
    static void Check(string via) {
      if (_win == null) return;
      IDictionary r = Read();
      string sig = Signature(r);
      if (sig == _lastSig) return;
      _lastSig = sig;
      _events++;
      IDictionary ev = Json.Obj("ev", "battery", "via", via);
      foreach (DictionaryEntry e in r) ev[e.Key] = e.Value;
      Program.Emit(ev);
    }

    static string Signature(IDictionary r) {
      return Str(r["ok"]) + "|" + Str(r["present"]) + "|" + Str(r["percent"]) + "|" + Str(r["ac"]) + "|" +
             Str(r["charging"]) + "|" + Str(r["saver"]) + "|" + Str(r["low"]) + "|" + Str(r["critical"]) + "|" +
             (r["secondsLeft"] == null ? "time?" : "time");
    }

    static string Str(object o) { return o == null ? "null" : Convert.ToString(o, CultureInfo.InvariantCulture); }
  }
}
