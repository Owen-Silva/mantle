// SysTimeRegion.cs - Settings > Time & language > Language & region: country or region, regional
// format and its overrides, for Mantle Settings (lane timelang, 2026-09-28). Page:
// ui/settings/sections/time.js. All per-user: no administrator prompt anywhere in here.
//
//   sysregion.get                        the regional format (locale), the country or region, every
//                                        format row with its value, its choices (each with a live
//                                        sample of NOW) and whether it overrides the locale's default,
//                                        and a preview of dates, times, numbers and money
//   sysregion.lists                      every regional format and every country or region Windows knows
//   sysregion.preview {locale}           what a regional format would look like (its defaults), to
//                                        preview a choice before making it
//   sysregion.setFormat {key, value, dryRun}   ONE override: SetLocaleInfoW (the documented route; it
//                                        writes HKCU\Control Panel\International) then WM_SETTINGCHANGE "intl"
//   sysregion.setLocale {locale, dryRun} the regional format: exactly what Microsoft's own Set-Culture
//                                        cmdlet does (measured 2026-09-28 by reading its IL):
//                                        kernelbase!NlsUpdateLocale(name, SELECT | CLEAR_USER_DATA = 3),
//                                        then SendNotifyMessage(HWND_BROADCAST, WM_SETTINGCHANGE, "intl").
//                                        It resets every override to the new format's defaults, as
//                                        Windows' Settings does.
//   sysregion.setGeo {geo, dryRun}       the country or region: SetUserGeoName (ISO code), then "intl"
//
// Every value offered is one Windows itself lists (EnumDateFormatsExEx, EnumTimeFormatsEx,
// EnumSystemGeoNames, the specific cultures): a write outside those lists is refused.
// PRIVACY: nothing here logs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class SysRegion {
    public static void Register(FeatureTable t) {
      t.Add("sysregion.get", Lanes.Slow, Get);
      t.Add("sysregion.lists", Lanes.Slow, Lists);
      t.Add("sysregion.preview", Lanes.Slow, Preview);
      t.Add("sysregion.setFormat", Lanes.Slow, SetFormat);
      t.Add("sysregion.setLocale", Lanes.Slow, SetLocale);
      t.Add("sysregion.setGeo", Lanes.Slow, SetGeo);
    }

    delegate bool DateFmtProc(IntPtr fmt, uint calId, IntPtr lp);
    delegate bool TimeFmtProc(IntPtr fmt, IntPtr lp);
    delegate bool GeoNameProc(IntPtr name, IntPtr lp);

    static class Native {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetLocaleInfoEx(string locale, uint type, StringBuilder data, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetLocaleInfoW(uint lcid, uint type, string data);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetDateFormatEx(string locale, uint flags, IntPtr date, string fmt, StringBuilder buf, int n, string cal);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetTimeFormatEx(string locale, uint flags, IntPtr time, string fmt, StringBuilder buf, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetNumberFormatEx(string locale, uint flags, string value, IntPtr fmt, StringBuilder buf, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetCurrencyFormatEx(string locale, uint flags, string value, IntPtr fmt, StringBuilder buf, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool EnumDateFormatsExEx(DateFmtProc proc, string locale, uint flags, IntPtr lp);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool EnumTimeFormatsEx(TimeFmtProc proc, string locale, uint flags, IntPtr lp);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool EnumSystemGeoNames(uint cls, GeoNameProc proc, IntPtr lp);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetGeoInfoEx(string location, uint type, StringBuilder buf, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetUserDefaultGeoName(StringBuilder buf, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetUserGeoName(string name);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetUserDefaultLocaleName(StringBuilder buf, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetSystemDefaultLocaleName(StringBuilder buf, int n);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int GetCalendarInfoEx(string locale, uint cal, string reserved, uint type, StringBuilder buf, int n, IntPtr value);
      [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "NlsUpdateLocale")] public static extern int NlsUpdateLocale(string locale, int flags);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr GetModuleHandleW(string name);
      [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] public static extern IntPtr GetProcAddress(IntPtr m, string name);
      [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SendNotifyMessageW(IntPtr hwnd, uint msg, IntPtr wp, string lp);
    }

    const uint LOCALE_USER_DEFAULT = 0x0400;
    const uint NOUSEROVERRIDE = 0x80000000;
    const uint LOCALE_SLOCALIZEDDISPLAYNAME = 0x02, LOCALE_IMEASURE = 0x0D, LOCALE_SDECIMAL = 0x0E, LOCALE_STHOUSAND = 0x0F;
    const uint LOCALE_SCURRENCY = 0x14, LOCALE_SSHORTDATE = 0x1F, LOCALE_SLONGDATE = 0x20, LOCALE_SDAYNAME1 = 0x2A;
    const uint LOCALE_SSHORTTIME = 0x79, LOCALE_STIMEFORMAT = 0x1003, LOCALE_ICALENDARTYPE = 0x1009, LOCALE_IFIRSTDAYOFWEEK = 0x100C;
    const uint DATE_SHORTDATE = 1, DATE_LONGDATE = 2, TIME_NOSECONDS = 2;
    const uint GEOCLASS_NATION = 16, GEO_FRIENDLYNAME = 8;

    // The rows Windows' Regional format page lets you change, plus the measurement system (intl.cpl).
    static readonly string[] Keys = { "shortDate", "longDate", "shortTime", "longTime", "firstDayOfWeek", "measure" };
    static readonly uint[] Types = { LOCALE_SSHORTDATE, LOCALE_SLONGDATE, LOCALE_SSHORTTIME, LOCALE_STIMEFORMAT, LOCALE_IFIRSTDAYOFWEEK, LOCALE_IMEASURE };
    static readonly string[] RegNames = { "sShortDate", "sLongDate", "sShortTime", "sTimeFormat", "iFirstDayOfWeek", "iMeasure" };

    // ------------------------------------------------------------------ small reads

    internal static string Info(string locale, uint type) {
      var sb = new StringBuilder(256);
      int n = Native.GetLocaleInfoEx(locale, type, sb, sb.Capacity);
      return n > 0 ? sb.ToString() : null;
    }

    static string UserLocale() {
      var sb = new StringBuilder(128);
      return Native.GetUserDefaultLocaleName(sb, sb.Capacity) > 0 ? sb.ToString() : null;
    }

    static string Date(string locale, uint flags, string fmt) {
      var sb = new StringBuilder(256);
      return Native.GetDateFormatEx(locale, flags, IntPtr.Zero, fmt, sb, sb.Capacity, null) > 0 ? sb.ToString() : null;
    }

    static string Time(string locale, uint flags, string fmt) {
      var sb = new StringBuilder(128);
      return Native.GetTimeFormatEx(locale, flags, IntPtr.Zero, fmt, sb, sb.Capacity) > 0 ? sb.ToString() : null;
    }

    /// NOW in the user's own formats: "longDate", "shortDate", "longTime", "shortTime".
    internal static string FormatNow(string kind) {
      switch (kind) {
        case "longDate": return Date(null, DATE_LONGDATE, null);
        case "shortDate": return Date(null, DATE_SHORTDATE, null);
        case "shortTime": return Time(null, TIME_NOSECONDS, null);
        default: return Time(null, 0, null);
      }
    }

    static string Sample(string key, string fmt) {
      if (key == "shortDate" || key == "longDate") return Date(null, 0, fmt);
      if (key == "shortTime" || key == "longTime") return Time(null, 0, fmt);
      return null;
    }

    static List<string> DateFormats(string locale, uint flags) {
      var list = new List<string>();
      DateFmtProc p = delegate (IntPtr f, uint cal, IntPtr lp) { string s = Marshal.PtrToStringUni(f); if (s != null && !list.Contains(s)) list.Add(s); return true; };
      Native.EnumDateFormatsExEx(p, locale, flags, IntPtr.Zero);
      GC.KeepAlive(p);
      return list;
    }

    static List<string> TimeFormats(string locale, uint flags) {
      var list = new List<string>();
      TimeFmtProc p = delegate (IntPtr f, IntPtr lp) { string s = Marshal.PtrToStringUni(f); if (s != null && !list.Contains(s)) list.Add(s); return true; };
      Native.EnumTimeFormatsEx(p, locale, flags, IntPtr.Zero);
      GC.KeepAlive(p);
      return list;
    }

    /// The choices Windows lists for one row of the user's regional format.
    static List<object> Options(string key, string current) {
      var opts = new List<object>();
      List<string> fmts = null;
      switch (key) {
        case "shortDate": fmts = DateFormats(null, DATE_SHORTDATE); break;
        case "longDate": fmts = DateFormats(null, DATE_LONGDATE); break;
        case "shortTime": fmts = TimeFormats(null, TIME_NOSECONDS); break;
        case "longTime": fmts = TimeFormats(null, 0); break;
        case "firstDayOfWeek":
          for (int d = 0; d < 7; d++) opts.Add(Json.Obj("value", d.ToString(CultureInfo.InvariantCulture), "label", Info(null, LOCALE_SDAYNAME1 + (uint)d) ?? ("day " + d)));
          return opts;
        case "measure":
          opts.Add(Json.Obj("value", "0", "label", "Metric"));
          opts.Add(Json.Obj("value", "1", "label", "U.S."));
          return opts;
      }
      if (current != null && !fmts.Contains(current)) fmts.Insert(0, current);
      foreach (string f in fmts) opts.Add(Json.Obj("value", f, "label", Sample(key, f) ?? f, "sample", Sample(key, f)));
      return opts;
    }

    static string Calendar(string locale) {
      string id = Info(locale, LOCALE_ICALENDARTYPE);
      uint cal;
      if (id == null || !uint.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out cal)) return null;
      var sb = new StringBuilder(128);
      return Native.GetCalendarInfoEx(locale, cal, null, 2 /* CAL_SCALNAME */, sb, sb.Capacity, IntPtr.Zero) > 0 ? sb.ToString() : null;
    }

    static IDictionary PreviewOf(string locale, bool defaults) {
      uint o = defaults ? NOUSEROVERRIDE : 0;
      var n = new StringBuilder(128); var c = new StringBuilder(128); var neg = new StringBuilder(128);
      Native.GetNumberFormatEx(locale, o, "1234567.89", IntPtr.Zero, n, n.Capacity);
      Native.GetCurrencyFormatEx(locale, o, "1234567.89", IntPtr.Zero, c, c.Capacity);
      Native.GetNumberFormatEx(locale, o, "-42.5", IntPtr.Zero, neg, neg.Capacity);
      return Json.Obj("shortDate", Date(locale, DATE_SHORTDATE | o, null), "longDate", Date(locale, DATE_LONGDATE | o, null),
                      "shortTime", Time(locale, TIME_NOSECONDS | o, null), "longTime", Time(locale, o, null),
                      "number", n.ToString(), "negative", neg.ToString(), "currency", c.ToString(),
                      "firstDay", Info(locale, LOCALE_SDAYNAME1 + (uint)ParseInt(Info(locale == null ? null : locale, LOCALE_IFIRSTDAYOFWEEK | o), 0)),
                      "measure", Info(locale, LOCALE_IMEASURE | o) == "1" ? "U.S." : "Metric",
                      "calendar", Calendar(locale));
    }

    static int ParseInt(string s, int dflt) {
      int v;
      return s != null && int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) && v >= 0 && v <= 6 ? v : dflt;
    }

    static string UserGeo() {
      var sb = new StringBuilder(16);
      try { return Native.GetUserDefaultGeoName(sb, sb.Capacity) > 0 ? sb.ToString() : null; }
      catch (EntryPointNotFoundException) { return null; }
    }

    static string GeoName(string code) {
      var sb = new StringBuilder(128);
      return Native.GetGeoInfoEx(code, GEO_FRIENDLYNAME, sb, sb.Capacity) > 0 ? sb.ToString() : null;
    }

    // ------------------------------------------------------------------ sysregion.get / lists / preview

    static string Get(Dictionary<string, object> req, ref object result) {
      string loc = UserLocale();
      if (loc == null) return "sysregion.get: Windows did not say which regional format is in use (error " + Marshal.GetLastWin32Error() + ")";
      var formats = new Dictionary<string, object>();
      var overrides = new List<object>();
      for (int i = 0; i < Keys.Length; i++) {
        string v = Info(null, Types[i]);
        string d = Info(loc, Types[i] | NOUSEROVERRIDE);
        bool over = v != null && d != null && v != d;
        if (over) overrides.Add(Keys[i]);
        formats[Keys[i]] = Json.Obj("value", v, "default", d, "override", over, "sample", Sample(Keys[i], v),
                                    "options", Options(Keys[i], v), "registry", @"HKCU\Control Panel\International\" + RegNames[i],
                                    "reason", v == null ? "Windows did not answer this read (error " + Marshal.GetLastWin32Error() + ")" : null);
      }
      string geo = UserGeo();
      bool nls = HasNlsUpdate();
      var sys = new StringBuilder(128);
      string sysLoc = Native.GetSystemDefaultLocaleName(sys, sys.Capacity) > 0 ? sys.ToString() : null;
      result = Json.Obj("ok", true,
        "locale", Json.Obj("name", loc, "display", Info(loc, LOCALE_SLOCALIZEDDISPLAYNAME),
                           "reason", nls ? null : "this Windows has no NlsUpdateLocale (the call Windows' own Set-Culture uses), so Mantle cannot switch the regional format here"),
        "geo", Json.Obj("code", geo, "name", geo == null ? null : GeoName(geo),
                        "reason", geo == null ? "Windows did not say which country or region is set (GetUserDefaultGeoName)" : null),
        "formats", formats, "overrides", overrides, "preview", PreviewOf(null, false),
        "symbols", Json.Obj("decimal", Info(null, LOCALE_SDECIMAL), "thousand", Info(null, LOCALE_STHOUSAND), "currency", Info(null, LOCALE_SCURRENCY)),
        "systemLocale", Json.Obj("name", sysLoc, "display", sysLoc == null ? null : Info(sysLoc, LOCALE_SLOCALIZEDDISPLAYNAME),
          "reason", "the language for non-Unicode programs is set for the whole PC and needs a restart; Windows only changes it from its administrative language settings (administrator)"));
      return null;
    }

    static bool HasNlsUpdate() {
      IntPtr m = Native.GetModuleHandleW("kernelbase.dll");
      return m != IntPtr.Zero && Native.GetProcAddress(m, "NlsUpdateLocale") != IntPtr.Zero;
    }

    static List<string> GeoCodes() {
      var list = new List<string>();
      GeoNameProc p = delegate (IntPtr n, IntPtr lp) { string s = Marshal.PtrToStringUni(n); if (s != null && s.Length == 2) list.Add(s); return true; };
      try { Native.EnumSystemGeoNames(GEOCLASS_NATION, p, IntPtr.Zero); } catch (EntryPointNotFoundException) { }
      GC.KeepAlive(p);
      return list;
    }

    static Dictionary<string, string> Locales() {
      var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (CultureInfo c in CultureInfo.GetCultures(CultureTypes.SpecificCultures)) {
        if (string.IsNullOrEmpty(c.Name) || (c.CultureTypes & CultureTypes.UserCustomCulture) != 0) continue;
        map[c.Name] = Info(c.Name, LOCALE_SLOCALIZEDDISPLAYNAME) ?? c.DisplayName;
      }
      return map;
    }

    static string Lists(Dictionary<string, object> req, ref object result) {
      var locs = new List<object>();
      foreach (KeyValuePair<string, string> kv in Locales()) locs.Add(Json.Obj("locale", kv.Key, "name", kv.Value));
      locs.Sort(delegate (object a, object b) { return string.Compare((string)((IDictionary)a)["name"], (string)((IDictionary)b)["name"], StringComparison.CurrentCulture); });
      var geos = new List<object>();
      foreach (string g in GeoCodes()) geos.Add(Json.Obj("geo", g, "name", GeoName(g) ?? g));
      geos.Sort(delegate (object a, object b) { return string.Compare((string)((IDictionary)a)["name"], (string)((IDictionary)b)["name"], StringComparison.CurrentCulture); });
      result = Json.Obj("ok", true, "locales", locs, "geos", geos,
                        "reason", locs.Count == 0 ? "Windows listed no regional formats" : geos.Count == 0 ? "Windows listed no countries or regions (EnumSystemGeoNames)" : null);
      return null;
    }

    static string Preview(Dictionary<string, object> req, ref object result) {
      string loc = Json.GetString(req, "locale");
      if (string.IsNullOrEmpty(loc) || !Locales().ContainsKey(loc)) return "sysregion.preview needs locale: a regional format Windows lists (e.g. \"en-GB\")";
      result = Json.Obj("ok", true, "locale", loc, "display", Info(loc, LOCALE_SLOCALIZEDDISPLAYNAME), "preview", PreviewOf(loc, true));
      return null;
    }

    // ------------------------------------------------------------------ writes

    static void Broadcast() {
      // What Set-Culture sends (SendNotifyMessage: never waits on a hung window).
      Native.SendNotifyMessageW(new IntPtr(0xFFFF), 0x001A /* WM_SETTINGCHANGE */, IntPtr.Zero, "intl");
    }

    static string SetFormat(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      int i = key == null ? -1 : Array.IndexOf(Keys, key);
      if (i < 0) return "sysregion.setFormat: key must be one of " + string.Join(", ", Keys);
      string value = Json.GetString(req, "value");
      if (value == null) return "sysregion.setFormat needs value (one of the choices sysregion.get lists)";
      string before = Info(null, Types[i]);
      bool listed = false;
      foreach (object o in Options(key, null)) if ((string)((IDictionary)o)["value"] == value) { listed = true; break; }
      if (!listed) return "sysregion.setFormat: \"" + (value.Length > 40 ? value.Substring(0, 40) + "..." : value) + "\" is not one of the choices Windows lists for " + key;
      string shown = Sample(key, value) ?? value;
      if (key == "firstDayOfWeek") shown = Info(null, LOCALE_SDAYNAME1 + (uint)ParseInt(value, 0));
      if (key == "measure") shown = value == "1" ? "U.S." : "Metric";
      var writes = SysCommon.List(Json.Obj("api", "SetLocaleInfoW", "lctype", "0x" + Types[i].ToString("X", CultureInfo.InvariantCulture),
                                           "registry", @"HKCU\Control Panel\International\" + RegNames[i], "value", value, "before", before),
                                  Json.Obj("api", "SendNotifyMessage", "message", "WM_SETTINGCHANGE", "lParam", "intl"));
      string would = "set " + key + " to " + value + " (" + shown + ") and tell running apps";
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, before, null, false);
        r["would"] = would; r["key"] = key; r["value"] = value; r["sample"] = shown;
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      if (!Native.SetLocaleInfoW(LOCALE_USER_DEFAULT, Types[i], value))
        return "sysregion.setFormat: Windows refused the format (error " + Marshal.GetLastWin32Error() + ")";
      Broadcast();
      string back = Info(null, Types[i]);
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "now", back, "sample", Sample(key, back),
                        "reason", back == value ? null : "Windows took the change but reads back " + (back ?? "(unread)"));
      return null;
    }

    static string SetLocale(Dictionary<string, object> req, ref object result) {
      string loc = Json.GetString(req, "locale");
      Dictionary<string, string> all = Locales();
      if (string.IsNullOrEmpty(loc) || !all.ContainsKey(loc)) return "sysregion.setLocale needs locale: a regional format Windows lists (e.g. \"en-GB\")";
      if (!HasNlsUpdate()) return "sysregion.setLocale: this Windows has no NlsUpdateLocale, so the regional format cannot be switched from here";
      string before = UserLocale();
      var over = new List<object>();
      for (int i = 0; i < Keys.Length; i++) {
        string v = Info(null, Types[i]), d = before == null ? null : Info(before, Types[i] | NOUSEROVERRIDE);
        if (v != null && d != null && v != d) over.Add(Keys[i]);
      }
      var writes = SysCommon.List(Json.Obj("api", "NlsUpdateLocale", "locale", loc, "flags", "SELECT | CLEAR_USER_DATA (3)", "before", before,
                                           "clearsOverrides", over),
                                  Json.Obj("api", "SendNotifyMessage", "message", "WM_SETTINGCHANGE", "lParam", "intl"));
      string would = "switch the regional format from " + (before == null ? "(unread)" : (Info(before, LOCALE_SLOCALIZEDDISPLAYNAME) ?? before)) + " to " + all[loc] +
                     (over.Count > 0 ? ", which also resets " + over.Count + " custom format" + (over.Count == 1 ? "" : "s") : "") + ", and tell running apps";
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, before, null, false);
        r["would"] = would; r["locale"] = loc; r["preview"] = PreviewOf(loc, true);
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      int ok;
      try { ok = Native.NlsUpdateLocale(loc, 3); }
      catch (EntryPointNotFoundException) { return "sysregion.setLocale: this Windows has no NlsUpdateLocale"; }
      if (ok == 0) return "sysregion.setLocale: Windows refused the regional format (error " + Marshal.GetLastWin32Error() + ")";
      Broadcast();
      CultureInfo.CurrentCulture.ClearCachedData();
      string back = UserLocale();
      result = Json.Obj("ok", true, "dryRun", false, "now", back,
                        "reason", string.Equals(back, loc, StringComparison.OrdinalIgnoreCase) ? null : "Windows took the change but reads back " + (back ?? "(unread)"));
      return null;
    }

    static string SetGeo(Dictionary<string, object> req, ref object result) {
      string geo = Json.GetString(req, "geo");
      List<string> codes = GeoCodes();
      if (string.IsNullOrEmpty(geo) || !codes.Contains(geo)) return "sysregion.setGeo needs geo: a two-letter country or region code Windows lists (e.g. \"GB\")";
      string before = UserGeo();
      var writes = SysCommon.List(Json.Obj("api", "SetUserGeoName", "geo", geo, "before", before),
                                  Json.Obj("api", "SendNotifyMessage", "message", "WM_SETTINGCHANGE", "lParam", "intl"));
      string would = "set the country or region from " + (before == null ? "(unread)" : (GeoName(before) ?? before)) + " to " + (GeoName(geo) ?? geo);
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary r = SysCommon.Dry(writes, before, null, false);
        r["would"] = would; r["geo"] = geo;
        result = r;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      if (!Native.SetUserGeoName(geo)) return "sysregion.setGeo: Windows refused the country or region (error " + Marshal.GetLastWin32Error() + ")";
      Broadcast();
      string back = UserGeo();
      result = Json.Obj("ok", true, "dryRun", false, "now", back, "name", back == null ? null : GeoName(back),
                        "reason", back == geo ? null : "Windows took the change but reads back " + (back ?? "(unread)"));
      return null;
    }
  }
}
