// Search.cs - `search`: main's launcher.files command, and the Windows Search service/scope report.
//
// Since 2026-09-29 the QUERY half lives in SearchIndex.cs, the one file-search engine Mantle has:
// `search {q}` is forwarded there as-is (same request, same answer shape, same latest-wins slot and
// workers as the Win+S feature's `search.files`), so the launcher ranks and filters files the same
// whether the Win+S feature is on or off. What stays here:
//   `search {status:true}`  the report below, flat, with the engine's counters
//   Status()                that report (also read by SysPrivacySecurity.cs and search.status)
//
// WHY THE INDEX, not a directory walk. The user's profile is hundreds of thousands of files, and a walk
// that has to stat all of them to answer "rep" would take seconds every keystroke. Windows has
// already done that work: SearchIndexer keeps a property store of every file name under the
// indexed roots, and its OLE DB provider (Search.CollatorDSO) answers a name query from that store.
// System.Data's OleDb reaches it from this csc-built exe with no new dependency.
//
// WHY ITS OWN THREADS, and not a lane (MEASURED 2026-09-22): most 3+ letter names answer in
// 60-300 ms warm, but a prefix that matches thousands of files - "a", "50" - took 1.3 s and 5-9 s.
// On a lane that would put icons, pins, launches or window placement behind a file search, so the
// dispatcher only HANDS the query over and SearchIndex.cs's workers run it.
//
// THE REPORT IS PLAIN WORDS. Its `reason` is shown on screen (the launcher's Files footer, the
// Settings privacy page), so it says what is wrong and what to do, with no service short names,
// exception text or error codes. It is READ-ONLY: a service state and registry reads.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.ServiceProcess;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  static class Search {
    public const int DefaultMax = 8;
    // How long a service/scope report stays good. The registry rules and the service state change
    // when a person opens Indexing Options or Services - not between two keystrokes.
    const int StatusFreshMs = 30000;

    static readonly object _lock = new object();
    static IDictionary _status;          // last Status() report
    static long _statusTs;

    /// On the dispatch lane. `status:true` is answered from a pool thread (the report reads a
    /// service and ~90 registry keys: MEASURED 28-51 ms); a query goes to SearchIndex's workers.
    /// Returns a plain error when the request itself is unusable; null = the answer comes later.
    public static string Enqueue(Dictionary<string, object> req, object id) {
      if (Json.GetBool(req, "status", false)) {
        bool fresh = Json.GetBool(req, "fresh", false);
        ThreadPool.QueueUserWorkItem(delegate (object unused) {
          IDictionary st = StatusCached(fresh);
          var copy = Json.Obj();
          if (st != null) foreach (DictionaryEntry e in st) copy[e.Key] = e.Value;
          foreach (DictionaryEntry e in SearchIndex.Stats()) copy[e.Key] = e.Value;   // counters are never cached
          copy["ageMs"] = Lanes.MsSince(StatusTs());
          Program.ReplyFromWorker(id, true, copy, null);
        });
        return null;
      }
      return SearchIndex.Enqueue(req, id, "search", DefaultMax);
    }

    static long StatusTs() { lock (_lock) return _statusTs; }

    /// The report, at most StatusFreshMs old unless `force`.
    public static IDictionary StatusCached(bool force) {
      lock (_lock) {
        if (!force && _status != null && Lanes.MsSince(_statusTs) < StatusFreshMs) return _status;
      }
      IDictionary st;
      try { st = Status(); } catch (Exception ex) {
        st = Json.Obj("ok", false, "serviceOk", null, "scopeIndexed", null, "detail", ex.GetType().Name,
                      "reason", "Mantle couldn't check Windows Search, so file results may be missing.");
      }
      lock (_lock) { _status = st; _statusTs = Stopwatch.GetTimestamp(); }
      return st;
    }

    /// READ-ONLY: the WSearch service's state and start type, and which folders the index covers
    /// (the crawl-scope rules Indexing Options keeps under HKLM). Nothing here changes either.
    public static IDictionary Status() {
      string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

      string svcState = null, svcReason = null;
      bool? svcOk = null;
      try {
        using (var sc = new ServiceController("WSearch")) {
          ServiceControllerStatus s = sc.Status;          // throws when the service does not exist
          svcState = s.ToString();
          svcOk = s == ServiceControllerStatus.Running;
        }
      } catch (Exception) {
        svcState = "Missing";
        svcOk = false;
        svcReason = "Windows Search isn't installed on this PC, so files can't be searched.";
      }
      string start = StartType();
      if (svcOk == false && svcReason == null) {
        svcReason = start == "Disabled"
          ? "Windows Search is turned off, so files can't be searched. To turn it on, open Services, " +
            "double-click Windows Search, set Startup type to Automatic and select Start."
          : "Windows Search isn't running, so files can't be searched. Restart your PC, or open Services " +
            "and start Windows Search.";
      }

      var included = new List<object>();
      var excluded = new List<string>();
      string scopeReason = null;
      bool? scopeIndexed = null;
      // The crawl-scope rules. Each is a URL like file:///C:\[{volume guid}]\Users\ with
      // Include 1/0; the most specific rule that covers a path decides whether it is indexed.
      var rules = new List<KeyValuePair<string, bool>>();
      try {
        using (RegistryKey root = Registry.LocalMachine.OpenSubKey(
                 @"SOFTWARE\Microsoft\Windows Search\CrawlScopeManager\Windows\SystemIndex\WorkingSetRules")) {
          if (root != null) {
            foreach (string sub in root.GetSubKeyNames()) {
              using (RegistryKey k = root.OpenSubKey(sub)) {
                if (k == null) continue;
                string url = Convert.ToString(k.GetValue("URL"), CultureInfo.InvariantCulture);
                object inc = k.GetValue("Include");
                string p = RulePath(url);
                if (p == null) continue;
                bool isInc = inc is int && (int)inc != 0;
                rules.Add(new KeyValuePair<string, bool>(p, isInc));
                if (isInc) included.Add(p);
                else if (p.StartsWith(profile + "\\", StringComparison.OrdinalIgnoreCase)) excluded.Add(p);
              }
            }
          }
        }
      } catch (Exception) {
        rules.Clear();                     // unknown, not "not indexed": say nothing rather than guess
      }

      if (rules.Count > 0) {
        // Most specific rule wins: the longest rule path that the profile sits under.
        string best = null; bool bestInc = false;
        string probe = profile + "\\";
        foreach (var kv in rules) {
          string rp = kv.Key.Replace("*", "");
          if (kv.Key.IndexOf('*') >= 0) continue;    // wildcard rules are the Windows defaults for temp/AppData
          if (probe.StartsWith(rp, StringComparison.OrdinalIgnoreCase) && (best == null || rp.Length > best.Length)) {
            best = rp; bestInc = kv.Value;
          }
        }
        scopeIndexed = best != null && bestInc;
        if (scopeIndexed == false) {
          scopeReason = best == null
            ? "Your user folder isn't in the Windows Search index, so files there can't be found. " +
              "Add it in Indexing Options (search Windows settings for \"Indexing Options\")."
            : "Your user folder is left out of the Windows Search index, so files there can't be found. " +
              "Include it again in Indexing Options.";
        }
      }

      excluded.Sort(StringComparer.OrdinalIgnoreCase);
      string reason = svcOk == false ? svcReason : scopeReason;
      IDictionary stats = SearchIndex.Stats();
      return Json.Obj("ok", svcOk == true && scopeIndexed != false,
                      "service", svcState, "startType", start, "serviceOk", svcOk,
                      "profile", profile, "scopeIndexed", scopeIndexed,
                      "indexedRoots", included, "excludedUnderProfile", excluded.Count,
                      "excludedSample", excluded.Count > 6 ? excluded.GetRange(0, 6) : excluded,
                      "served", stats["served"], "superseded", stats["superseded"], "failed", stats["failed"],
                      "reason", reason);
    }

    /// file:///C:\[{guid}]\Users\ -> C:\Users\ (the volume guid is dropped).
    static string RulePath(string url) {
      if (string.IsNullOrEmpty(url) || !url.StartsWith("file:///", StringComparison.OrdinalIgnoreCase)) return null;
      string p = url.Substring("file:///".Length);
      int lb = p.IndexOf("[");
      int rb = p.IndexOf("]\\");
      if (lb >= 0 && rb > lb) p = p.Substring(0, lb) + p.Substring(rb + 2);
      return p;
    }

    static string StartType() {
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\WSearch")) {
          if (k == null) return null;
          object v = k.GetValue("Start");
          if (!(v is int)) return null;
          switch ((int)v) {
            case 2: return Convert.ToInt32(k.GetValue("DelayedAutostart", 0), CultureInfo.InvariantCulture) == 1
                      ? "Automatic (delayed)" : "Automatic";
            case 3: return "Manual";
            case 4: return "Disabled";
            default: return "start=" + (int)v;
          }
        }
      } catch (Exception) {
        return null;
      }
    }
  }
}
