// SysPower.cs - Mantle Settings > System > Power & battery, natively (lane sysset, 2026-09-28).
//
// WHY: the user wants Mantle Settings to do everything Windows' Settings does without handing off. The
// Power & battery page's rows are all POWER SETTINGS of the active plan (powrprof's documented
// PowerRead/WriteACValueIndex, the same calls `powercfg /change` makes), so every one of them can be
// read and changed here, and each dropdown's choices come from Windows itself
// (PowerReadPossibleFriendlyName), in Windows' own words and language.
//
//   syspower.get {}                                  every row below, with AC and DC values, limits,
//                                                    choices, writability and the reason when not
//   syspower.set {setting, source:'ac'|'dc'|'both', value, dryRun?}   one setting on the ACTIVE plan,
//                                                    re-applied (PowerSetActiveScheme) and read back
//   syspower.hibernateSet {on, dryRun?}              hibernation on/off   (needs administrator)
//   syspower.fastStartupSet {on, dryRun?}            fast start-up on/off (needs administrator)
//
// The settings (subgroup / setting GUIDs are Windows' public ones, winnt.h and `powercfg /qh`):
//   screenOff   SUB_VIDEO   VIDEOIDLE        seconds, 0 = never   "Turn my screen off after"
//   sleep       SUB_SLEEP   STANDBYIDLE      seconds, 0 = never   "Make my device sleep after"
//   hibernate   SUB_SLEEP   HIBERNATEIDLE    seconds, 0 = never   "Make my device hibernate after" (24H2)
//   lid         SUB_BUTTONS LIDACTION        choice               "Closing the lid will make my PC"
//   powerButton SUB_BUTTONS PBUTTONACTION    choice               "Pressing the power button ..."
//   sleepButton SUB_BUTTONS SBUTTONACTION    choice               "Pressing the sleep button ..."
//   saverAt     SUB_ENERGYSAVER ESBATTTHRESHOLD  percent, 0 = never, 100 = always   (Energy saver)
//   saverBrightness SUB_ENERGYSAVER ESBRIGHTNESS percent: 100 = do not dim ("Lower screen brightness")
//   saverPolicy SUB_ENERGYSAVER ESPOLICY     choice User / Aggressive
// MEASURED here 2026-09-28 (powercfg /qh): screen off 300 s AC / 180 s DC, sleep the same, hibernate
// AC 0 and DC 0x7fffffff (outside the 0..max range Windows reports, so it is shown as a custom value,
// never "fixed" behind the user's back), lid / power / sleep button all Sleep, energy saver at 30% on
// battery, ESPOLICY AC User / DC Aggressive.
//
// ENERGY SAVER ON/OFF: Windows has no public switch (powrprof exports only the power-mode overlay
// calls; checked again 2026-09-28 by scanning its export names). Mantle already switches it the one
// supported way, through its turn-on level (GameMode.cs gamemode.saver): 100% = always on while on
// battery, 0 = never. The page offers exactly that ("Always use energy saver" = 100 on AC and DC),
// through syspower.set saverAt, and PowerMode.cs's lock keeps the power-mode switch honest meanwhile.
//
// HIBERNATE and FAST START-UP are machine-wide: turning hibernation on or off (re)creates or deletes
// hiberfil.sys (NtPowerInformation SystemReserveHiberFile, what `powercfg /hibernate` calls) and needs
// SeCreatePagefilePrivilege; fast start-up is HKLM ...\Session Manager\Power HiberbootEnabled. Both
// are [Elevated] actions (system.hibernate, system.fastStartup; class SysPowerAdmin below): the
// non-elevated commands answer dryRun, and otherwise {needsAdmin, elevate:<action>} for the page.
//
// PASSIVE: syspower.get and every dryRun answer; a real write answers FeatureTable.PassiveRefusal.
// PRIVACY: nothing here is personal; nothing logs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class SysPower {
    static class N {
      [DllImport("powrprof.dll")] public static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
      [DllImport("powrprof.dll")] public static extern uint PowerSetActiveScheme(IntPtr root, ref Guid scheme);
      [DllImport("powrprof.dll")] public static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerReadDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, out uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerWriteACValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerWriteDCValueIndex(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerReadFriendlyName(IntPtr root, ref Guid scheme, IntPtr sub, IntPtr setting, byte[] buffer, ref uint size);
      [DllImport("powrprof.dll")] public static extern uint PowerReadPossibleValue(IntPtr root, ref Guid sub, ref Guid setting, out uint type, uint index, byte[] buffer, ref uint size);
      [DllImport("powrprof.dll")] public static extern uint PowerReadPossibleFriendlyName(IntPtr root, ref Guid sub, ref Guid setting, uint index, byte[] buffer, ref uint size);
      [DllImport("powrprof.dll")] public static extern uint PowerReadValueMin(IntPtr root, ref Guid sub, ref Guid setting, out uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerReadValueMax(IntPtr root, ref Guid sub, ref Guid setting, out uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerReadValueIncrement(IntPtr root, ref Guid sub, ref Guid setting, out uint value);
      [DllImport("powrprof.dll")] public static extern uint PowerReadValueUnitsSpecifier(IntPtr root, ref Guid sub, ref Guid setting, byte[] buffer, ref uint size);
      [DllImport("powrprof.dll")] public static extern uint PowerSettingAccessCheck(int accessFlags, ref Guid setting);
      [DllImport("powrprof.dll")] [return: MarshalAs(UnmanagedType.U1)] public static extern bool GetPwrCapabilities([Out] byte[] caps);
      [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
    }

    static readonly Guid SubVideo = new Guid("7516b95f-f776-4464-8c53-06167f40cc99");
    static readonly Guid SubSleep = new Guid("238c9fa8-0aad-41ed-83f4-97be242c8f20");
    static readonly Guid SubButtons = new Guid("4f971e89-eebd-4455-a8de-9e59040e7347");
    static readonly Guid SubSaver = new Guid("de830923-a562-41af-a086-e3a2c6bad2da");

    sealed class Setting {
      public string Key, Kind, Needs;   // Kind: seconds | choice | percent; Needs: lid | powerButton | sleepButton | battery | null
      public Guid Sub, Guid;
      public Setting(string key, Guid sub, string guid, string kind, string needs) {
        Key = key; Sub = sub; Guid = new Guid(guid); Kind = kind; Needs = needs;
      }
    }

    static readonly Setting[] Settings = {
      new Setting("screenOff", SubVideo, "3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e", "seconds", null),
      new Setting("sleep", SubSleep, "29f6c1db-86da-48c5-9fdb-f2b67b1f44da", "seconds", null),
      new Setting("hibernate", SubSleep, "9d7815a6-7ee4-497e-8888-515a05f02364", "seconds", "hibernation"),
      new Setting("lid", SubButtons, "5ca83367-6e45-459f-a27b-476b1d01c936", "choice", "lid"),
      new Setting("powerButton", SubButtons, "7648efa3-dd9c-4e3e-b566-50f929386280", "choice", "powerButton"),
      new Setting("sleepButton", SubButtons, "96996bc0-ad50-47ec-923b-6f41874dd9eb", "choice", "sleepButton"),
      new Setting("saverAt", SubSaver, "e69653ca-cf7f-4f05-aa73-cb833fa90ad4", "percent", null),
      new Setting("saverBrightness", SubSaver, "13d09884-f74e-474a-a852-b6bde8ad03a8", "percent", null),
      new Setting("saverPolicy", SubSaver, "5c5bb349-ad29-4ee2-9d0b-2b25270f7a81", "choice", null),
    };

    const string PowerKey = @"SYSTEM\CurrentControlSet\Control\Power";
    const string SessionPowerKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Power";

    public static void Register(FeatureTable t) {
      t.Add("syspower.get", Lanes.Slow, Get);
      t.Add("syspower.set", Lanes.Slow, Set);
      t.Add("syspower.hibernateSet", Lanes.Slow, HibernateSet);
      t.Add("syspower.fastStartupSet", Lanes.Slow, FastStartupSet);
    }

    // ------------------------------------------------------------------ reads

    static bool ActivePlan(out Guid plan) {
      plan = Guid.Empty;
      IntPtr p;
      if (N.PowerGetActiveScheme(IntPtr.Zero, out p) != 0 || p == IntPtr.Zero) return false;
      try { plan = (Guid)Marshal.PtrToStructure(p, typeof(Guid)); } finally { N.LocalFree(p); }
      return true;
    }

    static string PlanName(Guid plan) {
      uint size = 0;
      if (N.PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, null, ref size) != 0 || size == 0) return null;
      byte[] buf = new byte[size];
      if (N.PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, buf, ref size) != 0) return null;
      return Utf16(buf);
    }

    static string Utf16(byte[] buf) {
      string s = Encoding.Unicode.GetString(buf);
      int z = s.IndexOf('\0');
      return z >= 0 ? s.Substring(0, z) : s;
    }

    /// GetPwrCapabilities' first bytes (SYSTEM_POWER_CAPABILITIES, all BOOLEANs): 0 power button,
    /// 1 sleep button, 2 lid, 6 S4 (hibernate usable), 8 hiberfile present, 18 Hiberboot (fast
    /// start-up possible), 20 AoAc (modern standby), 30 system batteries present.
    public sealed class Caps {
      public bool Read, PowerButton, SleepButton, Lid, S4, HiberFile, Hiberboot, AoAc, Batteries;
    }

    public static Caps ReadCaps() {
      var c = new Caps();
      byte[] b = new byte[256];
      try { c.Read = N.GetPwrCapabilities(b); } catch (Exception) { c.Read = false; }
      if (!c.Read) return c;
      c.PowerButton = b[0] != 0; c.SleepButton = b[1] != 0; c.Lid = b[2] != 0; c.S4 = b[6] != 0;
      c.HiberFile = b[8] != 0; c.Hiberboot = b[18] != 0; c.AoAc = b[20] != 0; c.Batteries = b[30] != 0;
      return c;
    }

    static List<object> Choices(Setting s) {
      var list = new List<object>();
      Guid sub = s.Sub, g = s.Guid;
      for (uint i = 0; i < 32; i++) {
        uint type, size = 0;
        if (N.PowerReadPossibleValue(IntPtr.Zero, ref sub, ref g, out type, i, null, ref size) != 0 || size == 0) break;
        byte[] vb = new byte[size];
        if (N.PowerReadPossibleValue(IntPtr.Zero, ref sub, ref g, out type, i, vb, ref size) != 0) break;
        long value = size >= 4 ? (long)BitConverter.ToUInt32(vb, 0) : (long)vb[0];
        uint ns = 0;
        string label = null;
        if (N.PowerReadPossibleFriendlyName(IntPtr.Zero, ref sub, ref g, i, null, ref ns) == 0 && ns > 0) {
          byte[] nb = new byte[ns];
          if (N.PowerReadPossibleFriendlyName(IntPtr.Zero, ref sub, ref g, i, nb, ref ns) == 0) label = Utf16(nb);
        }
        list.Add(Json.Obj("value", value, "label", label ?? ("Choice " + value)));
      }
      return list;
    }

    static IDictionary Range(Setting s) {
      Guid sub = s.Sub, g = s.Guid;
      uint min, max, inc;
      bool okMin = N.PowerReadValueMin(IntPtr.Zero, ref sub, ref g, out min) == 0;
      bool okMax = N.PowerReadValueMax(IntPtr.Zero, ref sub, ref g, out max) == 0;
      bool okInc = N.PowerReadValueIncrement(IntPtr.Zero, ref sub, ref g, out inc) == 0;
      uint us = 0;
      string units = null;
      if (N.PowerReadValueUnitsSpecifier(IntPtr.Zero, ref sub, ref g, null, ref us) == 0 && us > 0) {
        byte[] ub = new byte[us];
        if (N.PowerReadValueUnitsSpecifier(IntPtr.Zero, ref sub, ref g, ub, ref us) == 0) units = Utf16(ub);
      }
      return Json.Obj("min", okMin ? (object)(long)min : null, "max", okMax ? (object)(long)max : null,
                      "step", okInc ? (object)(long)(inc == 0 ? 1 : inc) : null, "units", units);
    }

    /// Why a setting cannot be changed on this PC right now, or null.
    static string Missing(Setting s, Caps c) {
      if (!c.Read) return null;
      switch (s.Needs) {
        case "lid": return c.Lid ? null : "this PC has no lid";
        case "powerButton": return c.PowerButton ? null : "Windows reports no power button on this PC";
        case "sleepButton": return c.SleepButton ? null : "this PC has no sleep button";
        case "hibernation": return c.S4 ? null : "hibernation is turned off on this PC (turn it on below first)";
      }
      return null;
    }

    static string Policy(Setting s, bool ac) {
      Guid g = s.Guid;
      uint rc = N.PowerSettingAccessCheck(ac ? 0 : 1, ref g);
      if (rc == 0) return null;
      if (rc == 5) return "a policy set on this PC fixes this setting (access check: denied)";
      return "Windows' access check failed (error " + rc + ")";
    }

    static IDictionary Side(Guid plan, Setting s, bool ac, string missing) {
      Guid sub = s.Sub, g = s.Guid;
      uint v;
      uint rc = ac ? N.PowerReadACValueIndex(IntPtr.Zero, ref plan, ref sub, ref g, out v)
                   : N.PowerReadDCValueIndex(IntPtr.Zero, ref plan, ref sub, ref g, out v);
      string why = rc != 0 ? "could not be read (error " + rc + ")" : missing ?? Policy(s, ac);
      return Json.Obj("value", rc == 0 ? (object)(long)v : null, "writable", why == null, "why", why);
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      try {
        Guid plan;
        if (!ActivePlan(out plan)) {
          result = Json.Obj("ok", false, "reason", "Windows would not say which power plan is active");
          return null;
        }
        Caps c = ReadCaps();
        var rows = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (Setting s in Settings) {
          string missing = Missing(s, c);
          IDictionary row = Json.Obj("key", s.Key, "kind", s.Kind,
                                     "ac", Side(plan, s, true, missing), "dc", Side(plan, s, false, missing),
                                     "applies", missing == null, "why", missing);
          if (s.Kind == "choice") row["choices"] = Choices(s);
          else row["range"] = Range(s);
          rows[s.Key] = row;
        }
        string hwhy;
        long? hib = SysCommon.ReadNumber("HKLM", PowerKey, "HibernateEnabled", out hwhy);
        long? fast = SysCommon.ReadNumber("HKLM", SessionPowerKey, "HiberbootEnabled", out hwhy);
        bool admin = SysCommon.Elevated();
        result = Json.Obj(
          "ok", true,
          "plan", Json.Obj("guid", plan.ToString(), "name", PlanName(plan)),
          "caps", Json.Obj("read", c.Read, "lid", c.Lid, "powerButton", c.PowerButton, "sleepButton", c.SleepButton,
                           "hibernate", c.S4, "hiberFile", c.HiberFile, "fastStartup", c.Hiberboot,
                           "modernStandby", c.AoAc, "battery", c.Batteries),
          "settings", rows,
          "hibernation", Json.Obj("on", c.Read ? (object)c.S4 : (hib.HasValue ? (object)(hib.Value != 0) : null),
                                  "registry", hib.HasValue ? (object)hib.Value : null,
                                  "writable", admin, "needsAdmin", !admin,
                                  "why", admin ? null : "Windows will ask for administrator permission to turn hibernation on or off"),
          "fastStartup", Json.Obj("on", fast.HasValue ? (object)(fast.Value != 0) : null,
                                  "available", c.Hiberboot || c.S4,
                                  "writable", admin, "needsAdmin", !admin,
                                  "why", !c.S4 ? "fast start-up needs hibernation turned on" :
                                         admin ? null : "Windows will ask for administrator permission to change fast start-up"));
        return null;
      } catch (Exception ex) {
        return "syspower.get failed: " + SysCommon.Why(ex);
      }
    }

    // ------------------------------------------------------------------ writes

    static Setting Find(string key) {
      foreach (Setting s in Settings) if (s.Key == key) return s;
      return null;
    }

    static string Keys() {
      var sb = new StringBuilder();
      foreach (Setting s in Settings) { if (sb.Length > 0) sb.Append(", "); sb.Append(s.Key); }
      return sb.ToString();
    }

    /// PURE: is `value` allowed for a setting with these limits / choices? null = yes.
    public static string Check(string kind, long value, long? min, long? max, IList choiceValues) {
      if (kind == "choice") {
        foreach (object o in choiceValues) if (Convert.ToInt64(o) == value) return null;
        return "that is not one of the choices Windows offers for this setting";
      }
      if (value < 0) return "the value cannot be negative";
      if (min.HasValue && value < min.Value) return "the lowest value Windows allows is " + min.Value;
      if (max.HasValue && value > max.Value) return "the highest value Windows allows is " + max.Value;
      if (kind == "percent" && value > 100) return "a percentage goes up to 100";
      return null;
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      try {
        string key = Json.GetString(req, "setting");
        Setting s = Find(key ?? "");
        if (s == null) return "syspower.set needs setting: one of " + Keys();
        string source = Json.GetString(req, "source") ?? "both";
        if (source != "ac" && source != "dc" && source != "both") return "syspower.set needs source: 'ac', 'dc' or 'both'";
        long value;
        string aerr = SysCommon.Number(req, "value", "syspower.set", 0, uint.MaxValue, out value);
        if (aerr != null) return aerr;
        bool dry = Json.GetBool(req, "dryRun", false);

        Guid plan;
        if (!ActivePlan(out plan)) return "Windows would not say which power plan is active; nothing was changed";
        Caps c = ReadCaps();
        string refuse = Missing(s, c);
        if (refuse == null) {
          var cv = new List<object>();
          long? min = null, max = null;
          if (s.Kind == "choice") foreach (IDictionary ch in Choices(s)) cv.Add(ch["value"]);
          else {
            IDictionary r = Range(s);
            if (r["min"] != null) min = (long)r["min"];
            if (r["max"] != null) max = (long)r["max"];
          }
          refuse = Check(s.Kind, value, min, max, cv);
        }
        bool doAc = source != "dc", doDc = source != "ac";
        if (refuse == null && doAc) refuse = Policy(s, true);
        if (refuse == null && doDc) refuse = Policy(s, false);

        IDictionary before = Json.Obj("ac", Side(plan, s, true, null)["value"], "dc", Side(plan, s, false, null)["value"]);
        var writes = new List<object>();
        if (doAc) writes.Add(Json.Obj("api", "PowerWriteACValueIndex", "scheme", plan.ToString(), "subgroup", s.Sub.ToString(), "setting", s.Guid.ToString(), "value", value));
        if (doDc) writes.Add(Json.Obj("api", "PowerWriteDCValueIndex", "scheme", plan.ToString(), "subgroup", s.Sub.ToString(), "setting", s.Guid.ToString(), "value", value));
        writes.Add(Json.Obj("api", "PowerSetActiveScheme", "scheme", plan.ToString()));
        if (dry) { result = SysCommon.Dry(writes, before, refuse, false); return null; }
        if (refuse != null) return refuse + "; nothing was changed";
        if (Program.Passive) return SysCommon.Passive("set " + s.Key + " to " + value + " (" + source + ")");

        Guid sub = s.Sub, g = s.Guid;
        uint rc = 0;
        if (doAc) rc = N.PowerWriteACValueIndex(IntPtr.Zero, ref plan, ref sub, ref g, (uint)value);
        if (rc == 0 && doDc) rc = N.PowerWriteDCValueIndex(IntPtr.Zero, ref plan, ref sub, ref g, (uint)value);
        if (rc != 0) return "Windows refused the change (error " + rc + ")";
        uint arc = N.PowerSetActiveScheme(IntPtr.Zero, ref plan);   // makes the new value take effect now
        object ac = Side(plan, s, true, null)["value"], dc = Side(plan, s, false, null)["value"];
        if ((doAc && (ac == null || (long)ac != value)) || (doDc && (dc == null || (long)dc != value)))
          return "the change was written but reads back as " + ac + " / " + dc + " (plugged in / on battery)";
        result = Json.Obj("ok", true, "setting", s.Key, "ac", ac, "dc", dc, "before", before,
                          "applied", arc == 0, "why", arc == 0 ? null : "saved, but Windows did not re-apply the plan (error " + arc + "); it takes effect at the next plan change");
        return null;
      } catch (Exception ex) {
        return "syspower.set failed: " + SysCommon.Why(ex);
      }
    }

    static string HibernateSet(Dictionary<string, object> req, ref object result) {
      bool on;
      string aerr = SysCommon.Bool(req, "on", "syspower.hibernateSet", out on);
      if (aerr != null) return aerr;
      Caps c = ReadCaps();
      var writes = SysCommon.List(Json.Obj("api", "CallNtPowerInformation", "level", "SystemReserveHiberFile (10)", "value", on,
                                           "same", "powercfg.exe /hibernate " + (on ? "on" : "off")));
      object before = c.Read ? (object)c.S4 : null;
      if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, before, null, !SysCommon.Elevated()); return null; }
      if (Program.Passive) return SysCommon.Passive("turned hibernation " + (on ? "on" : "off"));
      result = SysCommon.NeedsAdmin("system.hibernate", SysPowerAdmin.HibernateDoes, writes);
      return null;
    }

    static string FastStartupSet(Dictionary<string, object> req, ref object result) {
      bool on;
      string aerr = SysCommon.Bool(req, "on", "syspower.fastStartupSet", out on);
      if (aerr != null) return aerr;
      string why;
      long? now = SysCommon.ReadNumber("HKLM", SessionPowerKey, "HiberbootEnabled", out why);
      var writes = SysCommon.List(SysCommon.RegWrite("HKLM", SessionPowerKey, "HiberbootEnabled", on ? 1 : 0, false, now));
      if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, now, null, !SysCommon.Elevated()); return null; }
      if (Program.Passive) return SysCommon.Passive("turned fast start-up " + (on ? "on" : "off"));
      result = SysCommon.NeedsAdmin("system.fastStartup", SysPowerAdmin.FastDoes, writes);
      return null;
    }
  }

  /// The administrator half of Power & battery. Runs ONLY in the elevated copy of the sidecar that
  /// the broker starts after the user says yes (sidecar/ELEVATE.md): no shell, no command line, the
  /// documented APIs directly, and each validator is the whole trust boundary.
  static class SysPowerAdmin {
    public const string HibernateDoes = "turn hibernation on or off";
    public const string FastDoes = "turn fast start-up on or off";

    [DllImport("powrprof.dll")]
    static extern uint CallNtPowerInformation(int level, ref byte input, int inLen, IntPtr output, int outLen);

    /// NtPowerInformation(SystemReserveHiberFile = 10, BOOLEAN) is what `powercfg /hibernate on|off`
    /// does: it creates or deletes hiberfil.sys, and the kernel keeps HibernateEnabled in step. It
    /// needs SeCreatePagefilePrivilege ENABLED, which an elevated token holds but leaves disabled.
    [Elevated("system.hibernate", "CheckHibernate", HibernateDoes)]
    static string Hibernate(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      string perr = SysCommon.EnablePrivilege("SeCreatePagefilePrivilege");
      if (perr != null) return "Windows did not turn hibernation " + (on ? "on" : "off") + ": " + perr;
      byte b = (byte)(on ? 1 : 0);
      uint st = CallNtPowerInformation(10, ref b, 1, IntPtr.Zero, 0);
      if (st != 0) return "Windows did not turn hibernation " + (on ? "on" : "off") + " (status 0x" + st.ToString("X8") + ")";
      SysPower.Caps c = SysPower.ReadCaps();
      if (c.Read && c.S4 != on) return "Windows accepted the change but still reports hibernation " + (c.S4 ? "on" : "off");
      result = Json.Obj("on", on, "note", on ? "Hibernation is on; its file takes up disk space." : "Hibernation is off and its file was removed.");
      return null;
    }

    static string CheckHibernate(Dictionary<string, object> args) { return SysCommon.CheckOn(args); }

    /// HiberbootEnabled under HKLM (1 = fast start-up on), read back by WriteNumber.
    [Elevated("system.fastStartup", "CheckFast", FastDoes)]
    static string FastStartup(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      string err = SysCommon.WriteNumber("HKLM", @"SYSTEM\CurrentControlSet\Control\Session Manager\Power", "HiberbootEnabled", on ? 1 : 0, false);
      if (err != null) return "Windows did not change fast start-up: " + err;
      result = Json.Obj("on", on, "note", "Takes effect the next time you shut down.");
      return null;
    }

    static string CheckFast(Dictionary<string, object> args) { return SysCommon.CheckOn(args); }
  }
}
