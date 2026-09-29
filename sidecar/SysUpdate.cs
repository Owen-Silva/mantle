// SysUpdate.cs - Settings > Windows Update for Mantle Settings (lane gameupd, 2026-09-29).
//
// WHY: Mantle Settings replaces Windows Settings (ui/settings/SECTIONS.md). The reads use the
// documented Windows Update Agent COM API (wuapi: Microsoft.Update.Session / AutoUpdate / SystemInfo)
// and the values Windows' own Settings keeps (HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings):
//   update.status                      build, last checked / installed, restart needed, pause, active
//                                      hours, the Advanced switches, Delivery Optimization, Insider,
//                                      the policies that lock rows, and the running check (if any)
//   update.list                        the updates this PC already knows it needs: an OFFLINE search of
//                                      Windows Update's own cache (no network): pending + optional
//   update.history {count?}            the update history (newest first)
//   update.check {dryRun?}             "Check for updates": an ONLINE search through the same API,
//                                      on its own thread (it can take minutes); update.status reports
//                                      it. A real network action: dryRun in tests, refused passive.
//                                      Nothing is downloaded or installed.
//   update.pause {weeks 0-5, dryRun?}  pause (1-5 weeks) or resume (0). HKLM: the
//                                      [Elevated("update.pause")] broker action, one UAC prompt.
//   update.activeHours {start, end, dryRun?}  the same, [Elevated("update.activeHours")].
// Installing, uninstalling, downloading and restarting are NEVER done here. Joining the Insider
// Program, the Advanced switches and Delivery Optimization are READ-ONLY with their reasons.
//
// PRIVACY: nothing here logs. Update titles reach the page only in results.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysUpdate {
    public static void Register(FeatureTable t) {
      t.Add("update.status", Lanes.Slow, Status);
      t.Add("update.list", Lanes.Slow, List);
      t.Add("update.history", Lanes.Slow, History);
      t.Add("update.check", Lanes.Slow, Check);
      t.Add("update.pause", Lanes.Slow, Pause);
      t.Add("update.activeHours", Lanes.Slow, ActiveHours);
    }

    public const string PauseDoes = "pause or resume Windows Update for this PC";
    public const string HoursDoes = "change the active hours Windows Update keeps for this PC";
    const string UX = @"SOFTWARE\Microsoft\WindowsUpdate\UX\Settings";
    const string POL = @"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate";
    static readonly string[] PAUSE_VALUES = { "PauseUpdatesExpiryTime", "PauseUpdatesStartTime", "PauseFeatureUpdatesStartTime",
                                              "PauseFeatureUpdatesEndTime", "PauseQualityUpdatesStartTime", "PauseQualityUpdatesEndTime" };

    // ------------------------------------------------------------------ COM (late bound: no interop dll)
    static object Com(string progId) {
      Type t = Type.GetTypeFromProgID(progId, false);
      if (t == null) throw new InvalidOperationException("Windows Update Agent is not registered (" + progId + ")");
      return Activator.CreateInstance(t);
    }
    static object P(object o, string name) { return o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null); }
    static object At(object coll, int i) { return coll.GetType().InvokeMember("Item", BindingFlags.GetProperty, null, coll, new object[] { i }); }
    static object M(object o, string name, params object[] a) { return o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, a); }
    static void Set(object o, string name, object v) { o.GetType().InvokeMember(name, BindingFlags.SetProperty, null, o, new[] { v }); }
    static int Count(object coll) { return Convert.ToInt32(P(coll, "Count"), CultureInfo.InvariantCulture); }
    /// A WUA date (UTC) as ms since 1970, or null ("never" comes back empty or as year 1899/1601).
    static object Ms(object d) {
      if (!(d is DateTime)) return null;
      DateTime t = DateTime.SpecifyKind((DateTime)d, DateTimeKind.Utc);
      if (t.Year < 2000) return null;
      return Math.Floor((t - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
    }
    static object Session() {
      object s = Com("Microsoft.Update.Session");
      try { Set(s, "ClientApplicationID", "Mantle Settings"); } catch (Exception) { }
      return s;
    }

    // ------------------------------------------------------------------ registry helpers
    static string ReadString(string hive, string key, string name) {
      string w;
      object v = SysCommon.Read(hive, key, name, out w);
      return v as string;
    }
    static long? Num(string hive, string key, string name) { string w; return SysCommon.ReadNumber(hive, key, name, out w); }
    static DateTime? Iso(string s) {
      DateTime d;
      if (string.IsNullOrEmpty(s)) return null;
      if (DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out d)) return d;
      return null;
    }
    static object MsOf(DateTime? d) { return d == null ? null : Ms(d.Value); }

    // ------------------------------------------------------------------ update.status
    static IDictionary Build() {
      const string NT = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
      string build = ReadString("HKLM", NT, "CurrentBuild");
      long? ubr = Num("HKLM", NT, "UBR");
      string name = ReadString("HKLM", NT, "ProductName") ?? "Windows";
      int b;
      if (int.TryParse(build, NumberStyles.Integer, CultureInfo.InvariantCulture, out b) && b >= 22000) name = name.Replace("Windows 10", "Windows 11");
      return Json.Obj("name", name, "version", ReadString("HKLM", NT, "DisplayVersion"), "build", build + (ubr != null ? "." + ubr.Value : ""));
    }

    static IDictionary PauseState() {
      DateTime? until = Iso(ReadString("HKLM", UX, "PauseUpdatesExpiryTime"));
      DateTime? since = Iso(ReadString("HKLM", UX, "PauseUpdatesStartTime"));
      bool paused = until != null && until.Value > DateTime.UtcNow;
      long? max = Num("HKLM", UX, "FlightSettingsMaxPauseDays");
      string locked = Num("HKLM", POL, "SetDisablePauseUXAccess") == 1 ? "a policy on this PC removes Pause updates (WindowsUpdate SetDisablePauseUXAccess = 1)" : null;
      return Json.Obj("paused", paused, "until", MsOf(until), "since", MsOf(since), "maxDays", max ?? 35, "locked", locked,
                      "admin", !SysCommon.Elevated(), "does", PauseDoes);
    }

    static IDictionary HoursState() {
      bool pol = Num("HKLM", POL, "SetActiveHours") == 1;
      long? s = pol ? Num("HKLM", POL, "ActiveHoursStart") : Num("HKLM", UX, "ActiveHoursStart");
      long? e = pol ? Num("HKLM", POL, "ActiveHoursEnd") : Num("HKLM", UX, "ActiveHoursEnd");
      long? smart = Num("HKLM", UX, "SmartActiveHoursState");
      return Json.Obj("start", s ?? 8, "end", e ?? 17, "set", s != null && e != null, "auto", smart == 1,
                      "locked", pol ? "a policy on this PC sets the active hours (WindowsUpdate SetActiveHours = 1)" : null,
                      "admin", !SysCommon.Elevated(), "does", HoursDoes);
    }

    // The Advanced options switches: read-only (see the file head); [key, value name].
    static readonly string[][] FLAGS = {
      new[] { "latest", "IsContinuousInnovationOptedIn" }, new[] { "otherProducts", "AllowMUUpdateService" },
      new[] { "expedite", "IsExpedited" }, new[] { "metered", "AllowAutoWindowsUpdateDownloadOverMeteredNetwork" },
      new[] { "restartNotify", "RestartNotificationsAllowed2" },
    };
    const string FlagWhy = "Mantle changes only pause and active hours so far (each through the administrator prompt)";

    static IDictionary Flags() {
      var o = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string[] f in FLAGS) {
        long? v = Num("HKLM", UX, f[1]);
        o[f[0]] = Json.Obj("on", v == 1, "set", v != null, "name", f[1]);
      }
      o["why"] = FlagWhy;
      return o;
    }

    static IDictionary Delivery() {
      string w;
      long? pol = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization", "DODownloadMode", out w);
      long? mode = pol;
      string why = null;
      if (mode == null) {
        try {
          using (RegistryKey u = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Registry64))
          using (RegistryKey k = u.OpenSubKey(@"S-1-5-20\Software\Microsoft\Windows\CurrentVersion\DeliveryOptimization\Settings", false)) {
            object v = k == null ? null : k.GetValue("DownloadMode");
            if (v is int) mode = (int)v;
            else why = "not set: Windows' default applies (PCs on your local network)";
          }
        } catch (Exception ex) { why = "Windows keeps it in the Delivery Optimization service's own profile (NETWORK SERVICE), which this account may not read (" + SysCommon.Why(ex) + ")"; }
      }
      string words = mode == null ? null : mode == 0 ? "Off (only from Microsoft)" : mode == 1 ? "On: PCs on my local network" : mode == 3 ? "On: PCs on my local network and on the internet"
                   : mode == 99 || mode == 100 ? "Off (bypass mode)" : "Mode " + mode.Value;
      return Json.Obj("mode", mode, "words", words, "policy", pol != null, "why", why,
                      "readOnly", pol != null ? "a policy on this PC sets it (DeliveryOptimization DODownloadMode = " + pol.Value + ")"
                                             : "Windows keeps this in the Delivery Optimization service's own profile (NETWORK SERVICE), which only an administrator's tools change");
    }

    static IDictionary Insider() {
      string branch = ReadString("HKLM", @"SOFTWARE\Microsoft\WindowsSelfHost\UI\Selection", "UIBranch") ??
                      ReadString("HKLM", @"SOFTWARE\Microsoft\WindowsSelfHost\Applicability", "BranchName");
      long? on = Num("HKLM", @"SOFTWARE\Microsoft\WindowsSelfHost\Applicability", "IsBuildFlightingEnabled");
      bool joined = !string.IsNullOrEmpty(branch) || on == 1;
      return Json.Obj("joined", joined, "channel", branch,
                      "why", "Joining or leaving the Windows Insider Program needs your Microsoft account and Microsoft's Insider service, which only Windows' own Settings talks to");
    }

    static string Status(Dictionary<string, object> req, ref object result) {
      object lastCheck = null, lastInstall = null, reboot = null;
      string wuaWhy = null;
      try {
        object r = P(Com("Microsoft.Update.AutoUpdate"), "Results");
        lastCheck = Ms(P(r, "LastSearchSuccessDate"));
        lastInstall = Ms(P(r, "LastInstallationSuccessDate"));
      } catch (Exception ex) { wuaWhy = "Windows Update Agent did not answer: " + SysCommon.Why(ex.InnerException ?? ex); }
      try { reboot = (bool)P(Com("Microsoft.Update.SystemInfo"), "RebootRequired"); }
      catch (Exception) {
        try { using (RegistryKey k = SysCommon.Hive("HKLM").OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired", false)) reboot = k != null; }
        catch (Exception) { reboot = null; }
      }
      string noAuto = Num("HKLM", POL + @"\AU", "NoAutoUpdate") == 1 ? "a policy on this PC turns automatic updates off (WindowsUpdate\\AU NoAutoUpdate = 1)" : null;
      result = Json.Obj("ok", true, "build", Build(), "lastCheck", lastCheck, "lastInstall", lastInstall, "rebootRequired", reboot, "wuaWhy", wuaWhy,
                        "pause", PauseState(), "hours", HoursState(), "flags", Flags(), "delivery", Delivery(), "insider", Insider(),
                        "noAutoUpdate", noAuto, "check", CheckState(), "elevated", SysCommon.Elevated(), "reason", null);
      return null;
    }

    // ------------------------------------------------------------------ update.list (offline) / check (online)
    static IDictionary Item(object u) {
      var kbs = new List<object>();
      try { object k = P(u, "KBArticleIDs"); for (int i = 0; i < Count(k); i++) kbs.Add("KB" + At(k, i)); } catch (Exception) { }
      string kind = "update";
      try {
        if (Convert.ToInt32(P(u, "Type"), CultureInfo.InvariantCulture) == 2) kind = "driver";
        else {
          object cs = P(u, "Categories");
          for (int i = 0; i < Count(cs); i++) {
            string n = (P(At(cs, i), "Name") as string) ?? "";
            if (n == "Definition Updates") kind = "definition";
            else if (n == "Security Updates" || n == "Critical Updates") kind = kind == "update" ? "security" : kind;
            else if (n == "Upgrades") kind = "feature";
          }
        }
      } catch (Exception) { }
      object size = null;
      try { size = Convert.ToDouble(P(u, "MaxDownloadSize"), CultureInfo.InvariantCulture); } catch (Exception) { }
      bool down = false, browse = false;
      try { down = (bool)P(u, "IsDownloaded"); browse = (bool)P(u, "BrowseOnly"); } catch (Exception) { }
      string uid = null;
      try { uid = P(P(u, "Identity"), "UpdateID") as string; } catch (Exception) { }
      return Json.Obj("title", P(u, "Title") as string, "kb", kbs, "kind", kind, "size", size, "downloaded", down, "optional", browse, "uid", uid);
    }

    static void Search(bool online, out List<object> pending, out List<object> optional) {
      object searcher = M(Session(), "CreateUpdateSearcher");
      Set(searcher, "Online", online);
      object res = M(searcher, "Search", "IsInstalled=0 and IsHidden=0");
      object ups = P(res, "Updates");
      pending = new List<object>(); optional = new List<object>();
      for (int i = 0; i < Count(ups); i++) {
        IDictionary it = Item(At(ups, i));
        if ((bool)it["optional"]) optional.Add(it); else pending.Add(it);
      }
    }

    static string List(Dictionary<string, object> req, ref object result) {
      List<object> pending, optional;
      try { Search(false, out pending, out optional); }
      catch (Exception ex) { return "Windows Update's list could not be read: " + SysCommon.Why(ex.InnerException ?? ex); }
      result = Json.Obj("ok", true, "pending", pending, "optional", optional, "offline", true,
                        "note", "What Windows Update already knows this PC needs, from its own cache (Check for updates asks Microsoft again)");
      return null;
    }

    // The one online check at a time. Guarded by CK.
    static readonly object CK = new object();
    static bool _running; static object _started, _finished, _found, _optional; static string _error;
    static IDictionary CheckState() {
      lock (CK) return Json.Obj("running", _running, "started", _started, "finished", _finished, "found", _found, "optional", _optional, "error", _error);
    }
    static object Now() { return Ms(DateTime.UtcNow); }

    static string Check(Dictionary<string, object> req, ref object result) {
      bool dry = Json.GetBool(req, "dryRun", false);
      string would = "search Windows Update online for new updates for this PC (a network check: nothing is downloaded or installed)";
      bool running;
      lock (CK) running = _running;
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "would", would, "running", running, "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": update.check would " + would;
      lock (CK) {
        if (_running) { result = Json.Obj("ok", true, "started", false, "check", CheckState(), "note", "A check is already running"); return null; }
        _running = true; _started = Now(); _finished = null; _error = null; _found = null; _optional = null;
      }
      var th = new Thread(() => {
        List<object> p = null, o = null; string err = null;
        try { Search(true, out p, out o); }
        catch (Exception ex) { err = "Windows Update did not answer: " + SysCommon.Why(ex.InnerException ?? ex); }
        lock (CK) { _running = false; _finished = Now(); _error = err; _found = p == null ? null : (object)p.Count; _optional = o == null ? null : (object)o.Count; }
      });
      th.IsBackground = true; th.Name = "update.check";
      th.Start();
      result = Json.Obj("ok", true, "started", true, "check", CheckState(), "note", "Checking Windows Update: this can take a few minutes");
      return null;
    }

    // ------------------------------------------------------------------ update.history
    static readonly string[] RESULT = { "Not started", "In progress", "Succeeded", "Succeeded with errors", "Failed", "Cancelled" };
    static string History(Dictionary<string, object> req, ref object result) {
      long n = 60;
      object raw;
      if (Json.TryGet(req, "count", out raw)) { string e = SysCommon.Number(req, "count", "update.history", 1, 200, out n); if (e != null) return e; }
      var items = new List<object>();
      int total;
      try {
        object searcher = M(Session(), "CreateUpdateSearcher");
        total = Convert.ToInt32(M(searcher, "GetTotalHistoryCount"), CultureInfo.InvariantCulture);
        if (total > 0) {
          object h = M(searcher, "QueryHistory", 0, (int)Math.Min(n, total));
          for (int i = 0; i < Count(h); i++) {
            object e = At(h, i);
            int op = Convert.ToInt32(P(e, "Operation"), CultureInfo.InvariantCulture);
            int rc = Convert.ToInt32(P(e, "ResultCode"), CultureInfo.InvariantCulture);
            int hr = Convert.ToInt32(P(e, "HResult"), CultureInfo.InvariantCulture);
            string title = P(e, "Title") as string;
            if (string.IsNullOrEmpty(title)) continue;   // Windows keeps a few untitled service records
            items.Add(Json.Obj("title", title, "date", Ms(P(e, "Date")), "op", op == 2 ? "uninstall" : "install",
                               "result", rc >= 0 && rc < RESULT.Length ? RESULT[rc] : "Unknown", "ok", rc == 2 || rc == 3,
                               "code", hr == 0 ? null : "0x" + hr.ToString("X8", CultureInfo.InvariantCulture)));
          }
        }
      } catch (Exception ex) { return "The update history could not be read: " + SysCommon.Why(ex.InnerException ?? ex); }
      result = Json.Obj("ok", true, "total", total, "items", items);
      return null;
    }

    // ------------------------------------------------------------------ pause / active hours (HKLM)
    static string NeedsAdmin(string action, string does, IDictionary args, string would, ref object result) {
      result = Json.Obj("ok", false, "needsAdmin", true, "elevate", Json.Obj("action", action, "args", args), "would", would,
                        "reason", "Windows will ask for administrator permission to " + does);
      return null;
    }

    static string Pause(Dictionary<string, object> req, ref object result) {
      var a = new Dictionary<string, object>(StringComparer.Ordinal);
      object w0;
      if (Json.TryGet(req, "weeks", out w0)) a["weeks"] = w0;
      string why = CheckPause(a);
      if (why != null) return "update.pause: " + why;
      long weeks = (long)(double)a["weeks"];
      bool dry = Json.GetBool(req, "dryRun", false);
      IDictionary st = PauseState();
      if (st["locked"] != null) return "Read only: " + (string)st["locked"];
      string would = weeks == 0 ? "ask for administrator permission to " + PauseDoes + ", then resume updates (removes the pause values in HKLM WindowsUpdate UX Settings)"
                                : "ask for administrator permission to " + PauseDoes + ", then pause updates for " + weeks + " week" + (weeks == 1 ? "" : "s") +
                                  " until " + DateTime.UtcNow.AddDays(7 * weeks).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + " (HKLM WindowsUpdate UX Settings PauseUpdatesExpiryTime and its 5 companions)";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "weeks", weeks, "from", st["paused"], "would", would, "needsAdmin", !SysCommon.Elevated(), "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": update.pause would " + would;
      var args = new Dictionary<string, object>(StringComparer.Ordinal);
      args["weeks"] = (double)weeks;
      if (!SysCommon.Elevated()) return NeedsAdmin("update.pause", PauseDoes, args, would, ref result);
      return DoPause(args, ref result);
    }

    static string ActiveHours(Dictionary<string, object> req, ref object result) {
      object s, e;
      var a = new Dictionary<string, object>(StringComparer.Ordinal);
      if (Json.TryGet(req, "start", out s)) a["start"] = s;
      if (Json.TryGet(req, "end", out e)) a["end"] = e;
      string why = CheckHours(a);
      if (why != null) return "update.activeHours: " + why;
      bool dry = Json.GetBool(req, "dryRun", false);
      IDictionary st = HoursState();
      if (st["locked"] != null) return "Read only: " + (string)st["locked"];
      long start = (long)(double)a["start"], end = (long)(double)a["end"];
      string would = "ask for administrator permission to " + HoursDoes + ", then set active hours to " + start + ":00 - " + end + ":00 (HKLM WindowsUpdate UX Settings ActiveHoursStart = " + start + ", ActiveHoursEnd = " + end + ")";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "from", Json.Obj("start", st["start"], "end", st["end"]), "would", would, "needsAdmin", !SysCommon.Elevated(), "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": update.activeHours would " + would;
      if (!SysCommon.Elevated()) return NeedsAdmin("update.activeHours", HoursDoes, Json.Obj("start", (double)start, "end", (double)end), would, ref result);
      return DoHours(a, ref result);
    }

    static string CheckPause(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "weeks");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("weeks", out v) || !(v is double)) return "weeks must be a whole number from 0 (resume) to 5";
      double d = (double)v;
      if (d != Math.Floor(d) || d < 0 || d > 5) return "weeks must be a whole number from 0 (resume) to 5";
      return null;
    }
    static string CheckHours(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "start", "end");
      if (why != null) return why;
      object s, e;
      if (!args.TryGetValue("start", out s) || !(s is double) || !args.TryGetValue("end", out e) || !(e is double)) return "start and end must be hours from 0 to 23";
      double a = (double)s, b = (double)e;
      if (a != Math.Floor(a) || b != Math.Floor(b) || a < 0 || a > 23 || b < 0 || b > 23) return "start and end must be whole hours from 0 to 23";
      if (a == b) return "active hours must span at least one hour";
      if ((((long)b - (long)a) + 24) % 24 > 18) return "Windows allows active hours of up to 18 hours";
      return null;
    }

    static string WriteSz(string name, string value) {
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.CreateSubKey(UX, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
          if (k == null) return "the Windows Update settings key could not be opened for writing";
          k.SetValue(name, value, RegistryValueKind.String);
        }
      } catch (Exception ex) { return "Windows refused the write: " + SysCommon.Why(ex); }
      return ReadString("HKLM", UX, name) == value ? null : "the value was written but reads back differently";
    }
    static string Delete(string name) {
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.OpenSubKey(UX, true)) { if (k != null) k.DeleteValue(name, false); }
      } catch (Exception ex) { return "Windows refused to remove a value: " + SysCommon.Why(ex); }
      return null;
    }

    /// Pause: the six values Windows' own Settings writes (UTC, ISO 8601), or all six removed to resume.
    /// No shell, no command line: the registry API only (sidecar/ELEVATE.md).
    [Elevated("update.pause", "CheckPause", PauseDoes)]
    static string DoPause(Dictionary<string, object> args, ref object result) {
      long weeks = (long)(double)args["weeks"];
      if (weeks == 0) {
        foreach (string n in PAUSE_VALUES) { string err = Delete(n); if (err != null) return "Windows Update was not resumed (" + err + ")"; }
        result = Json.Obj("paused", false, "value", "0", "note", "Updates resumed: Windows Update checks again on its own schedule");
        return null;
      }
      DateTime now = DateTime.UtcNow, until = now.AddDays(7 * weeks);
      string a = now.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture), z = until.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
      string[] vals = { z, a, a, z, a, z };
      for (int i = 0; i < PAUSE_VALUES.Length; i++) {
        string err = WriteSz(PAUSE_VALUES[i], vals[i]);
        if (err != null) return "Windows Update was not paused (" + err + (i > 0 ? ", after " + i + " of 6 values" : "") + ")";
      }
      result = Json.Obj("paused", true, "until", Ms(until), "value", weeks.ToString(CultureInfo.InvariantCulture),
                        "note", "Updates paused until " + until.ToLocalTime().ToString("d MMMM", CultureInfo.CurrentCulture));
      return null;
    }

    [Elevated("update.activeHours", "CheckHours", HoursDoes)]
    static string DoHours(Dictionary<string, object> args, ref object result) {
      long s = (long)(double)args["start"], e = (long)(double)args["end"];
      string err = SysCommon.WriteNumber("HKLM", UX, "ActiveHoursStart", s, false) ?? SysCommon.WriteNumber("HKLM", UX, "ActiveHoursEnd", e, false);
      if (err != null) return "Windows did not change the active hours (" + err + ")";
      result = Json.Obj("start", s, "end", e, "note", "Active hours are " + s + ":00 to " + e + ":00: Windows Update will not restart this PC then");
      return null;
    }
  }
}
