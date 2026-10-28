// TaskMgrDetails.cs - the Details tab's End task / End process tree (lane tm-data-admin, 2026-10-28).
//
// `taskmgr.endpid {pid, created, tree?, force?, dryRun?}` ends ONE process, or its verified tree.
//
// THE RULES (a PPID walk once killed every process on the user's PC, 2026-10-23):
//   - By pid AND creation time. The target must be in the table with the same `created` (a FILETIME
//     as a decimal string), else nothing happens.
//   - tree: the descendants are found in ONE table read, and a process counts as a child only when its
//     parent is already in the set, is in that same read, and was created no later than the child
//     (Windows never clears a dead parent's pid, so a new process that got an old number is not the
//     parent of anything older than itself). More than 80 members: refused.
//   - Every member goes through TaskMgr.Refuse (Windows' own processes, session 0, games and
//     anti-cheat, Lively, Mantle itself). ONE refused member refuses the WHOLE request.
//   - A handle is held on every member (TaskMgr.Take re-verifies pid + creation time) for the whole
//     action, so no pid can be reused in between. One member that cannot be held refuses the whole
//     request.
//   - Never taskkill /T. Not force: WM_CLOSE to the set's app windows; none: taskkill naming every pid
//     (/PID a /PID b), no /F. force: TerminateProcess on each HELD handle (exit code 1).
//   - dryRun does everything up to holding the handles, answers what it would do and touches nothing.
//     A passive (test) sidecar refuses every real request before reading anything.
//   - Logs carry pids and Win32 codes only; never a name, path or title.
//
// Reply: { ok, done, how:'wm_close'|'taskkill'|'terminate'|'none', pids, refused:[{pid, why}], dryRun,
//          why|null, reason|null, needsAdmin? } plus `command` (taskkill), `windows` (wm_close) and
//          `failed` [{pid, code, why}] (terminate). ok == done; reason == why (TM-SPEC convention).
//
// OUTSIDE DEPENDENCIES (everything this file uses that it does not define):
//   TaskMgr.ReadProcs, TaskMgr.Proc, TaskMgr.Refuse (which itself reads Program.OwnPid and
//   Program.ParentPid, in TaskMgr.cs), TaskMgr.Take, TaskMgr.Held, TaskMgr.Release,
//   TaskMgr.AppWindowsByPid, TaskMgr.RunTaskkill, TaskMgr.TaskkillWords, TaskMgr.Str, TaskMgr.DryRun,
//   TaskMgr.QUERY_LIMITED, TaskMgr.SYNCHRONIZE; Json.Obj / GetBool / GetInt / GetString;
//   Win32.PostMessageW; MantleFeature, FeatureTable.Add, Lanes.Slow (Register only);
//   Program.Passive, FeatureTable.PassiveRefusal, Program.EmitLog (ONLY via the Host* accessors).
//
// C# 5 only (build.ps1): no interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class TaskMgrDetails {
    static class N {
      [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
    }

    // ------------------------------------------------------------------ host accessors
    // The ONLY reads of Program / FeatureTable globals in this file, so a second host (the planned
    // elevated helper exe) can compile these handlers and supply its own values here.
    static bool HostPassive() { return Program.Passive; }
    static string HostPassiveRefusal() { return FeatureTable.PassiveRefusal; }
    static void HostLog(string level, string message) { Program.EmitLog(level, message); }

    const int TREE_MAX = 80;
    const uint PROCESS_TERMINATE = 0x0001, WM_CLOSE = 0x0010;

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.endpid", Lanes.Slow, EndPid);   // {pid, created, tree?, force?, dryRun?} -> done/how/pids/refused
    }

    static Dictionary<string, object> Reply(bool done, string how, List<uint> pids, List<object> refused, bool dry, string why, bool needsAdmin) {
      var pl = new List<object>();
      if (pids != null) foreach (uint p in pids) pl.Add(p);
      var d = new Dictionary<string, object>();
      d["ok"] = done; d["done"] = done; d["how"] = how; d["pids"] = pl;
      d["refused"] = refused ?? new List<object>(); d["dryRun"] = dry; d["why"] = why; d["reason"] = why;
      if (needsAdmin) d["needsAdmin"] = true;
      return d;
    }

    static string EndPid(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req), force = Json.GetBool(req, "force", false), tree = Json.GetBool(req, "tree", false);
      if (!dry && HostPassive()) return HostPassiveRefusal();
      int pid = Json.GetInt(req, "pid", 0);
      string created = Json.GetString(req, "created");
      if (pid <= 0 || string.IsNullOrEmpty(created)) return "needs pid and created (from taskmgr.snapshot)";
      var refused = new List<object>();

      string why;
      List<TaskMgr.Proc> table = TaskMgr.ReadProcs(out why);
      if (table == null) return why;
      var byPid = new Dictionary<uint, TaskMgr.Proc>();
      foreach (TaskMgr.Proc p in table) byPid[p.Pid] = p;
      TaskMgr.Proc target;
      if (!byPid.TryGetValue((uint)pid, out target)) {
        result = Reply(false, "none", null, refused, dry, "it is no longer running", false); return null;
      }
      if (TaskMgr.Str(target.Created) != created) {
        result = Reply(false, "none", null, refused, dry, "refused: that pid is now a different process (Windows reused the number)", false); return null;
      }

      // The set: the target, plus (tree) its verified descendants from this one read.
      var set = new List<uint>();
      var inSet = new HashSet<uint>();
      set.Add(target.Pid); inSet.Add(target.Pid);
      if (tree) {
        for (bool grew = true; grew && set.Count <= TREE_MAX; ) {
          grew = false;
          foreach (TaskMgr.Proc c in table) {
            if (inSet.Contains(c.Pid) || c.Pid <= 4 || c.Ppid == c.Pid || !inSet.Contains(c.Ppid)) continue;
            TaskMgr.Proc parent;
            if (!byPid.TryGetValue(c.Ppid, out parent) || parent.Created > c.Created) continue;
            set.Add(c.Pid); inSet.Add(c.Pid); grew = true;
            if (set.Count > TREE_MAX) break;
          }
        }
        if (set.Count > TREE_MAX) {
          result = Reply(false, "none", null, refused, dry, "refused: the tree has more than " + TREE_MAX + " processes; Mantle will not end that many at once", false);
          return null;
        }
      }

      // One protected member refuses the whole request.
      foreach (uint m in set) {
        string no = TaskMgr.Refuse(byPid[m], byPid);
        if (no != null) refused.Add(Json.Obj("pid", m, "why", "refused: " + no));
      }
      if (refused.Count > 0) {
        var first = (System.Collections.IDictionary)refused[0];
        string w = refused.Count == 1 && set.Count == 1
          ? (string)first["why"]
          : "refused: pid " + first["pid"] + " is " + ((string)first["why"]).Substring("refused: ".Length)
            + (refused.Count > 1 ? " (and " + (refused.Count - 1) + " more)" : "") + "; Mantle ends the whole tree or nothing";
        result = Reply(false, "none", set, refused, dry, w, false);
        return null;
      }

      // Hold a handle on every member (Take re-reads the table and re-verifies pid + creation time).
      var procs = new List<object>();
      foreach (uint m in set) {
        // Shaped like a parsed request (Json.GetInt reads numbers as double): Take re-verifies each.
        var one = new Dictionary<string, object>();
        one["pid"] = (double)m; one["created"] = TaskMgr.Str(byPid[m].Created);
        procs.Add(one);
      }
      var takeReq = new Dictionary<string, object>();
      takeReq["procs"] = procs;
      Dictionary<uint, TaskMgr.Proc> byPid2;
      string err;
      uint access = TaskMgr.QUERY_LIMITED | TaskMgr.SYNCHRONIZE | (force ? PROCESS_TERMINATE : 0u);
      List<TaskMgr.Held> held = TaskMgr.Take(takeReq, access, refused, out byPid2, out err);
      if (held == null) return err;
      try {
        if (refused.Count > 0 || held.Count != set.Count) {
          bool admin = false;
          foreach (object o in refused) {
            string rw = (string)((System.Collections.IDictionary)o)["why"];
            if (rw != null && rw.StartsWith("access denied", StringComparison.Ordinal)) admin = true;
          }
          var first = refused.Count > 0 ? (System.Collections.IDictionary)refused[0] : null;
          string w = first == null ? "refused: a member could not be held"
            : set.Count == 1 ? (string)first["why"]
            : "pid " + first["pid"] + ": " + first["why"] + "; Mantle ends the whole tree or nothing";
          result = Reply(false, "none", set, refused, dry, w, admin);
          return null;
        }

        if (!force) {
          var targets = new List<IntPtr>();
          foreach (KeyValuePair<uint, List<IntPtr>> kv in TaskMgr.AppWindowsByPid())
            if (inSet.Contains(kv.Key)) targets.AddRange(kv.Value);
          if (targets.Count > 0) {
            if (dry) {
              var d0 = Reply(true, "wm_close", set, refused, true, "dry run: would send WM_CLOSE to " + targets.Count + " window(s)", false);
              d0["windows"] = targets.Count;
              result = d0; return null;
            }
            int posted = 0, failed = 0, lastErr = 0;
            foreach (IntPtr wnd in targets) {
              if (Win32.PostMessageW(wnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) posted++; else { failed++; lastErr = Marshal.GetLastWin32Error(); }
            }
            string fw = failed == 0 ? null
              : "WM_CLOSE could not be sent to " + failed + " window(s) (error " + lastErr + (lastErr == 5 ? ": it runs as administrator" : "") + ")";
            var d1 = Reply(posted > 0, "wm_close", set, refused, false, fw, lastErr == 5 && posted == 0);
            d1["windows"] = targets.Count;
            result = d1;
            HostLog(failed == 0 ? "info" : "warn", "taskmgr.endpid: WM_CLOSE to " + posted + "/" + targets.Count + " window(s) of pid(s) " + PidList(set) + (failed > 0 ? ", error " + lastErr : ""));
            return null;
          }
          var args = new StringBuilder();
          foreach (uint m in set) args.Append(args.Length > 0 ? " " : "").Append("/PID ").Append(m);
          string line = "taskkill " + args.ToString();
          if (dry) {
            var d2 = Reply(true, "taskkill", set, refused, true, "dry run: would run " + line, false);
            d2["command"] = line;
            result = d2; return null;
          }
          int code; string output;
          TaskMgr.RunTaskkill(args.ToString(), out code, out output);
          string kw = code == 0 ? null : TaskMgr.TaskkillWords(output, code, false);
          var d3 = Reply(code == 0, "taskkill", set, refused, false, kw, kw != null && kw.StartsWith("access denied", StringComparison.Ordinal));
          d3["command"] = line; d3["code"] = code;
          result = d3;
          HostLog(code == 0 ? "info" : "warn", "taskmgr.endpid: taskkill of pid(s) " + PidList(set) + " answered " + code);
          return null;
        }

        // force: TerminateProcess on each held handle.
        if (dry) {
          result = Reply(true, "terminate", set, refused, true, "dry run: would end " + set.Count + " process(es) with TerminateProcess (pids " + PidList(set) + ")", false);
          return null;
        }
        var fails = new List<object>();
        bool denied = false;
        int ended = 0;
        foreach (TaskMgr.Held h in held) {
          if (N.TerminateProcess(h.H, 1)) { ended++; continue; }
          int e = Marshal.GetLastWin32Error();
          if (e == 5) denied = true;
          fails.Add(Json.Obj("pid", h.Pid, "code", e, "why", e == 5 ? "access denied: it runs as administrator" : "Windows would not end it (error " + e + ")"));
        }
        string tw = fails.Count == 0 ? null
          : (ended == 0 ? "" : ended + " ended; ") + fails.Count + " could not be ended: " + (string)((System.Collections.IDictionary)fails[0])["why"];
        var d4 = Reply(fails.Count == 0, "terminate", set, refused, false, tw, denied);
        d4["failed"] = fails;
        result = d4;
        HostLog(fails.Count == 0 ? "info" : "warn", "taskmgr.endpid: TerminateProcess ended " + ended + "/" + set.Count + " (pids " + PidList(set) + ")");
        return null;
      } finally { TaskMgr.Release(held); }
    }

    static string PidList(List<uint> set) {
      var sb = new StringBuilder();
      foreach (uint p in set) sb.Append(sb.Length > 0 ? "," : "").Append(p);
      return sb.ToString();
    }
  }
}
