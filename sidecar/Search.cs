// Search.cs - `search`: the launcher's file results, straight out of the Windows Search index.
//
// WHY THE INDEX, not a directory walk. Owen's profile is hundreds of thousands of files (the
// 2026-09-14 census counted 408k lines of code alone, in repos that sit under it), and a walk
// that has to stat all of them to answer "rep" would take seconds every keystroke. Windows has
// already done that work: SearchIndexer keeps a property store of every file name under the
// indexed roots, and its OLE DB provider (Search.CollatorDSO) answers a TOP 8 name query from
// that store. System.Data's OleDb reaches it from this csc-built exe with no new dependency -
// System.Data.dll ships with .NET Framework 4 like everything else here.
//
// WHY ITS OWN THREADS, and not a lane. A query is an RPC into another process (SearchIndexer.exe)
// on a machine that runs simulations at ~70% CPU. MEASURED HERE, 2026-09-22, through this file:
// most 3+ letter names answer in 60-300 ms warm (the first query of a session adds ~160 ms to
// open the provider), but a prefix that matches thousands of files - "a", "50" - has to sort all
// of them by date and took 1.3 s and 5-9 s. On the slow lane that would put icons, pins, launches
// and the tray behind a file search; on the ui lane it would put window placement behind it. So
// the dispatcher only HANDS the query over (Enqueue takes a lock and returns; the command answers
// later, the way `morph` does) and this file's own workers run it.
//
// LATEST WINS. The launcher debounces typing by ~150 ms and then asks for every query it wants,
// but only the newest one matters to the person typing. There is ONE pending slot: a new query
// replaces the one waiting in it (whose caller gets `cancelled` at once), and a query that is
// already running is marked superseded and answered `cancelled` when it returns - its rows are
// never sent, because they would be for a word nobody is typing any more. Every id still gets
// exactly one answer: a promise that never settles is worse than a failure.
//
// WHY TWO WORKERS AND NO Cancel(). The obvious way to stop a superseded query is
// OleDbCommand.Cancel(). MEASURED, 2026-09-22: on this provider it does not interrupt anything -
// it BLOCKS its caller until the query finishes. Called from Enqueue it froze the dispatch thread
// for 16.4 s behind a slow query (a `ping` sent meanwhile waited just as long) and the query ran
// to the end anyway. A native call cannot be aborted safely either. So a superseded query is left
// to finish on its own, and the newest query starts at once on a SECOND worker. At most MaxWorkers
// run; a query that arrives while both are busy waits for the first to come free.
//
// NOTHING FAILS SILENTLY. If the index cannot answer, the reply is a RESULT with ok:false and a
// reason in plain words, and the reason says WHY: the WSearch service is stopped or disabled,
// the profile is not an indexed location, or the provider's own error text. `status:true` asks
// for that report on its own (read-only: the service state and the crawl-scope rules the
// Indexing Options dialog writes to the registry).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  static class Search {
    public const int DefaultMax = 8, HardMax = 40;
    const int MaxWorkers = 2;
    const string ConnStr = "Provider=Search.CollatorDSO;Extended Properties='Application=Windows'";

    // An open connection costs a round trip to the indexer (~160 ms the first time); keeping them
    // while somebody is typing saves that on every keystroke. A worker with nothing to do for this
    // long exits, and the last one out closes the connections, so an idle launcher holds nothing
    // open inside SearchIndexer.
    const int IdleExitMs = 30000;

    // Folders that are never what a person means when they type a file name into a launcher, and
    // that swamp everything else: MEASURED 2026-09-22, 7 of the 8 newest "rep" matches in Owen's
    // profile were inside node_modules. Filtered in the query (NOT ... LIKE), which cost ~50 ms
    // against the same query unfiltered, rather than after it, which would need a far bigger TOP.
    // (No __pycache__: "_" is LIKE's one-character wildcard, and escaping it is the bracket form
    // that measured 4.5 s - see Run.)
    static readonly string[] NoiseDirs = { "node_modules", ".git", "site-packages" };
    // LevelDB's fixed file names. Every Chromium or Electron profile is full of them, and dev
    // tools leave those profiles all over a profile folder (MEASURED 2026-09-22: "lock" returned
    // eight LOCK files from one automation profile and nothing else). Nobody types these meaning them.
    static readonly string[] NoiseNames = { "LOCK", "LOG", "LOG.old", "CURRENT" };
    // How long a service/scope report stays good. The registry rules and the service state change
    // when a person opens Indexing Options or services.msc - not between two keystrokes.
    const int StatusFreshMs = 30000;

    sealed class Job {
      public object Id;
      public string Q;
      public string Scope;
      public int Max;
      public long ArrivedTs;
      public int TtlMs;
      public volatile bool Superseded;
    }

    static readonly object _lock = new object();
    static Job _pending;                                   // the newest query not yet started: the one slot
    static readonly List<Job> _running = new List<Job>();  // queries on a worker right now
    static int _workers;                                   // worker threads alive
    // Idle connections, handed to whichever worker runs next. A connection is used by one
    // worker at a time; the provider is free-threaded, so which thread does not matter.
    static readonly Stack<OleDbConnection> _idle = new Stack<OleDbConnection>();
    static int _served, _superseded, _failed;

    static IDictionary _status;          // last Status() report
    static long _statusTs;

    /// On the dispatch lane: validate, hand the query to the worker, return at once. The caller
    /// answers `Program.Deferred`; the worker replies. Returns a plain-words error when the
    /// request itself is unusable (that one IS answered by the dispatcher, as an error).
    public static string Enqueue(Dictionary<string, object> req, object id) {
      if (Json.GetBool(req, "status", false)) {
        // The report reads a service and ~90 registry keys: MEASURED 28-51 ms here, which is too
        // long for the dispatch lane, so it is answered from a pool thread like a query is.
        bool fresh = Json.GetBool(req, "fresh", false);
        ThreadPool.QueueUserWorkItem(delegate (object unused) {
          Program.ReplyFromWorker(id, true, StatusCached(fresh), null);
        });
        return null;
      }
      string q = (Json.GetString(req, "q") ?? "").Trim();
      if (q.Length == 0) return "search needs q: the text to look for";
      if (q.Length > 200) return "search: q is longer than 200 characters";
      int max = Json.GetInt(req, "max", DefaultMax);
      if (max < 1 || max > HardMax) return "search: max must be 1.." + HardMax;
      string scope = Json.GetString(req, "scope");
      if (string.IsNullOrEmpty(scope)) scope = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      string serr = CheckScope(scope);
      if (serr != null) return serr;

      var job = new Job();
      job.Id = id;
      job.Q = q;
      job.Scope = scope.TrimEnd('\\', '/');
      job.Max = max;
      job.ArrivedTs = Stopwatch.GetTimestamp();
      object rawTtl;
      if (req.TryGetValue("ttl", out rawTtl) && rawTtl is double) {
        double d = (double)rawTtl;
        if (d > 0 && d < int.MaxValue) job.TtlMs = (int)d;
      }

      // Nothing in here waits on the provider: this runs on the dispatch lane.
      Job dropped = null;
      bool spawn = false;
      lock (_lock) {
        if (_pending != null) dropped = _pending;
        _pending = job;
        foreach (Job r in _running) r.Superseded = true;
        // A worker is free when there are more workers than running queries; it is waiting on
        // the lock and the Pulse below wakes it. Otherwise start one, up to MaxWorkers.
        if (_workers <= _running.Count && _workers < MaxWorkers) {
          _workers++;
          spawn = true;
        }
        Monitor.Pulse(_lock);
      }
      if (spawn) {
        var t = new Thread(WorkerLoop);
        t.IsBackground = true;               // must never hold the process open
        t.Name = "mantle-search";
        // MTA: this thread has no message pump, and the provider is free-threaded. An STA with no
        // pump is where a cross-apartment callback would deadlock.
        t.SetApartmentState(ApartmentState.MTA);
        t.Start();
      }
      if (dropped != null) {
        Interlocked.Increment(ref _superseded);
        Program.ReplyCancelled(dropped.Id);
      }
      return null;
    }

    /// Only an absolute local folder, and never one with a quote in it: the scope is spliced
    /// into the SQL as a string literal, so a quote would be the one way to break out of it.
    static string CheckScope(string scope) {
      if (scope.IndexOf('\'') >= 0 || scope.IndexOf('"') >= 0) return "search: scope may not contain quotes";
      if (scope.Length < 3 || scope[1] != ':' || (scope[2] != '\\' && scope[2] != '/'))
        return "search: scope must be an absolute folder like C:\\Users\\you (got \"" + scope + "\")";
      return null;
    }

    static void WorkerLoop() {
      for (;;) {
        Job job;
        OleDbConnection conn = null;
        lock (_lock) {
          while (_pending == null) {
            if (!Monitor.Wait(_lock, IdleExitMs) && _pending == null) {
              _workers--;
              if (_workers == 0) {
                while (_idle.Count > 0) { try { _idle.Pop().Dispose(); } catch (Exception) { } }
              }
              return;
            }
          }
          job = _pending;
          _pending = null;
          _running.Add(job);
          if (_idle.Count > 0) conn = _idle.Pop();
        }

        IDictionary result = null;
        string error = null;
        long waited = Lanes.MsSince(job.ArrivedTs);
        if (job.TtlMs > 0 && waited >= job.TtlMs) {
          error = "expired: \"search\" waited " + waited + " ms, past the caller's " + job.TtlMs +
                  " ms deadline, so it was skipped rather than run for nobody";
        } else {
          try {
            result = Run(job, ref conn);
          } catch (Exception ex) {
            // Run catches the provider's own failures and turns them into reasons; this is the
            // belt for a bug in this file.
            result = Json.Obj("ok", false, "q", job.Q, "items", new object[0],
                              "reason", "file search failed inside the sidecar (" + ex.GetType().Name + ": " + ex.Message + ")");
          }
        }

        bool superseded;
        lock (_lock) {
          superseded = job.Superseded;
          _running.Remove(job);
          if (conn != null) {
            if (_idle.Count < MaxWorkers) _idle.Push(conn);
            else { try { conn.Dispose(); } catch (Exception) { } }
          }
        }
        if (superseded) {
          Interlocked.Increment(ref _superseded);
          Program.ReplyCancelled(job.Id);
        } else if (error != null) {
          Program.ReplyFromWorker(job.Id, false, null, error);
        } else {
          Interlocked.Increment(ref _served);
          Program.ReplyFromWorker(job.Id, true, result, null);
        }
      }
    }

    // --------------------------------------------------------------- the query

    const string Columns = "System.ItemPathDisplay, System.FileName, System.ItemFolderPathDisplay, " +
                           "System.ItemType, System.DateModified, System.Size";

    /// Two passes, so a NAME PREFIX always outranks a word inside a name: "rep" puts report.docx
    /// above final-report.docx. Pass 1 is LIKE 'rep%' on the file name; pass 2, only if pass 1
    /// came up short, is a full-text word-prefix match (CONTAINS '"rep*"') for the rest. Each
    /// pass is newest-first, because the file you touched yesterday is the one you meant.
    static IDictionary Run(Job job, ref OleDbConnection conn) {
      var total = Stopwatch.StartNew();
      var items = new List<object>();
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      string where = "SCOPE='" + Sql("file:" + job.Scope.Replace('\\', '/')) + "'" + NoiseFilter();
      long openMs = 0, prefixMs = -1, wordMs = -1;

      try {
        var t = Stopwatch.StartNew();
        if (conn == null) {
          var c = new OleDbConnection(ConnStr);
          c.Open();                           // throws with the provider's reason when it cannot
          conn = c;
        }
        openMs = t.ElapsedMilliseconds;

        // LIKE's own wildcards typed by a person (%, _, [) would have to be bracket-escaped, and
        // MEASURED 2026-09-22 a bracketed pattern took 4.5 s to find nothing. The word pass
        // matches the same file ("50% off.pdf" is the words 50 and off), so the prefix pass is
        // simply skipped for such a query.
        if (job.Q.IndexOfAny(new[] { '%', '_', '[' }) < 0) {
          t.Restart();
          string sql1 = "SELECT TOP " + job.Max + " " + Columns + " FROM SystemIndex WHERE " + where +
                        " AND System.FileName LIKE '" + Sql(job.Q) + "%' ORDER BY System.DateModified DESC";
          Query(conn, sql1, job, "prefix", items, seen);
          prefixMs = t.ElapsedMilliseconds;
        }

        string contains = ContainsTerms(job.Q);
        if (items.Count < job.Max && contains != null && !job.Superseded) {
          t.Restart();
          // TOP asks for enough to fill the gap AFTER dropping the rows pass 1 already has.
          string sql2 = "SELECT TOP " + (job.Max + items.Count) + " " + Columns + " FROM SystemIndex WHERE " + where +
                        " AND CONTAINS(System.FileName, '" + Sql(contains) + "') ORDER BY System.DateModified DESC";
          Query(conn, sql2, job, "word", items, seen);
          wordMs = t.ElapsedMilliseconds;
        }
      } catch (Exception ex) {
        // A broken connection is not handed back: the next query opens a fresh one.
        if (conn != null) { try { conn.Dispose(); } catch (Exception) { } conn = null; }
        if (job.Superseded) return Json.Obj("ok", false, "q", job.Q, "items", new object[0], "reason", "superseded");
        Interlocked.Increment(ref _failed);
        return Json.Obj("ok", false, "q", job.Q, "items", new object[0],
                        "reason", Explain(ex), "status", StatusCached(true));
      }

      if (items.Count > job.Max) items.RemoveRange(job.Max, items.Count - job.Max);

      // A scope the index does not cover is not an error - the query simply finds nothing
      // there - so it has to be SAID, or an empty list reads as "you have no such file".
      IDictionary st = StatusCached(false);
      string note = null;
      if (st != null && Equals(st["scopeIndexed"], false)) note = (string)st["reason"];

      return Json.Obj("ok", true, "q", job.Q, "scope", job.Scope, "items", items,
                      "ms", total.ElapsedMilliseconds, "openMs", openMs,
                      "prefixMs", prefixMs < 0 ? (object)null : (object)prefixMs,
                      "wordMs", wordMs < 0 ? (object)null : (object)wordMs, "reason", note);
    }

    static string NoiseFilter() {
      var sb = new StringBuilder();
      foreach (string d in NoiseDirs) sb.Append(" AND NOT System.ItemPathDisplay LIKE '%\\").Append(d).Append("\\%'");
      foreach (string n in NoiseNames) sb.Append(" AND System.FileName <> '").Append(n).Append("'");
      return sb.ToString();
    }

    static void Query(OleDbConnection conn, string sql, Job job, string match, List<object> items, HashSet<string> seen) {
      if (job.Superseded) return;             // superseded between passes: do not even start
      using (var cmd = new OleDbCommand(sql, conn)) {
        using (OleDbDataReader r = cmd.ExecuteReader()) {
          while (r.Read()) {
            if (job.Superseded) return;
            string path = AsString(r.GetValue(0));
            if (string.IsNullOrEmpty(path) || !seen.Add(path)) continue;
            string name = AsString(r.GetValue(1));
            if (string.IsNullOrEmpty(name)) name = Path.GetFileName(path);
            string type = AsString(r.GetValue(3));
            bool isDir = string.Equals(type, "Directory", StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(type, "File folder", StringComparison.OrdinalIgnoreCase);
            object modified = null;
            object rawMod = r.GetValue(4);
            if (rawMod is DateTime) {
              modified = ((DateTime)rawMod).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            }
            object size = null;
            object rawSize = r.GetValue(5);
            if (!isDir && rawSize != null && !(rawSize is DBNull)) {
              try { size = Convert.ToInt64(rawSize, CultureInfo.InvariantCulture); } catch (Exception) { size = null; }
            }
            items.Add(Json.Obj("path", path, "name", name, "folder", AsString(r.GetValue(2)),
                               "isDir", isDir, "ext", isDir ? null : type, "modified", modified,
                               "size", size, "match", match));
          }
        }
      }
    }

    static string AsString(object v) {
      if (v == null || v is DBNull) return null;
      // Multi-valued properties come back as arrays; the ones selected here are single-valued,
      // but a provider that disagrees must not turn a path into "System.String[]".
      var arr = v as Array;
      if (arr != null) return arr.Length > 0 && arr.GetValue(0) != null ? arr.GetValue(0).ToString() : null;
      return Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    /// A SQL string literal: quotes doubled. The only escape Windows Search SQL needs.
    static string Sql(string s) {
      return s.Replace("'", "''");
    }

    /// '"final*" AND "rep*"' from "final rep". Only letters and digits survive: CONTAINS has its
    /// own grammar (quotes, parentheses, NEAR, ~), and a person typing a file name is not writing
    /// in it. null when nothing is left to match on.
    static string ContainsTerms(string q) {
      var terms = new List<string>();
      var sb = new StringBuilder();
      foreach (char c in q + " ") {
        if (char.IsLetterOrDigit(c)) { sb.Append(c); continue; }
        if (sb.Length > 0) { terms.Add("\"" + sb.ToString() + "*\""); sb.Length = 0; }
      }
      if (terms.Count == 0 || terms.Count > 8) return null;
      return string.Join(" AND ", terms.ToArray());
    }

    /// The provider's exception, in the words a person needs: if the service is the cause, say
    /// that instead of an HRESULT.
    static string Explain(Exception ex) {
      IDictionary st = StatusCached(true);
      if (st != null && Equals(st["serviceOk"], false)) return (string)st["reason"];
      string msg = ex.Message;
      var oe = ex as OleDbException;
      if (oe != null) msg = msg + " (HRESULT 0x" + oe.ErrorCode.ToString("X8", CultureInfo.InvariantCulture) + ")";
      else if (ex is InvalidOperationException && msg.IndexOf("provider", StringComparison.OrdinalIgnoreCase) >= 0)
        msg = msg + " - the Windows Search OLE DB provider (Search.CollatorDSO) is not registered on this machine";
      return "the Windows Search index did not answer: " + msg;
    }

    // ------------------------------------------------------------- the report

    static IDictionary StatusCached(bool force) {
      lock (_lock) {
        if (!force && _status != null && Lanes.MsSince(_statusTs) < StatusFreshMs) {
          // The service and scope facts can be 30 s old; the counters must not be.
          var copy = Json.Obj();
          foreach (DictionaryEntry e in _status) copy[e.Key] = e.Value;
          copy["served"] = _served;
          copy["superseded"] = _superseded;
          copy["failed"] = _failed;
          copy["ageMs"] = Lanes.MsSince(_statusTs);
          return copy;
        }
      }
      IDictionary st;
      try { st = Status(); } catch (Exception ex) {
        st = Json.Obj("ok", false, "serviceOk", null, "scopeIndexed", null,
                      "reason", "could not read the Windows Search status (" + ex.GetType().Name + ": " + ex.Message + ")");
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
      } catch (Exception ex) {
        svcState = "Missing";
        svcOk = false;
        svcReason = "the Windows Search service (WSearch) is not installed on this machine (" + ex.Message + ")";
      }
      string start = StartType();
      if (svcOk == false && svcReason == null) {
        svcReason = start == "Disabled"
          ? "the Windows Search service (WSearch) is disabled, so there is no file index to ask. Set it to Automatic in services.msc"
          : "the Windows Search service (WSearch) is " + svcState + " (start type " + (start ?? "unknown") +
            "), so there is no file index to ask. Start it in services.msc";
      }

      // The crawl-scope rules. Each is a URL like file:///C:\[{volume guid}]\Users\ with
      // Include 1/0; the most specific rule that covers a path decides whether it is indexed.
      var included = new List<object>();
      var excluded = new List<string>();
      string scopeReason = null;
      bool? scopeIndexed = null;
      var rules = new List<KeyValuePair<string, bool>>();
      try {
        using (RegistryKey root = Registry.LocalMachine.OpenSubKey(
                 @"SOFTWARE\Microsoft\Windows Search\CrawlScopeManager\Windows\SystemIndex\WorkingSetRules")) {
          if (root == null) {
            scopeReason = "the Windows Search crawl scope is not in the registry, so which folders are indexed is unknown";
          } else {
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
      } catch (Exception ex) {
        scopeReason = "could not read which folders are indexed (" + ex.Message + ")";
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
            ? "your profile (" + profile + ") is not an indexed location, so files there cannot be found. Add it in Indexing Options"
            : "your profile (" + profile + ") is excluded from the index by the rule " + best + ", so files there cannot be found";
        }
      }

      excluded.Sort(StringComparer.OrdinalIgnoreCase);
      string reason = svcOk == false ? svcReason : scopeReason;
      return Json.Obj("ok", svcOk == true && scopeIndexed != false,
                      "service", svcState, "startType", start, "serviceOk", svcOk,
                      "profile", profile, "scopeIndexed", scopeIndexed,
                      "indexedRoots", included, "excludedUnderProfile", excluded.Count,
                      "excludedSample", excluded.Count > 6 ? excluded.GetRange(0, 6) : excluded,
                      "served", Thread.VolatileRead(ref _served),
                      "superseded", Thread.VolatileRead(ref _superseded),
                      "failed", Thread.VolatileRead(ref _failed),
                      "reason", reason);
    }

    /// file:///C:\[{guid}]\Users\ -> C:\Users\  (the bracketed part is the volume id). null for
    /// anything that is not a file: rule (the winrt:// rules are app content, not folders).
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
