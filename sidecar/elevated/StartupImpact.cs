// StartupImpact.cs - the "Startup impact" read for mantle.elevated.exe (the elevated Task Manager helper).
//
//   taskmgr.startupimpact {partial?}
//     -> {ok:true, rows:[{item, name, impact, cpuMs, diskIO, lastRun, enabled}], source, note}
//     -> {ok:false, needsAdmin:true, reason}     when a key/folder it needs is administrator-only
//
// WHERE WINDOWS KEEPS THESE NUMBERS (checked on this machine, Windows 11 build 26300):
//   * On/off state: Explorer\StartupApproved\{Run,Run32,StartupFolder} under HKCU and HKLM. A 12-byte
//     REG_BINARY: byte 0 has bit 0 SET when the entry is disabled (02/06 = enabled, 03 = disabled);
//     bytes 4..11 are the FILETIME it was disabled (all zero while enabled). That FILETIME is NOT a
//     run time and holds NO impact, CPU or disk figure; no StartupApproved value carries more bytes.
//   * CPU at startup / Disk I/O at startup / the impact rating: NOT in the registry. Windows' WDI
//     records the first ~90 s of each sign-in to
//       %windir%\System32\WDI\LogFiles\StartupInfo\<SID>_StartupInfo<n>.xml   (UTF-16 XML)
//     one <Process Name="C:\...\x.exe" PID=".."> per process, with <CpuUsage Units="us">,
//     <DiskUsage Units="bytes">, <CommandLine>, <ParentPID>, <StartTime>, <ParentStartTime>.
//     The folder is SYSTEM/Administrators only (access denied to a normal token here). Task Manager
//     rates the result with Microsoft's published bands: High = more than 1 s of CPU or 3 MB of disk;
//     Medium = 300 ms..1 s of CPU or 300 KB..3 MB of disk; Low = under both; a disabled entry is None.
//     This helper reads the NEWEST file for the current user's SID and sums each entry's process
//     plus the processes it started inside that file.
//   * Last run: the Background Activity Moderator,
//       HKLM\SYSTEM\CurrentControlSet\Services\bam\State\UserSettings\<SID>   (older: bam\UserSettings)
//     value name = "\Device\HarddiskVolumeN\path\x.exe", data = 8-byte FILETIME (UTC) first. Also
//     administrator-only (SecurityException to a normal token here).
//
// The entries and their `item` keys ("<source>|<name>") mirror Startup.cs's fixed source table, so
// tm-data's startup.list rows join on `item` exactly. Read-only throughout: nothing is written.
//
// partial:true (for checks without elevation): instead of the needsAdmin refusal, reply ok:true with
// the rows Windows let us read and the denied figures null, `note` saying which and why.
//
// C# 5 only. Self-contained (Host.cs + ../Json.cs); needs System.Xml.dll (in csc's default refs).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text;
using System.Xml;
using Microsoft.Win32;

namespace Mantle {

  [MantleFeature]
  static class StartupImpact {

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.startupimpact", Lanes.Slow, Cmd);
    }

    const string ApprovedRoot = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\";
    const string WdiDirDisplay = @"%windir%\System32\WDI\LogFiles\StartupInfo";
    const string BamDisplay = @"HKLM\SYSTEM\CurrentControlSet\Services\bam\State\UserSettings\<your SID>";

    // Microsoft's published Task Manager bands.
    const long HighCpuMs = 1000, MedCpuMs = 300;
    const long HighDisk = 3L * 1024 * 1024, MedDisk = 300L * 1024;

    // ------------------------------------------------------------------ sources (same as Startup.cs)

    sealed class Source {
      public string Key;
      public bool Machine;
      public string RunPath;                    // null for a Startup folder
      public Environment.SpecialFolder Folder;
      public string ApprovedSub;
    }

    static Source Src(string key, bool machine, string runPath, Environment.SpecialFolder folder, string sub) {
      var s = new Source();
      s.Key = key; s.Machine = machine; s.RunPath = runPath; s.Folder = folder; s.ApprovedSub = sub;
      return s;
    }

