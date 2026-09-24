// SearchIndex.cs - `search.files` / `search.status`: the Win+S search's file rows, as a wave-3
// feature (Features.cs), straight out of the Windows Search index.
//
// WHY A SECOND FILE BESIDE Search.cs. Search.cs (2026-09-22) is the launcher's original `search`
// command, wired as a `case` in Program.Run; it stays exactly as it is for main.js's
// `launcher.files` until the main session retires that path. This file is the same machinery
// through the feature seam, plus the one thing the Win+S brief asked for that Search.cs does not
// do: a THIRD tier, a name that merely CONTAINS what was typed ("port" -> report.docx). Its
// latest-wins slot, its workers and its connections are its own, so the two never share a lock
// and neither can starve the other. The service/scope report is Search.Status() itself, so both
// say the same words when the index is unavailable.
//
// THE RANKING, per query, all scoped to the user's profile (never node_modules/.git/site-packages,
// never LevelDB's LOCK/LOG/CURRENT - see Search.cs for the measurements behind both lists):
//   1. prefix    System.FileName LIKE 'q%'                "rep" -> report.docx
//   2. word      CONTAINS(System.FileName, '"q*"')        "rep" -> final-report.docx
//   3. contains  System.FileName LIKE '%q%'  (3+ letters)  "port" -> report.docx
// Each tier newest-first (the file you touched yesterday is the one you meant), each only run
// while the tiers above came up short of `max`, rows de-duplicated by path.
// MEASURED here, 2026-09-24, OLE DB from PowerShell over the same scope: the prefix tier 4-26 ms,
// a contains tier 19-200 ms (TOP 24, "eadme" the slowest), so a third tier costs at most a fifth
// of a second and only when the first two did not fill the list.
//
// LATEST WINS, NO Cancel(). One pending slot: a newer query replaces the waiting one (answered
// `cancelled` at once) and marks any running one superseded (answered `cancelled` when it
// returns, its rows never sent). OleDbCommand.Cancel() BLOCKS until the query ends on this
// provider (MEASURED 2026-09-22 in Search.cs: 16.4 s), so a superseded query finishes on its own
// and the newest starts on a second worker. Every id gets exactly one answer.
//
// NOTHING FAILS SILENTLY. A query the index cannot answer comes back ok:false with a reason
// that says WHY (the WSearch service stopped or disabled, the profile not indexed, or the
// provider's own error), and a query that works over an unindexed scope still carries the reason.
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

    public const int DefaultMax = 24, HardMax = 40;
    const int MaxWorkers = 2;
    const int IdleExitMs = 30000;          // an idle launcher holds nothing open in SearchIndexer
    const int StatusFreshMs = 30000;       // the service and the crawl rules change in dialogs, not per key
    const int ContainsMinChars = 3;        // "ab" inside names is most of the disk and means nothing
    const string ConnStr = "Provider=Search.CollatorDSO;Extended Properties='Application=Windows'";
    const string Columns = "System.ItemPathDisplay, System.FileName, System.ItemFolderPathDisplay, " +
                           "System.ItemType, System.DateModified, System.Size";
    static readonly string[] NoiseDirs = { "node_modules", ".git", "site-packages" };
    static readonly string[] NoiseNames = { "LOCK", "LOG", "LOG.old", "CURRENT" };

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
    static Job _pending;
    static readonly List<Job> _running = new List<Job>();
    static int _workers;
    static readonly Stack<OleDbConnection> _idle = new Stack<OleDbConnection>();
    static int _served, _superseded, _failed;
    static IDictionary _status;
    static long _statusTs;

    // ------------------------------------------------------------ the commands

    static string StatusCmd(Dictionary<string, object> req, ref object result) {
      object id = req.ContainsKey("id") ? req["id"] : null;
      bool fresh = Json.GetBool(req, "fresh", false);
      // The report reads a service and the crawl-scope registry keys (28-51 ms, Search.cs):
      // too long for the ui lane, so a pool thread answers it.
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        IDictionary st = StatusCached(fresh);
        var o = new Dictionary<string, object>(StringComparer.Ordinal);
        if (st != null) foreach (DictionaryEntry kv in st) o[(string)kv.Key] = kv.Value;
        o["stats"] = Json.Obj("served", _served, "superseded", _superseded, "failed", _failed);
        Program.ReplyFromWorker(id, true, o, null);
      });
      result = Program.Deferred;
      return null;
    }

    static string Files(Dictionary<string, object> req, ref object result) {
      string q = (Json.GetString(req, "q") ?? "").Trim();
      if (q.Length == 0) return "search.files needs q: the text to look for";
      if (q.Length > 200) return "search.files: q is longer than 200 characters";
      int max = Json.GetInt(req, "max", DefaultMax);
      if (max < 1 || max > HardMax) return "search.files: max must be 1.." + HardMax;
      string scope = Json.GetString(req, "scope");
      if (string.IsNullOrEmpty(scope)) scope = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      // The scope is spliced into the SQL as a string literal: a quote is the one way out of it.
      if (scope.IndexOf('\'') >= 0 || scope.IndexOf('"') >= 0) return "search.files: scope may not contain quotes";
      if (scope.Length < 3 || scope[1] != ':' || (scope[2] != '\\' && scope[2] != '/'))
        return "search.files: scope must be an absolute folder like C:\\Users\\you (got \"" + scope + "\")";

      var job = new Job();
      job.Id = req.ContainsKey("id") ? req["id"] : null;
      job.Q = q;
      job.Scope = scope.TrimEnd('\\', '/');
      job.Max = max;
      job.ArrivedTs = Stopwatch.GetTimestamp();
      object rawTtl;
      if (req.TryGetValue("ttl", out rawTtl) && rawTtl is double) {
        double d = (double)rawTtl;
        if (d > 0 && d < int.MaxValue) job.TtlMs = (int)d;
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
        th.IsBackground = true;
        th.Name = "mantle-search-index";
        th.SetApartmentState(ApartmentState.MTA);   // no pump here; the provider is free-threaded
        th.Start();
      }
      if (dropped != null) {
        Interlocked.Increment(ref _superseded);
        Program.ReplyCancelled(dropped.Id);
      }
      result = Program.Deferred;
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
          error = "expired: \"search.files\" waited " + waited + " ms, past the caller's " + job.TtlMs +
                  " ms deadline, so it was skipped rather than run for nobody";
        } else {
          try { res = Run(job, ref conn); }
          catch (Exception ex) {
            res = Json.Obj("ok", false, "q", job.Q, "items", new object[0],
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
      // LIKE's own wildcards typed by a person would need bracket escapes, which MEASURED 4.5 s
      // to find nothing (Search.cs, 2026-09-22); the word tier still finds "50% off.pdf".
      bool likeSafe = job.Q.IndexOfAny(new[] { '%', '_', '[' }) < 0;

      try {
        var t = Stopwatch.StartNew();
        if (conn == null) {
          var c = new OleDbConnection(ConnStr);
          c.Open();                                   // throws with the provider's reason
          conn = c;
        }
        openMs = t.ElapsedMilliseconds;

        if (likeSafe) {
          t.Restart();
          Query(conn, "SELECT TOP " + job.Max + " " + Columns + " FROM SystemIndex WHERE " + where +
                      " AND System.FileName LIKE '" + Sql(job.Q) + "%' ORDER BY System.DateModified DESC",
                job, "prefix", items, seen);
          prefixMs = t.ElapsedMilliseconds;
        }

        string terms = ContainsTerms(job.Q);
        if (items.Count < job.Max && terms != null && !job.Superseded) {
          t.Restart();
          // TOP covers the gap AFTER the rows the tier above already has are dropped as duplicates.
          Query(conn, "SELECT TOP " + (job.Max + items.Count) + " " + Columns + " FROM SystemIndex WHERE " + where +
                      " AND CONTAINS(System.FileName, '" + Sql(terms) + "') ORDER BY System.DateModified DESC",
                job, "word", items, seen);
          wordMs = t.ElapsedMilliseconds;
        }

        if (items.Count < job.Max && likeSafe && job.Q.Length >= ContainsMinChars && !job.Superseded) {
          t.Restart();
          Query(conn, "SELECT TOP " + (job.Max + items.Count) + " " + Columns + " FROM SystemIndex WHERE " + where +
                      " AND System.FileName LIKE '%" + Sql(job.Q) + "%' ORDER BY System.DateModified DESC",
                job, "contains", items, seen);
          containsMs = t.ElapsedMilliseconds;
        }
      } catch (Exception ex) {
        if (conn != null) { try { conn.Dispose(); } catch (Exception) { } conn = null; }
        if (job.Superseded) return Json.Obj("ok", false, "q", job.Q, "items", new object[0], "reason", "superseded");
        Interlocked.Increment(ref _failed);
        return Json.Obj("ok", false, "q", job.Q, "items", new object[0],
                        "reason", Explain(ex), "status", StatusCached(true));
      }

      if (items.Count > job.Max) items.RemoveRange(job.Max, items.Count - job.Max);

      // An unindexed scope is not an error - the query just finds nothing there - so SAY it, or
      // an empty list reads as "you have no such file".
      IDictionary st = StatusCached(false);
      string note = null;
      if (st != null && Equals(st["scopeIndexed"], false)) note = st["reason"] as string;

      return Json.Obj("ok", true, "q", job.Q, "scope", job.Scope, "items", items,
                      "ms", total.ElapsedMilliseconds, "openMs", openMs,
                      "prefixMs", Ms(prefixMs), "wordMs", Ms(wordMs), "containsMs", Ms(containsMs),
                      "reason", note);
    }

    static object Ms(long v) { return v < 0 ? null : (object)v; }

    static string NoiseFilter() {
      var sb = new StringBuilder();
      foreach (string d in NoiseDirs) sb.Append(" AND NOT System.ItemPathDisplay LIKE '%\\").Append(d).Append("\\%'");
      foreach (string n in NoiseNames) sb.Append(" AND System.FileName <> '").Append(n).Append("'");
      return sb.ToString();
    }

    static void Query(OleDbConnection conn, string sql, Job job, string match, List<object> items, HashSet<string> seen) {
      if (job.Superseded) return;
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
    }

    static string AsString(object v) {
      if (v == null || v is DBNull) return null;
      var arr = v as Array;                         // a multi-valued property must not become "System.String[]"
      if (arr != null) return arr.Length > 0 && arr.GetValue(0) != null ? arr.GetValue(0).ToString() : null;
      return Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    static string Sql(string s) { return s.Replace("'", "''"); }

    /// '"final*" AND "rep*"' from "final rep": letters and digits only, because CONTAINS has its
    /// own grammar and a person typing a file name is not writing in it. null when nothing is left.
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

    static string Explain(Exception ex) {
      IDictionary st = StatusCached(true);
      if (st != null && Equals(st["serviceOk"], false)) return st["reason"] as string;
      string msg = ex.Message;
      var oe = ex as OleDbException;
      if (oe != null) msg = msg + " (HRESULT 0x" + oe.ErrorCode.ToString("X8", CultureInfo.InvariantCulture) + ")";
      else if (ex is InvalidOperationException && msg.IndexOf("provider", StringComparison.OrdinalIgnoreCase) >= 0)
        msg = msg + " - the Windows Search OLE DB provider (Search.CollatorDSO) is not registered on this machine";
      return "the Windows Search index did not answer: " + msg;
    }

    static IDictionary StatusCached(bool force) {
      lock (_lock) {
        if (!force && _status != null && Lanes.MsSince(_statusTs) < StatusFreshMs) return _status;
      }
      IDictionary st;
      try { st = Search.Status(); }
      catch (Exception ex) {
        st = Json.Obj("ok", false, "serviceOk", null, "scopeIndexed", null,
                      "reason", "the Windows Search status could not be read: " + ex.Message);
      }
      lock (_lock) { _status = st; _statusTs = Stopwatch.GetTimestamp(); }
      return st;
    }
  }
}
