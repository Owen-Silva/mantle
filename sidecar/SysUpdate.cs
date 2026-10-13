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
//   update.smartHours {on, dryRun?}    "Adjust active hours: Automatically / Manually": HKLM UX Settings
//                                      SmartActiveHoursState, 1 = Windows sets the active hours from use,
//                                      2 = you set them (winaero.com "automatically adjust active hours";
//                                      geekrewind.com says 0 for off: reads treat anything but 1 as manual).
//                                      [Elevated("update.smartHours")], one UAC prompt.
// update.pause {weeks, extend:true} while paused EXTENDS the pause from its ORIGINAL start: Windows'
// limit (FlightSettingsMaxPauseDays, 35 days) counts from PauseUpdatesStartTime, so only the end values
// move; a fresh pause while paused is refused (it would restart the count). Microsoft support, "Pause
// updates": after the limit, updates must be installed before Windows can be paused again.
// update.status carries "installing" (IUpdateInstaller.IsBusy, a read: no installer method is ever
// called) and the last check's HRESULT as check.code (never shown: main turns it into words, e.g. "busy").
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
      t.Add("update.smartHours", Lanes.Slow, SmartHours);
    }

    public const string PauseDoes = "pause or resume Windows Update for this PC";
    public const string HoursDoes = "change the active hours Windows Update keeps for this PC";
    public const string SmartDoes = "change how Windows Update sets the active hours for this PC";
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
      return Json.Obj("start", s ?? 8, "end", e ?? 17, "set", s != null && e != null, "auto", !pol && smart == 1, "autoSet", smart != null,
                      "locked", pol ? "a policy on this PC sets the active hours (WindowsUpdate SetActiveHours = 1)" : null,
                      "admin", !SysCommon.Elevated(), "does", HoursDoes, "smartDoes", SmartDoes);
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
      object installing = null;
      try { installing = (bool)P(M(Session(), "CreateUpdateInstaller"), "IsBusy"); }   // a read: no installer method is called
      catch (Exception) { installing = null; }
      string noAuto = Num("HKLM", POL + @"\AU", "NoAutoUpdate") == 1 ? "a policy on this PC turns automatic updates off (WindowsUpdate\\AU NoAutoUpdate = 1)" : null;
      result = Json.Obj("ok", true, "build", Build(), "lastCheck", lastCheck, "lastInstall", lastInstall, "rebootRequired", reboot, "wuaWhy", wuaWhy,
                        "pause", PauseState(), "hours", HoursState(), "flags", Flags(), "delivery", Delivery(), "insider", Insider(),
                        "noAutoUpdate", noAuto, "installing", installing, "check", CheckState(), "elevated", SysCommon.Elevated(), "reason", null);
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
    static bool _running; static object _started, _finished, _found, _optional; static string _error, _code;
    static IDictionary CheckState() {
      lock (CK) return Json.Obj("running", _running, "started", _started, "finished", _finished, "found", _found, "optional", _optional, "error", _error, "code", _code);
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
        _running = true; _started = Now(); _finished = null; _error = null; _code = null; _found = null; _optional = null;
      }
      var th = new Thread(() => {
        List<object> p = null, o = null; string err = null, code = null;
        try { Search(true, out p, out o); }
        catch (Exception ex) {
          Exception x = ex.InnerException ?? ex;
          // words here, the code apart: main says what it means (busy, no network...), the page never shows it
          err = "Windows Update stopped the check without saying why";
          code = "0x" + System.Runtime.InteropServices.Marshal.GetHRForException(x).ToString("X8", CultureInfo.InvariantCulture);
        }
        lock (CK) { _running = false; _finished = Now(); _error = err; _code = code; _found = p == null ? null : (object)p.Count; _optional = o == null ? null : (object)o.Count; }
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
      object w0, x0;
      if (Json.TryGet(req, "weeks", out w0)) a["weeks"] = w0;
      if (Json.TryGet(req, "extend", out x0)) a["extend"] = x0;
      string why = CheckPause(a);
      if (why != null) return "update.pause: " + why;
      long weeks = (long)(double)a["weeks"];
      bool extend = a.ContainsKey("extend") && (bool)a["extend"];
      bool dry = Json.GetBool(req, "dryRun", false);
      IDictionary st = PauseState();
      if (st["locked"] != null) return "Read only: " + (string)st["locked"];
      DateTime from = DateTime.UtcNow, until = from; DateTime? end = null;
      if (weeks > 0) { string no = PausePlan(weeks, extend, out from, out until, out end); if (no != null) return no; }
      string ask = "ask for administrator permission to " + PauseDoes + ", then ";
      string would = weeks == 0 ? ask + "resume updates (removes the pause values in HKLM WindowsUpdate UX Settings)"
                   : extend ? ask + "extend the pause to " + Ymd(until) + ", " + weeks + " week" + (weeks == 1 ? "" : "s") + " from the day it began (" + Ymd(from) +
                              "; PauseUpdatesExpiryTime and the two other end values move, the start stays)"
                   : ask + "pause updates for " + weeks + " week" + (weeks == 1 ? "" : "s") + " until " + Ymd(until) + " (HKLM WindowsUpdate UX Settings PauseUpdatesExpiryTime and its 5 companions)";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "weeks", weeks, "extend", extend, "until", weeks == 0 ? null : Ms(until), "since", weeks == 0 ? null : Ms(from),
                                   "from", st["paused"], "would", would, "needsAdmin", !SysCommon.Elevated(), "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": update.pause would " + would;
      var args = new Dictionary<string, object>(StringComparer.Ordinal);
      args["weeks"] = (double)weeks;
      if (extend) args["extend"] = true;
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

    static string SmartHours(Dictionary<string, object> req, ref object result) {
      var a = new Dictionary<string, object>(StringComparer.Ordinal);
      object v;
      if (Json.TryGet(req, "on", out v)) a["on"] = v;
      string why = CheckSmart(a);
      if (why != null) return "update.smartHours: " + why;
      bool on = (bool)a["on"];
      bool dry = Json.GetBool(req, "dryRun", false);
      IDictionary st = HoursState();
      if (st["locked"] != null) return "Read only: " + (string)st["locked"];
      string would = "ask for administrator permission to " + SmartDoes + ", then " + (on ? "let Windows set the active hours from when you use this PC" : "keep the active hours you set") +
                     " (HKLM WindowsUpdate UX Settings SmartActiveHoursState = " + (on ? 1 : 2) + ")";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "from", st["auto"], "would", would, "needsAdmin", !SysCommon.Elevated(), "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": update.smartHours would " + would;
      if (!SysCommon.Elevated()) return NeedsAdmin("update.smartHours", SmartDoes, Json.Obj("on", on), would, ref result);
      return DoSmart(a, ref result);
    }

    static string CheckSmart(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "on");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("on", out v) || !(v is bool)) return "on must be true (Windows sets the active hours) or false (you set them)";
      return null;
    }

    static string CheckPause(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "weeks", "extend");
      if (why != null) return why;
      object v, x;
      if (!args.TryGetValue("weeks", out v) || !(v is double)) return "weeks must be a whole number from 0 (resume) to 5";
      double d = (double)v;
      if (d != Math.Floor(d) || d < 0 || d > 5) return "weeks must be a whole number from 0 (resume) to 5";
      if (args.TryGetValue("extend", out x)) {
        if (!(x is bool)) return "extend must be true or false";
        if ((bool)x && d == 0) return "only a pause can be extended (weeks 1 to 5)";
      }
      return null;
    }

    static string Day(DateTime utc) { return utc.ToLocalTime().ToString("d MMMM", CultureInfo.CurrentCulture); }
    static string Ymd(DateTime utc) { return utc.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture); }
    static string Z(DateTime utc) { return utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture); }

    /// What a pause of `weeks` does NOW (the dry run and the elevated write both ask, so the broker decides
    /// from the registry as it is when it runs). A new pause runs from now. An extension keeps the pause's
    /// ORIGINAL start (PauseUpdatesStartTime) and moves only its end: Windows' limit counts from the day the
    /// pause began, so extending from "now" would quietly stretch it. The refusal in words, or null.
    static string PausePlan(long weeks, bool extend, out DateTime from, out DateTime until, out DateTime? end) {
      DateTime now = DateTime.UtcNow;
      end = Iso(ReadString("HKLM", UX, "PauseUpdatesExpiryTime"));
      DateTime? start = Iso(ReadString("HKLM", UX, "PauseUpdatesStartTime"));
      bool paused = end != null && end.Value > now;
      long max = Num("HKLM", UX, "FlightSettingsMaxPauseDays") ?? 35;
      from = now; until = now.AddDays(7 * weeks);
      if (weeks * 7 > max) return "Windows allows a pause of up to " + max + " days in all";
      if (!extend) return paused ? "Updates are already paused until " + Day(end.Value) + ": extend that pause instead (a new pause would restart Windows' count)" : null;
      if (!paused) return "Updates are not paused any more, so there is no pause to extend; nothing changed";
      if (start == null || start.Value > now) return "Windows did not record when this pause began, so Mantle cannot extend it; resume updates, then pause again";
      from = start.Value; until = start.Value.AddDays(7 * weeks);
      if (until <= end.Value) return "The pause already runs until " + Day(end.Value) + "; choose a later date to extend it";
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
      bool extend = args.ContainsKey("extend") && (bool)args["extend"];
      DateTime from, until; DateTime? end;
      string no = PausePlan(weeks, extend, out from, out until, out end);
      if (no != null) return (extend ? "The pause was not extended: " : "Windows Update was not paused: ") + no;
      if (extend) {
        string[] ends = { "PauseUpdatesExpiryTime", "PauseFeatureUpdatesEndTime", "PauseQualityUpdatesEndTime" };
        for (int i = 0; i < ends.Length; i++) {
          string err = WriteSz(ends[i], Z(until));
          if (err != null) return "The pause was not extended (" + err + (i > 0 ? ", after " + i + " of 3 values" : "") + ")";
        }
        result = Json.Obj("paused", true, "until", Ms(until), "since", Ms(from), "value", "paused",
                          "note", "Updates paused until " + Day(until) + ", counted from " + Day(from));
        return null;
      }
      string a = Z(from), z = Z(until);
      string[] vals = { z, a, a, z, a, z };
      for (int i = 0; i < PAUSE_VALUES.Length; i++) {
        string err = WriteSz(PAUSE_VALUES[i], vals[i]);
        if (err != null) return "Windows Update was not paused (" + err + (i > 0 ? ", after " + i + " of 6 values" : "") + ")";
      }
      result = Json.Obj("paused", true, "until", Ms(until), "value", weeks.ToString(CultureInfo.InvariantCulture),
                        "note", "Updates paused until " + until.ToLocalTime().ToString("d MMMM", CultureInfo.CurrentCulture));
      return null;
    }

    [Elevated("update.smartHours", "CheckSmart", SmartDoes)]
    static string DoSmart(Dictionary<string, object> args, ref object result) {
      bool on = (bool)args["on"];
      string err = SysCommon.WriteNumber("HKLM", UX, "SmartActiveHoursState", on ? 1 : 2, false);
      if (err != null) return "Windows did not change how the active hours are set (" + err + ")";
      if ((Num("HKLM", UX, "SmartActiveHoursState") == 1) != on) return "Windows kept the old setting: the value reads back differently";
      result = Json.Obj("auto", on, "value", on ? "auto" : "manual",
                        "note", on ? "Windows now sets the active hours from when you use this PC" : "Active hours are the ones you set");
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