    static readonly Source[] Sources = {
      Src("hkcu-run", false, @"Software\Microsoft\Windows\CurrentVersion\Run", Environment.SpecialFolder.Startup, "Run"),
      Src("hklm-run", true, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", Environment.SpecialFolder.Startup, "Run"),
      Src("hklm-run32", true, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", Environment.SpecialFolder.Startup, "Run32"),
      Src("user-folder", false, null, Environment.SpecialFolder.Startup, "StartupFolder"),
      Src("common-folder", true, null, Environment.SpecialFolder.CommonStartup, "StartupFolder"),
    };

    sealed class Entry {
      public string Item, Name, Command;
      public string Exe;        // full path of the program it starts, or null
      public string Args;       // its arguments (used when the program is a generic host)
      public bool Enabled;
    }

    // Programs that run something else; matching on them alone would claim every rundll32 etc.
    static readonly string[] Hosts = { "rundll32.exe", "cmd.exe", "wscript.exe", "cscript.exe", "powershell.exe",
                                       "pwsh.exe", "mshta.exe", "conhost.exe", "explorer.exe", "regsvr32.exe" };

    static RegistryKey Base(bool machine) {
      return RegistryKey.OpenBaseKey(machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64);
    }

    // ------------------------------------------------------------------ handler

    static string Cmd(Dictionary<string, object> req, ref object result) {
      bool partial = Json.GetBool(req, "partial", false);
      var notes = new List<string>();

      string sid = null;
      try {
        using (WindowsIdentity id = WindowsIdentity.GetCurrent()) sid = id.User != null ? id.User.Value : null;
      } catch (Exception) { sid = null; }

      // 1. Entries + on/off state (HKCU readable by anyone; HKLM keys are readable by users too).
      var entries = new List<Entry>();
      foreach (Source s in Sources) {
        string problem = ReadSource(s, entries);
        if (problem != null) notes.Add(problem);
      }

      // 2. WDI StartupInfo: CPU and disk at startup.
      List<Proc> procs = null;
      string wdiFile = null;
      bool wdiDenied = false;
      if (sid == null) {
        notes.Add("Windows did not say which user this is, so the startup measurements and last-run times could not be matched");
      } else {
        try {
          procs = ReadNewestStartupInfo(sid, out wdiFile);
          if (procs == null)
            notes.Add("Windows has not written a startup measurement (" + WdiDirDisplay + "\\" + sid +
                      "_StartupInfo*.xml) for this user yet; it does so about 90 seconds after a sign-in, so CPU, disk and impact are blank");
        } catch (UnauthorizedAccessException) { wdiDenied = true; }
        catch (SecurityException) { wdiDenied = true; }
        catch (Exception ex) {
          notes.Add("the startup measurement could not be read (" + ex.Message + "), so CPU, disk and impact are blank");
          procs = null;
        }
      }
      if (wdiDenied && !partial) {
        result = Json.Obj("ok", false, "needsAdmin", true,
          "reason", "Startup impact reads " + WdiDirDisplay + ", which needs administrator; Windows said access denied");
        return null;
      }
      if (wdiDenied)
        notes.Add("CPU at startup, disk at startup and impact are blank: they live only in " + WdiDirDisplay +
                  ", which needs administrator (Windows said access denied); the registry holds no such figures");

      // 3. BAM: last run.
      Dictionary<string, long> bam = null;
      bool bamDenied = false;
      if (sid != null) {
        try {
          bam = ReadBam(sid);
          if (bam == null) notes.Add("Windows keeps no last-run record (BAM) for this user, so last run is blank");
        } catch (UnauthorizedAccessException) { bamDenied = true; }
        catch (SecurityException) { bamDenied = true; }
        catch (Exception ex) { notes.Add("the last-run record (BAM) could not be read (" + ex.Message + "), so last run is blank"); }
      }
      if (bamDenied && !partial) {
        result = Json.Obj("ok", false, "needsAdmin", true,
          "reason", "Startup impact reads " + BamDisplay + ", which needs administrator; Windows said access denied");
        return null;
      }
      if (bamDenied)
        notes.Add("last run is blank: it lives in " + BamDisplay + ", which needs administrator (Windows said access denied)");

      // 4. Rows.
      var rows = new List<object>();
      int notMeasured = 0, noExe = 0;
      foreach (Entry e in entries) {
        object impact = null, cpu = null, disk = null, last = null;
        if (procs != null) {
          long c = 0, d = 0;
          bool seen = e.Exe != null && Measure(procs, e, out c, out d);
          if (seen) { cpu = c; disk = d; }
          if (!e.Enabled) impact = "None";
          else if (seen) impact = Rate(c, d);
          else notMeasured++;
        } else if (!e.Enabled) {
          impact = "None";       // Task Manager shows None for a disabled entry whatever was measured
        }
        if (e.Exe == null) noExe++;
        if (bam != null && e.Exe != null) {
          long ft;
          if (bam.TryGetValue(VolumeTail(e.Exe), out ft)) last = Iso(ft);
        }
        rows.Add(Json.Obj("item", e.Item, "name", e.Name, "impact", impact, "cpuMs", cpu, "diskIO", disk,
                          "lastRun", last, "enabled", e.Enabled));
      }
      if (procs != null && notMeasured > 0)
        notes.Add(notMeasured + " enabled entr" + (notMeasured == 1 ? "y was" : "ies were") +
                  " not seen in the newest startup measurement (" + Path.GetFileName(wdiFile) +
                  "), so Windows has not measured them (Task Manager says \"Not measured\"); impact is blank");
      if (noExe > 0)
        notes.Add(noExe + " entr" + (noExe == 1 ? "y has" : "ies have") + " no program path Mantle could work out, so its figures are blank");

      string source = procs != null ? "wdi" : (bam != null ? "bam" : (entries.Count > 0 ? "registry" : null));
      result = Json.Obj("ok", true, "rows", rows, "source", source,
                        "note", notes.Count == 0 ? null : string.Join("; ", notes.ToArray()));
      return null;
    }

    static string Rate(long cpuMs, long disk) {
      if (cpuMs > HighCpuMs || disk > HighDisk) return "High";
      if (cpuMs >= MedCpuMs || disk >= MedDisk) return "Medium";
      return "Low";
    }

    static string Iso(long ft) {
      if (ft <= 0) return null;
      try { return DateTime.FromFileTimeUtc(ft).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture); }
      catch (ArgumentOutOfRangeException) { return null; }
    }

    // ------------------------------------------------------------------ entries

    static string ReadSource(Source src, List<Entry> into) {
      var found = new List<KeyValuePair<string, string>>();
      try {
        if (src.RunPath != null) {
          using (RegistryKey hk = Base(src.Machine))
          using (RegistryKey run = hk.OpenSubKey(src.RunPath, false)) {
            if (run != null) {
              foreach (string n in run.GetValueNames()) {
                if (string.IsNullOrEmpty(n)) continue;
                object v = run.GetValue(n, null);   // expanded: we want a real path
                string cmd = v as string;
                if (cmd == null && v is string[]) cmd = string.Join(" ", (string[])v);
                found.Add(new KeyValuePair<string, string>(n, cmd));
              }
            }
          }
        } else {
          string dir = Environment.GetFolderPath(src.Folder);
          if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) {
            foreach (string f in Directory.GetFiles(dir)) {
              string n = Path.GetFileName(f);
              if (string.Equals(n, "desktop.ini", StringComparison.OrdinalIgnoreCase)) continue;
              found.Add(new KeyValuePair<string, string>(n, f));
            }
          }
        }
      } catch (Exception ex) {
        return src.Key + " could not be read (" + ex.Message + ")";
      }

      RegistryKey approved = null;
      try {
        using (RegistryKey hk = Base(src.Machine)) approved = hk.OpenSubKey(ApprovedRoot + src.ApprovedSub, false);
      } catch (Exception) { approved = null; }
      try {
        foreach (KeyValuePair<string, string> kv in found) {
          var e = new Entry();
          e.Item = src.Key + "|" + kv.Key;
          e.Name = kv.Key;
          e.Command = kv.Value;
          e.Enabled = IsEnabled(approved, kv.Key);
          if (src.RunPath != null) SplitCommand(kv.Value, out e.Exe, out e.Args);
          else ResolveFile(kv.Value, out e.Exe, out e.Args);
          into.Add(e);
        }
      } finally {
        if (approved != null) approved.Close();
      }
      return null;
    }

