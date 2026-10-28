// TaskMgrSvc.cs - the Services tab (lane tm-data-admin, 2026-10-28).
//
//   taskmgr.services {}            -> { rows: [{name, display, pid|null, desc|null, status, group|null,
//                                      startType|null, lastOp?}], ms, elevated }
//   taskmgr.servicesByPid {pid}    -> { pid, names: [...] }   (Details' "Go to service(s)")
//   taskmgr.service {name, op, dryRun?} -> { ok, op, name, state|null, dryRun, reason|null, needsAdmin? }
//
// THE LIST is one EnumServicesStatusExW(SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL) with
// the SCM opened for CONNECT|ENUMERATE_SERVICE only. Status words are Windows Task Manager's. The
// description, svchost group (the token after "-k" in the image path; the path itself never leaves
// this file and is never logged) and start type are static: read once per service name with
// SERVICE_QUERY_CONFIG and cached (pruned to the names the last list saw). A service Windows will
// not open for that gets nulls; it never fails the list.
//
// THE ACTIONS (start / stop / restart):
//   - A short CRITICAL list is never stopped or restarted, whatever the rights.
//   - The service is opened with exactly the rights the op needs. Mantle is not elevated, so for
//     most services Windows answers access denied: ok:false, needsAdmin:true, 'needs administrator:
//     open Services'. That is the honest answer, not a failure of this file.
//   - dryRun opens with those rights (which changes nothing), reads the state and answers what it
//     would do. A passive (test) sidecar refuses every real op before looking at anything.
//   - The slow lane is never held waiting for a service: the reply comes at once with the new
//     pending state ('Stopping' / 'Starting'). A ThreadPool watcher follows it for up to 30 s
//     (restart: waits for Stopped, then starts it) and records the outcome per service name as
//     `lastOp: {op, ok, reason, at}` on that row of taskmgr.services, so a failure is never silent.
//     A new op that Windows accepts clears the previous lastOp.
//
// OUTSIDE DEPENDENCIES (everything this file uses that it does not define):
//   TaskMgr.DryRun; Json.Obj / GetInt / GetString; MantleFeature, FeatureTable.Add, Lanes.Slow
//   (Register only); Program.Passive, FeatureTable.PassiveRefusal, Program.EmitLog (ONLY via the Host*
//   accessors). Everything else is advapi32/kernel32 P/Invoke declared below.
//
// C# 5 only (build.ps1): no interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class TaskMgrSvc {
    static class N {
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenSCManagerW(string machine, string db, uint access);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenServiceW(IntPtr scm, string name, uint access);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool CloseServiceHandle(IntPtr h);
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern bool EnumServicesStatusExW(IntPtr scm, int infoLevel, uint type, uint state, IntPtr buf, uint size, out uint needed, out uint returned, ref uint resume, string group);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool QueryServiceConfigW(IntPtr svc, IntPtr buf, uint size, out uint needed);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool QueryServiceConfig2W(IntPtr svc, uint level, IntPtr buf, uint size, out uint needed);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool QueryServiceStatusEx(IntPtr svc, int level, IntPtr buf, uint size, out uint needed);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool ControlService(IntPtr svc, uint control, IntPtr status);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool StartServiceW(IntPtr svc, uint argc, IntPtr argv);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buf, int len, out int ret);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    }

    // ------------------------------------------------------------------ host accessors
    // The ONLY reads of Program / FeatureTable globals in this file, so a second host (the planned
    // elevated helper exe) can compile these handlers and supply its own values here.
    static bool HostPassive() { return Program.Passive; }
    static string HostPassiveRefusal() { return FeatureTable.PassiveRefusal; }
    static void HostLog(string level, string message) { Program.EmitLog(level, message); }

    const uint SC_MANAGER_CONNECT = 0x1, SC_MANAGER_ENUMERATE_SERVICE = 0x4;
    const uint SERVICE_QUERY_CONFIG = 0x1, SERVICE_QUERY_STATUS = 0x4, SERVICE_START = 0x10, SERVICE_STOP = 0x20;
    const uint SERVICE_WIN32 = 0x30, SERVICE_STATE_ALL = 0x3, SERVICE_CONTROL_STOP = 0x1;
    const int SC_ENUM_PROCESS_INFO = 0, SC_STATUS_PROCESS_INFO = 0;
    const uint STOPPED = 1, START_PENDING = 2, STOP_PENDING = 3, RUNNING = 4;
    const int WAIT_MS = 30000;
    const string NEEDS_ADMIN = "needs administrator: open Services";
    const string CRITICAL_WHY = "Windows needs it running; Mantle will not stop it";

    static readonly HashSet<string> Critical = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "RpcSs", "RpcEptMapper", "DcomLaunch", "LSM", "BrokerInfrastructure", "Power", "PlugPlay", "SamSs", "EventLog",
      "Winmgmt", "CoreMessagingRegistrar", "SystemEventsBroker", "gpsvc", "ProfSvc", "Schedule", "mpssvc", "WinDefend",
      "BFE", "Dhcp", "Dnscache", "nsi", "AudioSrv", "AudioEndpointBuilder", "UserManager", "StateRepository",
      "TimeBrokerSvc", "camsvc", "Appinfo"
    };

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.services", Lanes.Slow, Services);          // {} -> every Win32 service, status, pid, desc, group, start type
      t.Add("taskmgr.servicesByPid", Lanes.Slow, ServicesByPid); // {pid} -> the services a process hosts
      t.Add("taskmgr.service", Lanes.Slow, Service);            // {name, op:'start'|'stop'|'restart', dryRun?}
    }

    // ------------------------------------------------------------------ the list

    sealed class Row { public string Name, Display; public uint Pid, State; }
    sealed class Cfg { public string StartType, Group, Desc; }

    static readonly object _gate = new object();
    static readonly Dictionary<string, Cfg> _cfg = new Dictionary<string, Cfg>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, object> _lastOp = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
    static readonly HashSet<string> _busy = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static int _elevated = -1;

    static string Word(uint state) {
      switch (state) {
        case 1: return "Stopped";
        case 2: return "Starting";
        case 3: return "Stopping";
        case 4: return "Running";
        case 5: return "Continuing";
        case 6: return "Pausing";
        case 7: return "Paused";
      }
      return null;
    }

    static IntPtr OpenScm(uint access, out string err) {
      err = null;
      IntPtr scm = N.OpenSCManagerW(null, null, access);
      if (scm == IntPtr.Zero) {
        int e = Marshal.GetLastWin32Error();
        err = "Windows' service manager could not be opened (error " + e + (e == 5 ? ": access denied" : "") + ")";
      }
      return scm;
    }

    /// One enumeration: every Win32 service with its state and pid. Null + err when it failed.
    static List<Row> Enumerate(out string err) {
      IntPtr scm = OpenScm(SC_MANAGER_CONNECT | SC_MANAGER_ENUMERATE_SERVICE, out err);
      if (scm == IntPtr.Zero) return null;
      var rows = new List<Row>(400);
      int ptr = IntPtr.Size;
      int stride = (2 * ptr + 36 + ptr - 1) / ptr * ptr;   // ENUM_SERVICE_STATUS_PROCESSW, aligned
      uint size = 256 * 1024;
      IntPtr buf = Marshal.AllocHGlobal((int)size);
      try {
        uint resume = 0;
        for (int round = 0; round < 64; round++) {
          uint needed, count;
          bool ok = N.EnumServicesStatusExW(scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL, buf, size, out needed, out count, ref resume, null);
          int e = ok ? 0 : Marshal.GetLastWin32Error();
          if (!ok && e != 234) { err = "Windows did not list the services (error " + e + ")"; return null; }
          for (int i = 0; i < count; i++) {
            IntPtr p = new IntPtr(buf.ToInt64() + (long)i * stride);
            var r = new Row();
            r.Name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, 0));
            r.Display = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, ptr));
            r.State = (uint)Marshal.ReadInt32(p, 2 * ptr + 4);
            r.Pid = (uint)Marshal.ReadInt32(p, 2 * ptr + 28);
            if (!string.IsNullOrEmpty(r.Name)) rows.Add(r);
          }
          if (ok) break;
          if (count == 0 && needed > size) {   // not even one entry fit: grow
            Marshal.FreeHGlobal(buf); size = needed + 4096; buf = Marshal.AllocHGlobal((int)size);
          }
        }
      } finally { Marshal.FreeHGlobal(buf); N.CloseServiceHandle(scm); }
      return rows;
    }

    /// Start type, svchost group and description, read once per service name.
    static Cfg ReadCfg(IntPtr scm, string name) {
      var c = new Cfg();
      IntPtr h = N.OpenServiceW(scm, name, SERVICE_QUERY_CONFIG);
      if (h == IntPtr.Zero) return c;
      IntPtr buf = IntPtr.Zero;
      try {
        uint size = 8192, needed;
        buf = Marshal.AllocHGlobal((int)size);
        bool ok = N.QueryServiceConfigW(h, buf, size, out needed);
        if (!ok && Marshal.GetLastWin32Error() == 122 && needed > size) {
          Marshal.FreeHGlobal(buf); size = needed; buf = Marshal.AllocHGlobal((int)size);
          ok = N.QueryServiceConfigW(h, buf, size, out needed);
        }
        if (ok) {
          int start = Marshal.ReadInt32(buf, 4);
          int pathOff = IntPtr.Size == 8 ? 16 : 12;
          string path = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, pathOff));
          c.Group = SvchostGroup(path);
          if (start == 2) {
            bool delayed = false;
            if (N.QueryServiceConfig2W(h, 3, buf, size, out needed)) delayed = Marshal.ReadInt32(buf, 0) != 0;   // SERVICE_CONFIG_DELAYED_AUTO_START_INFO
            c.StartType = delayed ? "Automatic (delayed)" : "Automatic";
          } else c.StartType = start == 3 ? "Manual" : start == 4 ? "Disabled" : null;
        }
        bool dok = N.QueryServiceConfig2W(h, 1, buf, size, out needed);   // SERVICE_CONFIG_DESCRIPTION
        if (!dok && Marshal.GetLastWin32Error() == 122 && needed > size) {
          Marshal.FreeHGlobal(buf); size = needed; buf = Marshal.AllocHGlobal((int)size);
          dok = N.QueryServiceConfig2W(h, 1, buf, size, out needed);
        }
        if (dok) {
          IntPtr d = Marshal.ReadIntPtr(buf, 0);
          string desc = d == IntPtr.Zero ? null : Marshal.PtrToStringUni(d);
          c.Desc = string.IsNullOrEmpty(desc) ? null : desc.Trim();
        }
      } finally {
        if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        N.CloseServiceHandle(h);
      }
      return c;
    }

    /// "C:\WINDOWS\system32\svchost.exe -k netsvcs -p" -> "netsvcs"; null when not svchost-hosted.
    internal static string SvchostGroup(string path) {
      if (string.IsNullOrEmpty(path) || path.IndexOf("svchost.exe", StringComparison.OrdinalIgnoreCase) < 0) return null;
      string[] parts = path.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
      for (int i = 0; i < parts.Length - 1; i++)
        if (string.Equals(parts[i], "-k", StringComparison.OrdinalIgnoreCase) || string.Equals(parts[i], "/k", StringComparison.OrdinalIgnoreCase)) {
          string g = parts[i + 1].Trim('"');
          return g.Length > 0 ? g : null;
        }
      return null;
    }

    static bool Elevated() {
      if (_elevated >= 0) return _elevated == 1;
      int v = 0;
      IntPtr tok;
      if (N.OpenProcessToken(N.GetCurrentProcess(), 0x0008, out tok)) {   // TOKEN_QUERY
        IntPtr b = Marshal.AllocHGlobal(4);
        try {
          int ret;
          if (N.GetTokenInformation(tok, 20, b, 4, out ret)) v = Marshal.ReadInt32(b) != 0 ? 1 : 0;   // TokenElevation
        } finally { Marshal.FreeHGlobal(b); N.CloseHandle(tok); }
      }
      _elevated = v;
      return v == 1;
    }

    static string Services(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      string err;
      List<Row> rows = Enumerate(out err);
      if (rows == null) return err;
      var outRows = new List<object>(rows.Count);
      lock (_gate) {
        IntPtr scm = IntPtr.Zero;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try {
          foreach (Row r in rows) {
            seen.Add(r.Name);
            Cfg c;
            if (!_cfg.TryGetValue(r.Name, out c)) {
              if (scm == IntPtr.Zero) { string e2; scm = OpenScm(SC_MANAGER_CONNECT, out e2); }
              c = scm == IntPtr.Zero ? new Cfg() : ReadCfg(scm, r.Name);
              if (scm != IntPtr.Zero) _cfg[r.Name] = c;   // an SCM that would not open is not cached as "no config"
            }
            var d = new Dictionary<string, object>();
            d["name"] = r.Name; d["display"] = r.Display;
            d["pid"] = r.Pid == 0 ? null : (object)r.Pid;
            d["desc"] = c.Desc; d["status"] = Word(r.State); d["group"] = c.Group; d["startType"] = c.StartType;
            object lo;
            if (_lastOp.TryGetValue(r.Name, out lo)) d["lastOp"] = lo;
            outRows.Add(d);
          }
        } finally { if (scm != IntPtr.Zero) N.CloseServiceHandle(scm); }
        if (_cfg.Count > seen.Count + 64) {
          var gone = new List<string>();
          foreach (string k in _cfg.Keys) if (!seen.Contains(k)) gone.Add(k);
          foreach (string k in gone) _cfg.Remove(k);
        }
      }
      result = Json.Obj("rows", outRows, "ms", (int)sw.ElapsedMilliseconds, "elevated", Elevated());
      return null;
    }

    static string ServicesByPid(Dictionary<string, object> req, ref object result) {
      int pid = Json.GetInt(req, "pid", 0);
      if (pid <= 0) return "needs pid";
      string err;
      List<Row> rows = Enumerate(out err);
      if (rows == null) return err;
      var names = new List<object>();
      foreach (Row r in rows) if (r.Pid == (uint)pid) names.Add(r.Name);
      result = Json.Obj("pid", pid, "names", names);
      return null;
    }

    // ------------------------------------------------------------------ start / stop / restart

    static uint QueryState(IntPtr svc, out uint exitCode) {
      exitCode = 0;
      IntPtr b = Marshal.AllocHGlobal(64);
      try {
        uint needed;
        if (!N.QueryServiceStatusEx(svc, SC_STATUS_PROCESS_INFO, b, 64, out needed)) return 0;
        exitCode = (uint)Marshal.ReadInt32(b, 12);   // dwWin32ExitCode
        return (uint)Marshal.ReadInt32(b, 4);        // dwCurrentState
      } finally { Marshal.FreeHGlobal(b); }
    }

    static Dictionary<string, object> Answer(bool ok, string op, string name, string state, bool dry, string reason, bool needsAdmin) {
      var d = new Dictionary<string, object>();
      d["ok"] = ok; d["op"] = op; d["name"] = name; d["state"] = state; d["dryRun"] = dry; d["reason"] = reason;
      if (needsAdmin) d["needsAdmin"] = true;
      return d;
    }

    static string StopWords(int e) {
      if (e == 5) return NEEDS_ADMIN;
      if (e == 1051) return "other running services depend on it";
      if (e == 1062) return "it is not running";
      if (e == 1061) return "it cannot take that request right now (it is starting or stopping)";
      if (e == 1052) return "it does not accept a stop request";
      return "Windows answered error " + e;
    }

    static string StartWords(int e) {
      if (e == 5) return NEEDS_ADMIN;
      if (e == 1056) return "it is already running";
      if (e == 1058) return "it is disabled";
      if (e == 1068) return "a service it depends on could not start";
      if (e == 1069) return "it could not log on with its account";
      if (e == 1053) return "it did not answer Windows in time";
      return "Windows answered error " + e;
    }

    static void Record(string name, string op, bool ok, string reason) {
      long at = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
      lock (_gate) _lastOp[name] = Json.Obj("op", op, "ok", ok, "reason", reason, "at", at);
      HostLog(ok ? "info" : "warn", "taskmgr.service: " + op + " " + name + (ok ? " done" : ": " + reason));
    }

    static string Service(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      if (!dry && HostPassive()) return HostPassiveRefusal();
      string name = Json.GetString(req, "name"), op = Json.GetString(req, "op");
      if (op != "start" && op != "stop" && op != "restart") return "op must be start, stop or restart";
      if (string.IsNullOrEmpty(name)) return "needs name (a service's key name from taskmgr.services)";
      if (name.Length > 256) return "a service name is at most 256 characters";
      if (op != "start" && Critical.Contains(name)) { result = Answer(false, op, name, null, dry, CRITICAL_WHY, false); return null; }

      string err;
      IntPtr scm = OpenScm(SC_MANAGER_CONNECT, out err);
      if (scm == IntPtr.Zero) return err;
      IntPtr svc = IntPtr.Zero;
      bool handedOff = false;
      try {
        uint need = SERVICE_QUERY_STATUS | (op == "start" ? SERVICE_START : op == "stop" ? SERVICE_STOP : SERVICE_START | SERVICE_STOP);
        svc = N.OpenServiceW(scm, name, need);
        if (svc == IntPtr.Zero) {
          int e = Marshal.GetLastWin32Error();
          if (e == 1060 || e == 123) return "there is no service named " + name;
          string st = null;
          IntPtr q = N.OpenServiceW(scm, name, SERVICE_QUERY_STATUS);
          if (q != IntPtr.Zero) { uint x; st = Word(QueryState(q, out x)); N.CloseServiceHandle(q); }
          result = e == 5 ? Answer(false, op, name, st, dry, NEEDS_ADMIN, true)
            : Answer(false, op, name, st, dry, "Windows would not open it (error " + e + ")", false);
          return null;
        }
        uint xc;
        uint state = QueryState(svc, out xc);
        string word = Word(state);
        bool busy;
        lock (_gate) busy = _busy.Contains(name);
        if (busy) { result = Answer(false, op, name, word, dry, "a restart of it is still in progress", false); return null; }
        Cfg cfg;
        lock (_gate) _cfg.TryGetValue(name, out cfg);
        bool disabled = cfg != null && cfg.StartType == "Disabled";

        if (dry) {
          string why; bool ok = true;
          if (op == "stop" && state == STOPPED) { ok = false; why = "it is not running"; }
          else if (op == "start" && state == RUNNING) { ok = false; why = "it is already running"; }
          else if (op != "stop" && disabled && (op == "start" || state == STOPPED)) { ok = false; why = "it is disabled"; }
          else if (op == "restart" && state == STOPPED) why = "dry run: would start " + name + " (it is not running)";
          else why = "dry run: would " + op + " " + name;
          result = Answer(ok, op, name, word, true, why, false);
          return null;
        }

        if (op == "start") {
          if (!N.StartServiceW(svc, 0, IntPtr.Zero)) {
            int e = Marshal.GetLastWin32Error();
            result = Answer(false, op, name, word, false, StartWords(e), e == 5); return null;
          }
          lock (_gate) _lastOp.Remove(name);
          Watch(scm, svc, name, op, false); handedOff = true;
          result = Answer(true, op, name, "Starting", false, null, false); return null;
        }
        IntPtr ss = Marshal.AllocHGlobal(64);
        int se = 0;
        bool stopped;
        try { stopped = N.ControlService(svc, SERVICE_CONTROL_STOP, ss); if (!stopped) se = Marshal.GetLastWin32Error(); }
        finally { Marshal.FreeHGlobal(ss); }
        if (!stopped && !(op == "restart" && se == 1062)) {
          result = Answer(false, op, name, word, false, StopWords(se), se == 5); return null;
        }
        lock (_gate) _lastOp.Remove(name);
        Watch(scm, svc, name, op, op == "restart"); handedOff = true;
        result = Answer(true, op, name, stopped ? "Stopping" : "Starting", false, null, false);
        return null;
      } finally {
        if (!handedOff) {
          if (svc != IntPtr.Zero) N.CloseServiceHandle(svc);
          N.CloseServiceHandle(scm);
        }
      }
    }

    /// Follows the op on a ThreadPool thread (the handles are its to close) and records the outcome.
    static void Watch(IntPtr scm, IntPtr svc, string name, string op, bool restart) {
      if (restart) lock (_gate) _busy.Add(name);
      ThreadPool.QueueUserWorkItem(delegate (object unused) {
        try {
          uint xc;
          if (op == "stop" || restart) {
            uint st = WaitFor(svc, STOPPED, out xc);
            if (st != STOPPED) { Record(name, op, false, "it did not stop within 30 s (now " + (Word(st) ?? "unknown") + ")"); return; }
            if (!restart) { Record(name, op, true, null); return; }
            if (!N.StartServiceW(svc, 0, IntPtr.Zero)) { Record(name, op, false, "it stopped, then would not start: " + StartWords(Marshal.GetLastWin32Error())); return; }
          }
          uint s2 = WaitFor(svc, RUNNING, out xc);
          if (s2 == RUNNING) Record(name, op, true, null);
          else if (s2 == STOPPED) Record(name, op, false, "it stopped again right after starting (exit code " + xc + ")");
          else Record(name, op, false, "it did not start within 30 s (now " + (Word(s2) ?? "unknown") + ")");
        } catch (Exception ex) {
          Record(name, op, false, "Mantle lost track of it: " + ex.GetType().Name);
        } finally {
          if (restart) lock (_gate) _busy.Remove(name);
          N.CloseServiceHandle(svc); N.CloseServiceHandle(scm);
        }
      });
    }

    /// Polls until the state is `want` or settles elsewhere (Stopped when starting), up to 30 s.
    static uint WaitFor(IntPtr svc, uint want, out uint exitCode) {
      var sw = Stopwatch.StartNew();
      uint st = 0;
      exitCode = 0;
      while (sw.ElapsedMilliseconds < WAIT_MS) {
        st = QueryState(svc, out exitCode);
        if (st == want || st == 0) return st;
        if (want == RUNNING && st == STOPPED && sw.ElapsedMilliseconds > 1000) return st;
        Thread.Sleep(250);
      }
      return st;
    }
  }
}
