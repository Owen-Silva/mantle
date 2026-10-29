// TaskMgrSvc.cs - the Services tab (lane tm-data-admin, 2026-10-28).
//
//   taskmgr.services {fresh?}      -> { rows: [{name, display, pid|null, desc|null, status, group|null,
//                                      startType|null, lastOp?}], ms, elevated, fresh, freshMs? }
//   taskmgr.servicesByPid {pid}    -> { pid, names: [...] }   (Details' "Go to service(s)")
//   taskmgr.service {name, op, dryRun?, confirmed?}
//                                  -> { ok, op, name, state|null, startType|null, dryRun, reason|null,
//                                       needsAdmin?, needsConfirm?, title?, text?, button? }
//
// THE LIST is one EnumServicesStatusExW(SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL) with
// the SCM opened for CONNECT|ENUMERATE_SERVICE only. Status words are Windows Task Manager's. The
// description and svchost group (the token after "-k" in the image path; the path itself never leaves
// this file and is never logged) are static: read once per service name with SERVICE_QUERY_CONFIG and
// cached (pruned to the names the last list saw). The START TYPE is never trusted past a page open
// (lane tm-users, Owen 10-28): {fresh:true} re-reads every service's start type (the registry's Start +
// DelayedAutostart, SCM fallback; see RegStartType for the measured cost) and lib sends it every time the Services page
// opens and after every op; every service op's answer carries that service's fresh startType too.
// A service Windows will not open for that gets nulls; it never fails the list.
//
// THE ACTIONS (start / stop / restart):
//   - A short CRITICAL list (Windows needs those running) is confirm-first, as Windows' own warnings are:
//     stop/restart without confirmed:true answers {ok:false, needsConfirm:true, title, text, button} and
//     touches nothing, BEFORE the dry run and before the passive refusal. With confirmed:true it is like
//     any other service, and the SCM's own refusal (it does not accept a stop, other running services
//     depend on it, ...) comes back as the reason in plain words.
//   - The service is opened with exactly the rights the op needs. Mantle is not elevated, so for
//     most services Windows answers access denied: ok:false, needsAdmin:true, 'needs administrator:
//     open Services'. That is the honest answer, not a failure of this file.
//   - dryRun opens with those rights (which changes nothing), reads the state (and for a stop: whether
//     the service accepts one and whether running services depend on it) and answers what it would do.
//     A passive (test) sidecar refuses every real op before looking at anything.
//   - The slow lane is never held waiting for a service: the reply comes at once with the new
//     pending state ('Stopping' / 'Starting'). A ThreadPool watcher follows it for up to 30 s
//     (restart: waits for Stopped, then starts it) and records the outcome per service name as
//     `lastOp: {op, ok, reason, at}` on that row of taskmgr.services, so a failure is never silent.
//     A new op that Windows accepts clears the previous lastOp.
//
// OUTSIDE DEPENDENCIES (everything this file uses that it does not define):
//   TaskMgr.DryRun; Json.Obj / GetInt / GetString / GetBool; MantleFeature, FeatureTable.Add, Lanes.Slow
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
      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetServiceDisplayNameW(IntPtr scm, string name, System.Text.StringBuilder buf, ref uint size);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool EnumDependentServicesW(IntPtr svc, uint state, IntPtr buf, uint size, out uint needed, out uint returned);
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
    const uint SERVICE_QUERY_CONFIG = 0x1, SERVICE_QUERY_STATUS = 0x4, SERVICE_ENUMERATE_DEPENDENTS = 0x8, SERVICE_START = 0x10, SERVICE_STOP = 0x20;
    const uint SERVICE_ACTIVE = 0x1, SERVICE_ACCEPT_STOP = 0x1;
    const uint SERVICE_WIN32 = 0x30, SERVICE_STATE_ALL = 0x3, SERVICE_CONTROL_STOP = 0x1;
    const int SC_ENUM_PROCESS_INFO = 0, SC_STATUS_PROCESS_INFO = 0;
    const uint STOPPED = 1, START_PENDING = 2, STOP_PENDING = 3, RUNNING = 4;
    const int WAIT_MS = 30000;
    const string NEEDS_ADMIN = "needs administrator: open Services";
    const string CRITICAL_TEXT = "Windows needs this service running. Stopping it can make Windows or other apps stop working until you restart.";

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
          int pathOff = IntPtr.Size == 8 ? 16 : 12;
          string path = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, pathOff));
          c.Group = SvchostGroup(path);
          c.StartType = StartWord(h, Marshal.ReadInt32(buf, 4), buf, size);
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

    /// QUERY_SERVICE_CONFIG.dwStartType -> Windows' word; Automatic asks for the delayed flag (buf is scratch).
    static string StartWord(IntPtr h, int start, IntPtr buf, uint size) {
      if (start == 2) {
        uint needed;
        bool delayed = false;
        if (N.QueryServiceConfig2W(h, 3, buf, size, out needed)) delayed = Marshal.ReadInt32(buf, 0) != 0;   // SERVICE_CONFIG_DELAYED_AUTO_START_INFO
        return delayed ? "Automatic (delayed)" : "Automatic";
      }
      return start == 3 ? "Manual" : start == 4 ? "Disabled" : null;
    }

    /// One service's start type straight from the SCM (no cache); null when Windows will not open it.
    static string FreshStartType(IntPtr scm, string name, IntPtr buf, uint size) {
      IntPtr h = N.OpenServiceW(scm, name, SERVICE_QUERY_CONFIG);
      if (h == IntPtr.Zero) return null;
      try {
        uint needed;
        if (!N.QueryServiceConfigW(h, buf, size, out needed)) return null;
        return StartWord(h, Marshal.ReadInt32(buf, 4), buf, size);
      } finally { N.CloseServiceHandle(h); }
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
      bool fresh = Json.GetBool(req, "fresh", false);
      long freshTicks = 0;
      var outRows = new List<object>(rows.Count);
      lock (_gate) {
        IntPtr scm = IntPtr.Zero;
        IntPtr fbuf = IntPtr.Zero;
        Microsoft.Win32.RegistryKey svcKey = null;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try {
          foreach (Row r in rows) {
            seen.Add(r.Name);
            Cfg c;
            bool got = _cfg.TryGetValue(r.Name, out c);
            if (!got) {
              if (scm == IntPtr.Zero) { string e2; scm = OpenScm(SC_MANAGER_CONNECT, out e2); }
              c = scm == IntPtr.Zero ? new Cfg() : ReadCfg(scm, r.Name);
              if (scm != IntPtr.Zero) _cfg[r.Name] = c;   // an SCM that would not open is not cached as "no config"
            } else if (fresh) {
              long f0 = Stopwatch.GetTimestamp();
              if (svcKey == null) svcKey = OpenServicesKey();
              string st = svcKey == null ? null : RegStartType(svcKey, r.Name);
              if (st == null) {   // no registry answer: ask the SCM for this one
                if (scm == IntPtr.Zero) { string e3; scm = OpenScm(SC_MANAGER_CONNECT, out e3); }
                if (fbuf == IntPtr.Zero) fbuf = Marshal.AllocHGlobal((int)FRESH_BUF);
                if (scm != IntPtr.Zero) st = FreshStartType(scm, r.Name, fbuf, FRESH_BUF);
              }
              c.StartType = st;
              freshTicks += Stopwatch.GetTimestamp() - f0;
            }
            var d = new Dictionary<string, object>();
            d["name"] = r.Name; d["display"] = r.Display;
            d["pid"] = r.Pid == 0 ? null : (object)r.Pid;
            d["desc"] = c.Desc; d["status"] = Word(r.State); d["group"] = c.Group; d["startType"] = c.StartType;
            object lo;
            if (_lastOp.TryGetValue(r.Name, out lo)) d["lastOp"] = lo;
            outRows.Add(d);
          }
        } finally {
          if (scm != IntPtr.Zero) N.CloseServiceHandle(scm);
          if (fbuf != IntPtr.Zero) Marshal.FreeHGlobal(fbuf);
          if (svcKey != null) svcKey.Close();
        }
        if (_cfg.Count > seen.Count + 64) {
          var gone = new List<string>();
          foreach (string k in _cfg.Keys) if (!seen.Contains(k)) gone.Add(k);
          foreach (string k in gone) _cfg.Remove(k);
        }
      }
      var res = new Dictionary<string, object>();
      res["rows"] = outRows; res["ms"] = (int)sw.ElapsedMilliseconds; res["elevated"] = Elevated(); res["fresh"] = fresh;
      if (fresh) res["freshMs"] = Math.Round(freshTicks * 1000.0 / Stopwatch.Frequency, 1);
      result = res;
      return null;
    }

    const uint FRESH_BUF = 8192;   // QueryServiceConfigW refuses a buffer over 8 KB (ERROR_INVALID_PARAMETER)

    // FRESH START TYPE (measured 10-28 on Owen's PC, 290 services): the registry's Start + DelayedAutostart
    // under HKLM\SYSTEM\CurrentControlSet\Services ~4 ms for all of them, vs ~42 ms for one OpenService +
    // QueryServiceConfigW (+ the delayed flag) each. The SCM writes those values whenever the start type is
    // changed (ChangeServiceConfig: Services, sc config, Settings). They agreed on every service except a
    // per-user instance (name_luid), whose delayed flag lives on its template key (the SCM inherits it, so
    // this does too), and one the SCM would not open for a standard user (the registry still answers). A
    // service with no readable registry key falls back to the SCM.
    static Microsoft.Win32.RegistryKey OpenServicesKey() {
      try { return Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services"); }
      catch (Exception) { return null; }
    }

    static string RegStartType(Microsoft.Win32.RegistryKey services, string name) {
      try {
        using (Microsoft.Win32.RegistryKey k = services.OpenSubKey(name)) {
          if (k == null) return null;
          object st = k.GetValue("Start");
          if (!(st is int)) return null;
          int v = (int)st;
          if (v == 2) {
            object d = k.GetValue("DelayedAutostart");
            int us = name.LastIndexOf('_');
            if (d == null && us > 0) {   // per-user instance: the template carries the flag
              using (Microsoft.Win32.RegistryKey tk = services.OpenSubKey(name.Substring(0, us))) { if (tk != null) d = tk.GetValue("DelayedAutostart"); }
            }
            return d is int && (int)d != 0 ? "Automatic (delayed)" : "Automatic";
          }
          return v == 3 ? "Manual" : v == 4 ? "Disabled" : null;
        }
      } catch (Exception) { return null; }
    }

    /// One service's start type right now: the registry, else the SCM.
    static string StartTypeNow(IntPtr scm, string name) {
      string st = null;
      Microsoft.Win32.RegistryKey k = OpenServicesKey();
      if (k != null) { try { st = RegStartType(k, name); } finally { k.Close(); } }
      if (st != null || scm == IntPtr.Zero) return st;
      IntPtr buf = Marshal.AllocHGlobal((int)FRESH_BUF);
      try { return FreshStartType(scm, name, buf, FRESH_BUF); } finally { Marshal.FreeHGlobal(buf); }
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

    static uint QueryState(IntPtr svc, out uint exitCode) { uint a; return QueryState(svc, out exitCode, out a); }
    static uint QueryState(IntPtr svc, out uint exitCode, out uint accepts) {
      exitCode = 0; accepts = 0;
      IntPtr b = Marshal.AllocHGlobal(64);
      try {
        uint needed;
        if (!N.QueryServiceStatusEx(svc, SC_STATUS_PROCESS_INFO, b, 64, out needed)) return 0;
        exitCode = (uint)Marshal.ReadInt32(b, 12);   // dwWin32ExitCode
        accepts = (uint)Marshal.ReadInt32(b, 8);     // dwControlsAccepted
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
      if (e == 1051) return "other running services depend on it; Windows will not stop it while they run";
      if (e == 1062) return "it is not running";
      if (e == 1061) return "it cannot take that request right now (it is starting or stopping)";
      if (e == 1052) return "Windows says this service cannot be stopped (it does not accept a stop request)";
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

    /// The op, then the service's start type read fresh from the SCM onto the answer (and into the cache).
    static string Service(Dictionary<string, object> req, ref object result) {
      string err = ServiceOp(req, ref result);
      var d = result as Dictionary<string, object>;
      if (err == null && d != null) {
        string name = d["name"] as string, st = null;
        string e2;
        IntPtr scm = OpenScm(SC_MANAGER_CONNECT, out e2);
        try { st = StartTypeNow(scm, name); } finally { if (scm != IntPtr.Zero) N.CloseServiceHandle(scm); }
        Cfg c;
        lock (_gate) if (st != null && _cfg.TryGetValue(name, out c)) c.StartType = st;
        d["startType"] = st;
      }
      return err;
    }

    static string DisplayName(IntPtr scm, string name) {
      var sb = new System.Text.StringBuilder(260);
      uint size = (uint)sb.Capacity;
      return N.GetServiceDisplayNameW(scm, name, sb, ref size) && sb.Length > 0 ? sb.ToString() : name;
    }

    /// Running services that depend on `name` (0 when Windows will not say; the real stop then reports it).
    static int ActiveDependents(IntPtr scm, string name) {
      IntPtr h = N.OpenServiceW(scm, name, SERVICE_ENUMERATE_DEPENDENTS);
      if (h == IntPtr.Zero) return 0;
      IntPtr buf = IntPtr.Zero;
      try {
        uint needed, count;
        if (N.EnumDependentServicesW(h, SERVICE_ACTIVE, IntPtr.Zero, 0, out needed, out count)) return (int)count;
        if (Marshal.GetLastWin32Error() != 234 || needed == 0 || needed > 1 << 20) return 0;   // ERROR_MORE_DATA
        buf = Marshal.AllocHGlobal((int)needed);
        return N.EnumDependentServicesW(h, SERVICE_ACTIVE, buf, needed, out needed, out count) ? (int)count : 0;
      } finally {
        if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        N.CloseServiceHandle(h);
      }
    }

    static string ServiceOp(Dictionary<string, object> req, ref object result) {
      bool dry = TaskMgr.DryRun(req);
      string name = Json.GetString(req, "name"), op = Json.GetString(req, "op");
      if (op != "start" && op != "stop" && op != "restart") return "op must be start, stop or restart";
      if (string.IsNullOrEmpty(name)) return "needs name (a service's key name from taskmgr.services)";
      if (name.Length > 256) return "a service name is at most 256 characters";

      string err;
      IntPtr scm;
      // Windows needs the Critical services running: confirm first, before the dry run and the passive refusal.
      if (op != "start" && Critical.Contains(name) && !Json.GetBool(req, "confirmed", false)) {
        scm = OpenScm(SC_MANAGER_CONNECT, out err);
        string display = name;
        if (scm != IntPtr.Zero) { display = DisplayName(scm, name); N.CloseServiceHandle(scm); }
        var c = Answer(false, op, name, null, dry, "needs confirmation: Windows needs this service running", false);
        c["needsConfirm"] = true;
        c["title"] = (op == "stop" ? "Stop " : "Restart ") + display + "?";
        c["text"] = CRITICAL_TEXT;
        c["button"] = op == "stop" ? "Stop service" : "Restart service";
        result = c;
        return null;
      }
      if (!dry && HostPassive()) return HostPassiveRefusal();

      scm = OpenScm(SC_MANAGER_CONNECT, out err);
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
          uint qs = 0, qa = 0;
          IntPtr q = N.OpenServiceW(scm, name, SERVICE_QUERY_STATUS);
          if (q != IntPtr.Zero) { uint x; qs = QueryState(q, out x, out qa); st = Word(qs); N.CloseServiceHandle(q); }
          // Not even an administrator can stop a running service that does not accept a stop: say that, not "needs admin".
          if (e == 5 && op != "start" && qs == RUNNING && (qa & SERVICE_ACCEPT_STOP) == 0) {
            result = Answer(false, op, name, st, dry, StopWords(1052), false); return null;
          }
          result = e == 5 ? Answer(false, op, name, st, dry, NEEDS_ADMIN, true)
            : Answer(false, op, name, st, dry, "Windows would not open it (error " + e + ")", false);
          return null;
        }
        uint xc, accepts;
        uint state = QueryState(svc, out xc, out accepts);
        string word = Word(state);
        bool busy;
        lock (_gate) busy = _busy.Contains(name);
        if (busy) { result = Answer(false, op, name, word, dry, "a restart of it is still in progress", false); return null; }
        Cfg cfg;
        lock (_gate) _cfg.TryGetValue(name, out cfg);
        string startNow = StartTypeNow(scm, name);
        bool disabled = startNow != null ? startNow == "Disabled" : cfg != null && cfg.StartType == "Disabled";

        if (dry) {
          string why; bool ok = true;
          if (op == "stop" && state == STOPPED) { ok = false; why = "it is not running"; }
          else if (op == "start" && state == RUNNING) { ok = false; why = "it is already running"; }
          else if (op != "stop" && disabled && (op == "start" || state == STOPPED)) { ok = false; why = "it is disabled"; }
          else if (op != "start" && state == RUNNING && (accepts & SERVICE_ACCEPT_STOP) == 0) { ok = false; why = StopWords(1052); }
          else if (op != "start" && state == RUNNING && ActiveDependents(scm, name) > 0) { ok = false; why = StopWords(1051); }
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