    // Same rule as Startup.cs: no value or bit 0 clear = enabled.
    static bool IsEnabled(RegistryKey approved, string name) {
      if (approved == null) return true;
      try {
        byte[] b = approved.GetValue(name, null) as byte[];
        if (b == null || b.Length < 1) return true;
        return (b[0] & 1) == 0;
      } catch (Exception) { return true; }
    }

    /// "C:\x\y.exe" -a  |  C:\x\y.exe -a  |  C:\Program Files\x\y.exe -a (unquoted with spaces)
    static void SplitCommand(string cmd, out string exe, out string args) {
      exe = null; args = "";
      if (string.IsNullOrEmpty(cmd)) return;
      string c = Environment.ExpandEnvironmentVariables(cmd).Trim();
      if (c.StartsWith("\"")) {
        int q = c.IndexOf('"', 1);
        if (q > 1) { exe = c.Substring(1, q - 1); args = c.Substring(q + 1).Trim(); }
        else exe = c.Trim('"');
      } else {
        // Grow the candidate one space-separated word at a time until it names a file.
        int pos = 0;
        while (true) {
          int sp = c.IndexOf(' ', pos);
          string cand = sp < 0 ? c : c.Substring(0, sp);
          string withExe = cand.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? cand : cand + ".exe";
          if (SafeExists(cand) || SafeExists(withExe)) {
            exe = SafeExists(cand) ? cand : withExe;
            args = sp < 0 ? "" : c.Substring(sp + 1).Trim();
            break;
          }
          if (sp < 0) {
            int first = c.IndexOf(' ');
            exe = first < 0 ? c : c.Substring(0, first);
            args = first < 0 ? "" : c.Substring(first + 1).Trim();
            break;
          }
          pos = sp + 1;
        }
      }
      exe = FullPath(exe);
    }

