// SysTime.cs - Settings > Time & language > Date & time for Mantle Settings (lane timelang,
// 2026-09-28). The page is ui/settings/sections/time.js, its main half
// lib/features/_settings-sections/time.js.
//
// WHY: the user wants Mantle Settings to replace Windows' Settings outright. Every row of Windows'
// Date & time page is here, read from where Windows keeps it and changed the way Windows changes
// it, and where only an administrator may change it the change goes through the elevation broker
// (sidecar/ELEVATE.md), one UAC prompt per change, exactly like the shield rows in Windows.
//
//   systime.get                       the clock, the zone, both "automatically" switches, the tray
//                                     clock values and the two additional clocks, each with a reason
//   systime.zones                     every time zone Windows knows (key, display name, offset, DST)
//   systime.setZone {zone, dryRun}    SetDynamicTimeZoneInformation. NOT an administrator action:
//                                     it needs SeTimeZonePrivilege, which Windows gives every
//                                     standard user (disabled until asked). dryRun checks the token
//                                     HOLDS it (a read) and never enables it.
//   systime.setDst {on, dryRun}       "Adjust for daylight saving time automatically": the same
//                                     call with DynamicDaylightTimeDisabled flipped (tzutil's _dstoff)
//   systime.setAutoSync {on, dryRun}  -> administrator action time.setAutoSync   (HKLM W32Time Type)
//   systime.setAutoZone {on, dryRun}  -> administrator action time.setAutoZone   (tzautoupdate start)
//   systime.setClock {year..second, dryRun} -> administrator action time.setClock (SetLocalTime)
//   systime.syncNow {dryRun}          -> administrator action time.syncNow       (W32TimeSyncNow)
//   systime.setExtraClock {slot, on, zone, name, dryRun}   HKCU Control Panel\TimeDate\AdditionalClocks\<slot>
//   systime.setTray {key, value, dryRun}                   HKCU ...\Explorer\Advanced (seconds in the tray clock)
//
// THE ADMINISTRATOR ROWS answer {ok:false, needsAdmin, elevate:{action, args}} to a real call (the
// main half turns that into the prompt) and a plan to a dryRun. MEASURED on the user's desktop
// (2026-09-28, reads only): the Windows Time service is trigger-started and usually stopped; its
// service ACL lets interactive users query but not start it (sc sdshow: IU = CCLCSWLOCRRC), so
// "Sync now" must be an administrator action; whoami /priv lists SeTimeZonePrivilege (Disabled).
//
// PRIVACY: nothing here logs. Zone keys and clock names only travel in replies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysTime {
    public static void Register(FeatureTable t) {
      t.Add("systime.get", Lanes.Slow, Get);
      t.Add("systime.zones", Lanes.Slow, Zones);
      t.Add("systime.setZone", Lanes.Slow, SetZone);
      t.Add("systime.setDst", Lanes.Slow, SetDst);
      t.Add("systime.setAutoSync", Lanes.Slow, SetAutoSync);
      t.Add("systime.setAutoZone", Lanes.Slow, SetAutoZone);
      t.Add("systime.setClock", Lanes.Slow, SetClock);
      t.Add("systime.syncNow", Lanes.Slow, SyncNow);
      t.Add("systime.setExtraClock", Lanes.Slow, SetExtraClock);
      t.Add("systime.setTray", Lanes.Slow, SetTray);
    }

    // ------------------------------------------------------------------ native

    [StructLayout(LayoutKind.Sequential)]
    internal struct SYSTEMTIME {
      public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Ms;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct DTZI {
      public int Bias;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string StandardName;
      public SYSTEMTIME StandardDate;
      public int StandardBias;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DaylightName;
      public SYSTEMTIME DaylightDate;
      public int DaylightBias;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string TimeZoneKeyName;
      [MarshalAs(UnmanagedType.U1)] public bool DynamicDaylightTimeDisabled;
    }

    internal static class Native {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetDynamicTimeZoneInformation(out DTZI tz);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetDynamicTimeZoneInformation(ref DTZI tz);
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetLocalTime(ref SYSTEMTIME st);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr p, int access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool LookupPrivilegeValueW(string sys, string name, out long luid);
      [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SendNotifyMessageW(IntPtr hwnd, uint msg, IntPtr wp, string lp);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SendNotifyMessageW(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenSCManagerW(string machine, string db, uint access);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenServiceW(IntPtr scm, string name, uint access);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern bool ChangeServiceConfigW(IntPtr svc, uint type, uint start, uint error, string path, string group, IntPtr tag, string deps, string user, string pwd, string display);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool StartServiceW(IntPtr svc, int n, IntPtr args);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool ControlService(IntPtr svc, uint control, out SERVICE_STATUS st);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool QueryServiceStatus(IntPtr svc, out SERVICE_STATUS st);
      [DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr h);
      // w32time.dll's own export, the one w32tm.exe /resync calls (ReactOS w32time.h names the flags).
      [DllImport("w32time.dll", CharSet = CharSet.Unicode)] public static extern uint W32TimeSyncNow(string computer, uint wait, uint flags);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SERVICE_STATUS { public uint Type, State, Accepted, Win32Exit, SpecificExit, CheckPoint, WaitHint; }

    internal const string TzRoot = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Time Zones";
    internal const string W32Params = @"SYSTEM\CurrentControlSet\Services\W32Time\Parameters";
    internal const string W32Config = @"SYSTEM\CurrentControlSet\Services\W32Time\Config";
    internal const string TzAutoKey = @"SYSTEM\CurrentControlSet\Services\tzautoupdate";
    internal const string LocationKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location";
    const string ClocksKey = @"Control Panel\TimeDate\AdditionalClocks";
    const string AdvancedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
    const string ExplorerPolicy = @"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";

    static string Iso(DateTime t) { return t.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture); }

    // ------------------------------------------------------------------ token privileges (READ)

    /// Whether this process's token HOLDS a privilege, and whether it is enabled. A read: nothing
    /// is adjusted. null = answered, else why the token could not be read.
    internal static string Privilege(string name, out bool held, out bool enabled) {
      held = false; enabled = false;
      long want;
      if (!Native.LookupPrivilegeValueW(null, name, out want)) return "Windows does not know " + name + " (error " + Marshal.GetLastWin32Error() + ")";
      IntPtr tok;
      if (!Native.OpenProcessToken(Native.GetCurrentProcess(), 0x0008 /* TOKEN_QUERY */, out tok))
        return "the process token could not be read (error " + Marshal.GetLastWin32Error() + ")";
      IntPtr buf = IntPtr.Zero;
      try {
        int len;
        Native.GetTokenInformation(tok, 3 /* TokenPrivileges */, IntPtr.Zero, 0, out len);
        if (len <= 0) return "the token's privileges could not be sized (error " + Marshal.GetLastWin32Error() + ")";
        buf = Marshal.AllocHGlobal(len);
        if (!Native.GetTokenInformation(tok, 3, buf, len, out len)) return "the token's privileges could not be read (error " + Marshal.GetLastWin32Error() + ")";
        int n = Marshal.ReadInt32(buf);
        for (int i = 0; i < n; i++) {
          long luid = Marshal.ReadInt64(buf, 4 + i * 12);
          int attr = Marshal.ReadInt32(buf, 12 + i * 12);
          if (luid == want) { held = true; enabled = (attr & 2) != 0; break; }
        }
        return null;
      } finally {
        if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        Native.CloseHandle(tok);
      }
    }

    // ------------------------------------------------------------------ zones

    internal static string CurrentZone(out DTZI tz, out uint which) {
      tz = new DTZI();
      which = Native.GetDynamicTimeZoneInformation(out tz);
      if (which == 0xFFFFFFFF) return "Windows did not answer the time zone query (error " + Marshal.GetLastWin32Error() + ")";
      return null;
    }

    /// The zone's registry facts: display name, the TZI rule, and whether it has daylight saving.
    internal static string ZoneFacts(string key, out string display, out byte[] tzi, out string std, out string dlt, out bool dst) {
      display = null; tzi = null; std = null; dlt = null; dst = false;
      if (string.IsNullOrEmpty(key) || key.Length > 127 || key.IndexOf('\\') >= 0) return "not a time zone key";
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.OpenSubKey(TzRoot + "\\" + key, false)) {
          if (k == null) return "Windows does not know a time zone called that";
          display = k.GetValue("Display") as string;
          tzi = k.GetValue("TZI") as byte[];
          std = k.GetValue("Std") as string;
          dlt = k.GetValue("Dlt") as string;
          if (tzi == null || tzi.Length != 44) return "the zone's rule (TZI) is missing or damaged in the registry";
          dst = BitConverter.ToUInt16(tzi, 12 + 16 + 2) != 0;   // DaylightDate.wMonth
          using (RegistryKey dyn = k.OpenSubKey("Dynamic DST", false)) { if (dyn != null && !dst) dst = DynamicHasDst(k, dyn); }
          return null;
        }
      } catch (Exception ex) { return "the zone could not be read: " + SysCommon.Why(ex); }
    }

    static bool DynamicHasDst(RegistryKey zone, RegistryKey dyn) {
      foreach (string name in dyn.GetValueNames()) {
        byte[] b = dyn.GetValue(name) as byte[];
        if (b != null && b.Length == 44 && BitConverter.ToUInt16(b, 30) != 0) return true;
      }
      return false;
    }

    static SYSTEMTIME St(byte[] b, int off) {
      var s = new SYSTEMTIME();
      s.Year = BitConverter.ToUInt16(b, off); s.Month = BitConverter.ToUInt16(b, off + 2);
      s.DayOfWeek = BitConverter.ToUInt16(b, off + 4); s.Day = BitConverter.ToUInt16(b, off + 6);
      s.Hour = BitConverter.ToUInt16(b, off + 8); s.Minute = BitConverter.ToUInt16(b, off + 10);
      s.Second = BitConverter.ToUInt16(b, off + 12); s.Ms = BitConverter.ToUInt16(b, off + 14);
      return s;
    }

    /// The DYNAMIC_TIME_ZONE_INFORMATION timedate.cpl / tzutil would set for `key`. dstOff =
    /// tzutil's "_dstoff": dynamic DST disabled and no transition dates (the clock stays on standard).
    internal static DTZI Build(string key, byte[] tzi, string std, string dlt, bool dstOff) {
      var z = new DTZI();
      z.Bias = BitConverter.ToInt32(tzi, 0);
      z.StandardBias = BitConverter.ToInt32(tzi, 4);
      z.DaylightBias = BitConverter.ToInt32(tzi, 8);
      z.StandardDate = dstOff ? new SYSTEMTIME() : St(tzi, 12);
      z.DaylightDate = dstOff ? new SYSTEMTIME() : St(tzi, 28);
      z.StandardName = Cut(std ?? key, 31);
      z.DaylightName = Cut(dlt ?? key, 31);
      z.TimeZoneKeyName = key;
      z.DynamicDaylightTimeDisabled = dstOff;
      return z;
    }

    static string Cut(string s, int n) { return s.Length > n ? s.Substring(0, n) : s; }

    static string Zones(Dictionary<string, object> req, ref object result) {
      var list = new List<object>();
      try {
        foreach (TimeZoneInfo z in TimeZoneInfo.GetSystemTimeZones())
          list.Add(Json.Obj("zone", z.Id, "name", z.DisplayName, "offsetMinutes", (int)z.BaseUtcOffset.TotalMinutes,
                            "dst", z.SupportsDaylightSavingTime));
      } catch (Exception ex) { return "the time zone list could not be read: " + SysCommon.Why(ex); }
      result = Json.Obj("ok", true, "zones", list, "reason", list.Count == 0 ? "Windows listed no time zones" : null);
      return null;
    }

    // ------------------------------------------------------------------ services (READ)

    internal static IDictionary ServiceInfo(string name, string key) {
      string why;
      long? start = SysCommon.ReadNumber("HKLM", key, "Start", out why);
      string state = null, stateWhy = null;
      try {
        using (var sc = new ServiceController(name)) state = sc.Status.ToString().ToLowerInvariant();
      } catch (Exception ex) { stateWhy = "its state could not be read: " + SysCommon.Why(ex); }
      string startType = start == null ? null : start == 2 ? "automatic" : start == 3 ? "manual" : start == 4 ? "disabled" : "boot/system";
      return Json.Obj("state", state, "startType", startType, "reason", stateWhy ?? (start == null ? "its start type could not be read (" + why + ")" : null));
    }

    // ------------------------------------------------------------------ systime.get

    static string Get(Dictionary<string, object> req, ref object result) {
      var problems = new List<object>();
      DateTime now = DateTime.Now;
      IDictionary nowJ = Json.Obj("local", Iso(now), "utc", Iso(now.ToUniversalTime()) + "Z",
                                  "epochMs", (long)(now.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds,
                                  "date", SysRegion.FormatNow("longDate"), "time", SysRegion.FormatNow("longTime"),
                                  "timeShort", SysRegion.FormatNow("shortTime"));

      // --- the zone
      DTZI tz; uint which;
      IDictionary zone;
      string zerr = CurrentZone(out tz, out which);
      bool autoZoneOn = false;
      IDictionary autoZone = AutoZone(out autoZoneOn);
      if (zerr != null) { zone = Json.Obj("key", null, "reason", zerr); problems.Add("zone: " + zerr); }
      else {
        string display, std, dlt; byte[] tzi; bool dst;
        string ferr = ZoneFacts(tz.TimeZoneKeyName, out display, out tzi, out std, out dlt, out dst);
        bool held, enabled;
        string perr = Privilege("SeTimeZonePrivilege", out held, out enabled);
        string manualWhy = perr != null ? "Mantle could not check its right to change the time zone: " + perr
          : !held ? "this account does not hold the right to change the time zone (SeTimeZonePrivilege); an administrator can change it"
          : autoZoneOn ? "Set time zone automatically is on, so Windows picks the zone from your location; turn that off to choose one"
          : ferr != null ? "the current zone's details could not be read (" + ferr + ")" : null;
        int bias = tz.Bias + (which == 2 ? tz.DaylightBias : tz.StandardBias);
        bool dstAuto = !tz.DynamicDaylightTimeDisabled && (tz.DaylightDate.Month != 0 || dst);
        zone = Json.Obj("key", tz.TimeZoneKeyName, "name", display, "standardName", tz.StandardName, "daylightName", tz.DaylightName,
                        "offsetMinutes", -bias, "daylightNow", which == 2, "supportsDst", dst,
                        "dstAuto", dstAuto,
                        "dstReason", !dst ? "this time zone has no daylight saving time" : manualWhy != null && !held ? manualWhy : null,
                        "writable", manualWhy == null, "reason", manualWhy,
                        "privilege", Json.Obj("name", "SeTimeZonePrivilege", "held", held, "enabled", enabled, "reason", perr));
      }

      // --- set time automatically (W32Time)
      string why;
      object type = SysCommon.Read("HKLM", W32Params, "Type", out why);
      object ntp = SysCommon.Read("HKLM", W32Params, "NtpServer", out why);
      string ntpText = ntp as string;
      var servers = new List<object>();
      if (ntpText != null) foreach (string s in ntpText.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
        int comma = s.IndexOf(',');
        servers.Add(comma > 0 ? s.Substring(0, comma) : s);
      }
      string typeText = type as string;
      bool autoOn = typeText != null && !string.Equals(typeText, "NoSync", StringComparison.OrdinalIgnoreCase);
      IDictionary svc = ServiceInfo("w32time", @"SYSTEM\CurrentControlSet\Services\W32Time");
      object lastGood = null; string lastWhy = null;
      object lg = SysCommon.Read("HKLM", W32Config, "LastKnownGoodTime", out lastWhy);
      if (lg is long) {
        try { lastGood = Iso(DateTime.FromFileTimeUtc((long)lg).ToLocalTime()); lastWhy = null; }
        catch (Exception) { lastWhy = "the stored time is not a valid date"; }
      } else if (lg != null) lastWhy = "the stored time is not a date (" + lg.GetType().Name + ")";
      IDictionary autoTime = Json.Obj("on", autoOn, "type", typeText, "servers", servers, "service", svc,
        "lastGood", lastGood, "lastGoodReason", lastWhy,
        "admin", "time.setAutoSync",
        "reason", typeText == null ? "the Windows Time setting could not be read (" + why + ")" : null);

      // --- the clock itself and Sync now
      bool svcDisabled = (string)svc["startType"] == "disabled";
      IDictionary clock = Json.Obj("admin", "time.setClock",
        "reason", autoOn ? "Set time automatically is on, so Windows would put the time right back at the next sync; turn it off to set the time yourself" : null);
      IDictionary sync = Json.Obj("admin", "time.syncNow", "server", servers.Count > 0 ? servers[0] : null,
        "reason", !autoOn ? "Set time automatically is off, so there is no time server to sync with"
          : svcDisabled ? "the Windows Time service is disabled, so Windows cannot sync" : null);

      // --- the tray clock and the additional clocks
      string sw; long? secs = SysCommon.ReadNumber("HKCU", AdvancedKey, "ShowSecondsInSystemClock", out sw);
      string hw; long? hide = SysCommon.ReadNumber("HKCU", ExplorerPolicy, "HideClock", out hw);
      long? hideM = SysCommon.ReadNumber("HKLM", ExplorerPolicy, "HideClock", out hw);
      bool hidden = (hide ?? 0) != 0 || (hideM ?? 0) != 0;
      IDictionary tray = Json.Obj(
        "showSeconds", Json.Obj("on", (secs ?? 0) != 0, "set", secs != null, "info", secs == null ? "not set: Windows' default (off) applies" : null),
        "clockHidden", Json.Obj("on", hidden, "reason", hidden ? "a policy (HideClock) removes the clock from Windows' taskbar; only an administrator or the policy owner can change it" : null));

      var extras = new List<object>();
      for (int slot = 1; slot <= 2; slot++) extras.Add(ExtraClock(slot));

      result = Json.Obj("ok", true, "now", nowJ, "zone", zone, "autoTime", autoTime, "autoZone", autoZone,
                        "clock", clock, "sync", sync, "tray", tray, "extraClocks", extras,
                        "elevated", SysCommon.Elevated(), "problems", problems);
      return null;
    }

    /// Set time zone automatically: the tzautoupdate service's start type (4 = off), and whether it
    /// can work at all (it needs location access and the Geolocation service).
    static IDictionary AutoZone(out bool on) {
      IDictionary svc = ServiceInfo("tzautoupdate", TzAutoKey);
      on = svc["startType"] != null && (string)svc["startType"] != "disabled";
      string mw, uw;
      string machine = SysCommon.Read("HKLM", LocationKey, "Value", out mw) as string;
      string user = SysCommon.Read("HKCU", LocationKey, "Value", out uw) as string;
      IDictionary geo = ServiceInfo("lfsvc", @"SYSTEM\CurrentControlSet\Services\lfsvc");
      string blocked = machine != null && machine != "Allow" ? "location services are off for this PC (Privacy & security > Location), and Windows needs your location to set the time zone automatically"
        : user != null && user != "Allow" ? "location access is off for your account (Privacy & security > Location), and Windows needs your location to set the time zone automatically"
        : (string)geo["startType"] == "disabled" ? "the Geolocation service is disabled, and Windows needs it to set the time zone automatically" : null;
      return Json.Obj("on", on, "service", svc, "location", Json.Obj("machine", machine, "user", user, "service", geo),
                      "works", blocked == null, "admin", "time.setAutoZone",
                      "reason", svc["startType"] == null ? "the setting could not be read (" + (string)svc["reason"] + ")" : null,
                      "blocked", blocked);
    }

    static IDictionary ExtraClock(int slot) {
      string key = ClocksKey + "\\" + slot;
      string w1, w2, w3;
      long? en = SysCommon.ReadNumber("HKCU", key, "Enable", out w1);
      string name = SysCommon.Read("HKCU", key, "DisplayName", out w2) as string;
      string zone = SysCommon.Read("HKCU", key, "TzRegKeyName", out w3) as string;
      string zname = null;
      if (zone != null) {
        string d, s, l; byte[] t; bool dst;
        if (ZoneFacts(zone, out d, out t, out s, out l, out dst) == null) zname = d;
      }
      return Json.Obj("slot", slot, "on", (en ?? 0) != 0, "name", name, "zone", zone, "zoneName", zname,
                      "info", en == null ? "not set up" : null);
    }

    // ------------------------------------------------------------------ writes: zone and DST

    static string SetZone(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "zone");
      if (string.IsNullOrEmpty(key)) return "systime.setZone needs zone (a time zone key, e.g. \"Pacific Standard Time\")";
      return ApplyZone(req, key, null, ref result);
    }

    static string SetDst(Dictionary<string, object> req, ref object result) {
      bool on;
      string bad = SysCommon.Bool(req, "on", "systime.setDst", out on);
      if (bad != null) return bad;
      return ApplyZone(req, null, on, ref result);
    }

    /// One zone change: `key` = a new zone (DST as it is now), or `dst` = the current zone with
    /// daylight saving on/off. dryRun does every read and check and stops before the call.
    static string ApplyZone(Dictionary<string, object> req, string key, bool? dst, ref object result) {
      bool dry = Json.GetBool(req, "dryRun", false);
      string cmd = dst == null ? "systime.setZone" : "systime.setDst";
      DTZI cur; uint which;
      string err = CurrentZone(out cur, out which);
      if (err != null) return cmd + ": " + err;
      bool curDstOff = cur.DynamicDaylightTimeDisabled;
      string target = key ?? cur.TimeZoneKeyName;
      string display, std, dlt; byte[] tzi; bool hasDst;
      err = ZoneFacts(target, out display, out tzi, out std, out dlt, out hasDst);
      if (err != null) return cmd + ": " + err;
      bool dstOff = dst == null ? (curDstOff && hasDst) : !dst.Value;
      if (dst != null && !hasDst) return cmd + ": this time zone has no daylight saving time, so there is nothing to adjust";
      bool held, enabled;
      err = Privilege("SeTimeZonePrivilege", out held, out enabled);
      if (err != null) return cmd + ": " + err;
      if (!held) return cmd + ": this account does not hold the right to change the time zone (SeTimeZonePrivilege)";
      string curDisplay, a, b2; byte[] t2; bool d2;
      ZoneFacts(cur.TimeZoneKeyName, out curDisplay, out t2, out a, out b2, out d2);

      string would = dst == null
        ? "change the time zone from " + (curDisplay ?? cur.TimeZoneKeyName) + " to " + (display ?? target) + (dstOff ? " (daylight saving adjustment off)" : "")
        : "turn " + (dst.Value ? "on" : "off") + " adjusting for daylight saving time automatically in " + (display ?? target);
      var writes = SysCommon.List(Json.Obj("api", "SetDynamicTimeZoneInformation", "zone", target, "dynamicDaylightTimeDisabled", dstOff,
                                           "privilege", "SeTimeZonePrivilege (held by this account, enabled only for the call)"));
      if (dry) {
        IDictionary r = SysCommon.Dry(writes, Json.Obj("zone", cur.TimeZoneKeyName, "dstOff", curDstOff), null, false);
        r["would"] = would; r["zone"] = target; r["zoneName"] = display; r["dstOff"] = dstOff;
        r["privilege"] = Json.Obj("held", held, "enabled", enabled);
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);

      err = SysCommon.EnablePrivilege("SeTimeZonePrivilege");
      if (err != null) return cmd + ": " + err;
      DTZI z = Build(target, tzi, std, dlt, dstOff);
      if (!Native.SetDynamicTimeZoneInformation(ref z))
        return cmd + ": Windows refused the time zone (error " + Marshal.GetLastWin32Error() + ")";
      // What timedate.cpl does after a zone change: tell every window the clock moved.
      Native.SendNotifyMessageW(new IntPtr(0xFFFF), 0x001E /* WM_TIMECHANGE */, IntPtr.Zero, IntPtr.Zero);
      TimeZoneInfo.ClearCachedData();
      DTZI back; uint w2;
      err = CurrentZone(out back, out w2);
      if (err != null) return cmd + ": the change was made but could not be read back (" + err + ")";
      bool okBack = back.TimeZoneKeyName == target && back.DynamicDaylightTimeDisabled == dstOff;
      result = Json.Obj("ok", true, "dryRun", false, "zone", back.TimeZoneKeyName, "zoneName", display, "dstAuto", !back.DynamicDaylightTimeDisabled,
                        "now", dst == null ? (object)back.TimeZoneKeyName : !back.DynamicDaylightTimeDisabled,
                        "reason", okBack ? null : "Windows took the change but reads back " + back.TimeZoneKeyName + (back.DynamicDaylightTimeDisabled ? " (daylight saving off)" : ""));
      return null;
    }

    // ------------------------------------------------------------------ writes: administrator rows

    static string SetAutoSync(Dictionary<string, object> req, ref object result) {
      bool on;
      string bad = SysCommon.Bool(req, "on", "systime.setAutoSync", out on);
      if (bad != null) return bad;
      string why;
      object before = SysCommon.Read("HKLM", W32Params, "Type", out why);
      if (before == null) return "systime.setAutoSync: the Windows Time setting could not be read (" + why + ")";
      var writes = SysCommon.List(Json.Obj("api", "registry", "hive", "HKLM", "key", W32Params, "name", "Type", "type", "REG_SZ", "value", on ? "NTP" : "NoSync", "before", before));
      return AdminAnswer(req, "time.setAutoSync", "turn setting the time automatically " + (on ? "on" : "off"), Json.Obj("on", on), writes, before, ref result);
    }

    static string SetAutoZone(Dictionary<string, object> req, ref object result) {
      bool on;
      string bad = SysCommon.Bool(req, "on", "systime.setAutoZone", out on);
      if (bad != null) return bad;
      bool cur;
      IDictionary az = AutoZone(out cur);
      var writes = SysCommon.List(Json.Obj("api", "ChangeServiceConfig", "service", "tzautoupdate", "startType", on ? "manual (trigger-started)" : "disabled"));
      IDictionary plan;
      string err = AdminAnswer(req, "time.setAutoZone", "turn setting the time zone automatically " + (on ? "on" : "off"), Json.Obj("on", on), writes, cur, ref result);
      plan = result as IDictionary;
      if (err == null && plan != null && on && !(bool)az["works"]) plan["note"] = "It cannot work yet: " + (string)az["blocked"];
      return err;
    }

    static string SetClock(Dictionary<string, object> req, ref object result) {
      var args = new Dictionary<string, object>();
      foreach (string k in new[] { "year", "month", "day", "hour", "minute", "second" }) {
        object v;
        if (Json.TryGet(req, k, out v)) args[k] = v;
      }
      string bad = CheckSetClock(args);
      if (bad != null) return "systime.setClock: " + bad;
      string text = ClockText(args);
      var writes = SysCommon.List(Json.Obj("api", "SetLocalTime", "to", text, "privilege", "SeSystemtimePrivilege (administrators only)"));
      return AdminAnswer(req, "time.setClock", "set the date and time to " + text, args, writes, Iso(DateTime.Now), ref result);
    }

    static string SyncNow(Dictionary<string, object> req, ref object result) {
      string why;
      string type = SysCommon.Read("HKLM", W32Params, "Type", out why) as string;
      if (type == null) return "systime.syncNow: the Windows Time setting could not be read (" + why + ")";
      if (string.Equals(type, "NoSync", StringComparison.OrdinalIgnoreCase)) return "systime.syncNow: Set time automatically is off, so there is no time server to sync with";
      IDictionary svc = ServiceInfo("w32time", @"SYSTEM\CurrentControlSet\Services\W32Time");
      if ((string)svc["startType"] == "disabled") return "systime.syncNow: the Windows Time service is disabled, so Windows cannot sync";
      var writes = SysCommon.List(Json.Obj("api", "W32TimeSyncNow", "service", "w32time", "startsService", (string)svc["state"] != "running",
                                           "note", "asks the time server and sets the clock (a network request)"));
      return AdminAnswer(req, "time.syncNow", "sync the clock with the time server now", new Dictionary<string, object>(), writes, svc["state"], ref result);
    }

    /// A plan for dryRun, the passive refusal, else {ok:false, needsAdmin, elevate:{action,args}}.
    static string AdminAnswer(Dictionary<string, object> req, string action, string does, IDictionary args, IList writes, object before, ref object result) {
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, before, null, !SysCommon.Elevated());
        r["would"] = "ask for administrator permission to " + does;
        r["elevate"] = Json.Obj("action", action, "args", args);
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive("asked for administrator permission to " + does);
      result = Json.Obj("ok", false, "needsAdmin", true, "elevate", Json.Obj("action", action, "args", args), "writes", writes,
                        "reason", "Windows will ask for administrator permission to " + does);
      return null;
    }

    // ------------------------------------------------------------------ the elevated actions

    static string CheckOnly(Dictionary<string, object> args) { return SysCommon.CheckOn(args); }

    static string CheckNone(Dictionary<string, object> args) { return Elevate.OnlyKeys(args); }

    internal static string CheckSetClock(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "year", "month", "day", "hour", "minute", "second");
      if (why != null) return why;
      string[] keys = { "year", "month", "day", "hour", "minute", "second" };
      int[] min = { 2000, 1, 1, 0, 0, 0 }, max = { 2099, 12, 31, 23, 59, 59 };
      for (int i = 0; i < keys.Length; i++) {
        object v;
        if (!args.TryGetValue(keys[i], out v) || !(v is double)) return keys[i] + " must be a whole number from " + min[i] + " to " + max[i];
        double d = (double)v;
        if (d != Math.Floor(d) || d < min[i] || d > max[i]) return keys[i] + " must be a whole number from " + min[i] + " to " + max[i];
      }
      int y = (int)(double)args["year"], m = (int)(double)args["month"], day = (int)(double)args["day"];
      if (day > DateTime.DaysInMonth(y, m)) return "that month has only " + DateTime.DaysInMonth(y, m) + " days";
      return null;
    }

    static int A(Dictionary<string, object> a, string k) { return (int)(double)a[k]; }

    static string ClockText(Dictionary<string, object> a) {
      var t = new DateTime(A(a, "year"), A(a, "month"), A(a, "day"), A(a, "hour"), A(a, "minute"), A(a, "second"));
      return t.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
    }

    // Each runs ELEVATED, in the broker's second sidecar, with only the validated args.

    [Elevated("time.setAutoSync", "CheckOnly", "turn setting the time automatically on or off")]
    static string ElevSetAutoSync(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      // What Settings writes: W32Time's Type is NTP (sync from the NtpServer list) or NoSync.
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.OpenSubKey(W32Params, true)) {
          if (k == null) return "the Windows Time settings key is missing, so nothing was changed";
          k.SetValue("Type", on ? "NTP" : "NoSync", RegistryValueKind.String);
        }
      } catch (Exception ex) { return "Windows refused the change: " + SysCommon.Why(ex); }
      // A running service re-reads its settings on SERVICE_CONTROL_PARAMCHANGE (what w32tm /config /update sends).
      string note = null;
      IntPtr scm = Native.OpenSCManagerW(null, null, 0x0001);
      if (scm != IntPtr.Zero) {
        IntPtr s = Native.OpenServiceW(scm, "w32time", 0x0004 | 0x0040 /* QUERY_STATUS | PAUSE_CONTINUE */);
        if (s != IntPtr.Zero) {
          SERVICE_STATUS st;
          if (Native.QueryServiceStatus(s, out st) && st.State == 4 && !Native.ControlService(s, 6 /* PARAMCHANGE */, out st))
            note = "saved; the running Windows Time service takes it at its next restart";
          Native.CloseServiceHandle(s);
        }
        Native.CloseServiceHandle(scm);
      }
      string why;
      string back = SysCommon.Read("HKLM", W32Params, "Type", out why) as string;
      if (back != (on ? "NTP" : "NoSync")) return "the change was written but reads back as " + (back ?? "(unread: " + why + ")");
      result = Json.Obj("on", on, "type", back, "note", note);
      return null;
    }

    [Elevated("time.setAutoZone", "CheckOnly", "turn setting the time zone automatically on or off")]
    static string ElevSetAutoZone(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      // What Settings does: the Auto Time Zone Updater service is trigger-started (manual) when on, disabled when off.
      IntPtr scm = Native.OpenSCManagerW(null, null, 0x0001);
      if (scm == IntPtr.Zero) return "the service manager could not be opened (error " + Marshal.GetLastWin32Error() + ")";
      try {
        IntPtr s = Native.OpenServiceW(scm, "tzautoupdate", 0x0002 | 0x0004 | 0x0010 | 0x0020 /* CHANGE_CONFIG | QUERY_STATUS | START | STOP */);
        if (s == IntPtr.Zero) return "the Auto Time Zone Updater service could not be opened (error " + Marshal.GetLastWin32Error() + ")";
        try {
          if (!Native.ChangeServiceConfigW(s, 0xFFFFFFFF, on ? 3u : 4u, 0xFFFFFFFF, null, null, IntPtr.Zero, null, null, null, null))
            return "Windows refused the change (error " + Marshal.GetLastWin32Error() + ")";
          SERVICE_STATUS st;
          if (!on && Native.QueryServiceStatus(s, out st) && st.State == 4) Native.ControlService(s, 1 /* STOP */, out st);
          if (on) Native.StartServiceW(s, 0, IntPtr.Zero);   // it sets the zone once it has a location, then stops itself
        } finally { Native.CloseServiceHandle(s); }
      } finally { Native.CloseServiceHandle(scm); }
      string why;
      long? back = SysCommon.ReadNumber("HKLM", TzAutoKey, "Start", out why);
      if (back == null || (back.Value != 4) != on) return "the change was made but the service reads back as start type " + (back == null ? "(unread)" : back.Value.ToString(CultureInfo.InvariantCulture));
      result = Json.Obj("on", on, "note", on ? "Windows sets the zone once it knows your location" : null);
      return null;
    }

    [Elevated("time.setClock", "CheckSetClock", "set this PC's date and time")]
    static string ElevSetClock(Dictionary<string, object> args, ref object result) {
      string err = SysCommon.EnablePrivilege("SeSystemtimePrivilege");
      if (err != null) return "the right to set the clock could not be used: " + err;
      var st = new SYSTEMTIME();
      st.Year = (ushort)A(args, "year"); st.Month = (ushort)A(args, "month"); st.Day = (ushort)A(args, "day");
      st.Hour = (ushort)A(args, "hour"); st.Minute = (ushort)A(args, "minute"); st.Second = (ushort)A(args, "second");
      // SetLocalTime is called twice on purpose: the first call may land on the other side of a
      // daylight saving change and use the wrong offset (documented in SetLocalTime's remarks).
      if (!Native.SetLocalTime(ref st) || !Native.SetLocalTime(ref st))
        return "Windows did not set the clock (error " + Marshal.GetLastWin32Error() + ")";
      result = Json.Obj("now", Iso(DateTime.Now));
      return null;
    }

    [Elevated("time.syncNow", "CheckNone", "sync the clock with the time server now")]
    static string ElevSyncNow(Dictionary<string, object> args, ref object result) {
      // The Windows Time service is trigger-started and usually stopped: start it first (fixed name).
      try {
        using (var sc = new ServiceController("w32time")) {
          if (sc.Status != ServiceControllerStatus.Running) {
            sc.Start();
            sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(15));
          }
        }
      } catch (Exception ex) { return "the Windows Time service could not be started: " + SysCommon.Why(ex); }
      // w32tm /resync's call: wait for the answer, ReturnResult (0x02) | HardResync (0x01).
      uint r;
      try { r = Native.W32TimeSyncNow(null, 1, 0x03); }
      catch (Exception ex) { return "Windows Time could not be asked: " + SysCommon.Why(ex); }
      switch (r) {
        case 0: result = Json.Obj("synced", true, "now", Iso(DateTime.Now)); return null;
        case 1: return "the time server gave no time data (no network, or it did not answer)";
        case 2: return "the time data was too old to use; try again in a minute";
        case 3: return "the time is too far off for Windows to correct by syncing; set it by hand once, then sync";
        case 4: return "the Windows Time service is shutting down";
        default: return "Windows Time answered " + r + " (" + new System.ComponentModel.Win32Exception((int)r).Message + ")";
      }
    }

    // ------------------------------------------------------------------ writes: HKCU rows

    static string SetExtraClock(Dictionary<string, object> req, ref object result) {
      long slot;
      string bad = SysCommon.Number(req, "slot", "systime.setExtraClock", 1, 2, out slot);
      if (bad != null) return bad;
      bool on;
      bad = SysCommon.Bool(req, "on", "systime.setExtraClock", out on);
      if (bad != null) return bad;
      IDictionary cur = ExtraClock((int)slot);
      string zone = Json.GetString(req, "zone") ?? (string)cur["zone"];
      string name = Json.GetString(req, "name") ?? (string)cur["name"] ?? "";
      if (on && string.IsNullOrEmpty(zone)) return "systime.setExtraClock: choose a time zone for this clock first";
      string zname = null;
      if (!string.IsNullOrEmpty(zone)) {
        string d, s, l; byte[] t; bool dst;
        string zerr = ZoneFacts(zone, out d, out t, out s, out l, out dst);
        if (zerr != null) return "systime.setExtraClock: " + zerr;
        zname = d;
      }
      // Windows' own dialog allows 15 characters; control characters never.
      if (name.Length > 15) return "systime.setExtraClock: the clock's name can be at most 15 characters";
      foreach (char c in name) if (char.IsControl(c)) return "systime.setExtraClock: the clock's name cannot hold control characters";
      string key = ClocksKey + "\\" + slot;
      var writes = SysCommon.List(
        Json.Obj("api", "registry", "hive", "HKCU", "key", key, "name", "Enable", "type", "REG_DWORD", "value", on ? 1 : 0),
        Json.Obj("api", "registry", "hive", "HKCU", "key", key, "name", "DisplayName", "type", "REG_SZ", "value", name),
        Json.Obj("api", "registry", "hive", "HKCU", "key", key, "name", "TzRegKeyName", "type", "REG_SZ", "value", zone ?? ""));
      string would = (on ? "show" : "hide") + " additional clock " + slot + (on ? " (" + (zname ?? zone) + ")" : "");
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, cur, null, false);
        r["would"] = would;
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      try {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(key)) {
          k.SetValue("Enable", on ? 1 : 0, RegistryValueKind.DWord);
          k.SetValue("DisplayName", name, RegistryValueKind.String);
          k.SetValue("TzRegKeyName", zone ?? "", RegistryValueKind.String);
        }
      } catch (Exception ex) { return "systime.setExtraClock: Windows refused the write: " + SysCommon.Why(ex); }
      IDictionary back = ExtraClock((int)slot);
      result = Json.Obj("ok", true, "dryRun", false, "clock", back, "now", back["on"],
                        "reason", (bool)back["on"] == on ? null : "the clock was written but reads back " + ((bool)back["on"] ? "on" : "off"));
      return null;
    }

    static string SetTray(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      if (key != "showSeconds") return "systime.setTray: key must be \"showSeconds\"";
      bool on;
      string bad = SysCommon.Bool(req, "value", "systime.setTray", out on);
      if (bad != null) return bad;
      string why;
      long? before = SysCommon.ReadNumber("HKCU", AdvancedKey, "ShowSecondsInSystemClock", out why);
      var writes = SysCommon.List(SysCommon.RegWrite("HKCU", AdvancedKey, "ShowSecondsInSystemClock", on ? 1 : 0, false, before));
      string would = "turn " + (on ? "on" : "off") + " seconds in Windows' taskbar clock";
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, before, null, false);
        r["would"] = would;
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      string err = SysCommon.WriteNumber("HKCU", AdvancedKey, "ShowSecondsInSystemClock", on ? 1 : 0, false);
      if (err != null) return "systime.setTray: " + err;
      // Explorer re-reads its taskbar switches on this broadcast (what Settings sends).
      Native.SendNotifyMessageW(new IntPtr(0xFFFF), 0x001A, IntPtr.Zero, "TraySettings");
      result = Json.Obj("ok", true, "dryRun", false, "now", on, "reason", null);
      return null;
    }
  }
}
