// StartupMeta.cs - what the Startup apps tab shows beside startup.list's items (lane tm-users, 2026-10-28).
//
//   taskmgr.startupmeta {commands: [string]} (at most 256)
//     -> { biosSec|null, rows: [{command, path|null, publisher|null, impact:null, diskIO:null, cpuMs:null}],
//          why: {impact, publisher?, bios?}, ms }
//
//   biosSec   "Last BIOS time": HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power FwPOSTTime (ms)
//             / 1000, one decimal. Null + why.bios when the value is missing or 0 (Windows then shows none).
//   path      the program a startup command runs: a quoted path; an unquoted path with spaces resolved the
//             way CreateProcess does (shortest existing prefix first, ".exe" appended when it has no
//             extension, a bare name searched with SearchPath); environment variables expanded. Hosts:
//             rundll32 -> the DLL it loads; cmd /c|/k [start ["title"] [/switches]] X -> X's program;
//             explorer X.exe -> X.exe (explorer with a folder, URL or document stays explorer.exe);
//             a Startup-folder .lnk -> its target read from the link's LinkInfo (no COM). Null when the
//             file cannot be found.
//   publisher what Windows' Startup tab shows: the file's version-info CompanyName; null when it has none.
//             Cached per path + last-write time (at most 512 entries).
//   impact / diskIO / cpuMs  always null here: Windows measures startup impact itself and keeps it for
//             administrators (the elevated helper's taskmgr.startupimpact fills them).
//
// OUTSIDE DEPENDENCIES: MantleFeature, FeatureTable.Add, Lanes.Slow, Json.Obj / TryGet; kernel32 SearchPathW.
// Logs nothing (paths and command lines never leave this reply).
//
// C# 5 only (build.ps1): no interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class StartupMeta {
    static class N {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      public static extern uint SearchPathW(string path, string file, string ext, uint size, StringBuilder buf, IntPtr filePart);
    }

    const int MAX_COMMANDS = 256, MAX_CACHE = 512, MAX_LEN = 4096;
    const string IMPACT_WHY = "Windows measures startup impact itself and keeps it for administrators";

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.startupmeta", Lanes.Slow, Meta);   // {commands:[string]} -> path, publisher, BIOS time
    }

    sealed class Pub { public long Mtime; public string Company; }
    static readonly object _gate = new object();
    static readonly Dictionary<string, Pub> _pub = new Dictionary<string, Pub>(StringComparer.OrdinalIgnoreCase);

    static string Meta(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      object raw;
      var cmds = Json.TryGet(req, "commands", out raw) ? raw as List<object> : null;
      if (cmds == null) return "needs commands: [string] (startup.list's command lines)";
      if (cmds.Count > MAX_COMMANDS) return "refused: more than " + MAX_COMMANDS + " commands in one request";
      var rows = new List<object>(cmds.Count);
      int noPath = 0, noPub = 0;
      foreach (object o in cmds) {
        string cmd = o as string;
        string path = null, pub = null;
        if (!string.IsNullOrEmpty(cmd) && cmd.Length <= MAX_LEN) {
          try { path = Resolve(cmd, 0); } catch (Exception) { path = null; }
          if (path != null) pub = Publisher(path);
        }
        if (path == null) noPath++; else if (pub == null) noPub++;
        var d = new Dictionary<string, object>();
        d["command"] = cmd; d["path"] = path; d["publisher"] = pub;
        d["impact"] = null; d["diskIO"] = null; d["cpuMs"] = null;
        rows.Add(d);
      }
      var why = new Dictionary<string, object>();
      why["impact"] = IMPACT_WHY;
      if (noPath > 0 || noPub > 0) {
        var w = new List<string>();
        if (noPath > 0) w.Add("Mantle could not find the program " + noPath + (noPath == 1 ? " command runs" : " commands run"));
        if (noPub > 0) w.Add(noPub + (noPub == 1 ? " program carries" : " programs carry") + " no company name in its version info");
        why["publisher"] = string.Join("; ", w.ToArray());
      }
      string bwhy;
      object bios = BiosSec(out bwhy);
      if (bwhy != null) why["bios"] = bwhy;
      var r = new Dictionary<string, object>();
      r["biosSec"] = bios; r["rows"] = rows; r["why"] = why; r["ms"] = (int)sw.ElapsedMilliseconds;
      result = r;
      return null;
    }

    static object BiosSec(out string why) {
      why = null;
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Power")) {
          object v = k == null ? null : k.GetValue("FwPOSTTime");
          if (v is int && (int)v > 0) return Math.Round((int)v / 1000.0, 1);
          why = v == null ? "Windows did not record the firmware's start-up time (FwPOSTTime is missing)" : "the firmware reported no start-up time";
        }
      } catch (Exception ex) { why = "Windows would not give the firmware's start-up time (" + ex.GetType().Name + ")"; }
      return null;
    }

    // ------------------------------------------------------------------ command line -> program

    /// The program `cmd` runs, or null. depth guards cmd /c recursion.
    internal static string Resolve(string cmd, int depth) {
      string s = Environment.ExpandEnvironmentVariables(cmd.Trim());
      if (s.Length == 0) return null;
      string exe, rest;
      if (s[0] == '"') {
        int end = s.IndexOf('"', 1);
        if (end < 0) { exe = Find(s.Substring(1)); rest = ""; }
        else { exe = Find(s.Substring(1, end - 1)); rest = s.Substring(end + 1); }
      } else {
        exe = null; rest = "";
        int from = 0;
        while (true) {   // CreateProcess: try each prefix ending at a space, shortest first, then the whole line
          int sp = s.IndexOf(' ', from);
          string cand = sp < 0 ? s : s.Substring(0, sp);
          string f = cand.Length > 0 ? Find(cand) : null;
          if (f != null) { exe = f; rest = sp < 0 ? "" : s.Substring(sp); break; }
          if (sp < 0) break;
          from = sp + 1;
        }
      }
      if (exe == null) return null;
      rest = rest.Trim();
      string file = Path.GetFileName(exe).ToLowerInvariant();
      if (file.EndsWith(".lnk")) return LinkTarget(exe) ?? exe;
      if (file == "rundll32.exe" && rest.Length > 0) {
        string dll = rest;
        if (dll[0] == '"') { int q = dll.IndexOf('"', 1); dll = q > 0 ? dll.Substring(1, q - 1) : dll.Substring(1); }
        else { int c = dll.IndexOf(','); if (c >= 0) dll = dll.Substring(0, c); }
        dll = dll.Trim().TrimEnd(',');
        string found = dll.Length > 0 ? Find(dll, ".dll") : null;
        return found ?? exe;
      }
      if (file == "cmd.exe" && depth < 2) {
        string inner = AfterSwitch(rest);
        if (inner != null) {
          inner = SkipStart(inner);
          if (inner.Length > 1 && inner[0] == '"' && inner[inner.Length - 1] == '"' && inner.IndexOf('"', 1) == inner.Length - 1) inner = inner.Substring(1, inner.Length - 2);
          string r = inner.Length > 0 ? Resolve(inner, depth + 1) : null;
          if (r != null) return r;
        }
        return exe;
      }
      if (file == "explorer.exe" && rest.Length > 0) {
        string arg = rest[0] == '"' ? rest.Substring(1, Math.Max(0, (rest.IndexOf('"', 1) < 0 ? rest.Length : rest.IndexOf('"', 1)) - 1)) : rest;
        if (arg.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && Path.IsPathRooted(arg) && File.Exists(arg)) return arg;
        return exe;
      }
      return exe;
    }

    /// The text after cmd's /c or /k (null when neither).
    static string AfterSwitch(string rest) {
      for (int i = 0; i + 1 < rest.Length; i++) {
        if (rest[i] != '/' && rest[i] != '-') continue;
        char c = char.ToLowerInvariant(rest[i + 1]);
        if ((c == 'c' || c == 'k') && (i + 2 == rest.Length || rest[i + 2] == ' ' || rest[i + 2] == '"')) return rest.Substring(i + 2).Trim();
      }
      return null;
    }

    /// "start "title" /min X" -> "X" (start's first quoted argument is a window title when more follows).
    static string SkipStart(string s) {
      if (!s.StartsWith("start ", StringComparison.OrdinalIgnoreCase)) return s;
      s = s.Substring(6).TrimStart();
      if (s.StartsWith("\"")) {
        int q = s.IndexOf('"', 1);
        if (q > 0 && s.Substring(q + 1).Trim().Length > 0) s = s.Substring(q + 1).TrimStart();
      }
      while (s.StartsWith("/")) { int sp = s.IndexOf(' '); if (sp < 0) return ""; s = s.Substring(sp + 1).TrimStart(); }
      return s;
    }

    /// A file that exists for `name`: rooted -> as is (or + ext when it has no extension); bare -> SearchPath.
    static string Find(string name) { return Find(name, ".exe"); }
    static string Find(string name, string ext) {
      name = name.Trim();
      if (name.Length == 0 || name.Length > 260 || name.IndexOfAny(Path.GetInvalidPathChars()) >= 0) return null;
      bool hasExt = Path.HasExtension(name);
      if (Path.IsPathRooted(name)) {
        if (File.Exists(name)) return Path.GetFullPath(name);
        if (!hasExt && File.Exists(name + ext)) return Path.GetFullPath(name + ext);
        return null;
      }
      if (name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0) return null;   // relative with a folder: no working dir to resolve it against
      var sb = new StringBuilder(520);
      uint n = N.SearchPathW(null, name, hasExt ? null : ext, (uint)sb.Capacity, sb, IntPtr.Zero);
      return n > 0 && n < sb.Capacity ? sb.ToString() : null;
    }

    /// A .lnk's target from its LinkInfo (LocalBasePath + CommonPathSuffix); null when it has none
    /// (advertised MSI shortcuts, shell-namespace targets) or the file is not a shell link.
    static string LinkTarget(string lnk) {
      try {
        byte[] b;
        using (var f = File.OpenRead(lnk)) {
          if (f.Length < 0x4C || f.Length > 1 << 20) return null;
          b = new byte[f.Length];
          int got = 0;
          while (got < b.Length) { int n = f.Read(b, got, b.Length - got); if (n <= 0) break; got += n; }
        }
        if (BitConverter.ToInt32(b, 0) != 0x4C) return null;
        int flags = BitConverter.ToInt32(b, 0x14);
        int p = 0x4C;
        if ((flags & 0x1) != 0) p += 2 + BitConverter.ToUInt16(b, p);   // HasLinkTargetIDList
        if ((flags & 0x2) == 0 || p + 0x1C > b.Length) return null;      // HasLinkInfo
        int infoSize = BitConverter.ToInt32(b, p), hdr = BitConverter.ToInt32(b, p + 4), liFlags = BitConverter.ToInt32(b, p + 8);
        if ((liFlags & 0x1) == 0 || infoSize <= 0 || p + infoSize > b.Length) return null;   // VolumeIDAndLocalBasePath
        string basePath, suffix;
        if (hdr >= 0x24) {
          basePath = Uni(b, p + BitConverter.ToInt32(b, p + 0x1C), p + infoSize);
          suffix = Uni(b, p + BitConverter.ToInt32(b, p + 0x20), p + infoSize);
        } else {
          basePath = Ansi(b, p + BitConverter.ToInt32(b, p + 0x10), p + infoSize);
          suffix = Ansi(b, p + BitConverter.ToInt32(b, p + 0x18), p + infoSize);
        }
        if (string.IsNullOrEmpty(basePath)) return null;
        string full = basePath + (suffix ?? "");
        return File.Exists(full) ? full : null;
      } catch (Exception) { return null; }
    }

    static string Ansi(byte[] b, int at, int end) {
      if (at <= 0 || at >= end) return null;
      int e = at; while (e < end && b[e] != 0) e++;
      return Encoding.Default.GetString(b, at, e - at);
    }
    static string Uni(byte[] b, int at, int end) {
      if (at <= 0 || at >= end) return null;
      int e = at; while (e + 1 < end && (b[e] != 0 || b[e + 1] != 0)) e += 2;
      return Encoding.Unicode.GetString(b, at, e - at);
    }

    // ------------------------------------------------------------------ publisher

    static string Publisher(string path) {
      long mt;
      try { mt = File.GetLastWriteTimeUtc(path).Ticks; } catch (Exception) { return null; }
      lock (_gate) {
        Pub c;
        if (_pub.TryGetValue(path, out c) && c.Mtime == mt) return c.Company;
      }
      string company = null;
      try {
        FileVersionInfo v = FileVersionInfo.GetVersionInfo(path);
        company = v.CompanyName == null ? null : v.CompanyName.Trim();
        if (company != null && company.Length == 0) company = null;
      } catch (Exception) { company = null; }
      lock (_gate) {
        if (_pub.Count >= MAX_CACHE) _pub.Clear();
        var e = new Pub(); e.Mtime = mt; e.Company = company;
        _pub[path] = e;
      }
      return company;
    }
  }
}