    static bool SafeExists(string p) {
      try { return p.IndexOf('\\') >= 0 && File.Exists(p); } catch (Exception) { return false; }
    }

    static string FullPath(string p) {
      if (string.IsNullOrEmpty(p)) return null;
      if (p.IndexOf('\\') < 0) {
        // A bare name ("rundll32.exe"): System32 is where Windows finds the hosts that matter here.
        string n = p.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? p : p + ".exe";
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), n);
      }
      try { return Path.GetFullPath(p); } catch (Exception) { return p; }
    }

    /// A Startup-folder file: a .lnk is resolved through WScript.Shell (late-bound COM, no interop
    /// assembly); anything else is the program itself, or run by cmd/wscript for a script.
    static void ResolveFile(string file, out string exe, out string args) {
      exe = null; args = "";
      if (string.IsNullOrEmpty(file)) return;
      string ext = Path.GetExtension(file).ToLowerInvariant();
      if (ext == ".lnk") {
        object shell = null, link = null;
        try {
          Type t = Type.GetTypeFromProgID("WScript.Shell");
          if (t == null) return;
          shell = Activator.CreateInstance(t);
          link = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { file });
          Type lt = link.GetType();
          string target = lt.InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null) as string;
          string a = lt.InvokeMember("Arguments", BindingFlags.GetProperty, null, link, null) as string;
          if (!string.IsNullOrEmpty(target)) { exe = FullPath(Environment.ExpandEnvironmentVariables(target)); args = a ?? ""; }
        } catch (Exception) { exe = null; }
        finally {
          if (link != null && Marshal.IsComObject(link)) Marshal.ReleaseComObject(link);
          if (shell != null && Marshal.IsComObject(shell)) Marshal.ReleaseComObject(shell);
        }
      } else if (ext == ".exe") {
        exe = FullPath(file);
      } else if (ext == ".bat" || ext == ".cmd") {
        exe = FullPath("cmd.exe"); args = Path.GetFileName(file);
      } else if (ext == ".vbs" || ext == ".js") {
        exe = FullPath("wscript.exe"); args = Path.GetFileName(file);
      }
    }

    // ------------------------------------------------------------------ WDI StartupInfo

    sealed class Proc {
      public string Path, CommandLine, Pid, ParentPid, StartTime, ParentStartTime;
      public long CpuMs, DiskBytes;
    }

    /// The newest <sid>_StartupInfo*.xml, parsed; null when there is none. Throws
    /// UnauthorizedAccessException when the folder is administrator-only.
    static List<Proc> ReadNewestStartupInfo(string sid, out string file) {
      file = null;
      string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WDI\LogFiles\StartupInfo");
      // No Directory.Exists first: it answers false on access denied, which would hide the denial.
      string[] files;
      try { files = Directory.GetFiles(dir, sid + "_StartupInfo*.xml"); }   // UnauthorizedAccessException propagates
      catch (DirectoryNotFoundException) { return null; }
      DateTime best = DateTime.MinValue;
      foreach (string f in files) {
        DateTime w = File.GetLastWriteTimeUtc(f);
        if (file == null || w > best) { best = w; file = f; }
      }
      if (file == null) return null;
      return ParseStartupInfo(File.ReadAllBytes(file));
    }

    static List<Proc> ParseStartupInfo(byte[] raw) {
      string text;
      if (raw.Length >= 2 && raw[0] == 0xFF && raw[1] == 0xFE) text = Encoding.Unicode.GetString(raw, 2, raw.Length - 2);
      else if (raw.Length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF) text = Encoding.UTF8.GetString(raw, 3, raw.Length - 3);
      else if (raw.Length >= 2 && raw[1] == 0) text = Encoding.Unicode.GetString(raw);
      else text = Encoding.UTF8.GetString(raw);

      var settings = new XmlReaderSettings();
      settings.DtdProcessing = DtdProcessing.Prohibit;
      settings.XmlResolver = null;
      var doc = new XmlDocument();
      doc.XmlResolver = null;
      using (var sr = new StringReader(text))
      using (XmlReader xr = XmlReader.Create(sr, settings)) doc.Load(xr);

      var list = new List<Proc>();
      foreach (XmlNode n in doc.GetElementsByTagName("*")) {
        if (n.NodeType != XmlNodeType.Element || n.LocalName != "Process") continue;
        var el = (XmlElement)n;
        var p = new Proc();
        p.Path = el.GetAttribute("Name");
        p.Pid = el.GetAttribute("PID");
        p.CommandLine = Child(el, "CommandLine");
        p.ParentPid = Child(el, "ParentPID");
        p.StartTime = Child(el, "StartTime");
        p.ParentStartTime = Child(el, "ParentStartTime");
        p.CpuMs = Quantity(el, "CpuUsage", true);
        p.DiskBytes = Quantity(el, "DiskUsage", false);
        list.Add(p);
      }
      return list;
    }

    static XmlElement ChildEl(XmlElement el, string local) {
      foreach (XmlNode c in el.ChildNodes)
        if (c.NodeType == XmlNodeType.Element && c.LocalName == local) return (XmlElement)c;
      return null;
    }

    static string Child(XmlElement el, string local) {
      XmlElement c = ChildEl(el, local);
      return c == null ? null : c.InnerText.Trim();
    }

    /// CpuUsage -> milliseconds (Windows writes Units="us"); DiskUsage -> bytes (Units="bytes").
    static long Quantity(XmlElement el, string local, bool time) {
      XmlElement c = ChildEl(el, local);
      if (c == null) return 0;
      double v;
      if (!double.TryParse(c.InnerText.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return 0;
      string u = (c.GetAttribute("Units") + c.GetAttribute("Unit")).Trim().ToLowerInvariant();
      if (time) {
        if (u == "us" || u == "microseconds") v = v / 1000.0;
        else if (u == "ns" || u == "nanoseconds") v = v / 1000000.0;
        else if (u == "100ns") v = v / 10000.0;
        else if (u == "s" || u == "seconds") v = v * 1000.0;
        else if (u == "" ) v = v / 1000.0;   // no unit: Windows' own files say "us"
      } else {
        if (u == "kb") v = v * 1024; else if (u == "mb") v = v * 1024 * 1024;
      }
      return (long)Math.Round(v);
    }

    /// Sums the entry's process(es) and everything they started within the measurement.
    static bool Measure(List<Proc> procs, Entry e, out long cpuMs, out long disk) {
      cpuMs = 0; disk = 0;
      string want = VolumeTail(e.Exe);
      bool host = Array.IndexOf(Hosts, Path.GetFileName(e.Exe).ToLowerInvariant()) >= 0;
      var taken = new HashSet<Proc>();
      var queue = new Queue<Proc>();
      foreach (Proc p in procs) {
        if (string.IsNullOrEmpty(p.Path) || VolumeTail(p.Path) != want) continue;
        if (host) {
          // A host program only counts when its command line carries this entry's arguments.
          if (string.IsNullOrEmpty(e.Args) || p.CommandLine == null ||
              p.CommandLine.IndexOf(e.Args, StringComparison.OrdinalIgnoreCase) < 0) continue;
        }
        if (taken.Add(p)) queue.Enqueue(p);
      }
      if (taken.Count == 0) return false;
      while (queue.Count > 0) {
        Proc parent = queue.Dequeue();
        cpuMs += parent.CpuMs; disk += parent.DiskBytes;
        foreach (Proc c in procs) {
          if (taken.Contains(c) || string.IsNullOrEmpty(c.ParentPid) || c.ParentPid != parent.Pid) continue;
          if (!string.IsNullOrEmpty(c.ParentStartTime) && !string.IsNullOrEmpty(parent.StartTime) &&
              c.ParentStartTime != parent.StartTime) continue;   // a reused PID, not this parent
          taken.Add(c); queue.Enqueue(c);
        }
      }
      return true;
    }

    /// "C:\A\b.exe" and "\Device\HarddiskVolume3\A\b.exe" both -> "\a\b.exe", so a drive path and
    /// a BAM/WDI device path compare without a QueryDosDevice call.
    static string VolumeTail(string p) {
      if (string.IsNullOrEmpty(p)) return "";
      string s = p.Trim();
      if (s.StartsWith(@"\\?\")) s = s.Substring(4);
      if (s.StartsWith(@"\Device\", StringComparison.OrdinalIgnoreCase)) {
        int i = s.IndexOf('\\', 8);
        s = i < 0 ? "" : s.Substring(i);
      } else if (s.Length >= 2 && s[1] == ':') {
        s = s.Substring(2);
      }
      return s.ToLowerInvariant();
    }

    // ------------------------------------------------------------------ BAM

    /// path tail -> last-run FILETIME, or null when there is no BAM key for this user. Throws
    /// SecurityException / UnauthorizedAccessException when it is administrator-only.
    static Dictionary<string, long> ReadBam(string sid) {
      string[] roots = { @"SYSTEM\CurrentControlSet\Services\bam\State\UserSettings\",
                         @"SYSTEM\CurrentControlSet\Services\bam\UserSettings\" };
      using (RegistryKey hk = Base(true)) {
        foreach (string r in roots) {
          using (RegistryKey k = hk.OpenSubKey(r + sid, false)) {
            if (k == null) continue;
            var map = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (string n in k.GetValueNames()) {
              byte[] b = k.GetValue(n, null) as byte[];
              if (b == null || b.Length < 8 || n.IndexOf('\\') < 0) continue;   // skip Version / SequenceNumber
              long ft = BitConverter.ToInt64(b, 0);
              string tail = VolumeTail(n);
              long had;
              if (!map.TryGetValue(tail, out had) || ft > had) map[tail] = ft;
            }
            return map;
          }
        }
      }
      return null;
    }
  }
}
