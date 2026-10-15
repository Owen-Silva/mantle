// AppPower.cs - `apppower.*`: per-app CPU / memory / GPU controls for the top bar's CPU, RAM and GPU
// dropdowns (lane mantle-power-sidecar, 2026-10-14). Owen: Efficiency mode, priority, CPU limit,
// lower memory priority, free up memory, memory limit, lower graphics priority, graphics preference,
// remembered per app. The contract is C:\Users\user\mantle-notes\power-CONTRACT.md sections 2-3; Node
// (lib/apppower-core.js, lib/features/apppower.js) decides WHAT, this file only does it to Windows.
//
// WHAT EACH SETTING IS:
//   eco       SetProcessInformation(ProcessPowerThrottling, EXECUTION_SPEED on) + IDLE priority unless a
//             priority is set too - exactly Task Manager's Efficiency mode. Off: the throttling state the
//             process had before, and its old priority.
//   priority  low (IDLE) / belownormal / normal / abovenormal. NEVER high or realtime: refused.
//   cpuCap    a NAMED job object per app root, "Local\Mantle.AppPower.<hash of key>.<root pid>", CPU rate
//             ENABLE|HARD_CAP at pct*100 (of the whole machine). Children the root starts later are
//             born in it. A process already in another job (Chromium's sandboxed children) gets its own
//             nested job instead (shared=false: the limit covers the app fully once it restarts under
//             the rule). Never KILL_ON_JOB_CLOSE, never UI limits; BREAKAWAY_OK so an app that starts a
//             child "outside its job" on purpose still starts it instead of failing.
//             A job cannot be left: 0 = the limits cleared, which is the undo.
//   memLow    ProcessMemoryPriority LOW (2); off = what it had (NORMAL, 5).
//   memCap    JOB_OBJECT_LIMIT_JOB_MEMORY on the same job(s): committed memory of the whole job.
//   gpuLow    D3DKMTSetProcessSchedulingPriorityClass BELOW_NORMAL; off = what it had (NORMAL).
// KEEPING A JOB REACHABLE: a named object's name disappears when its last HANDLE closes, even while
// processes are still in it, so a restarted sidecar could no longer find (and lift) a limit. So each
// job's first process gets ONE extra handle to it - SYNCHRONIZE only, which lets it do nothing with the
// job - duplicated into it: the name then lives exactly as long as the app does.
//
// THE TABLE: apppower.rules REPLACES the whole enforced table (idempotent): applied at once to every
// running matched process, then a watcher thread (BelowNormal, every 2 s, one process-list read) applies
// it to NEW matched processes. A key that leaves the table, or a process that no longer matches its
// key, is put back. Every pid's own values are recorded at first touch, so "off" restores them; after a
// sidecar restart a value equal to what the rule itself sets is taken as Windows' default (NORMAL).
//
// SAFETY: the NEVER list, this sidecar, its parent (Mantle's electron) and anything under Mantle's
// electron are refused whatever Node sends ("protected"); games and anti-cheat are never opened for
// writing ("game"); other sessions are "system". dryRun runs every check and writes nothing. A
// PASSIVE (--test) sidecar writes only to the test burner (AppPowerProc.IsTestTarget); anything else is
// FeatureTable.PassiveRefusal. Nothing here logs an app name or a path (privacy rule).
//
// C# 5 (see build.ps1).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static partial class AppPower {
    public static void Register(FeatureTable t) {
      t.Add("apppower.rules", Lanes.Slow, RulesCmd);      // { rules:[{key,label,match,set}], dryRun? } -> { ok, status }
      t.Add("apppower.status", Lanes.Qs, StatusCmd);      // the last status array
      t.Add("apppower.trim", Lanes.Slow, TrimCmd);        // { match, dryRun? } -> { ok, n, before, after, denied }
      t.Add("apppower.read", Lanes.Slow, ReadCmd);        // { pid } -> what Windows says about it now
      t.Add("apppower.caps", Lanes.Slow, CapsCmd);        // GPUs, whether graphics priority can be changed
      t.Add("apppower.gpupref", Lanes.Slow, GpuPrefCmd);  // { path, pref, dryRun? } Windows' per-app GPU choice
    }

    const uint IDLE = 0x40, BELOW_NORMAL = 0x4000, NORMAL = 0x20, ABOVE_NORMAL = 0x8000, HIGH = 0x80, REALTIME = 0x100;
    const int ProcessMemoryPriority = 0, ProcessPowerThrottling = 4;
    const uint MEM_LOW = 2, MEM_NORMAL = 5;
    const int GPU_BELOW_NORMAL = 1, GPU_NORMAL = 2;
    const int WatchMs = 2000;
    const int STATUS_INVALID_PARAMETER = unchecked((int)0xC000000D);

    // ================================================================ PARSING
    sealed class PSet {
      public bool Eco, MemLow, GpuLow; public string Priority; public int CpuCap; public long MemCap;
      public bool NeedsJob { get { return CpuCap > 0 || MemCap > 0; } }
      public string Sig() { return (Eco ? "e" : "") + "|" + (Priority ?? "") + "|" + CpuCap + "|" + (MemLow ? "m" : "") + "|" + MemCap + "|" + (GpuLow ? "g" : ""); }
    }
    sealed class MSpec { public string Exe, Path; public HashSet<uint> Pids; }
    sealed class Rule { public string Key, Label; public MSpec Match; public PSet Set; }

    static uint PrioClass(string p) {
      switch (p) { case "low": return IDLE; case "belownormal": return BELOW_NORMAL; case "normal": return NORMAL; case "abovenormal": return ABOVE_NORMAL; }
      return 0;
    }
    static string PrioName(uint c) {
      switch (c) { case IDLE: return "low"; case BELOW_NORMAL: return "belownormal"; case NORMAL: return "normal"; case ABOVE_NORMAL: return "abovenormal"; case HIGH: return "high"; case REALTIME: return "realtime"; }
      return null;
    }

    static string ParseMatch(object o, out MSpec m) {
      m = null;
      var d = o as Dictionary<string, object>;
      if (d == null) return "match must be { exe, path?, pids? }";
      string exe = ExeOf((Json.GetString(d, "exe") ?? "").Trim());
      if (exe.Length == 0) return "match.exe is missing";
      m = new MSpec { Exe = exe, Path = Json.GetString(d, "path") };
      if (m.Path != null && m.Path.Trim().Length == 0) m.Path = null;
      object pv;
      if (Json.TryGet(d, "pids", out pv)) {
        var l = pv as List<object>;
        if (l == null) return "match.pids must be a list of process ids";
        m.Pids = new HashSet<uint>();
        foreach (object x in l) if (x is double && (double)x > 0 && (double)x < uint.MaxValue) m.Pids.Add((uint)(double)x);
      }
      return null;
    }

    static string ParseSet(object o, out PSet s) {
      s = new PSet();
      var d = o as Dictionary<string, object>;
      if (o == null) return null;
      if (d == null) return "set must be an object";
      s.Eco = Json.GetBool(d, "eco", false);
      s.MemLow = Json.GetBool(d, "memLow", false);
      s.GpuLow = Json.GetBool(d, "gpuLow", false);
      string p = Json.GetString(d, "priority");
      if (p != null) {
        p = p.Trim().ToLowerInvariant();
        if (p == "high" || p == "realtime") return "refused: Mantle never sets high or realtime priority";
        if (PrioClass(p) == 0) return "set.priority must be low, belownormal, normal or abovenormal";
        s.Priority = p;
      }
      int cap = Json.GetInt(d, "cpuCap", 0);
      if (cap < 0 || cap > 99) return "set.cpuCap must be 0 (no limit) or 1 to 99 percent";
      s.CpuCap = cap;
      object mv; double mem = 0;
      if (Json.TryGet(d, "memCap", out mv)) { if (!(mv is double)) return "set.memCap must be a number of bytes"; mem = Math.Round((double)mv); }
      if (mem < 0 || (mem > 0 && mem < 32.0 * 1048576)) return "set.memCap must be 0 (no limit) or at least 32 MB";
      s.MemCap = (long)mem;
      return null;
    }

    static string ParseRules(Dictionary<string, object> req, out List<Rule> rules) {
      rules = new List<Rule>();
      object rv;
      if (!Json.TryGet(req, "rules", out rv) || !(rv is List<object>)) return "apppower.rules needs rules: [{ key, label, match, set }]";
      var keys = new HashSet<string>(StringComparer.Ordinal);
      foreach (object o in (List<object>)rv) {
        var d = o as Dictionary<string, object>;
        if (d == null) return "each rule must be { key, label, match, set }";
        string key = Json.GetString(d, "key");
        if (string.IsNullOrEmpty(key)) return "a rule has no key";
        if (!keys.Add(key)) return "two rules have the same key";
        object mo, so; MSpec m; PSet s;
        Json.TryGet(d, "match", out mo);
        string e = ParseMatch(mo, out m);
        if (e != null) return e;
        Json.TryGet(d, "set", out so);
        e = ParseSet(so, out s);
        if (e != null) return e;
        rules.Add(new Rule { Key = key, Label = Json.GetString(d, "label"), Match = m, Set = s });
      }
      return null;
    }

    // ================================================================ MATCHING
    sealed class Tree {
      public List<PInfo> All; public Dictionary<uint, PInfo> ByPid = new Dictionary<uint, PInfo>();
      public Dictionary<uint, List<PInfo>> Kids = new Dictionary<uint, List<PInfo>>();
      /// The parent, only when it really is the parent: the pid a process names as its parent may have
      /// been reused by a process that started later.
      public PInfo Parent(PInfo p) {
        PInfo q;
        if (p.Ppid == p.Pid || !ByPid.TryGetValue(p.Ppid, out q) || q.Created > p.Created) return null;
        return q;
      }
    }
    static Tree MakeTree(List<PInfo> all) {
      var t = new Tree { All = all };
      foreach (PInfo p in all) t.ByPid[p.Pid] = p;
      foreach (PInfo p in all) {
        PInfo q = t.Parent(p);
        if (q == null) continue;
        List<PInfo> l;
        if (!t.Kids.TryGetValue(q.Pid, out l)) t.Kids[q.Pid] = l = new List<PInfo>();
        l.Add(p);
      }
      return t;
    }

    sealed class Hit { public PInfo P; public uint Root; public bool IsRoot; public string Deny; public bool PassiveSkip; }

    /// Every process the match names, and the whole tree under each (whatever its exe). Each hit knows its
    /// root (the topmost matched process above it) and why it would be refused (null = it can be changed).
    static List<Hit> Resolve(MSpec m, Tree t, bool forWrite) {
      var matched = new Dictionary<uint, PInfo>();
      var queue = new Queue<PInfo>();
      foreach (PInfo p in t.All) {
        if (p.Pid <= 4) continue;
        if (m.Pids != null && !m.Pids.Contains(p.Pid)) continue;
        if (!string.Equals(ExeOf(p.Name), m.Exe, StringComparison.OrdinalIgnoreCase)) continue;
        if (m.Path != null) {
          string pp = PathOf(p.Pid, p.Created, p.Name);
          if (pp == null || !string.Equals(pp, m.Path, StringComparison.OrdinalIgnoreCase)) continue;
        }
        matched[p.Pid] = p;
        queue.Enqueue(p);
      }
      while (queue.Count > 0) {
        PInfo p = queue.Dequeue();
        List<PInfo> ch;
        if (!t.Kids.TryGetValue(p.Pid, out ch)) continue;
        foreach (PInfo c in ch) {
          // a console app's window host is Windows', not the app's (it is started as the app's child)
          if (matched.ContainsKey(c.Pid) || string.Equals(c.Name, "conhost.exe", StringComparison.OrdinalIgnoreCase)) continue;
          matched[c.Pid] = c;
          queue.Enqueue(c);
        }
      }
      var hits = new List<Hit>(matched.Count);
      uint own = (uint)Program.OwnPid, parent = Program.ParentPid > 0 ? (uint)Program.ParentPid : 0;
      foreach (PInfo p in matched.Values) {
        var h = new Hit { P = p };
        // up to the root; Mantle itself (or this sidecar) anywhere on the way = refused
        PInfo cur = p;
        bool mantle = p.Pid == own || p.Pid == parent;
        for (int guard = 0; guard < 256; guard++) {
          PInfo up = t.Parent(cur);
          if (up == null || !matched.ContainsKey(up.Pid)) break;
          cur = up;
          if (cur.Pid == own || cur.Pid == parent) mantle = true;
        }
        h.Root = cur.Pid;
        h.IsRoot = cur.Pid == p.Pid;
        string a = AccessOf(p.Pid, p.Created, p.Name, p.Session);
        if (mantle && a == "ok") a = "protected";
        h.Deny = a == "ok" ? null : a == "unknown" ? "error" : a;
        if (forWrite && h.Deny == null && Program.Passive && !IsTestTarget(p)) h.PassiveSkip = true;
        hits.Add(h);
      }
      // roots first (their job exists before their children look for it), then by start time
      hits.Sort(delegate (Hit a, Hit b) {
        if (a.IsRoot != b.IsRoot) return a.IsRoot ? -1 : 1;
        return a.P.Created.CompareTo(b.P.Created);
      });
      return hits;
    }

    // ================================================================ THE ENFORCED TABLE
    sealed class Touch {
      public uint Pid; public long Created; public string Key, Sig, Result, Job;
      public bool Orig; public uint OrigPrio, SetPrio;
      public THROTTLE OrigThr; public bool ThrKnown, EcoSet;
      public uint OrigMem = MEM_NORMAL; public bool MemSet;
      public int OrigGpu = GPU_NORMAL; public bool GpuSet;
    }
    sealed class JobRef { public string Name, Key; public IntPtr H; public bool HasOwner, Existed; public int Cpu = -1; public long Mem = -1; }

    static readonly object _gate = new object();
    static List<Rule> _rules = new List<Rule>();
    static Dictionary<uint, Touch> _touched = new Dictionary<uint, Touch>();
    static Dictionary<string, JobRef> _jobs = new Dictionary<string, JobRef>(StringComparer.Ordinal);
    static List<object> _lastStatus = new List<object>();
    static string _lastEmitted = "[]";
    static Thread _watcher;
    static readonly AutoResetEvent _watchWake = new AutoResetEvent(false);

    static string RulesCmd(Dictionary<string, object> req, ref object result) {
      List<Rule> rules;
      string err = ParseRules(req, out rules);
      if (err != null) return err;
      bool dry = Json.GetBool(req, "dryRun", false);
      lock (_gate) {
        List<object> status;
        if (dry) {
          // every check a real call makes, nothing written, the enforced table and its jobs untouched
          err = Pass(rules, true, out status);
          if (err != null) return err;
          result = Json.Obj("ok", true, "status", status, "dryRun", true);
          return null;
        }
        if (Program.Passive) {
          string snapErr;
          Tree t = MakeTree(Snap(out snapErr));
          if (snapErr != null) return snapErr;
          foreach (Rule r in rules)
            foreach (Hit h in Resolve(r.Match, t, true))
              if (h.PassiveSkip) return FeatureTable.PassiveRefusal + ": would have changed a process that is not the test burner";
        }
        if (!_swept) { _swept = true; SweepOrphanJobs(rules); }
        bool wasEmpty = _rules.Count == 0;
        _rules = rules;
        err = Pass(rules, false, out status);
        if (err != null) return err;
        _lastStatus = status;
        MaybeEmit(status);
        if (rules.Count > 0) {
          if (_watcher == null) {
            _watcher = new Thread(WatchLoop);
            _watcher.IsBackground = true;
            _watcher.Name = "apppower-watch";
            _watcher.Priority = ThreadPriority.BelowNormal;
            _watcher.Start();
          } else if (wasEmpty) _watchWake.Set();
        }
        result = Json.Obj("ok", true, "status", status);
      }
      return null;
    }

    static string StatusCmd(Dictionary<string, object> req, ref object result) {
      lock (_gate) result = Json.Obj("ok", true, "status", _lastStatus, "rules", _rules.Count);
      return null;
    }

    /// New matched processes, every WatchMs, while the table is not empty. One process-list read a pass;
    /// a process already handled under the same rule costs a dictionary lookup.
    static void WatchLoop() {
      while (true) {
        bool any;
        lock (_gate) any = _rules.Count > 0;
        if (!any) { _watchWake.WaitOne(); continue; }
        _watchWake.WaitOne(WatchMs);
        try {
          lock (_gate) {
            if (_rules.Count == 0) continue;
            List<object> status;
            if (Pass(_rules, false, out status) == null) { _lastStatus = status; MaybeEmit(status); }
          }
        } catch (Exception ex) {
          Features.Event("apppower", Json.Obj("status", null, "reason", "the App power watcher hit " + ex.GetType().Name + "; it carries on"));
        }
      }
    }

    static void MaybeEmit(List<object> status) {
      string js = Json.Write(status);
      if (js == _lastEmitted) return;
      _lastEmitted = js;
      Features.Event("apppower", Json.Obj("status", status));
    }

    /// One pass over the table (under _gate). dry: the status it would produce, nothing written and no
    /// record changed. Otherwise: new or changed processes get the rule, processes that left their rule
    /// are put back, jobs nobody uses any more are cleared and closed.
    static string Pass(List<Rule> rules, bool dry, out List<object> status) {
      status = new List<object>();
      string err;
      List<PInfo> all = Snap(out err);
      if (err != null) return err;
      Tree t = MakeTree(all);
      var claimed = new Dictionary<uint, string>();
      foreach (Rule r in rules) {
        string sig = r.Set.Sig();
        int applied = 0;
        var denied = new Dictionary<string, int>(StringComparer.Ordinal);
        var jobs = new HashSet<string>(StringComparer.Ordinal);
        bool jobless = false;
        foreach (Hit h in Resolve(r.Match, t, !dry)) {
          if (claimed.ContainsKey(h.P.Pid)) continue;   // an earlier rule has it
          if (h.PassiveSkip) continue;                   // never written by a passive sidecar (RulesCmd refused such a table)
          claimed[h.P.Pid] = r.Key;
          if (h.Deny != null) { Bump(denied, h.Deny); continue; }
          if (dry) { applied++; continue; }
          Touch tc;
          bool have = _touched.TryGetValue(h.P.Pid, out tc) && tc.Created == h.P.Created;
          if (have && tc.Key != r.Key) { Restore(tc); have = false; }
          if (!have) { tc = new Touch { Pid = h.P.Pid, Created = h.P.Created, Key = r.Key }; _touched[h.P.Pid] = tc; }
          if (tc.Sig != sig) {
            tc.Result = Apply(h, r, tc);
            tc.Sig = sig;
          }
          if (tc.Result == null) applied++; else Bump(denied, tc.Result);
          if (tc.Job != null) jobs.Add(tc.Job); else if (tc.Result == null) jobless = true;
        }
        var dl = new List<object>();
        foreach (var kv in denied) dl.Add(Json.Obj("access", kv.Key, "n", kv.Value));
        object shared = null;
        if (r.Set.NeedsJob && applied > 0) shared = jobs.Count == 1 && !jobless && !denied.ContainsKey("error");
        status.Add(Json.Obj("key", r.Key, "applied", applied, "denied", dl, "shared", shared));
      }
      if (dry) return null;
      // put back what no longer belongs to its rule; forget what has exited
      var live = new Dictionary<uint, long>();
      foreach (PInfo p in all) live[p.Pid] = p.Created;
      foreach (Touch tc in new List<Touch>(_touched.Values)) {
        long c;
        if (!live.TryGetValue(tc.Pid, out c) || c != tc.Created) { _touched.Remove(tc.Pid); continue; }
        string k;
        if (!claimed.TryGetValue(tc.Pid, out k) || k != tc.Key) { Restore(tc); _touched.Remove(tc.Pid); }
      }
      // jobs no live process of a rule uses any more: limits cleared, handle closed
      var used = new HashSet<string>(StringComparer.Ordinal);
      foreach (Touch tc in _touched.Values) if (tc.Job != null) used.Add(tc.Job);
      foreach (JobRef j in new List<JobRef>(_jobs.Values)) {
        if (used.Contains(j.Name)) continue;
        SetLimits(j, 0, 0);
        N.CloseHandle(j.H);
        _jobs.Remove(j.Name);
      }
      return null;
    }

    static void Bump(Dictionary<string, int> d, string k) { int n; d.TryGetValue(k, out n); d[k] = n + 1; }

    static void Restore(Touch tc) {
      Apply(null, null, tc);
    }

    /// Make one process match its rule (or, rule == null, put back everything Mantle changed on it).
    /// Returns null, or the denial code for the status ("gone", "error").
    static string Apply(Hit h, Rule r, Touch tc) {
      PSet s = r != null ? r.Set : new PSet();
      uint want = BASE_ACCESS | P_QUERY_INFORMATION | (s.NeedsJob ? P_TERMINATE : 0);   // Assign needs SET_QUOTA + TERMINATE
      IntPtr ph = N.OpenProcess(want, false, tc.Pid);
      if (ph == IntPtr.Zero) {
        if (Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER) return "gone";
        ph = N.OpenProcess(BASE_ACCESS, false, tc.Pid);
        if (ph == IntPtr.Zero) return Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER ? "gone" : "error";
      }
      try {
        if (!SameRun(ph, tc.Created)) return "gone";   // the pid was reused between the list read and the open
        string fail = null;
        if (!tc.Orig && r != null) { RecordOriginals(ph, tc, s); if (h != null) AdoptJob(h, r.Key, ph, tc); }
        // priority (eco without an explicit priority = IDLE, Task Manager's Efficiency mode)
        uint cur = N.GetPriorityClass(ph);
        uint target = s.Priority != null ? PrioClass(s.Priority) : s.Eco ? IDLE : 0;
        if (target != 0) {
          if (cur != target && !N.SetPriorityClass(ph, target)) fail = "error"; else tc.SetPrio = target;
        } else if (tc.SetPrio != 0) {
          if (cur == tc.SetPrio) N.SetPriorityClass(ph, tc.OrigPrio);   // an app that changed it itself since wins
          tc.SetPrio = 0;
        }
        // Efficiency mode (EcoQoS)
        if (s.Eco) {
          var th = new THROTTLE { Version = 1, ControlMask = 1, StateMask = 1 };
          if (N.SetProcessInformation(ph, ProcessPowerThrottling, ref th, 12)) tc.EcoSet = true; else fail = "error";
        } else if (tc.EcoSet) {
          var th = tc.ThrKnown ? tc.OrigThr : new THROTTLE { Version = 1 };
          th.Version = 1;
          N.SetProcessInformation(ph, ProcessPowerThrottling, ref th, 12);
          tc.EcoSet = false;
        }
        // memory priority
        if (s.MemLow) {
          uint v = MEM_LOW;
          if (N.SetProcessInformation(ph, ProcessMemoryPriority, ref v, 4)) tc.MemSet = true; else fail = "error";
        } else if (tc.MemSet) {
          uint v = tc.OrigMem;
          N.SetProcessInformation(ph, ProcessMemoryPriority, ref v, 4);
          tc.MemSet = false;
        }
        // graphics priority (only where Windows lets a normal user change it: apppower.caps)
        if (s.GpuLow && GpuLowWorks()) {
          // STATUS_INVALID_PARAMETER: the process has never used the GPU (no graphics context to lower)
          int grc = N.D3DKMTSetProcessSchedulingPriorityClass(ph, GPU_BELOW_NORMAL);
          if (grc == 0) tc.GpuSet = true; else if (grc != STATUS_INVALID_PARAMETER) fail = "error";
        } else if (tc.GpuSet) {
          N.D3DKMTSetProcessSchedulingPriorityClass(ph, tc.OrigGpu);
          tc.GpuSet = false;
        }
        // CPU / memory limit: the app's job
        if (s.NeedsJob && h != null) { string jf = JoinJob(h, r.Key, ph, tc); if (jf != null) fail = jf; }
        // (putting one process back never lifts its app's limit: Pass clears a job once no process of the
        // rule uses it any more)
        if (tc.Job != null && r != null) {
          JobRef j;
          if (_jobs.TryGetValue(tc.Job, out j) && !SetLimits(j, s.CpuCap, s.MemCap) && s.NeedsJob) fail = "error";
        }
        return fail;
      } finally { N.CloseHandle(ph); }
    }

    static bool SameRun(IntPtr ph, long created) {
      long c, x, k, u;
      return !N.GetProcessTimes(ph, out c, out x, out k, out u) || c == created;
    }

    /// The values the process had before Mantle touched it. After a sidecar restart the process may still
    /// carry what the rule set last time: a value equal to the rule's own is then taken as Windows' default.
    static void RecordOriginals(IntPtr ph, Touch tc, PSet s) {
      tc.Orig = true;
      uint p = N.GetPriorityClass(ph);
      uint target = s.Priority != null ? PrioClass(s.Priority) : s.Eco ? IDLE : 0;
      tc.OrigPrio = p == 0 || (target != 0 && p == target && p != NORMAL) ? NORMAL : p;
      var th = new THROTTLE { Version = 1 };
      tc.ThrKnown = N.GetProcessInformation(ph, ProcessPowerThrottling, ref th, 12);
      if (tc.ThrKnown && s.Eco && (th.ControlMask & 1) != 0 && (th.StateMask & 1) != 0) th = new THROTTLE { Version = 1 };
      tc.OrigThr = th;
      uint m = 0;
      if (N.GetProcessInformation(ph, ProcessMemoryPriority, ref m, 4) && m >= 1 && m <= 5) tc.OrigMem = s.MemLow && m == MEM_LOW ? MEM_NORMAL : m;
      int g;
      if (N.D3DKMTGetProcessSchedulingPriorityClass(ph, out g) == 0 && g >= 0 && g <= 5) tc.OrigGpu = s.GpuLow && g == GPU_BELOW_NORMAL ? GPU_NORMAL : g;
    }

    // ================================================================ JOBS
    const uint JOB_ALL_ACCESS = 0x1F003F, SYNCHRONIZE = 0x00100000;
    const int JobCpuRateControl = 15, JobExtendedLimit = 9;
    const uint CPU_ENABLE = 0x1, CPU_HARD_CAP = 0x4, LIMIT_JOB_MEMORY = 0x200, LIMIT_BREAKAWAY_OK = 0x800;

    internal static string JobName(string key, uint pid) {
      uint h = 2166136261;   // FNV-1a, 32 bit
      foreach (char c in key ?? "") { h ^= c; h *= 16777619; }
      return "Local\\Mantle.AppPower." + h.ToString("x8") + "." + pid.ToString(CultureInfo.InvariantCulture);
    }

    /// Put the process in its app's job: the root's own job (children are born in it), else - a process
    /// already in another job - a nested job of its own.
    static string JoinJob(Hit h, string key, IntPtr ph, Touch tc) {
      bool inj;
      if (h.IsRoot) {
        JobRef rj = OpenOrCreate(JobName(key, h.P.Pid), key, h.P.Pid);
        if (rj == null) return "error";
        if ((N.IsProcessInJob(ph, rj.H, out inj) && inj) || N.AssignProcessToJobObject(rj.H, ph)) { rj.HasOwner = true; tc.Job = rj.Name; return null; }
        return "error";
      }
      JobRef root;
      if (_jobs.TryGetValue(JobName(key, h.Root), out root)) {
        if (N.IsProcessInJob(ph, root.H, out inj) && inj) { tc.Job = root.Name; return null; }
        if (root.HasOwner && N.AssignProcessToJobObject(root.H, ph)) { tc.Job = root.Name; return null; }
      }
      JobRef own = OpenOrCreate(JobName(key, h.P.Pid), key, h.P.Pid);
      if (own == null) return "error";
      if ((N.IsProcessInJob(ph, own.H, out inj) && inj) || N.AssignProcessToJobObject(own.H, ph)) { own.HasOwner = true; tc.Job = own.Name; return null; }
      return "error";
    }

    /// A process this sidecar has not handled yet may already be in a job a previous run of the sidecar
    /// made for the same rule (Mantle restarted): that job is taken over, so its limits follow the rule
    /// again - lowered, raised or cleared - instead of a second job nesting under a limit nobody can lift.
    static void AdoptJob(Hit h, string key, IntPtr ph, Touch tc) {
      if (tc.Job != null) return;
      foreach (uint owner in new uint[] { h.Root, h.P.Pid }) {
        string name = JobName(key, owner);
        JobRef j;
        if (!_jobs.TryGetValue(name, out j)) {
          IntPtr hj = N.OpenJobObjectW(JOB_ALL_ACCESS, false, name);
          if (hj == IntPtr.Zero) continue;
          j = new JobRef { Name = name, Key = key, H = hj, HasOwner = true, Existed = true };
          _jobs[name] = j;
        }
        bool inj;
        if (N.IsProcessInJob(ph, j.H, out inj) && inj) { tc.Job = name; return; }
      }
    }

    // ---------------------------------------------------------------- orphaned limits
    [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [DllImport("ntdll.dll")] static extern int NtOpenDirectoryObject(out IntPtr h, uint access, ref OBJECT_ATTRIBUTES oa);
    [DllImport("ntdll.dll")] static extern int NtQueryDirectoryObject(IntPtr h, IntPtr buf, int len, bool single, bool restart, ref uint ctx, out int ret);
    static bool _swept;

    /// The first table after the sidecar starts: a limit a previous run left on an app whose rule is no
    /// longer in the table (Mantle restarted after "Reset", or a setting that was not remembered) is
    /// cleared - every Mantle.AppPower job in this session's object directory whose key is not in the
    /// table. Nothing else is touched; a job of a rule still in the table is adopted by AdoptJob instead.
    static void SweepOrphanJobs(List<Rule> rules) {
      var keep = new HashSet<string>(StringComparer.Ordinal);
      foreach (Rule r in rules) { string n = JobName(r.Key, 0); keep.Add(n.Substring(0, n.LastIndexOf('.') + 1)); }
      string dir = OwnSession == 0 ? "\\BaseNamedObjects" : "\\Sessions\\" + OwnSession + "\\BaseNamedObjects";
      IntPtr name = Marshal.StringToHGlobalUni(dir);
      IntPtr us = Marshal.AllocHGlobal(16), buf = IntPtr.Zero, hd = IntPtr.Zero;
      try {
        Marshal.WriteInt16(us, 0, (short)(dir.Length * 2)); Marshal.WriteInt16(us, 2, (short)(dir.Length * 2 + 2)); Marshal.WriteIntPtr(us, 8, name);
        var oa = new OBJECT_ATTRIBUTES { Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), ObjectName = us, Attributes = 0x40 /* OBJ_CASE_INSENSITIVE */ };
        if (NtOpenDirectoryObject(out hd, 0x0001 /* DIRECTORY_QUERY */, ref oa) != 0) return;
        const int len = 64 * 1024;
        buf = Marshal.AllocHGlobal(len);
        uint ctx = 0; int ret;
        var found = new List<string>();
        bool first = true;
        for (int rounds = 0; rounds < 256; rounds++) {
          int st = NtQueryDirectoryObject(hd, buf, len, false, first, ref ctx, out ret);
          first = false;
          if (st < 0 || (st != 0 && st != 0x105 /* STATUS_MORE_ENTRIES */)) break;
          for (int i = 0; ; i++) {   // OBJECT_DIRECTORY_INFORMATION { UNICODE_STRING Name, TypeName }, 32 bytes each on x64
            int at = i * 32;
            if (at + 32 > len) break;
            int nl = Marshal.ReadInt16(buf, at) & 0xFFFF;
            if (nl == 0) break;
            string on = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, at + 8), nl / 2);
            int tl = Marshal.ReadInt16(buf, at + 16) & 0xFFFF;
            string tn = tl > 0 ? Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, at + 24), tl / 2) : "";
            if (tn == "Job" && on.StartsWith("Mantle.AppPower.", StringComparison.Ordinal)) found.Add("Local\\" + on);
          }
          if (st == 0) break;
        }
        // a passive (--test) sidecar shares this session with the real one: it clears only the jobs of
        // the test burner, never a limit Owen's Mantle set on a real app
        Dictionary<uint, PInfo> live = null;
        if (Program.Passive) {
          string err;
          live = new Dictionary<uint, PInfo>();
          foreach (PInfo p in Snap(out err)) live[p.Pid] = p;
        }
        foreach (string jn in found) {
          if (keep.Contains(jn.Substring(0, jn.LastIndexOf('.') + 1))) continue;
          if (live != null) {
            uint owner; PInfo op;
            if (!uint.TryParse(jn.Substring(jn.LastIndexOf('.') + 1), out owner) || !live.TryGetValue(owner, out op) || !IsTestTarget(op)) continue;
          }
          IntPtr hj = N.OpenJobObjectW(JOB_ALL_ACCESS, false, jn);
          if (hj == IntPtr.Zero) continue;
          var j = new JobRef { Name = jn, H = hj };
          SetLimits(j, 0, 0);
          N.CloseHandle(hj);
        }
      } finally {
        if (hd != IntPtr.Zero) N.CloseHandle(hd);
        if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        Marshal.FreeHGlobal(us); Marshal.FreeHGlobal(name);
      }
    }

    static JobRef OpenOrCreate(string name, string key, uint ownerPid) {
      JobRef j;
      if (_jobs.TryGetValue(name, out j)) return j;
      IntPtr hj = N.OpenJobObjectW(JOB_ALL_ACCESS, false, name);
      bool created = false;
      if (hj == IntPtr.Zero) {
        hj = N.CreateJobObjectW(IntPtr.Zero, name);
        if (hj == IntPtr.Zero) return null;
        created = Marshal.GetLastWin32Error() != 183;   // ERROR_ALREADY_EXISTS: someone made it meanwhile
      }
      j = new JobRef { Name = name, Key = key, H = hj, Existed = !created };
      if (created) {
        SetLimits(j, 0, 0);   // BREAKAWAY_OK, nothing else
        // the name lives as long as the app: one SYNCHRONIZE-only handle in the app's first process
        IntPtr owner = N.OpenProcess(P_DUP_HANDLE, false, ownerPid);
        if (owner != IntPtr.Zero) {
          IntPtr remote;
          N.DuplicateHandle(N.GetCurrentProcess(), hj, owner, out remote, SYNCHRONIZE, false, 0);
          N.CloseHandle(owner);
        }
      }
      _jobs[name] = j;
      return j;
    }

    /// cpu 0 = no CPU limit, mem 0 = no memory limit. Only what changed is written.
    static bool SetLimits(JobRef j, int cpu, long mem) {
      bool ok = true;
      IntPtr b = Marshal.AllocHGlobal(144);
      try {
        if (j.Cpu != cpu) {
          Marshal.WriteInt32(b, 0, cpu > 0 ? (int)(CPU_ENABLE | CPU_HARD_CAP) : 0);
          Marshal.WriteInt32(b, 4, cpu > 0 ? cpu * 100 : 0);
          if (N.SetInformationJobObject(j.H, JobCpuRateControl, b, 8)) j.Cpu = cpu; else ok = false;
        }
        if (j.Mem != mem) {
          // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64, 144 bytes): BasicLimitInformation.LimitFlags at 16,
          // JobMemoryLimit at 120. Read first: only our two flags change.
          uint ret;
          for (int i = 0; i < 144; i += 8) Marshal.WriteInt64(b, i, 0);
          N.QueryInformationJobObject(j.H, JobExtendedLimit, b, 144, out ret);
          uint flags = (uint)Marshal.ReadInt32(b, 16);
          flags = (flags & ~LIMIT_JOB_MEMORY) | LIMIT_BREAKAWAY_OK | (mem > 0 ? LIMIT_JOB_MEMORY : 0);
          Marshal.WriteInt32(b, 16, (int)flags);
          Marshal.WriteInt64(b, 120, mem > 0 ? mem : 0);
          if (N.SetInformationJobObject(j.H, JobExtendedLimit, b, 144)) j.Mem = mem; else ok = false;
        }
      } finally { Marshal.FreeHGlobal(b); }
      return ok;
    }

    static void JobLimits(IntPtr job, out object cpuRate, out object memLimit) {
      cpuRate = null; memLimit = null;
      IntPtr b = Marshal.AllocHGlobal(144);
      try {
        uint ret;
        if (N.QueryInformationJobObject(job, JobCpuRateControl, b, 8, out ret)) {
          uint f = (uint)Marshal.ReadInt32(b, 0);
          if ((f & CPU_ENABLE) != 0) cpuRate = Marshal.ReadInt32(b, 4) / 100.0;
        }
        if (N.QueryInformationJobObject(job, JobExtendedLimit, b, 144, out ret)) {
          uint f = (uint)Marshal.ReadInt32(b, 16);
          if ((f & LIMIT_JOB_MEMORY) != 0) memLimit = (double)Marshal.ReadInt64(b, 120);
        }
      } finally { Marshal.FreeHGlobal(b); }
    }

    // ================================================================ TRIM / READ
    static string TrimCmd(Dictionary<string, object> req, ref object result) {
      object mo; MSpec m;
      Json.TryGet(req, "match", out mo);
      string err = ParseMatch(mo, out m);
      if (err != null) return err;
      bool dry = Json.GetBool(req, "dryRun", false);
      List<PInfo> all = Snap(out err);
      if (err != null) return err;
      Tree t = MakeTree(all);
      List<Hit> hits = Resolve(m, t, !dry);
      if (!dry) foreach (Hit h in hits) if (h.PassiveSkip) return FeatureTable.PassiveRefusal + ": would have trimmed a process that is not the test burner";
      long before = 0;
      foreach (Hit h in hits) before += h.P.WorkingSet;
      int n = 0;
      var denied = new Dictionary<string, int>(StringComparer.Ordinal);
      foreach (Hit h in hits) {
        if (h.Deny != null) { Bump(denied, h.Deny); continue; }
        if (dry) { n++; continue; }
        IntPtr ph = N.OpenProcess(P_QUERY_LIMITED | P_SET_QUOTA, false, h.P.Pid);
        if (ph == IntPtr.Zero) { Bump(denied, Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER ? "gone" : "error"); continue; }
        try {
          if (!SameRun(ph, h.P.Created)) Bump(denied, "gone");
          else if (N.EmptyWorkingSet(ph)) n++;
          else Bump(denied, "error");
        } finally { N.CloseHandle(ph); }
      }
      long after = before;
      if (!dry) {
        var pids = new Dictionary<uint, long>();
        foreach (Hit h in hits) pids[h.P.Pid] = h.P.Created;
        after = 0;
        foreach (PInfo p in Snap(out err)) { long c; if (pids.TryGetValue(p.Pid, out c) && c == p.Created) after += p.WorkingSet; }
      }
      var dl = new List<object>();
      foreach (var kv in denied) dl.Add(Json.Obj("access", kv.Key, "n", kv.Value));
      result = Json.Obj("ok", true, "n", n, "before", (double)before, "after", (double)after, "denied", dl, "dryRun", dry ? (object)true : null);
      return null;
    }

    static string ReadCmd(Dictionary<string, object> req, ref object result) {
      int ipid = Json.GetInt(req, "pid", 0);
      if (ipid <= 0) return "apppower.read needs pid";
      uint pid = (uint)ipid;
      string err;
      PInfo me = null;
      foreach (PInfo p in Snap(out err)) if (p.Pid == pid) { me = p; break; }
      if (err != null) return err;
      if (me == null) return "no process with that id is running";
      // Windows answers the graphics priority only through a handle that may SET information (measured
      // 2026-10-14: QUERY rights alone get STATUS_ACCESS_DENIED); never asked of a game
      IntPtr ph = IsGameish(me.Name) ? IntPtr.Zero : N.OpenProcess(P_QUERY_LIMITED | P_QUERY_INFORMATION | P_SET_INFORMATION, false, pid);
      if (ph == IntPtr.Zero) ph = N.OpenProcess(P_QUERY_LIMITED | P_QUERY_INFORMATION, false, pid);
      if (ph == IntPtr.Zero) ph = N.OpenProcess(P_QUERY_LIMITED, false, pid);
      if (ph == IntPtr.Zero) {
        result = Json.Obj("ok", true, "pid", (double)pid, "exe", ExeOf(me.Name), "readable", false, "workingSet", (double)me.WorkingSet,
                          "session", (double)me.Session, "access", AccessOf(pid, me.Created, me.Name, me.Session));
        return null;
      }
      try {
        uint pc = N.GetPriorityClass(ph);
        var th = new THROTTLE { Version = 1 };
        object eco = null;
        if (N.GetProcessInformation(ph, ProcessPowerThrottling, ref th, 12) && (th.ControlMask & 1) != 0) eco = (th.StateMask & 1) != 0;
        uint mp = 0;
        object memPrio = N.GetProcessInformation(ph, ProcessMemoryPriority, ref mp, 4) ? (object)(double)mp : null;
        bool inJob;
        N.IsProcessInJob(ph, IntPtr.Zero, out inJob);
        object cpuRate = null, memLimit = null; string jobName = null; bool existed = false;
        lock (_gate) {
          // the innermost of OUR jobs it is in: its own nested one, else its app's
          foreach (JobRef j in _jobs.Values) {
            bool injob;
            if (!N.IsProcessInJob(ph, j.H, out injob) || !injob) continue;
            if (jobName == null || j.Name.EndsWith("." + pid.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)) { jobName = j.Name; existed = j.Existed; JobLimits(j.H, out cpuRate, out memLimit); }
          }
        }
        int g;
        int grc = N.D3DKMTGetProcessSchedulingPriorityClass(ph, out g);
        object gpu = grc == 0 ? (object)GpuPrioName(g) : null;
        result = Json.Obj("ok", true, "pid", (double)pid, "exe", ExeOf(me.Name), "priority", PrioName(pc) ?? "other", "eco", eco,
                          "memPriority", memPrio, "inJob", inJob, "mantleJob", jobName != null, "jobExisted", jobName != null ? (object)existed : null, "jobCpuRate", cpuRate, "jobMemLimit", memLimit,
                          "workingSet", (double)me.WorkingSet, "gpuPriority", gpu, "gpuWhy", grc == 0 ? null : "status 0x" + grc.ToString("X8"), "cpuMs", me.Cpu100ns / 10000.0, "session", (double)me.Session,
                          "access", AccessOf(pid, me.Created, me.Name, me.Session));
      } finally { N.CloseHandle(ph); }
      return null;
    }

    static string GpuPrioName(int g) {
      switch (g) { case 0: return "idle"; case 1: return "belownormal"; case 2: return "normal"; case 3: return "abovenormal"; case 4: return "high"; case 5: return "realtime"; }
      return "other";
    }
  }
}
