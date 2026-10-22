// PowerMode.cs - `powermode.*`: Windows 11's power mode (Best power efficiency / Balanced /
// Best performance) for the quick-settings panel (osd lane, wave 3, 2026-09-24).
//
// WHAT WINDOWS CALLS IT. Settings > System > Power & battery's "Power mode" is a power-scheme
// OVERLAY laid over the Balanced plan, CHOSEN SEPARATELY for each power source ("Power mode when
// plugged in" / "Power mode when on battery"; stored in HKLM ...\Power\User\PowerSchemes as
// ActiveOverlayAcPowerScheme / ActiveOverlayDcPowerScheme, empty = Balanced).
//
// WHICH VALUE SETTINGS SHOWS (measured 2026-09-25, after the tile said "Efficiency" and a set of
// Performance on battery was reported as refused although it had landed):
//   - Settings' own power-mode code (SettingsHandlers_OneCore_BatterySaver.dll, cpowermode.cpp, and
//     SettingsHandlers_OneCore_PowerAndSleep.dll) imports PowerGetUserConfiguredACPowerMode /
//     ...DCPowerMode and PowerSetUserConfiguredACPowerMode / ...DCPowerMode, and never
//     PowerGetEffectiveOverlayScheme: the dropdowns are the USER-CONFIGURED mode per source.
//   - its string table has "Power mode cannot be set when energy saver is on." (and the same for
//     battery saver, Game Mode, Windows Mixed Reality).
//   - on battery: configured DC = ded574b5 (Best performance) = PowerGetActualOverlayScheme = the
//     registry DC value, but PowerGetEffectiveOverlayScheme = 961cc777 (Best power efficiency),
//     because GUID_ENERGY_SAVER_STATUS read 1 (on): the Balanced plan's DC "turn energy saver on at"
//     level is 100%, so Energy saver is on whenever this PC is unplugged. GetSystemPowerStatus's
//     SystemStatusFlag and GUID_POWER_SAVING_STATUS both read 0 all along - they are Windows 10's
//     battery saver and do NOT see Windows 11's Energy saver.
//   - plugged in: configured AC = 00000000 (Balanced) = actual = effective, energy saver status 0.
// So the mode shown is the configured one for the current source (what Settings shows), the mode
// actually IN FORCE (effective) travels beside it, Energy saver comes from GUID_ENERGY_SAVER_STATUS,
// and a set writes the current source's value with the same call Settings uses and is verified by
// reading that same value back. While Energy saver is on the switch is locked with Settings' reason.
// The old code verified a set against the EFFECTIVE overlay, which Energy saver pins to efficiency,
// so a set that landed was reported as "Windows accepted the change but still reports efficiency".
// A same-value PowerSetUserConfiguredDCPowerMode(performance) returned 0 in 0 ms and changed
// nothing (all four reads and both registry values identical before and after, 2026-09-25).
//
// MEASURED ON THE USER'S MACHINE (2026-09-24, Windows 11 25H2 26200.9550):
//   - the overlays registered here: 961cc777-2547-4f9d-8174-7d86181b8a7a ("Better Battery-life
//     Overlay" = Best power efficiency), ded574b5-45a0-4f42-8737-46345c09c238 ("Max Performance
//     Overlay" = Best performance), 3af9b8d9-7c97-431d-ad78-34a8bfea439f ("High Performance
//     Overlay", Windows 10's "Better performance" slider stop, which Windows 11 Settings no longer
//     offers); Balanced is no overlay at all: 00000000-0000-0000-0000-000000000000.
//   - (2026-09-24) ActiveOverlayAcPowerScheme and ActiveOverlayDcPowerScheme were both EMPTY
//     (= Balanced), and the effective overlay read 00000000-... on AC.
//   - THE ACTIVE PLAN IS NOT BALANCED: 44444444-4444-4444-4444-444444444452 "Hone Ultimate Power
//     Plan V5" (a third-party tuning plan). Windows applies an overlay only on top of Balanced
//     (381b4222-f694-41f0-9685-ff5bb260df2e) and Settings hides the dropdown on any other plan, so
//     on this machine today the control is shown muted with that reason, and a set is refused
//     with it rather than written to a registry value Windows would ignore.
//   - (2026-09-30, 26H2 26300.9550) the same rule reads right: the plan is Balanced now and the AC
//     overlay is Best performance (ded574b5-...), DC none; sidecar/test-power.js passes.
//
// LIVE UPDATES. Listeners only, no polling: PowerRegisterForEffectivePowerModeNotifications (the
// mode in force changed), PowerSettingRegisterNotification for GUID_ACTIVE_POWERSCHEME (a plan
// switch), GUID_ACDC_POWER_SOURCE (plugged in / unplugged) and GUID_ENERGY_SAVER_STATUS, and a
// registry change notification on the PowerSchemes key (a choice made in Settings that does not
// change the mode in force: the OTHER source's dropdown, or any choice while Energy saver pins
// efficiency). Each re-reads on a pool thread and pushes {ev:"powermode", ...state} when the state
// changed. Listening changes nothing, so it runs in --passive too.
//
// TESTS (the brief): a set in --passive is allowed only when it asks for the mode already chosen
// for this power source (a same-value write); anything else is refused with the reason, before
// powrprof is called. powermode.decide runs the pure read/verify logic over made-up readings.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class PowerMode {
    static class Native {
      [DllImport("powrprof.dll")] public static extern uint PowerGetEffectiveOverlayScheme(out Guid overlay);
      [DllImport("powrprof.dll")] public static extern uint PowerGetActualOverlayScheme(out Guid overlay);
      [DllImport("powrprof.dll")] public static extern uint PowerSetActiveOverlayScheme(Guid overlay);
      [DllImport("powrprof.dll")] public static extern uint PowerGetActiveScheme(IntPtr rootKey, out IntPtr scheme);
      [DllImport("powrprof.dll")] public static extern uint PowerReadFriendlyName(IntPtr rootKey, ref Guid scheme,
          IntPtr subGroup, IntPtr setting, byte[] buffer, ref uint size);
      [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
      [DllImport("powrprof.dll")] public static extern uint PowerEnumerate(IntPtr rootKey, IntPtr scheme, IntPtr subGroup,
          uint accessFlags, uint index, byte[] buffer, ref uint size);
      [DllImport("powrprof.dll")] public static extern uint PowerSetActiveScheme(IntPtr rootKey, ref Guid scheme);
      // What Settings' own power-mode dropdowns call (Windows 11; missing = EntryPointNotFoundException).
      [DllImport("powrprof.dll")] public static extern uint PowerGetUserConfiguredACPowerMode(out Guid mode);
      [DllImport("powrprof.dll")] public static extern uint PowerGetUserConfiguredDCPowerMode(out Guid mode);
      [DllImport("powrprof.dll")] public static extern uint PowerSetUserConfiguredACPowerMode(ref Guid mode);
      [DllImport("powrprof.dll")] public static extern uint PowerSetUserConfiguredDCPowerMode(ref Guid mode);
      [DllImport("powrprof.dll")] public static extern uint PowerReadDCValueIndex(IntPtr rootKey, ref Guid scheme,
          ref Guid subGroup, ref Guid setting, out uint value);

      [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] public static extern int RegOpenKeyEx(IntPtr hKey, string subKey,
          uint options, uint sam, out IntPtr result);
      [DllImport("advapi32.dll")] public static extern int RegNotifyChangeKeyValue(IntPtr hKey, bool watchSubtree, uint filter,
          IntPtr hEvent, bool async);
      [DllImport("advapi32.dll")] public static extern int RegCloseKey(IntPtr hKey);

      [StructLayout(LayoutKind.Sequential)]
      public struct SYSTEM_POWER_STATUS {
        public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public int BatteryLifeTime, BatteryFullLifeTime;
      }
      [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);

      [UnmanagedFunctionPointer(CallingConvention.StdCall)]
      public delegate void EffectiveModeCallback(int mode, IntPtr context);
      [DllImport("powrprof.dll")] public static extern int PowerRegisterForEffectivePowerModeNotifications(
          uint version, EffectiveModeCallback callback, IntPtr context, out IntPtr handle);
      [DllImport("powrprof.dll")] public static extern int PowerUnregisterFromEffectivePowerModeNotifications(IntPtr handle);

      [UnmanagedFunctionPointer(CallingConvention.StdCall)]
      public delegate uint DeviceNotifyCallback(IntPtr context, uint type, IntPtr setting);
      [StructLayout(LayoutKind.Sequential)]
      public struct DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { public DeviceNotifyCallback Callback; public IntPtr Context; }
      [DllImport("powrprof.dll")] public static extern uint PowerSettingRegisterNotification(ref Guid setting, uint flags,
          ref DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS recipient, out IntPtr handle);
      [DllImport("powrprof.dll")] public static extern uint PowerSettingUnregisterNotification(IntPtr handle);
    }

    public static readonly Guid BalancedPlan = new Guid("381b4222-f694-41f0-9685-ff5bb260df2e");
    public static readonly Guid Efficiency = new Guid("961cc777-2547-4f9d-8174-7d86181b8a7a");
    public static readonly Guid Balanced = Guid.Empty;
    public static readonly Guid Performance = new Guid("ded574b5-45a0-4f42-8737-46345c09c238");
    static readonly Guid Win10Better = new Guid("3af9b8d9-7c97-431d-ad78-34a8bfea439f");
    static readonly Guid ActivePowerSchemeSetting = new Guid("31F9F286-5084-42FE-B720-2B0264993763");
    static readonly Guid AcDcSourceSetting = new Guid("5d3e9a59-e9d5-4b00-a6bd-ff34ff516548");        // GUID_ACDC_POWER_SOURCE
    static readonly Guid EnergySaverStatusSetting = new Guid("550e8400-e29b-41d4-a716-446655440000"); // GUID_ENERGY_SAVER_STATUS
    static readonly Guid EnergySaverSubgroup = new Guid("de830923-a562-41af-a086-e3a2c6bad2da");
    static readonly Guid EnergySaverAtSetting = new Guid("e69653ca-cf7f-4f05-aa73-cb833fa90ad4");      // "turn on at" battery %
    const uint EffectivePowerModeV2 = 2, DeviceNotifyCallbackFlag = 2;
    static readonly IntPtr HKLM = new IntPtr(unchecked((int)0x80000002));
    const string SchemesKey = @"SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes";
    const uint KeyNotify = 0x0010, KeyQueryValue = 0x0001;
    const uint RegNotifyLastSet = 0x4, RegNotifyThreadAgnostic = 0x10000000;   // re-armed from pool threads

    public static void Register(FeatureTable t) {
      t.Add("powermode.get", Lanes.Qs, Get);       // the panel's lane: the first read loads powrprof (90 ms here)
      t.Add("powermode.set", Lanes.Qs, Set);
      t.Add("powermode.watch", Lanes.Qs, Watch);
      t.Add("powermode.plan", Lanes.Qs, SetPlan);    // switch the power PLAN (the user's click only)
      t.Add("powermode.decide", Lanes.Qs, DecideCmd); // PURE: the read/verify logic over given readings (tests)
    }

    // ------------------------------------------------------------------ reading

    public static string ModeOf(Guid overlay) {
      if (overlay == Efficiency) return "efficiency";
      if (overlay == Balanced) return "balanced";
      if (overlay == Performance) return "performance";
      if (overlay == Win10Better) return "better";
      return "other";
    }

    static Guid OverlayFor(string mode) {
      switch (mode) {
        case "efficiency": return Efficiency;
        case "balanced": return Balanced;
        case "performance": return Performance;
      }
      throw new ArgumentException("mode");
    }

    static string PlanName(Guid plan) {
      try {
        uint size = 0;
        Native.PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, null, ref size);
        if (size == 0 || size > 4096) return null;
        var buf = new byte[size];
        if (Native.PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, buf, ref size) != 0) return null;
        return Encoding.Unicode.GetString(buf).TrimEnd('\0');
      } catch (Exception) { return null; }
    }

    // ------------------------------------------------------------------ the power PLANS
    //
    // WHY (2026-09-24): the user's active plan is "Hone Ultimate Power Plan V5", and Windows applies a
    // power MODE only on Balanced, so the mode switch alone is a dead control on their machine. The
    // panel offers the installed plans instead (PowerEnumerate + PowerReadFriendlyName, the list
    // Control Panel > Power Options shows) and the modes once Balanced is chosen.
    const uint AccessScheme = 16;              // POWER_DATA_ACCESSOR ACCESS_SCHEME

    static bool ActivePlan(out Guid plan, out uint rc) {
      plan = Guid.Empty;
      IntPtr p;
      rc = Native.PowerGetActiveScheme(IntPtr.Zero, out p);
      if (rc != 0) return false;
      plan = (Guid)Marshal.PtrToStructure(p, typeof(Guid));
      Native.LocalFree(p);
      return true;
    }

    /// Every installed power plan, in Windows' order: [{guid, name, active, balanced}].
    public static List<object> Plans(Guid active) {
      var list = new List<object>();
      var buf = new byte[16];
      for (uint i = 0; i < 64; i++) {
        uint size = 16;
        if (Native.PowerEnumerate(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, AccessScheme, i, buf, ref size) != 0) break;   // 259 = no more
        var g = new Guid(buf);
        list.Add(Json.Obj("guid", g.ToString(), "name", PlanName(g) ?? g.ToString(), "active", g == active, "balanced", g == BalancedPlan));
      }
      return list;
    }

    /// Everything Windows reported for one read. Read() fills it from Windows; powermode.decide
    /// fills it from the request, so the logic in Decide is tested with made-up readings.
    public sealed class Facts {
      public bool PlanOk = true; public uint PlanRc;
      public Guid Plan = BalancedPlan; public string PlanName; public List<object> Plans;
      public string Source = "unknown";   // GetSystemPowerStatus: "ac" | "battery" | "unknown"
      public string Ac, Dc;               // PowerGetUserConfigured{AC,DC}PowerMode as GUID text; null = not readable
      public string ConfiguredWhy;        // why they are not readable (an older Windows), else null
      public string Actual;               // PowerGetActualOverlayScheme; null = not readable
      public string Effective;            // PowerGetEffectiveOverlayScheme: the mode IN FORCE; null = not readable
      public uint EffectiveRc;
      public int Saver = -1;              // GUID_ENERGY_SAVER_STATUS: 0 off, 1 standard, 2 high savings, -1 unknown
      public bool LegacySaver;            // SystemStatusFlag bit 0: Windows 10's battery saver
      public int SaverAt = -1;            // the plan's DC "turn energy saver on at" level, %; -1 unknown
      public long Ms;
    }

    static string ModeOfText(string guid) {
      if (guid == null) return null;
      if (guid.Length == 0) return "balanced";                 // the registry's empty value = no overlay
      Guid g;
      try { g = new Guid(guid); } catch (Exception) { return "other"; }
      return ModeOf(g);
    }

    public static string FullName(string mode) {
      switch (mode) {
        case "efficiency": return "Best power efficiency";
        case "balanced": return "Balanced";
        case "performance": return "Best performance";
        case "better": return "Better performance";
      }
      return mode == null ? "no mode" : "an unrecognised mode";
    }

    static string SourceWords(string source) {
      return source == "battery" ? "on battery" : source == "ac" ? "plugged in" : "the current power source";
    }

    /// Energy saver's reason, as plain as Settings' own ("Power mode cannot be set when energy saver
    /// is on.") plus what is running, what comes back, and how to turn it off.
    public static string SaverReason(string chosen, string source, int saverAt) {
      string s = "Energy saver is on, so Windows runs Best power efficiency and the power mode can't be set";
      if (chosen != null && chosen != "efficiency")
        s += "; " + FullName(chosen) + " (your choice " + SourceWords(source) + ") comes back when it is off";
      if (source == "battery" && saverAt >= 100)
        s += ". It is set to turn on at 100% battery, so it is on whenever this PC is unplugged: to change that, open " +
             "Settings > System > Power & battery > Energy saver and turn off \"Always use energy saver\" " +
             "(or lower \"Turn energy saver on automatically\")";
      else
        s += ". To turn it off: the Energy saver button in quick settings (Win+A), or Settings > System > Power & battery > Energy saver" +
             (source == "battery" && saverAt > 0 ? " (it turns on by itself at " + saverAt + "% battery)" : "");
      return s;
    }

    /// THE PURE HALF: the state the panel draws, from one set of readings. `mode` is the mode chosen
    /// for the CURRENT power source (Settings' dropdown for it); `inForce` is what Windows is running.
    public static IDictionary Decide(Facts f) {
      if (!f.PlanOk)
        return Json.Obj("ok", false, "mode", null, "available", false, "settable", false, "ms", f.Ms,
                        "reason", "Windows would not say which power plan is active (error " + f.PlanRc + ")");
      bool onBalanced = f.Plan == BalancedPlan;
      IDictionary plan = Json.Obj("guid", f.Plan.ToString(), "name", f.PlanName, "balanced", onBalanced);
      List<object> plans = f.Plans ?? new List<object>();

      // Settings shows the configured mode per source. Without that API (an older Windows 11) the
      // ACTUAL overlay is the same value (measured equal on AC and on DC, 2026-09-25); the effective
      // one is the last resort, since Energy saver pins it.
      string chosenGuid = null, by = null;
      if (f.Source == "battery" && f.Dc != null) { chosenGuid = f.Dc; by = "dc"; }
      else if (f.Source == "ac" && f.Ac != null) { chosenGuid = f.Ac; by = "ac"; }
      else if (f.Actual != null) { chosenGuid = f.Actual; by = "actual"; }
      else if (f.Effective != null) { chosenGuid = f.Effective; by = "effective"; }
      if (chosenGuid == null)
        return Json.Obj("ok", false, "mode", null, "available", false, "settable", false, "plan", plan, "plans", plans,
                        "source", f.Source, "ms", f.Ms,
                        "reason", "Windows would not say which power mode is chosen (error " + f.EffectiveRc +
                                  (f.ConfiguredWhy != null ? "; " + f.ConfiguredWhy : "") + ")");

      string mode = ModeOfText(chosenGuid);
      string inForce = ModeOfText(f.Effective);
      bool saver = f.Saver >= 1 || f.LegacySaver;
      string reason = null;
      if (!onBalanced)
        reason = "Power mode works only on the Balanced power plan, and this PC is on \"" +
                 (f.PlanName ?? f.Plan.ToString()) + "\". Choose the Balanced plan to use it";
      else if (saver)
        reason = SaverReason(mode, f.Source, f.SaverAt);
      return Json.Obj("ok", true, "mode", mode, "overlay", chosenGuid, "inForce", inForce, "available", onBalanced,
                      "settable", onBalanced && !saver, "by", by,
                      "configured", Json.Obj("ac", ModeOfText(f.Ac), "battery", ModeOfText(f.Dc)),
                      "plan", plan, "plans", plans, "source", f.Source, "saver", saver, "saverLevel", f.Saver,
                      "saverAt", f.SaverAt, "ms", f.Ms, "reason", reason);
    }

    /// THE PURE HALF of a set: did the write land? Judged on the value that was WRITTEN (the
    /// configured mode for that source), never on the mode in force, which Energy saver can pin.
    /// wroteFor: "battery" / "ac" (a per-source write), or null (the overlay call: the current source).
    public static bool Verify(string want, string wroteFor, uint rc, IDictionary after, out string why) {
      why = null;
      if (rc != 0) { why = "Windows refused the power mode change (error " + rc + ")"; return false; }
      if (after == null || !(after["ok"] is bool) || !(bool)after["ok"]) {
        why = "Windows accepted the change but the power mode could not be read back" +
              (after != null && after["reason"] != null ? " (" + after["reason"] + ")" : "");
        return false;
      }
      var cfg = after["configured"] as IDictionary;
      string got = wroteFor == "battery" && cfg != null ? cfg["battery"] as string
                 : wroteFor == "ac" && cfg != null ? cfg["ac"] as string
                 : after["mode"] as string;
      if (got == want) return true;
      why = "Windows accepted the change but still reports " + FullName(got) + " for " +
            SourceWords(wroteFor ?? after["source"] as string);
      return false;
    }

    /// Read everything from Windows. Only the plan read is fatal; every other gap is carried in
    /// Facts and Decide says what it could not read.
    public static Facts ReadFacts() {
      var sw = Stopwatch.StartNew();
      var f = new Facts();
      Guid plan; uint prc;
      if (!ActivePlan(out plan, out prc)) { f.PlanOk = false; f.PlanRc = prc; f.Ms = sw.ElapsedMilliseconds; return f; }
      f.Plan = plan;
      f.PlanName = PlanName(plan);
      f.Plans = Plans(plan);

      Native.SYSTEM_POWER_STATUS ps;
      if (Native.GetSystemPowerStatus(out ps)) {
        f.Source = ps.ACLineStatus == 1 ? "ac" : ps.ACLineStatus == 0 ? "battery" : "unknown";
        f.LegacySaver = (ps.SystemStatusFlag & 1) != 0;
      }
      try {
        Guid g;
        if (Native.PowerGetUserConfiguredACPowerMode(out g) == 0) f.Ac = g.ToString();
        if (Native.PowerGetUserConfiguredDCPowerMode(out g) == 0) f.Dc = g.ToString();
        if (f.Ac == null || f.Dc == null) f.ConfiguredWhy = "Windows would not say which power mode is chosen per power source";
      } catch (EntryPointNotFoundException) {
        f.ConfiguredWhy = "this Windows has no per-source power mode call";
      }
      Guid o;
      if (Native.PowerGetActualOverlayScheme(out o) == 0) f.Actual = o.ToString();
      uint erc = Native.PowerGetEffectiveOverlayScheme(out o);
      if (erc == 0) f.Effective = o.ToString(); else f.EffectiveRc = erc;
      f.Saver = SaverStatus();
      if (f.Saver >= 1 || f.LegacySaver) {
        uint at;
        Guid sub = EnergySaverSubgroup, set = EnergySaverAtSetting;
        if (Native.PowerReadDCValueIndex(IntPtr.Zero, ref plan, ref sub, ref set, out at) == 0) f.SaverAt = (int)at;
      }
      f.Ms = sw.ElapsedMilliseconds;
      return f;
    }

    /// The whole picture the panel draws: mode, plan, power source, and - when a mode cannot be
    /// chosen - why, in words the panel shows as they are.
    public static IDictionary Read() { return Decide(ReadFacts()); }

    static string Get(Dictionary<string, object> req, ref object result) {
      result = Read();
      return null;
    }

    static string Opt(Dictionary<string, object> req, string key) {
      string s = Json.GetString(req, key);
      return string.IsNullOrEmpty(s) ? null : s;
    }

    /// PURE (no Windows call, allowed in --passive): Decide over readings given in the request,
    /// and, with `want`, Verify a set against that state. The rows in sidecar/test-osd.js.
    static string DecideCmd(Dictionary<string, object> req, ref object result) {
      var f = new Facts();
      f.PlanOk = Json.GetBool(req, "planOk", true);
      f.PlanRc = (uint)Math.Max(0, Json.GetInt(req, "planRc", 0));
      string pg = Opt(req, "plan");
      try { if (pg != null) f.Plan = new Guid(pg); } catch (Exception) { return "powermode.decide: plan is not a GUID"; }
      f.PlanName = Opt(req, "planName") ?? (f.Plan == BalancedPlan ? "Balanced" : null);
      f.Source = Opt(req, "source") ?? "unknown";
      f.Ac = Opt(req, "ac"); f.Dc = Opt(req, "dc"); f.Actual = Opt(req, "actual"); f.Effective = Opt(req, "effective");
      f.EffectiveRc = (uint)Math.Max(0, Json.GetInt(req, "effectiveRc", 0));
      f.ConfiguredWhy = Opt(req, "configuredWhy");
      f.Saver = Json.GetInt(req, "saver", -1);
      f.LegacySaver = Json.GetBool(req, "legacySaver", false);
      f.SaverAt = Json.GetInt(req, "saverAt", -1);
      IDictionary state = Decide(f);
      string want = Opt(req, "want");
      if (want == null) { result = state; return null; }
      string why;
      bool ok = Verify(want, Opt(req, "wroteFor"), (uint)Math.Max(0, Json.GetInt(req, "rc", 0)), state, out why);
      result = Json.Obj("ok", ok, "reason", why, "state", state);
      return null;
    }

    // ------------------------------------------------------------------ the switch

    /// {mode: "efficiency"|"balanced"|"performance", dryRun?} -> {ok, mode (asked), same, setMs, wroteFor,
    /// state (READ BACK), reason}. Writes the mode for the power source the PC is on NOW with the
    /// call Settings uses (PowerSetUserConfigured{AC,DC}PowerMode), and ok means that same value
    /// reads back as asked (Verify) - never merely that powrprof returned 0, and never judged on the
    /// mode in force, which Energy saver pins. While Energy saver is on it refuses as Settings does.
    static string Set(Dictionary<string, object> req, ref object result) {
      string want = Json.GetString(req, "mode");
      if (want != "efficiency" && want != "balanced" && want != "performance")
        return "powermode.set needs mode: \"efficiency\", \"balanced\" or \"performance\" (got " +
               (want == null ? "nothing" : "\"" + want + "\"") + ")";
      IDictionary before = Read();
      if (!(bool)before["ok"] || !(bool)before["available"] || !(bool)before["settable"]) {
        result = Json.Obj("ok", false, "mode", want, "state", before, "reason", before["reason"]);
        return null;
      }
      bool same = (string)before["mode"] == want;
      // dryRun (2026-09-29): everything a real set checks - the argument, the plan, Energy saver's
      // lock (all above) and which source's value would be written - and no write. Allowed in
      // --passive, since it changes nothing; tests prove the set path with it (sidecar/test-power.js).
      if (Json.GetBool(req, "dryRun", false)) {
        string dryBy = before["by"] as string;
        string dryFor = dryBy == "dc" ? "battery" : dryBy == "ac" ? "ac" : before["source"] as string;
        result = Json.Obj("ok", true, "dryRun", true, "mode", want, "same", same, "from", before["mode"],
                          "wroteFor", dryFor, "state", before, "reason", null,
                          "would", same ? "nothing: " + FullName(want) + " is already chosen " + SourceWords(dryFor)
                                        : "choose " + FullName(want) + " " + SourceWords(dryFor) + " (now " + FullName(before["mode"] as string) + ")");
        return null;
      }
      if (Program.Passive && !same) {
        result = Json.Obj("ok", false, "mode", want, "state", before,
                          "reason", FeatureTable.PassiveRefusal + ": it would have changed the power mode " +
                                    SourceWords(before["source"] as string) + " from " + before["mode"] + " to " + want);
        return null;
      }
      string by = before["by"] as string, wroteFor = null;
      Guid g = OverlayFor(want);
      var sw = Stopwatch.StartNew();
      uint rc;
      try {
        if (by == "dc") { wroteFor = "battery"; rc = Native.PowerSetUserConfiguredDCPowerMode(ref g); }
        else if (by == "ac") { wroteFor = "ac"; rc = Native.PowerSetUserConfiguredACPowerMode(ref g); }
        else rc = Native.PowerSetActiveOverlayScheme(g);          // no per-source call: the current source
      } catch (EntryPointNotFoundException) {
        wroteFor = null;
        rc = Native.PowerSetActiveOverlayScheme(g);
      }
      long ms = sw.ElapsedMilliseconds;
      IDictionary after = Read();
      string why;
      bool took = Verify(want, wroteFor, rc, after, out why);
      result = Json.Obj("ok", took, "mode", want, "same", same, "setMs", ms, "wroteFor", wroteFor ?? before["source"],
                        "state", after, "reason", why);
      if (took && !same) Changed("set");
      return null;
    }

    // ------------------------------------------------------------------ Energy saver
    //
    // GUID_ENERGY_SAVER_STATUS has no getter, but a listener is called with the current value as
    // soon as it registers (the probe, 2026-09-25: 1 on battery, 0 plugged in), so ONE listener
    // lives for the sidecar's lifetime and a read takes its latest value. The first read waits for
    // that first value (at most 500 ms, once). -1 = unknown (a Windows without Energy saver), and
    // Decide falls back to SystemStatusFlag.
    static readonly object _saverLock = new object();
    static IntPtr _saverHandle = IntPtr.Zero;
    static Native.DeviceNotifyCallback _saverCb;          // kept alive: powrprof holds the pointer
    static readonly ManualResetEvent _saverFirst = new ManualResetEvent(false);
    static int _saver = -1;
    static bool _saverAsked, _saverGaveUp;

    /// POWERBROADCAST_SETTING: GUID PowerSetting, DWORD DataLength, then the data.
    static int SettingValue(IntPtr setting) {
      if (setting == IntPtr.Zero) return -1;
      int len = Marshal.ReadInt32(setting, 16);
      if (len >= 4) return Marshal.ReadInt32(setting, 20);
      if (len >= 1) return Marshal.ReadByte(setting, 20);
      return -1;
    }

    internal static int SaverStatus() {         // internal: Battery.cs reads SystemStatusFlag, blind to this (2026-09-25)
      lock (_saverLock) {
        if (!_saverAsked) {
          _saverAsked = true;
          _saverCb = delegate (IntPtr ctx, uint type, IntPtr setting) {
            int v = SettingValue(setting);
            if (v >= 0) {
              int was = Interlocked.Exchange(ref _saver, v);
              _saverFirst.Set();
              if (was >= 0 && was != v) { Changed("saver"); Battery.SaverChanged(); }   // the readout's "Energy saver on" too
            }
            return 0;
          };
          try {
            var p = new Native.DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS();
            p.Callback = _saverCb;
            p.Context = IntPtr.Zero;
            Guid g = EnergySaverStatusSetting;
            IntPtr h;
            if (Native.PowerSettingRegisterNotification(ref g, DeviceNotifyCallbackFlag, ref p, out h) == 0) _saverHandle = h;
          } catch (Exception) { }
        }
      }
      if (_saverHandle != IntPtr.Zero && !_saverGaveUp && !_saverFirst.WaitOne(500)) _saverGaveUp = true;
      return Interlocked.CompareExchange(ref _saver, 0, 0);
    }

    /// {plan: guid} -> {ok, plan, same, setMs, state (READ BACK), reason}: make an installed plan the
    /// active one (PowerSetActiveScheme, what Control Panel > Power Options does). ok means the
    /// read-back names the plan asked for. In --passive only the plan already active may be "set"
    /// (a same-value write: sidecar/test-osd.js does exactly that, confirmed by powercfg).
    static string SetPlan(Dictionary<string, object> req, ref object result) {
      string raw = Json.GetString(req, "plan");
      Guid want;
      try { want = new Guid(raw ?? ""); }
      catch (Exception) {
        return "powermode.plan needs plan: the GUID of an installed power plan (got " + (raw == null ? "nothing" : "\"" + raw + "\"") + ")";
      }
      Guid active; uint rc0;
      if (!ActivePlan(out active, out rc0)) {
        result = Json.Obj("ok", false, "plan", want.ToString(), "state", Read(),
                          "reason", "Windows would not say which power plan is active (error " + rc0 + ")");
        return null;
      }
      string wantName = null;
      foreach (object o in Plans(active)) {
        var d = (IDictionary)o;
        if ((string)d["guid"] == want.ToString()) { wantName = (string)d["name"]; break; }
      }
      if (wantName == null) return "powermode.plan: no installed power plan has the GUID " + want;
      bool same = want == active;
      if (Json.GetBool(req, "dryRun", false)) {     // validated above (a GUID, an installed plan); no switch
        string fromName = PlanName(active) ?? active.ToString();
        result = Json.Obj("ok", true, "dryRun", true, "plan", want.ToString(), "same", same, "from", fromName, "to", wantName,
                          "state", Read(), "reason", null,
                          "would", same ? "nothing: \"" + wantName + "\" is already the active plan"
                                        : "switch the power plan from \"" + fromName + "\" to \"" + wantName + "\"");
        return null;
      }
      if (Program.Passive && !same) {
        result = Json.Obj("ok", false, "plan", want.ToString(), "same", false, "state", Read(),
                          "reason", FeatureTable.PassiveRefusal + ": it would have switched the power plan from \"" +
                                    (PlanName(active) ?? active.ToString()) + "\" to \"" + wantName + "\"");
        return null;
      }
      var sw = Stopwatch.StartNew();
      uint rc = Native.PowerSetActiveScheme(IntPtr.Zero, ref want);
      long ms = sw.ElapsedMilliseconds;
      Guid after; uint rc1;
      bool read = ActivePlan(out after, out rc1);
      bool took = rc == 0 && read && after == want;
      string why = null;
      if (rc != 0) why = "Windows refused to switch to \"" + wantName + "\" (error " + rc + ")";
      else if (!read) why = "Windows accepted the switch but would not say which plan is active now (error " + rc1 + ")";
      else if (!took) why = "Windows accepted the switch but still reports \"" + (PlanName(after) ?? after.ToString()) + "\"";
      result = Json.Obj("ok", took, "plan", want.ToString(), "same", same, "setMs", ms, "state", Read(), "reason", why);
      if (took && !same) Changed("plan");
      return null;
    }

    // ------------------------------------------------------------------ live updates

    static readonly object _lock = new object();
    static IntPtr _modeHandle = IntPtr.Zero, _planHandle = IntPtr.Zero, _sourceHandle = IntPtr.Zero;
    static Native.EffectiveModeCallback _modeCb;      // kept alive: powrprof holds the pointer
    static Native.DeviceNotifyCallback _planCb, _sourceCb;
    static IntPtr _regKey = IntPtr.Zero;
    static AutoResetEvent _regEvent;
    static RegisteredWaitHandle _regWait;
    static volatile bool _watching;                    // pushes only while the feature watches
    static string _lastSig;
    static int _pushes, _callbacks, _pending;

    static string Sig(IDictionary s) {
      var plan = s["plan"] as IDictionary;
      var cfg = s["configured"] as IDictionary;
      return s["ok"] + "|" + s["mode"] + "|" + s["inForce"] + "|" + s["available"] + "|" + s["settable"] + "|" +
             s["source"] + "|" + s["saver"] + "|" + (cfg != null ? cfg["ac"] + "/" + cfg["battery"] : null) + "|" +
             (plan != null ? plan["guid"] : null) + "|" + s["reason"];
    }

    static void Changed(string via) {
      Interlocked.Increment(ref _callbacks);
      if (!_watching) return;
      // A burst of callbacks (a plan switch fires several) becomes one read on the pool.
      if (Interlocked.Exchange(ref _pending, 1) == 1) return;
      ThreadPool.QueueUserWorkItem(delegate (object o) {
        Thread.Sleep(30);
        Interlocked.Exchange(ref _pending, 0);
        IDictionary s;
        try { s = Read(); } catch (Exception ex) {
          s = Json.Obj("ok", false, "mode", null, "available", false, "settable", false,
                       "reason", "the power mode could not be read (" + ex.Message + ")");
        }
        string sig = Sig(s);
        // A watch turned off while this read ran: no push after the feature stopped (2026-09-29).
        lock (_lock) { if (!_watching || sig == _lastSig) return; _lastSig = sig; }
        Interlocked.Increment(ref _pushes);
        var ev = Json.Obj("via", (object)via);
        foreach (DictionaryEntry kv in s) ev[kv.Key] = kv.Value;
        Features.Event("powermode", ev);
      });
    }

    /// A power-setting listener (plan, power source): null = listening, else why not.
    static string Listen(Guid setting, Native.DeviceNotifyCallback cb, string what, ref IntPtr handle) {
      try {
        var p = new Native.DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS();
        p.Callback = cb;
        p.Context = IntPtr.Zero;
        IntPtr h;
        uint rc = Native.PowerSettingRegisterNotification(ref setting, DeviceNotifyCallbackFlag, ref p, out h);
        if (rc == 0) { handle = h; return null; }
        return "Windows refused the " + what + " listener (error " + rc + ")";
      } catch (Exception ex) { return "the " + what + " listener is not available (" + ex.GetType().Name + ")"; }
    }

    /// The PowerSchemes key: a choice made in Settings that leaves the mode in force alone (the other
    /// source's dropdown, or anything while Energy saver pins efficiency) is seen here. Re-armed
    /// before each push; THREAD_AGNOSTIC because the re-arm runs on pool threads. Caller holds _lock.
    static string WatchRegistry() {
      IntPtr k;
      int rc = Native.RegOpenKeyEx(HKLM, SchemesKey, 0, KeyNotify | KeyQueryValue, out k);
      if (rc != 0) return "Windows would not let Mantle watch the power mode settings (error " + rc + ")";
      var ev = new AutoResetEvent(false);
      rc = Native.RegNotifyChangeKeyValue(k, false, RegNotifyLastSet | RegNotifyThreadAgnostic, ev.SafeWaitHandle.DangerousGetHandle(), true);
      if (rc != 0) { Native.RegCloseKey(k); ev.Close(); return "Windows refused the power mode settings listener (error " + rc + ")"; }
      _regKey = k;
      _regEvent = ev;
      _regWait = ThreadPool.RegisterWaitForSingleObject(ev, delegate (object st, bool timedOut) {
        lock (_lock) {
          if (_regKey == IntPtr.Zero) return;
          Native.RegNotifyChangeKeyValue(_regKey, false, RegNotifyLastSet | RegNotifyThreadAgnostic,
                                         _regEvent.SafeWaitHandle.DangerousGetHandle(), true);
        }
        Changed("settings");
      }, null, -1, false);
      return null;
    }

    static void UnwatchRegistry() {
      if (_regWait != null) { try { _regWait.Unregister(null); } catch (Exception) { } _regWait = null; }
      if (_regKey != IntPtr.Zero) { try { Native.RegCloseKey(_regKey); } catch (Exception) { } _regKey = IntPtr.Zero; }
      if (_regEvent != null) { try { _regEvent.Close(); } catch (Exception) { } _regEvent = null; }
    }

    /// {on} -> start or stop the listeners. Idempotent; the reply says what is listening and, if a
    /// listener could not start, why (the panel then re-reads while it is open instead).
    static string Watch(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      string modeWhy = null, planWhy = null, sourceWhy = null, regWhy = null;
      lock (_lock) {
        if (!on) {
          _watching = false;
          if (_modeHandle != IntPtr.Zero) { try { Native.PowerUnregisterFromEffectivePowerModeNotifications(_modeHandle); } catch (Exception) { } }
          if (_planHandle != IntPtr.Zero) { try { Native.PowerSettingUnregisterNotification(_planHandle); } catch (Exception) { } }
          if (_sourceHandle != IntPtr.Zero) { try { Native.PowerSettingUnregisterNotification(_sourceHandle); } catch (Exception) { } }
          _modeHandle = _planHandle = _sourceHandle = IntPtr.Zero;
          UnwatchRegistry();
          _lastSig = null;
          result = Json.Obj("ok", true, "watching", false, "pushes", _pushes, "callbacks", _callbacks, "reason", null);
          return null;
        }
        if (_modeHandle == IntPtr.Zero) {
          if (_modeCb == null) _modeCb = delegate (int mode, IntPtr ctx) { Changed("mode"); };
          try {
            IntPtr h;
            int hr = Native.PowerRegisterForEffectivePowerModeNotifications(EffectivePowerModeV2, _modeCb, IntPtr.Zero, out h);
            if (hr == 0) _modeHandle = h;
            else modeWhy = "Windows refused the power-mode listener (HRESULT 0x" + hr.ToString("X8") + ")";
          } catch (Exception ex) { modeWhy = "the power-mode listener is not available (" + ex.GetType().Name + ")"; }
        }
        if (_planHandle == IntPtr.Zero) {
          if (_planCb == null) _planCb = delegate (IntPtr ctx, uint type, IntPtr setting) { Changed("plan"); return 0; };
          planWhy = Listen(ActivePowerSchemeSetting, _planCb, "power-plan", ref _planHandle);
        }
        if (_sourceHandle == IntPtr.Zero) {
          if (_sourceCb == null) _sourceCb = delegate (IntPtr ctx, uint type, IntPtr setting) { Changed("source"); return 0; };
          sourceWhy = Listen(AcDcSourceSetting, _sourceCb, "power-source", ref _sourceHandle);
        }
        if (_regKey == IntPtr.Zero) regWhy = WatchRegistry();
      }
      IDictionary now = Read();
      lock (_lock) { _lastSig = Sig(now); _watching = true; }
      bool all = _modeHandle != IntPtr.Zero && _planHandle != IntPtr.Zero && _sourceHandle != IntPtr.Zero && _regKey != IntPtr.Zero;
      result = Json.Obj("ok", true, "watching", all, "mode", _modeHandle != IntPtr.Zero, "plan", _planHandle != IntPtr.Zero,
                        "source", _sourceHandle != IntPtr.Zero, "settings", _regKey != IntPtr.Zero,
                        "saver", _saverHandle != IntPtr.Zero && Interlocked.CompareExchange(ref _saver, 0, 0) >= 0,
                        "state", now, "reason", all ? null : (modeWhy ?? planWhy ?? sourceWhy ?? regWhy));
      return null;
    }
  }
}
