// SearchIndex.cs - Mantle's ONE file search over the Windows Search index. It answers both
// commands that ask for file rows:
//   `search.files`  the Win+S feature's (lib/features/search.js), through the feature seam
//   `search`        main's launcher.files (Search.cs forwards every query here; it keeps only
//                   the service/scope report and `search {status:true}`)
// and `search.status`, the same report plus this engine's counters.
//
// WHY ONE ENGINE (2026-09-29 quality pass). Until then Search.cs and this file were two copies of
// the same machinery: two latest-wins slots, two pairs of workers, two connection pools, and
// Search.cs without the contains tier, so the launcher found "port" -> report.docx only when the
// Win+S feature was on. The page asks for exactly one of them per keystroke, so the two only ever
// cost double the threads and connections. Now both commands share one slot (the newest query
// from either wins), at most two workers and at most two open connections, and both rank the same.
//
// THE RANKING, per query, all scoped to the user's profile (never node_modules/.git/site-packages,
// never LevelDB's LOCK/LOG/CURRENT, never Office's "~$" owner files, desktop.ini or Thumbs.db,
// never a file Windows marks hidden or system):
//   1. prefix    System.FileName LIKE 'q%'                "rep" -> report.docx
//   2. word      CONTAINS(System.FileName, '"q*"')        "rep" -> final-report.docx
//   3. contains  System.FileName LIKE '%q%'  (one word, 3+ letters)  "port" -> report.docx
// Each tier newest-first (the file you touched yesterday is the one you meant), each only run
// while the tiers above came up short of `max`, rows de-duplicated by path.
// MEASURED 2026-09-24, OLE DB from PowerShell over the same scope: the prefix tier 4-26 ms, a
// contains tier 19-200 ms (TOP 24, "eadme" the slowest). Re-measured 2026-09-29 through this file
// (sidecar/test-search-bench.js): see the numbers in the lane report.
//
// LIKE'S OWN WILDCARDS (% _ [) in what a person typed. Escaping them is the bracket form, which
// MEASURED 4.5 s to find nothing (2026-09-22). Before 2026-09-29 such a query skipped both LIKE
// tiers, so "my_notes" found nothing at all: the word breaker keeps "my_notes" one word, and
// "my*" AND "notes*" never matches it. Now each of those characters goes into the pattern as
// "_" (any one character), which finds a SUPERSET, and the rows are then kept only when their name
// really starts with / contains what was typed. The literal part must still be long enough: a
// query that is only wildcards ("__") runs the word tier alone.
//
// LATEST WINS, NO Cancel(). One pending slot: a newer query replaces the waiting one (answered
// `cancelled` at once) and marks any running one superseded (answered `cancelled` when it
// returns, its rows never sent). OleDbCommand.Cancel() BLOCKS until the query ends on this
// provider (MEASURED 2026-09-22: 16.4 s, a `ping` behind it waited as long), so a superseded
// query finishes on its own and the newest starts on a second worker. Every id gets exactly one
// answer. A worker with nothing to do for IdleExitMs exits; the last one out closes the
// connections, so an idle launcher holds no thread and nothing open inside SearchIndexer.
//
// NOTHING FAILS SILENTLY, IN PLAIN WORDS. A query the index cannot answer comes back ok:false with
// a reason a person can act on (Windows Search is off, your folder is not indexed, Windows Search
// did not answer). No HRESULTs, provider names or exception types reach the reason; `detail`
// carries the exception TYPE only, for mantle.log. A query over an unindexed scope still says why.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class SearchIndex {
    public static void Register(FeatureTable t) {
      // ui lane: both only HAND OFF (a lock and a Pulse) and answer from their own threads.
      t.Add("search.files", Lanes.Ui, Files);
      t.Add("search.status", Lanes.Ui, StatusCmd);
    }

    public const int DefaultMax = 24, HardMax = 40, MaxQueryChars = 200;
    const int MaxWorkers = 2;
    const int IdleExitMs = 30000;          // an idle launcher holds nothing open in SearchIndexer
    const int ContainsMinChars = 3;        // "ab" inside names is most of the disk and means nothing
    const string ConnStr = "Provider=Search.CollatorDSO;Extended Properties='Application=Windows'";
    const string Columns = "System.ItemPathDisplay, System.FileName, System.ItemFolderPathDisplay, " +
                           "System.ItemType, System.DateModified, System.Size, System.FileAttributes";
    // Folders that swamp everything else: MEASURED 2026-09-22, 7 of the 8 newest "rep" matches in
    // Owen's profile were inside node_modules. Filtered in the query (~50 ms) rather than after it.
    static readonly string[] NoiseDirs = { "node_modules", ".git", "site-packages" };
    // Fixed names nobody types meaning them: LevelDB's (every Chromium/Electron profile is full of
    // them; "lock" once returned eight LOCK files and nothing else) and Explorer's own.
    static readonly string[] NoiseNames = { "LOCK", "LOG", "LOG.old", "CURRENT", "desktop.ini", "Thumbs.db" };
    const int AttrHidden = 0x2, AttrSystem = 0x4;

    sealed class Job {
      public object Id;
      public string Cmd;
      public string Q;
      public string Scope;
      public int Max;
      public long ArrivedTs;
      public int TtlMs;
      public volatile bool Superseded;
    }

    static readonly object _lock = new object();
    static Job _pending;
    static readonly List<Job> _running = new List<Job>();
    static int _workers;
    static readonly Stack<OleDbConnection> _idle = new Stack<OleDbConnection>();
    static int _served, _superseded, _failed, _hiddenDropped;

    /// The engine's counters, for both status reports (Search.cs puts them in `search {status}`).
    public static IDictionary Stats() {
      lock (_lock) {
        return Json.Obj("served", _served, "superseded", _superseded, "failed", _failed,
                        "hiddenDropped", _hiddenDropped, "workers", _workers,
                        "openConnections", _idle.Count, "running", _running.Count,
                        "pending", _pending != null);
      }
    }

    // ------------------------------------------------------------ the commands

    static string StatusCmd(Dictionary<string, object> req, ref object result) {
      object id = req.ContainsKey("id") ? req["id"] : null;
      bool fresh = Json.GetBool(req, "fresh", false);
      // The report reads a service and the crawl-scope registry keys (28-51 ms): too long for the
      // ui lane, so a pool thread answers it.
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        IDictionary st = Search.StatusCached(fresh);
        var o = new Dictionary<string, object>(StringComparer.Ordinal);
        if (st != null) foreach (DictionaryEntry kv in st) o[(string)kv.Key] = kv.Value;
        o["stats"] = Stats();
        Program.ReplyFromWorker(id, true, o, null);
      });
      result = Program.Deferred;
      return null;
    }

    static string Files(Dictionary<string, object> req, ref object result) {
      string err = Enqueue(req, req.ContainsKey("id") ? req["id"] : null, "search.files", DefaultMax);
      if (err != null) return err;
      result = Program.Deferred;
      return null;
    }

    /// Both commands' way in, on the dispatch lane: validate, hand the query to a worker, return
    /// at once (the caller answers Program.Deferred; the worker replies). A request that is itself
    /// unusable gets its reason back here, answered by the dispatcher as an error.
    public static string Enqueue(Dictionary<string, object> req, object id, string cmd, int defaultMax) {
      object rawQ;
      if (req.TryGetValue("q", out rawQ) && rawQ != null && !(rawQ is string))
        return cmd + ": q must be text";
      string q = (Json.GetString(req, "q") ?? "").Trim();
      if (q.Length == 0) return cmd + " needs q: the text to look for";
      if (q.Length > MaxQueryChars) return cmd + ": q is longer than " + MaxQueryChars + " characters";
      foreach (char c in q) if (char.IsControl(c)) return cmd + ": q may not contain control characters";
      int max = Json.GetInt(req, "max", defaultMax);
      if (max < 1 || max > HardMax) return cmd + ": max must be 1.." + HardMax;
      string scope = Json.GetString(req, "scope");
      if (string.IsNullOrEmpty(scope)) scope = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      string serr = CheckScope(cmd, scope);
      if (serr != null) return serr;

      var job = new Job();
      job.Id = id;
      job.Cmd = cmd;
      job.Q = q;
      job.Scope = scope.TrimEnd('\\', '/');
      job.Max = max;
      job.ArrivedTs = Stopwatch.GetTimestamp();
      object rawTtl;
      if (req.TryGetValue("ttl", out rawTtl) && rawTtl is double) {
        double d = (double)rawTtl;
        if (d > 0 && d < int.MaxValue) job.TtlMs = Math.Max(1, (int)d);
      }

      Job dropped = null;
      bool spawn = false;
      lock (_lock) {
        dropped = _pending;
        _pending = job;
        foreach (Job r in _running) r.Superseded = true;
        if (_workers <= _running.Count && _workers < MaxWorkers) { _workers++; spawn = true; }
        Monitor.Pulse(_lock);
      }
      if (spawn) {
        var th = new Thread(WorkerLoop);
        th.IsBackground = true;                     // must never hold the process open
        th.Name = "mantle-search-index";
        th.SetApartmentState(ApartmentState.MTA);   // no pump here; the provider is free-threaded
        th.Start();
      }
      if (dropped != null) {
        Interlocked.Increment(ref _superseded);
        Program.ReplyCancelled(dropped.Id);
      }
      return null;
    }

    /// The scope is spliced into the SQL as a string literal: a quote is the one way out of it.
    /// It must be a plain drive folder (C:\...), never a share, a device path or a relative one.
    public static string CheckScope(string cmd, string scope) {
      if (scope.IndexOf('\'') >= 0 || scope.IndexOf('"') >= 0) return cmd + ": scope may not contain quotes";
      foreach (char c in scope) if (char.IsControl(c)) return cmd + ": scope may not contain control characters";
      if (scope.Length < 3 || !char.IsLetter(scope[0]) || scope[1] != ':' || (scope[2] != '\\' && scope[2] != '/'))
        return cmd + ": scope must be an absolute folder like C:\\Users\\you";
      return null;
    }

    // ------------------------------------------------------------- the workers

    static void WorkerLoop() {
      for (;;) {
        Job job;
        OleDbConnection conn = null;
        lock (_lock) {
          while (_pending == null) {
            if (!Monitor.Wait(_lock, IdleExitMs) && _pending == null) {
              _workers--;
              if (_workers == 0) while (_idle.Count > 0) { try { _idle.Pop().Dispose(); } catch (Exception) { } }
              return;
            }
          }
          job = _pending;
          _pending = null;
          _running.Add(job);
          if (_idle.Count > 0) conn = _idle.Pop();
        }

        IDictionary res = null;
        string error = null;
        long waited = Lanes.MsSince(job.ArrivedTs);
        if (job.TtlMs > 0 && waited >= job.TtlMs) {
          error = "expired: \"" + job.Cmd + "\" waited " + waited + " ms, past the caller's " + job.TtlMs +
                  " ms deadline, so it was skipped rather than run for nobody";
        } else {
          try { res = Run(job, ref conn); }
          catch (Exception ex) {
            Interlocked.Increment(ref _failed);
            res = Json.Obj("ok", false, "q", job.Q, "items", new object[0],
                           "reason", "The file search stopped unexpectedly. Try again.",
                           "detail", ex.GetType().Name);
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
        if (superseded) { Interlocked.Increment(ref _superseded); Program.ReplyCancelled(job.Id); }
        else if (error != null) Program.ReplyFromWorker(job.Id, false, null, error);
        else { Interlocked.Increment(ref _served); Program.ReplyFromWorker(job.Id, true, res, null); }
      }
    }

    // --------------------------------------------------------------- the query

    static IDictionary Run(Job job, ref OleDbConnection conn) {
      var total = Stopwatch.StartNew();
      var items = new List<object>();
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      string where = "SCOPE='" + Sql("file:" + job.Scope.Replace('\\', '/')) + "'" + NoiseFilter();
      long openMs = 0, prefixMs = -1, wordMs = -1, containsMs = -1;
      int literal = LiteralLength(job.Q);
      bool wild = literal < job.Q.Length;           // % _ [ typed: the LIKE pattern is a superset
      string like = Sql(LikeText(job.Q));
      int hidden = 0;

      try {
        var t = Stopwatch.StartNew();
        if (conn == null) {
          var c = new OleDbConnection(ConnStr);
          c.Open();                                   // throws when the index cannot be reached
          conn = c;
        }
        openMs = t.ElapsedMilliseconds;

        if (literal >= 1) {
          t.Restart();
          hidden += Query(conn, "SELECT TOP " + job.Max + " " + Columns + " FROM SystemIndex WHERE " + where +
                                " AND System.FileName LIKE '" + like + "%' ORDER BY System.DateModified DESC",
                          job, "prefix", wild ? 1 : 0, items, seen);
          prefixMs = t.ElapsedMilliseconds;
        }

        string terms = ContainsTerms(job.Q);
        if (items.Count < job.Max && terms != null && !job.Superseded) {
          t.Restart();
          // TOP covers the gap AFTER the rows the tier above already has are dropped as duplicates.
          hidden += Query(conn, "SELECT TOP " + (job.Max + items.Count) + " " + Columns + " FROM SystemIndex WHERE " + where +
                                " AND CONTAINS(System.FileName, '" + Sql(terms) + "') ORDER BY System.DateModified DESC",
                          job, "word", 0, items, seen);
          wordMs = t.ElapsedMilliseconds;
        }

        // Not for several words: the word tier already matched every word's start ("final rep" ->
        // "my final report.docx"), and a contains pass over "%final rep%" is a full scan for the
        // one name with that exact spacing (MEASURED 2026-09-29: it put multi-word p50 at 528 ms
        // against 84 ms without it).
        if (items.Count < job.Max && literal >= ContainsMinChars && !HasSpace(job.Q) && !job.Superseded) {
          t.Restart();
          hidden += Query(conn, "SELECT TOP " + (job.Max + items.Count) + " " + Columns + " FROM SystemIndex WHERE " + where +
                                " AND System.FileName LIKE '%" + like + "%' ORDER BY System.DateModified DESC",
                          job, "contains", wild ? 2 : 0, items, seen);
          containsMs = t.ElapsedMilliseconds;
        }
      } catch (Exception ex) {
        if (conn != null) { try { conn.Dispose(); } catch (Exception) { } conn = null; }
        if (job.Superseded) return Json.Obj("ok", false, "q", job.Q, "items", new object[0], "reason", "superseded");
        Interlocked.Increment(ref _failed);
        return Json.Obj("ok", false, "q", job.Q, "items", new object[0],
                        "reason", Explain(ex), "detail", ex.GetType().Name, "status", Search.StatusCached(true));
      }
      if (hidden > 0) Interlocked.Add(ref _hiddenDropped, hidden);

      if (items.Count > job.Max) items.RemoveRange(job.Max, items.Count - job.Max);

      // An unindexed scope is not an error - the query just finds nothing there - so SAY it, or
      // an empty list reads as "you have no such file".
      IDictionary st = Search.StatusCached(false);
      string note = null;
      if (st != null && Equals(st["scopeIndexed"], false)) note = st["reason"] as string;

      return Json.Obj("ok", true, "q", job.Q, "scope", job.Scope, "items", items,
                      "ms", total.ElapsedMilliseconds, "openMs", openMs,
                      "prefixMs", Ms(prefixMs), "wordMs", Ms(wordMs), "containsMs", Ms(containsMs),
                      "hidden", hidden, "reason", note);
    }

    static object Ms(long v) { return v < 0 ? null : (object)v; }

    static string NoiseFilter() {
      var sb = new StringBuilder();
      foreach (string d in NoiseDirs) sb.Append(" AND NOT System.ItemPathDisplay LIKE '%\\").Append(d).Append("\\%'");
      foreach (string n in NoiseNames) sb.Append(" AND System.FileName <> '").Append(n).Append("'");
      return sb.ToString();
    }

    /// `check`: 0 = trust the index's match; 1 = keep only names that START with q; 2 = only names
    /// that CONTAIN q (a wildcard pattern found a superset). Returns how many hidden/system rows
    /// were dropped.
    static int Query(OleDbConnection conn, string sql, Job job, string match, int check, List<object> items, HashSet<string> seen) {
      if (job.Superseded) return 0;
      int hidden = 0;
      using (var cmd = new OleDbCommand(sql, conn)) {
        using (OleDbDataReader r = cmd.ExecuteReader()) {
          while (r.Read()) {
            if (job.Superseded) return hidden;
            string path = AsString(r.GetValue(0));
            if (string.IsNullOrEmpty(path) || seen.Contains(path)) continue;
            string name = AsString(r.GetValue(1));
            if (string.IsNullOrEmpty(name)) name = Path.GetFileName(path);
            if (name.StartsWith("~$", StringComparison.Ordinal)) continue;   // Office's owner file of an open document
            if (check == 1 && !name.StartsWith(job.Q, StringComparison.OrdinalIgnoreCase)) continue;
            if (check == 2 && name.IndexOf(job.Q, StringComparison.OrdinalIgnoreCase) < 0) continue;
            long attrs = AsLong(r.GetValue(6));
            if ((attrs & (AttrHidden | AttrSystem)) != 0) { hidden++; continue; }
            seen.Add(path);
            string type = AsString(r.GetValue(3));
            bool isDir = string.Equals(type, "Directory", StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(type, "File folder", StringComparison.OrdinalIgnoreCase);
            object modified = null;
            object rawMod = r.GetValue(4);
            if (rawMod is DateTime)
              modified = ((DateTime)rawMod).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
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
      return hidden;
    }

    static string AsString(object v) {
      if (v == null || v is DBNull) return null;
      var arr = v as Array;                         // a multi-valued property must not become "System.String[]"
      if (arr != null) return arr.Length > 0 && arr.GetValue(0) != null ? arr.GetValue(0).ToString() : null;
      return Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    static long AsLong(object v) {
      if (v == null || v is DBNull) return 0;
      try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); } catch (Exception) { return 0; }
    }

    /// A SQL string literal: quotes doubled. The only escape Windows Search SQL needs.
    public static string Sql(string s) { return s.Replace("'", "''"); }

    /// LIKE's wildcards typed by a person become "_" (any one character): see the header.
    public static string LikeText(string q) {
      var sb = new StringBuilder(q.Length);
      foreach (char c in q) sb.Append(c == '%' || c == '_' || c == '[' ? '_' : c);
      return sb.ToString();
    }

    static bool HasSpace(string q) {
      foreach (char c in q) if (char.IsWhiteSpace(c)) return true;
      return false;
    }

    /// How many characters of q are NOT a LIKE wildcard.
    public static int LiteralLength(string q) {
      int n = 0;
      foreach (char c in q) if (c != '%' && c != '_' && c != '[') n++;
      return n;
    }

    /// '"final*" AND "rep*"' from "final rep": letters and digits only, because CONTAINS has its
    /// own grammar (quotes, parentheses, NEAR, ~) and a person typing a file name is not writing
    /// in it. null when nothing is left.
    public static string ContainsTerms(string q) {
      var terms = new List<string>();
      var sb = new StringBuilder();
      foreach (char c in q + " ") {
        if (char.IsLetterOrDigit(c)) { sb.Append(c); continue; }
        if (sb.Length > 0) { terms.Add("\"" + sb.ToString() + "*\""); sb.Length = 0; }
      }
      if (terms.Count == 0 || terms.Count > 8) return null;
      return string.Join(" AND ", terms.ToArray());
    }

    /// The failure, in words a person can act on. If the service is the cause, say that.
    static string Explain(Exception ex) {
      IDictionary st = Search.StatusCached(true);
      if (st != null && Equals(st["serviceOk"], false) && st["reason"] is string) return (string)st["reason"];
      if (ex is InvalidOperationException && ex.Message.IndexOf("provider", StringComparison.OrdinalIgnoreCase) >= 0)
        return "Windows Search isn't available on this PC, so files can't be searched.";
      return "Windows Search didn't answer. It may be busy updating its index - try again in a moment.";
    }
  }
}
