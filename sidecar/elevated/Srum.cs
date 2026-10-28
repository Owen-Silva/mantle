// Srum.cs - Task Manager "App history" for mantle.elevated.exe (lane tm-elevate-srum, 2026-10-28).
//
// WHAT: Windows' Task Manager App history page reads SRUM (System Resource Usage Monitor). SRUM's
// store is an ESE database, C:\Windows\System32\sr\SRUDB.dat, held open (locked) by the SRUM
// service. This file copies it out of a volume shadow copy with esentutl.exe (the fixed System32
// path, a built argument list, never a shell string), opens the COPY read-only through esent.dll
// (raw P/Invoke, recovery off, no logs written) and sums, per app, over the SRUM rows:
//   SruDbIdMapTable                           IdType, IdIndex, IdBlob    -> id -> identity / user SID
//   {D10CA2FE-6FCF-4F6D-848E-B2E99266FA89}    Application Resource Usage: TimeStamp, AppId, UserId,
//                                             ForegroundCycleTime, BackgroundCycleTime -> cpuTimeSec
//   {973F5D5C-1D90-4944-BE8E-24B94231A174}    Network Usage: TimeStamp, AppId, UserId, InterfaceLuid,
//                                             BytesSent, BytesRecvd -> net / uploads / downloads / metered
//
// COPY: "esentutl /y SRUDB.dat /vssrec sru <sr dir> /d <temp>" first (snapshot + log replay, so the
// copy is a clean-shutdown database ESE will attach). If that fails, "esentutl /y SRUDB.dat /vss /d
// <temp>" (snapshot only; ESE refuses it if it is dirty, and that refusal is reported, not hidden).
// Both need administrator: un-elevated, VSS init fails with 0x80070005 and the reply is a clean
// {ok:false, needsAdmin:true, reason}. The temp folder is ALWAYS deleted in a finally (plus a sweep
// of stale ones from a killed run), and every child process runs under a hard timeout.
//
// METERED: SRUM records the interface (LUID) each byte went over, not whether that network was set
// as metered. Bytes over cellular (WWAN) interfaces count as metered; a Wi-Fi/Ethernet network the
// user marked metered is not distinguishable here. The reply says so in "meteredBasis".
//
// SCOPE: like Task Manager ("for current user account"), rows are filtered to the helper's user
// SID when SRUM knows it; otherwise all users are summed and "scope" says "allUsers".
//
// C# 5 only: no string interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class Srum {
    const string SrDir = @"C:\Windows\System32\sr";
    const string SrDb = @"C:\Windows\System32\sr\SRUDB.dat";
    const string EsentutlPath = @"C:\Windows\System32\esentutl.exe";
    const string EsentutlWow64 = @"C:\Windows\Sysnative\esentutl.exe";   // 32-bit caller on 64-bit Windows
    const string IdMapTable = "SruDbIdMapTable";
    const string AppTable = "{D10CA2FE-6FCF-4F6D-848E-B2E99266FA89}";
    const string NetTable = "{973F5D5C-1D90-4944-BE8E-24B94231A174}";
    const string TempPrefix = "mantle-srum-";
    const string ReasonHead = "App history reads SRUM (SRUDB.dat), which needs administrator; ";
    const string MeteredBasis = "bytes over cellular (WWAN) interfaces; SRUM does not record which Wi-Fi or Ethernet networks were set as metered";
    const int CopyTimeoutMs = 60000;
    static readonly TimeSpan CacheAge = TimeSpan.FromMinutes(5);

    static readonly object _gate = new object();
    static IDictionary _cache;
    static DateTime _cacheAtUtc;
    static readonly Dictionary<string, string> _names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.apphistory", Lanes.Slow, Cmd);
    }

    // {refresh?:bool}. Serves the parsed result for up to 5 minutes; refresh:true forces a re-read.
    // Failures are never cached, so the next ask retries.
    static string Cmd(Dictionary<string, object> req, ref object result) {
      bool refresh = Json.GetBool(req, "refresh", false);
      lock (_gate) {
        if (!refresh && _cache != null && DateTime.UtcNow - _cacheAtUtc < CacheAge) {
          result = _cache;
          return null;
        }
        IDictionary fresh = ReadAll();
        object ok = fresh["ok"];
        if (ok is bool && (bool)ok) { _cache = fresh; _cacheAtUtc = DateTime.UtcNow; }
        result = fresh;
        return null;
      }
    }

    // ------------------------------------------------------------------ read pass

    sealed class Acc {
      public double Cycles;
      public long Sent, Recvd, Metered;
    }

    sealed class Col {
      public uint Id;      // 0 = column not present
      public uint Coltyp;
    }

    static IDictionary Fail(string what, bool accessDenied) {
      // needsAdmin is true whenever admin is the missing piece (not elevated, or access was denied).
      // An elevated helper failing for another reason (e.g. a dirty copy) says so with needsAdmin
      // false, so the UI does not loop on an admin setup that is already done.
      bool needsAdmin = accessDenied || !IsElevated();
      return Json.Obj("ok", false, "needsAdmin", needsAdmin, "reason", ReasonHead + what, "source", "srum");
    }

    static IDictionary ReadAll() {
      string work = null;
      try {
        SweepStaleTemp();
        work = Path.Combine(Path.GetTempPath(), TempPrefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        string copy = Path.Combine(work, "SRUDB.dat");

        bool denied = false;
        bool recovered = false;
        string copyErr = CopyDb(copy, work, ref denied, ref recovered);
        if (copyErr != null) return Fail(copyErr, denied);

        return ParseCopy(copy, work, recovered);
      } catch (Exception ex) {
        return Fail("reading the SRUM copy hit " + ex.GetType().Name + ": " + ex.Message, ex is UnauthorizedAccessException);
      } finally {
        DeleteTree(work);
      }
    }

    // ------------------------------------------------------------------ copy (esentutl)

    static string CopyDb(string dest, string work, ref bool denied, ref bool recovered) {
      string exe = (!Environment.Is64BitProcess && Environment.Is64BitOperatingSystem) ? EsentutlWow64 : EsentutlPath;
      if (!File.Exists(exe)) return "esentutl.exe was not found at " + exe;

      string out1;
      int code1 = RunTool(exe, new string[] { "/y", SrDb, "/vssrec", "sru", SrDir, "/d", dest }, work, out out1);
      if (code1 == 0 && File.Exists(dest)) { recovered = true; return null; }
      if (LooksDenied(out1)) { denied = true; return "esentutl could not take a shadow copy of SRUDB.dat: access denied (" + Gist(out1, code1) + ")"; }

      TryDelete(dest);
      string out2;
      int code2 = RunTool(exe, new string[] { "/y", SrDb, "/vss", "/d", dest }, work, out out2);
      if (code2 == 0 && File.Exists(dest)) return null;
      if (LooksDenied(out2)) denied = true;
      return "esentutl /y /vssrec failed (" + Gist(out1, code1) + ") and esentutl /y /vss failed (" + Gist(out2, code2) + ")";
    }

    static bool LooksDenied(string s) {
      if (s == null) return false;
      return s.IndexOf("0x80070005", StringComparison.OrdinalIgnoreCase) >= 0 ||
             s.IndexOf("access is denied", StringComparison.OrdinalIgnoreCase) >= 0 ||
             s.IndexOf("JET_errFileAccessDenied", StringComparison.OrdinalIgnoreCase) >= 0 ||
             s.IndexOf("-1032", StringComparison.Ordinal) >= 0;
    }

    // The useful line(s) of esentutl's output: the failure detail and the "terminated" line.
    static string Gist(string output, int code) {
      var parts = new List<string>();
      if (output != null) {
        foreach (string raw in output.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) {
          string line = raw.Trim();
          if (line.Length == 0) continue;
          if (line.IndexOf("failed", StringComparison.OrdinalIgnoreCase) >= 0 ||
              line.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0 ||
              line.IndexOf("terminated", StringComparison.OrdinalIgnoreCase) >= 0 ||
              line.IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0) {
            parts.Add(line.Length > 220 ? line.Substring(0, 220) : line);
            if (parts.Count >= 2) break;
          }
        }
      }
      string g = parts.Count > 0 ? string.Join(" | ", parts.ToArray()) : "no error text";
      return "exit " + code.ToString(CultureInfo.InvariantCulture) + ": " + g;
    }

    // Run a fixed exe with a built argument list. stdin is closed at once (esentutl's usage screen
    // waits on a key), output is drained async, and the run is killed past the timeout.
    static int RunTool(string exe, string[] args, string work, out string output) {
      var sb = new StringBuilder();
      // The events are never Closed: a late EOF callback after a kill must not Set a disposed
      // handle on a pool thread (an unhandled exception there would take the helper down).
      var outDone = new ManualResetEvent(false);
      var errDone = new ManualResetEvent(false);
      Process p = null;
      bool drained = false;
      try {
        var psi = new ProcessStartInfo(exe, JoinArgs(args));
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.WorkingDirectory = work;
        p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) {
          try {
            if (e.Data == null) { outDone.Set(); return; }
            lock (sb) sb.AppendLine(e.Data);
          } catch (Exception) { }
        };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) {
          try {
            if (e.Data == null) { errDone.Set(); return; }
            lock (sb) sb.AppendLine(e.Data);
          } catch (Exception) { }
        };
        p.Start();
        try { p.StandardInput.Close(); } catch (Exception) { }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        bool exited = p.WaitForExit(CopyTimeoutMs);
        if (!exited) {
          try { p.Kill(); } catch (Exception) { }
          try { p.WaitForExit(5000); } catch (Exception) { }
        }
        // Drain the async readers, bounded (never the unbounded WaitForExit()).
        drained = outDone.WaitOne(3000) & errDone.WaitOne(3000);
        if (!exited) {
          lock (sb) {
            sb.AppendLine("esentutl timed out after " + (CopyTimeoutMs / 1000).ToString(CultureInfo.InvariantCulture) + " s and was stopped");
            output = sb.ToString();
          }
          return -1;
        }
        lock (sb) output = sb.ToString();
        return p.ExitCode;
      } catch (Exception ex) {
        try { if (p != null && !p.HasExited) p.Kill(); } catch (Exception) { }   // HasExited throws if never started
        lock (sb) output = sb.ToString() + "could not run esentutl: " + ex.Message;
        return -1;
      } finally {
        // Dispose only once both readers hit EOF; otherwise leave the Process to the GC.
        if (p != null && drained) { try { p.Dispose(); } catch (Exception) { } }
      }
    }

    // CommandLineToArgvW-compatible quoting (backslashes before a quote are doubled).
    static string JoinArgs(string[] args) {
      var sb = new StringBuilder();
      foreach (string a in args) {
        if (sb.Length > 0) sb.Append(' ');
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) { sb.Append(a); continue; }
        sb.Append('"');
        int slashes = 0;
        foreach (char c in a) {
          if (c == '\\') { slashes++; continue; }
          if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
          sb.Append('\\', slashes); slashes = 0; sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
      }
      return sb.ToString();
    }

    // ------------------------------------------------------------------ parse (esent.dll)

    static IDictionary ParseCopy(string db, string work, bool recovered) {
      IntPtr inst = IntPtr.Zero, ses = IntPtr.Zero;
      bool created = false, attached = false;
      uint dbid = 0; bool opened = false;
      var notes = new List<object>();
      if (!recovered) notes.Add("esentutl /vssrec failed, so the copy is a plain shadow copy (no log replay); the newest rows may be missing");
      try {
        int pageSize = PageSize(db);
        if (pageSize > 0)
          N.JetSetSystemParameterW(IntPtr.Zero, IntPtr.Zero, P_DatabasePageSize, new IntPtr(pageSize), null);  // already-set is fine

        int err = N.JetCreateInstanceW(out inst, "MantleSrum-" + Guid.NewGuid().ToString("N"));
        if (err < 0) return Fail(Jet("JetCreateInstance", err), false);
        created = true;
        string dir = work.EndsWith("\\") ? work : work + "\\";
        SetParam(ref inst, P_SystemPath, IntPtr.Zero, dir);
        SetParam(ref inst, P_TempPath, IntPtr.Zero, dir);
        SetParam(ref inst, P_LogFilePath, IntPtr.Zero, dir);
        SetParam(ref inst, P_Recovery, IntPtr.Zero, "Off");
        SetParam(ref inst, P_MaxTemporaryTables, IntPtr.Zero, null);
        SetParam(ref inst, P_NoInformationEvent, new IntPtr(1), null);
        SetParam(ref inst, P_EnableIndexChecking, IntPtr.Zero, null);
        SetParam(ref inst, P_CreatePathIfNotExist, new IntPtr(1), null);

        err = N.JetInit(ref inst);
        if (err < 0) return Fail(Jet("JetInit", err), false);
        err = N.JetBeginSessionW(inst, out ses, null, null);
        if (err < 0) { ses = IntPtr.Zero; return Fail(Jet("JetBeginSession", err), false); }
        err = N.JetAttachDatabaseW(ses, db, JET_bitDbReadOnly);
        if (err < 0) return Fail(Jet("JetAttachDatabase (read-only) on the SRUDB.dat copy", err), err == JET_errFileAccessDenied);
        attached = true;
        err = N.JetOpenDatabaseW(ses, db, null, out dbid, JET_bitDbReadOnly);
        if (err < 0) return Fail(Jet("JetOpenDatabase (read-only) on the SRUDB.dat copy", err), err == JET_errFileAccessDenied);
        opened = true;

        // 1. id map: AppId/UserId -> identity string / SID.
        var idName = new Dictionary<int, string>();
        var sidToId = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        string terr = ReadIdMap(ses, dbid, idName, sidToId);
        if (terr != null) return Fail(terr, false);

        int userFilter = int.MinValue;
        string scope = "allUsers";
        string me = CurrentUserSid();
        if (me != null && !IsServiceSid(me)) {
          int uid;
          if (sidToId.TryGetValue(me, out uid)) { userFilter = uid; scope = "currentUser"; }
          else notes.Add("the current user's SID is not in SRUM's id map, so usage for all users is summed");
        }

        // 2. CPU + 3. network.
        var acc = new Dictionary<int, Acc>();
        DateTime since = DateTime.MaxValue;
        bool haveApp, haveNet;
        terr = ReadAppUsage(ses, dbid, userFilter, acc, ref since, out haveApp);
        if (terr != null) return Fail(terr, false);
        terr = ReadNetUsage(ses, dbid, userFilter, acc, ref since, out haveNet);
        if (terr != null) return Fail(terr, false);
        if (!haveApp && !haveNet) return Fail("neither SRUM usage table (" + AppTable + ", " + NetTable + ") is in the copy", false);
        if (!haveApp) notes.Add("the application resource usage table " + AppTable + " is missing, so CPU time is 0");
        if (!haveNet) notes.Add("the network usage table " + NetTable + " is missing, so network columns are 0");

        // 4. rows.
        double hz = CpuHz();
        if (hz <= 0) notes.Add("the CPU clock (HKLM ...\\CentralProcessor\\0 ~MHz) could not be read, so CPU time is 0");
        Dictionary<string, string> devices = DeviceMap();
        var rows = new List<object>();
        var order = new List<Tuple<double, long, IDictionary>>();
        foreach (KeyValuePair<int, Acc> kv in acc) {
          Acc a = kv.Value;
          double cpu = hz > 0 ? a.Cycles / hz : 0;
          long net = a.Sent + a.Recvd;
          if (cpu < 0.0005 && net <= 0) continue;
          string identity;
          if (!idName.TryGetValue(kv.Key, out identity)) identity = "";
          string name = identity.Length > 0 ? DisplayName(identity, devices) : "Unknown app (SRUM id " + kv.Key.ToString(CultureInfo.InvariantCulture) + ")";
          IDictionary row = Json.Obj(
            "name", name,
            "identity", identity,
            "cpuTimeSec", Math.Round(cpu, 3),
            "net", net,
            "metered", a.Metered,
            "tiles", 0,
            "nonMetered", net - a.Metered,
            "downloads", a.Recvd,
            "uploads", a.Sent);
          order.Add(Tuple.Create(cpu, net, row));
        }
        // Heaviest CPU first, then heaviest network (the UI re-sorts by any column).
        order.Sort(delegate(Tuple<double, long, IDictionary> x, Tuple<double, long, IDictionary> y) {
          int c = y.Item1.CompareTo(x.Item1);
          return c != 0 ? c : y.Item2.CompareTo(x.Item2);
        });
        foreach (Tuple<double, long, IDictionary> r in order) rows.Add(r.Item3);

        object sinceIso = since == DateTime.MaxValue ? null : (object)since.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        return Json.Obj(
          "ok", true,
          "since", sinceIso,
          "rows", rows,
          "source", "srum",
          "scope", scope,
          "meteredBasis", MeteredBasis,
          "readAt", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
          "notes", notes);
      } finally {
        if (opened) { try { N.JetCloseDatabase(ses, dbid, 0); } catch (Exception) { } }
        if (attached) { try { N.JetDetachDatabaseW(ses, db); } catch (Exception) { } }
        if (ses != IntPtr.Zero) { try { N.JetEndSession(ses, 0); } catch (Exception) { } }
        if (created) { try { N.JetTerm2(inst, JET_bitTermComplete); } catch (Exception) { } }
      }
    }

    static void SetParam(ref IntPtr inst, uint id, IntPtr num, string str) {
      N.JetSetInstanceParameterW(ref inst, IntPtr.Zero, id, num, str);  // best effort; a refused tuning knob is not fatal
    }

    static string ReadIdMap(IntPtr ses, uint dbid, Dictionary<int, string> idName, Dictionary<string, int> sidToId) {
      IntPtr t;
      int err = N.JetOpenTableW(ses, dbid, IdMapTable, IntPtr.Zero, 0, JET_bitTableReadOnly | JET_bitTableSequential, out t);
      if (err < 0) return Jet("JetOpenTable " + IdMapTable, err);
      try {
        Col cType = Column(ses, t, "IdType"), cIndex = Column(ses, t, "IdIndex"), cBlob = Column(ses, t, "IdBlob");
        if (cIndex.Id == 0 || cBlob.Id == 0) return IdMapTable + " has no IdIndex/IdBlob column";
        byte[] num = new byte[16];
        byte[] blob = new byte[4096];
        for (err = N.JetMove(ses, t, JET_MoveFirst, 0); err >= 0; err = N.JetMove(ses, t, JET_MoveNext, 0)) {
          long idx, type;
          if (!GetInt(ses, t, cIndex, num, out idx)) continue;
          if (!GetInt(ses, t, cType, num, out type)) type = -1;
          byte[] b = GetBytes(ses, t, cBlob, ref blob);
          if (b == null || b.Length == 0) continue;
          if (type == 3) {
            string sid = null;
            try { sid = new SecurityIdentifier(b, 0).Value; } catch (Exception) { }
            if (sid != null && !sidToId.ContainsKey(sid)) sidToId[sid] = (int)idx;
            if (sid != null) idName[(int)idx] = sid;
          } else {
            int n = b.Length & ~1;
            string s = Encoding.Unicode.GetString(b, 0, n).TrimEnd('\0').Trim();
            idName[(int)idx] = s;
          }
        }
        if (err != JET_errNoCurrentRecord) return Jet("JetMove over " + IdMapTable, err);
        return null;
      } finally {
        N.JetCloseTable(ses, t);
      }
    }

    static string ReadAppUsage(IntPtr ses, uint dbid, int userFilter, Dictionary<int, Acc> acc, ref DateTime since, out bool present) {
      present = false;
      IntPtr t;
      int err = N.JetOpenTableW(ses, dbid, AppTable, IntPtr.Zero, 0, JET_bitTableReadOnly | JET_bitTableSequential, out t);
      if (err == JET_errObjectNotFound) return null;
      if (err < 0) return Jet("JetOpenTable " + AppTable + " (application resource usage)", err);
      present = true;
      try {
        Col cTs = Column(ses, t, "TimeStamp"), cApp = Column(ses, t, "AppId"), cUser = Column(ses, t, "UserId");
        Col cFg = Column(ses, t, "ForegroundCycleTime"), cBg = Column(ses, t, "BackgroundCycleTime");
        if (cApp.Id == 0) return AppTable + " has no AppId column";
        byte[] num = new byte[16];
        for (err = N.JetMove(ses, t, JET_MoveFirst, 0); err >= 0; err = N.JetMove(ses, t, JET_MoveNext, 0)) {
          long app, user, fg, bg;
          if (!GetInt(ses, t, cApp, num, out app)) continue;
          if (userFilter != int.MinValue && (!GetInt(ses, t, cUser, num, out user) || user != userFilter)) continue;
          if (!GetInt(ses, t, cFg, num, out fg)) fg = 0;
          if (!GetInt(ses, t, cBg, num, out bg)) bg = 0;
          Acc a = Get(acc, (int)app);
          a.Cycles += (double)(ulong)fg + (double)(ulong)bg;
          Since(ses, t, cTs, num, ref since);
        }
        if (err != JET_errNoCurrentRecord) return Jet("JetMove over " + AppTable, err);
        return null;
      } finally {
        N.JetCloseTable(ses, t);
      }
    }

    static string ReadNetUsage(IntPtr ses, uint dbid, int userFilter, Dictionary<int, Acc> acc, ref DateTime since, out bool present) {
      present = false;
      IntPtr t;
      int err = N.JetOpenTableW(ses, dbid, NetTable, IntPtr.Zero, 0, JET_bitTableReadOnly | JET_bitTableSequential, out t);
      if (err == JET_errObjectNotFound) return null;
      if (err < 0) return Jet("JetOpenTable " + NetTable + " (network usage)", err);
      present = true;
      try {
        Col cTs = Column(ses, t, "TimeStamp"), cApp = Column(ses, t, "AppId"), cUser = Column(ses, t, "UserId");
        Col cLuid = Column(ses, t, "InterfaceLuid"), cSent = Column(ses, t, "BytesSent"), cRecv = Column(ses, t, "BytesRecvd");
        if (cApp.Id == 0) return NetTable + " has no AppId column";
        byte[] num = new byte[16];
        for (err = N.JetMove(ses, t, JET_MoveFirst, 0); err >= 0; err = N.JetMove(ses, t, JET_MoveNext, 0)) {
          long app, user, sent, recv, luid;
          if (!GetInt(ses, t, cApp, num, out app)) continue;
          if (userFilter != int.MinValue && (!GetInt(ses, t, cUser, num, out user) || user != userFilter)) continue;
          if (!GetInt(ses, t, cSent, num, out sent) || sent < 0) sent = 0;
          if (!GetInt(ses, t, cRecv, num, out recv) || recv < 0) recv = 0;
          Acc a = Get(acc, (int)app);
          a.Sent += sent;
          a.Recvd += recv;
          if (GetInt(ses, t, cLuid, num, out luid)) {
            // NET_LUID: IfType is the top 16 bits. 243/244 = IF_TYPE_WWANPP / WWANPP2 (cellular).
            ulong ifType = ((ulong)luid) >> 48;
            if (ifType == 243 || ifType == 244) a.Metered += sent + recv;
          }
          Since(ses, t, cTs, num, ref since);
        }
        if (err != JET_errNoCurrentRecord) return Jet("JetMove over " + NetTable, err);
        return null;
      } finally {
        N.JetCloseTable(ses, t);
      }
    }

    static Acc Get(Dictionary<int, Acc> acc, int app) {
      Acc a;
      if (!acc.TryGetValue(app, out a)) { a = new Acc(); acc[app] = a; }
      return a;
    }

    static void Since(IntPtr ses, IntPtr t, Col c, byte[] num, ref DateTime since) {
      DateTime ts;
      if (GetTime(ses, t, c, num, out ts) && ts < since) since = ts;
    }

    static Col Column(IntPtr ses, IntPtr t, string name) {
      var c = new Col();
      var def = new N.JET_COLUMNDEF();
      def.cbStruct = (uint)Marshal.SizeOf(typeof(N.JET_COLUMNDEF));
      int err = N.JetGetTableColumnInfoW(ses, t, name, ref def, def.cbStruct, JET_ColInfo);
      if (err >= 0) { c.Id = def.columnid; c.Coltyp = def.coltyp; }
      return c;
    }

    // A fixed-size integer column, widened to long. False when absent, null or unreadable.
    static bool GetInt(IntPtr ses, IntPtr t, Col c, byte[] buf, out long v) {
      v = 0;
      if (c.Id == 0) return false;
      uint cb;
      int err = N.JetRetrieveColumn(ses, t, c.Id, buf, (uint)buf.Length, out cb, 0, IntPtr.Zero);
      if (err != 0) return false;   // JET_wrnColumnNull, truncated, or an error
      switch (cb) {
        case 1: v = buf[0]; return true;
        case 2: v = c.Coltyp == JET_coltypUnsignedShort ? (long)BitConverter.ToUInt16(buf, 0) : BitConverter.ToInt16(buf, 0); return true;
        case 4: v = c.Coltyp == JET_coltypUnsignedLong ? (long)BitConverter.ToUInt32(buf, 0) : BitConverter.ToInt32(buf, 0); return true;
        case 8: v = BitConverter.ToInt64(buf, 0); return true;
        default: return false;
      }
    }

    // SRUM TimeStamp is a JET DateTime (OLE Automation date, UTC); an 8-byte integer is read as a FILETIME.
    static bool GetTime(IntPtr ses, IntPtr t, Col c, byte[] buf, out DateTime v) {
      v = DateTime.MinValue;
      if (c.Id == 0) return false;
      uint cb;
      int err = N.JetRetrieveColumn(ses, t, c.Id, buf, (uint)buf.Length, out cb, 0, IntPtr.Zero);
      if (err != 0 || cb != 8) return false;
      if (c.Coltyp == JET_coltypDateTime || c.Coltyp == JET_coltypIEEEDouble) {
        double d = BitConverter.ToDouble(buf, 0);
        if (double.IsNaN(d) || d < 36526 || d > 2958465) return false;   // before 2000 or past 9999 = junk
        v = DateTime.SpecifyKind(DateTime.FromOADate(d), DateTimeKind.Utc);
        return true;
      }
      long ft = BitConverter.ToInt64(buf, 0);
      if (ft <= 0 || ft > DateTime.MaxValue.ToFileTimeUtc()) return false;
      v = DateTime.FromFileTimeUtc(ft);
      return true;
    }

    // A variable-length column (IdBlob). Grows the shared buffer when the value is bigger.
    static byte[] GetBytes(IntPtr ses, IntPtr t, Col c, ref byte[] buf) {
      if (c.Id == 0) return null;
      uint cb;
      int err = N.JetRetrieveColumn(ses, t, c.Id, buf, (uint)buf.Length, out cb, 0, IntPtr.Zero);
      if (err == JET_wrnBufferTruncated && cb > buf.Length && cb <= 1024 * 1024) {
        buf = new byte[cb];
        err = N.JetRetrieveColumn(ses, t, c.Id, buf, (uint)buf.Length, out cb, 0, IntPtr.Zero);
      }
      if (err != 0 || cb > buf.Length) return null;
      byte[] r = new byte[cb];
      Buffer.BlockCopy(buf, 0, r, 0, (int)cb);
      return r;
    }

    // Page size from the database header via ESE (works before any instance), else the raw header.
    static int PageSize(string db) {
      try {
        int ps;
        if (N.JetGetDatabaseFileInfoW(db, out ps, 4, JET_DbInfoPageSize) >= 0 && ValidPage(ps)) return ps;
      } catch (Exception) { }
      try {
        using (var fs = new FileStream(db, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
          byte[] h = new byte[240];
          if (fs.Read(h, 0, h.Length) == h.Length && BitConverter.ToUInt32(h, 4) == 0x89ABCDEF) {
            int ps = BitConverter.ToInt32(h, 236);
            if (ValidPage(ps)) return ps;
          }
        }
      } catch (Exception) { }
      return 0;
    }

    static bool ValidPage(int ps) { return ps == 2048 || ps == 4096 || ps == 8192 || ps == 16384 || ps == 32768; }

    static string Jet(string what, int err) {
      string name;
      switch (err) {
        case -550: name = "JET_errDatabaseDirtyShutdown: the copy was not cleanly shut down and its logs were not replayed"; break;
        case -1032: name = "JET_errFileAccessDenied"; break;
        case -1213: name = "JET_errPageSizeMismatch"; break;
        case -1305: name = "JET_errObjectNotFound"; break;
        case -1811: name = "JET_errFileNotFound"; break;
        case -1206: name = "JET_errDatabaseCorrupted"; break;
        case -1030: name = "JET_errAlreadyInitialized"; break;
        case -1003: name = "JET_errInvalidParameter"; break;
        default: name = "JET error"; break;
      }
      return what + " failed with " + err.ToString(CultureInfo.InvariantCulture) + " (" + name + ")";
    }

    // ------------------------------------------------------------------ names, user, clock

    static string DisplayName(string identity, Dictionary<string, string> devices) {
      string cached;
      if (_names.TryGetValue(identity, out cached)) return cached;
      string name = ComputeName(identity, devices);
      if (_names.Count < 20000) _names[identity] = name;
      return name;
    }

    static string ComputeName(string identity, Dictionary<string, string> devices) {
      string id = identity;
      if (id.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase)) return id;
      if (id.IndexOf('\\') >= 0) {
        string dos = ToDosPath(id, devices);
        string file = id.Substring(id.LastIndexOf('\\') + 1);
        if (dos != null) {
          try {
            if (File.Exists(dos)) {
              string desc = FileVersionInfo.GetVersionInfo(dos).FileDescription;
              if (!string.IsNullOrEmpty(desc) && desc.Trim().Length > 0) return desc.Trim();
              file = Path.GetFileName(dos);
            }
          } catch (Exception) { }
        }
        return file.Length > 0 ? file : id;
      }
      // Package identity: "Publisher.App_<ver>_<arch>__<pubid>" or "Publisher.App_<pubid>!AppId".
      int bang = id.IndexOf('!');
      if (bang > 0) id = id.Substring(0, bang);
      int us = id.IndexOf('_');
      if (us > 0 && id.IndexOf(' ') < 0) id = id.Substring(0, us);
      return id.Length > 0 ? id : identity;
    }

    static string ToDosPath(string nt, Dictionary<string, string> devices) {
      if (nt.Length > 2 && nt[1] == ':') return nt;   // already a DOS path
      foreach (KeyValuePair<string, string> kv in devices) {
        string dev = kv.Key + "\\";
        if (nt.StartsWith(dev, StringComparison.OrdinalIgnoreCase)) return kv.Value + "\\" + nt.Substring(dev.Length);
      }
      return null;
    }

    // \Device\HarddiskVolumeN -> "C:" for every mounted drive letter.
    static Dictionary<string, string> DeviceMap() {
      var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      try {
        foreach (string root in Environment.GetLogicalDrives()) {
          string drive = root.TrimEnd('\\');
          if (drive.Length != 2) continue;
          var sb = new StringBuilder(1024);
          if (N.QueryDosDeviceW(drive, sb, sb.Capacity) == 0) continue;
          string dev = sb.ToString();
          if (dev.Length > 0 && !map.ContainsKey(dev)) map[dev] = drive;
        }
      } catch (Exception) { }
      return map;
    }

    static string CurrentUserSid() {
      try {
        using (WindowsIdentity w = WindowsIdentity.GetCurrent()) {
          return w.User != null ? w.User.Value : null;
        }
      } catch (Exception) { return null; }
    }

    // LocalSystem / LocalService / NetworkService: no "current user" history to scope to.
    static bool IsServiceSid(string sid) {
      return sid == "S-1-5-18" || sid == "S-1-5-19" || sid == "S-1-5-20";
    }

    static bool IsElevated() {
      try {
        using (WindowsIdentity w = WindowsIdentity.GetCurrent()) {
          return new WindowsPrincipal(w).IsInRole(WindowsBuiltInRole.Administrator);
        }
      } catch (Exception) { return false; }
    }

    // Nominal clock in Hz (Task Manager converts SRUM cycle counts to time with it). 0 if unknown.
    static double CpuHz() {
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0")) {
          if (k == null) return 0;
          object v = k.GetValue("~MHz");
          if (v is int && (int)v > 0) return (int)v * 1e6;
        }
      } catch (Exception) { }
      return 0;
    }

    // ------------------------------------------------------------------ temp hygiene

    static void DeleteTree(string dir) {
      if (string.IsNullOrEmpty(dir)) return;
      for (int i = 0; i < 4; i++) {
        try {
          if (!Directory.Exists(dir)) return;
          foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) {
            try { File.SetAttributes(f, FileAttributes.Normal); } catch (Exception) { }
          }
          Directory.Delete(dir, true);
          return;
        } catch (Exception) {
          Thread.Sleep(250);
        }
      }
    }

    static void TryDelete(string f) {
      try { if (File.Exists(f)) File.Delete(f); } catch (Exception) { }
    }

    // A killed helper cannot run its finally; the next read removes its leftovers (older than 30 min).
    static void SweepStaleTemp() {
      try {
        foreach (string d in Directory.GetDirectories(Path.GetTempPath(), TempPrefix + "*")) {
          try {
            if (DateTime.UtcNow - Directory.GetCreationTimeUtc(d) > TimeSpan.FromMinutes(30)) DeleteTree(d);
          } catch (Exception) { }
        }
      } catch (Exception) { }
    }

    // ------------------------------------------------------------------ ESE constants + P/Invoke

    const uint P_SystemPath = 0, P_TempPath = 1, P_LogFilePath = 2, P_MaxTemporaryTables = 10,
               P_Recovery = 34, P_EnableIndexChecking = 45, P_NoInformationEvent = 50,
               P_DatabasePageSize = 64, P_CreatePathIfNotExist = 100;
    const uint JET_bitDbReadOnly = 0x1;
    const uint JET_bitTableReadOnly = 0x4, JET_bitTableSequential = 0x8000;
    const uint JET_bitTermComplete = 0x1;
    const uint JET_ColInfo = 0;
    const uint JET_DbInfoPageSize = 17;
    const int JET_MoveFirst = int.MinValue;   // 0x80000000
    const int JET_MoveNext = 1;
    const int JET_wrnBufferTruncated = 1006;
    const int JET_errNoCurrentRecord = -1603;
    const int JET_errObjectNotFound = -1305;
    const int JET_errFileAccessDenied = -1032;
    const uint JET_coltypIEEEDouble = 7, JET_coltypDateTime = 8, JET_coltypUnsignedLong = 14, JET_coltypUnsignedShort = 17;

    static class N {
      [StructLayout(LayoutKind.Sequential)]
      public struct JET_COLUMNDEF {
        public uint cbStruct;
        public uint columnid;
        public uint coltyp;
        public ushort wCountry;
        public ushort langid;
        public ushort cp;
        public ushort wCollate;
        public uint cbMax;
        public uint grbit;
      }

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetGetDatabaseFileInfoW(string szDatabaseName, out int pvResult, uint cbMax, uint InfoLevel);

      // Global form (pinstance = NULL).
      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetSetSystemParameterW(IntPtr pinstance, IntPtr sesid, uint paramid, IntPtr lParam, string szParam);

      // Per-instance form (pinstance = &instance).
      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true, EntryPoint = "JetSetSystemParameterW")]
      public static extern int JetSetInstanceParameterW(ref IntPtr pinstance, IntPtr sesid, uint paramid, IntPtr lParam, string szParam);

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetCreateInstanceW(out IntPtr pinstance, string szInstanceName);

      [DllImport("esent.dll", ExactSpelling = true)]
      public static extern int JetInit(ref IntPtr pinstance);

      [DllImport("esent.dll", ExactSpelling = true)]
      public static extern int JetTerm2(IntPtr instance, uint grbit);

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetBeginSessionW(IntPtr instance, out IntPtr psesid, string szUserName, string szPassword);

      [DllImport("esent.dll", ExactSpelling = true)]
      public static extern int JetEndSession(IntPtr sesid, uint grbit);

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetAttachDatabaseW(IntPtr sesid, string szFilename, uint grbit);

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetDetachDatabaseW(IntPtr sesid, string szFilename);

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetOpenDatabaseW(IntPtr sesid, string szFilename, string szConnect, out uint pdbid, uint grbit);

      [DllImport("esent.dll", ExactSpelling = true)]
      public static extern int JetCloseDatabase(IntPtr sesid, uint dbid, uint grbit);

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetOpenTableW(IntPtr sesid, uint dbid, string szTableName, IntPtr pvParameters, uint cbParameters, uint grbit, out IntPtr ptableid);

      [DllImport("esent.dll", ExactSpelling = true)]
      public static extern int JetCloseTable(IntPtr sesid, IntPtr tableid);

      [DllImport("esent.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern int JetGetTableColumnInfoW(IntPtr sesid, IntPtr tableid, string szColumnName, ref JET_COLUMNDEF pvResult, uint cbMax, uint InfoLevel);

      [DllImport("esent.dll", ExactSpelling = true)]
      public static extern int JetMove(IntPtr sesid, IntPtr tableid, int cRow, uint grbit);

      [DllImport("esent.dll", ExactSpelling = true)]
      public static extern int JetRetrieveColumn(IntPtr sesid, IntPtr tableid, uint columnid, byte[] pvData, uint cbData, out uint pcbActual, uint grbit, IntPtr pretinfo);

      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
      public static extern uint QueryDosDeviceW(string lpDeviceName, StringBuilder lpTargetPath, int ucchMax);
    }
  }
}
