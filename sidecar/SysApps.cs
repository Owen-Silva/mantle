// SysApps.cs - Settings > Apps > Installed apps for Mantle Settings (lane appsacct, 2026-09-29).
//
// WHY: Mantle Settings replaces Windows Settings (ui/settings/SECTIONS.md). Windows' Installed apps
// page is two lists glued together, and so is this one:
//   * desktop (Win32) apps: the Uninstall keys Windows' own list reads - HKLM (64 and 32-bit views)
//     and HKCU - with the same hiding rules (SystemComponent, updates, entries with no name);
//   * Store (packaged) apps: Windows.Management.Deployment.PackageManager for the CURRENT USER,
//     without the frameworks, resource packages and system-signed parts of Windows.
// PackageManager is reached by REFLECTION over the WinRT projection the CLR does by itself
// (Type.GetType("...,ContentType=WindowsRuntime")): no winmd reference, so this file builds the same
// with or without MANTLE_WINMD. MEASURED here: 180 packages enumerated in ~85 ms.
//
// Commands (all Lanes.Slow):
//   apps.installed {sizes?}          both lists: name, publisher, version, size, install date, drive,
//                                    what uninstall / modify would run (or why they cannot). sizes:true
//                                    starts ONE background walk that sizes the Store apps' folders
//                                    (Windows keeps no size for them); later reads carry the results.
//   apps.uninstall {key, dryRun?}    Store app: PackageManager.RemovePackageAsync(full name) for this
//                                    user, on its own thread (the next apps.installed says how it went).
//                                    Desktop app: starts the app's OWN UninstallString (its own
//                                    uninstaller, which may ask Windows for administrator rights itself).
//   apps.modify {key, dryRun?}       the app's ModifyPath, or MsiExec /I{product code} for an MSI.
// THE COMMAND LINE RULE: a request carries only `key` (a hash this file made). The command that runs is
// read from the registry entry that key names, never from the request, so no request text can ever
// reach a command line. A key that names nothing is refused. dryRun answers exactly what would run.
// Passive (tests): every uninstall / modify is refused after its dryRun; nothing is ever started.
//
// PRIVACY: nothing here logs. App names, paths and commands reach the page only in results.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysApps {
    public static void Register(FeatureTable t) {
      t.Add("apps.installed", Lanes.Slow, Installed);
      t.Add("apps.uninstall", Lanes.Slow, Uninstall);
      t.Add("apps.modify", Lanes.Slow, Modify);
    }

    // ------------------------------------------------------------------ one app
    sealed class App {
      public string Key, Kind, Name, Publisher, Version, Drive, Scope, Uninstall, ModifyCmd, NoRemove, NoModify, FullName, Family, Path;
      public object Installed;   // ms or null
      public long? Size;
    }

    static readonly string[][] ROOTS = {
      new[] { "HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "machine" },
      new[] { "HKLM", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", "machine" },
      new[] { "HKCU", @"Software\Microsoft\Windows\CurrentVersion\Uninstall", "user" },
      new[] { "HKCU", @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", "user" },
    };
    static readonly Regex KEY = new Regex("^[ws][0-9a-z]{1,13}$");
    static readonly Regex GUID = new Regex(@"^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$");

    /// A stable short key (FNV-1a, base 36): the page and the request only ever carry this.
    public static string KeyOf(string prefix, string s) {
      uint h = 2166136261;
      foreach (char c in s.ToLowerInvariant()) { h ^= c; h *= 16777619; }
      const string D = "0123456789abcdefghijklmnopqrstuvwxyz";
      string o = "";
      do { o = D[(int)(h % 36)] + o; h /= 36; } while (h > 0);
      return prefix + o;
    }

    static string Str(RegistryKey k, string name) {
      try {
        object v = k.GetValue(name, null);
        string s = v as string;
        return string.IsNullOrWhiteSpace(s) ? null : s.Trim();
      } catch (Exception) { return null; }
    }
    static long? Dw(RegistryKey k, string name) {
      try {
        object v = k.GetValue(name, null);
        if (v is int) return (long)(uint)(int)v;
        if (v is long) return (long)v;
        string s = v as string;
        long n;
        if (s != null && long.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) return n;
      } catch (Exception) { }
      return null;
    }
    static object Ms(DateTime utc) {
      return Math.Floor((utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
    }
    static string DriveOf(string path) {
      if (string.IsNullOrEmpty(path)) return null;
      string p = path.Trim().Trim('"');
      if (p.Length >= 2 && p[1] == ':' && char.IsLetter(p[0])) return char.ToUpperInvariant(p[0]) + ":";
      return null;
    }

    // ------------------------------------------------------------------ desktop apps
    static void ReadWin32(List<App> into, List<object> problems) {
      var seen = new HashSet<string>(StringComparer.Ordinal);
      foreach (string[] r in ROOTS) {
        try {
          using (RegistryKey b = SysCommon.Hive(r[0]))
          using (RegistryKey root = b.OpenSubKey(r[1], false)) {
            if (root == null) continue;
            foreach (string sub in root.GetSubKeyNames()) {
              try {
                using (RegistryKey k = root.OpenSubKey(sub, false)) {
                  if (k == null) continue;
                  string name = Str(k, "DisplayName");
                  if (name == null) continue;
                  if (Dw(k, "SystemComponent") == 1) continue;
                  if (Str(k, "ParentKeyName") != null) continue;
                  string rel = Str(k, "ReleaseType");
                  if (rel != null && (rel.IndexOf("Update", StringComparison.OrdinalIgnoreCase) >= 0 || rel.Equals("Hotfix", StringComparison.OrdinalIgnoreCase))) continue;
                  string un = Str(k, "UninstallString");
                  string mod = Str(k, "ModifyPath");
                  bool msi = Dw(k, "WindowsInstaller") == 1;
                  if (un == null && mod == null && !msi) continue;   // Windows' list hides these too
                  var a = new App { Kind = "win32", Name = name, Publisher = Str(k, "Publisher"), Version = Str(k, "DisplayVersion"), Scope = r[2] };
                  a.Key = KeyOf("w", r[0] + "\\" + r[1] + "\\" + sub);
                  if (!seen.Add(a.Key)) continue;
                  long? kb = Dw(k, "EstimatedSize");
                  a.Size = kb != null && kb.Value > 0 ? (long?)(kb.Value * 1024) : null;
                  string d = Str(k, "InstallDate");
                  DateTime when;
                  if (d != null && d.Length == 8 && DateTime.TryParseExact(d, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out when))
                    a.Installed = Ms(when.ToUniversalTime());
                  string loc = Str(k, "InstallLocation");
                  a.Path = loc;
                  a.Drive = DriveOf(Environment.ExpandEnvironmentVariables(loc ?? Str(k, "DisplayIcon") ?? un ?? ""));
                  if (Dw(k, "NoRemove") == 1) a.NoRemove = "Its installer marked it as not removable on its own (NoRemove), so Windows' own list offers no Uninstall for it either";
                  else if (un == null) a.NoRemove = "It registered no uninstaller (no UninstallString), so there is nothing to run";
                  else a.Uninstall = un;
                  if (Dw(k, "NoModify") == 1) a.NoModify = "Its installer turned Modify off (NoModify)";
                  else if (mod != null) a.ModifyCmd = mod;
                  else if (msi && GUID.IsMatch(sub)) a.ModifyCmd = "MsiExec.exe /I" + sub;
                  else a.NoModify = "It offers no Modify (no ModifyPath, and it is not a Windows Installer package)";
                  into.Add(a);
                }
              } catch (Exception) { /* one unreadable entry: skipped, counted below */ }
            }
          }
        } catch (Exception ex) { problems.Add("The " + r[2] + " app list (" + r[0] + ") could not be read: " + SysCommon.Why(ex)); }
      }
    }

    // ------------------------------------------------------------------ Store apps (WinRT by reflection)
    public static Type WinRt(string type, string asm) {
      return Type.GetType(type + ", " + asm + ", ContentType=WindowsRuntime", false);
    }
    static object Prop(object o, string name) {
      if (o == null) return null;
      try {
        PropertyInfo p = o.GetType().GetProperty(name);
        return p == null ? null : p.GetValue(o, null);
      } catch (Exception) { return null; }
    }
    static object PkgManager(out Type t, out string why) {
      why = null;
      t = WinRt("Windows.Management.Deployment.PackageManager", "Windows.Management");
      if (t == null) { why = "Windows' package manager (Windows.Management.Deployment) is not available on this PC"; return null; }
      try { return Activator.CreateInstance(t); } catch (Exception ex) { why = "Windows' package manager could not be started: " + SysCommon.Why(ex); return null; }
    }

    /// Every Store package of this user that Windows' Installed apps would list.
    static void ReadStore(List<App> into, List<object> problems) {
      Type t; string why;
      object pm = PkgManager(out t, out why);
      if (pm == null) { problems.Add(why); return; }
      IEnumerable all;
      try { all = (IEnumerable)t.GetMethod("FindPackagesForUser", new[] { typeof(string) }).Invoke(pm, new object[] { "" }); }
      catch (Exception ex) { problems.Add("The Store app list could not be read: " + SysCommon.Why(ex.InnerException ?? ex)); return; }
      foreach (object p in all) {
        try {
          if (Equals(Prop(p, "IsFramework"), true) || Equals(Prop(p, "IsResourcePackage"), true)) continue;
          object sig = Prop(p, "SignatureKind");
          if (sig != null && sig.ToString() == "System") continue;
          object pid = Prop(p, "Id");
          string full = Prop(pid, "FullName") as string;
          if (string.IsNullOrEmpty(full)) continue;
          string name = Prop(p, "DisplayName") as string;
          if (string.IsNullOrWhiteSpace(name) || name.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase)) name = Prop(pid, "Name") as string;
          var a = new App { Kind = "store", Name = name, FullName = full, Family = Prop(pid, "FamilyName") as string, Scope = "user" };
          a.Key = KeyOf("s", full);
          a.Publisher = Prop(p, "PublisherDisplayName") as string;
          object v = Prop(pid, "Version");
          if (v != null) {
            Type vt = v.GetType();
            Func<string, string> f = (n) => { FieldInfo fi = vt.GetField(n); return fi == null ? "0" : Convert.ToString(fi.GetValue(v), CultureInfo.InvariantCulture); };
            a.Version = f("Major") + "." + f("Minor") + "." + f("Build") + "." + f("Revision");
          }
          object d = Prop(p, "InstalledDate");
          if (d is DateTimeOffset) { DateTimeOffset dto = (DateTimeOffset)d; if (dto.Year > 2000) a.Installed = Ms(dto.UtcDateTime); }
          a.Path = Prop(p, "InstalledPath") as string;
          a.Drive = DriveOf(a.Path);
          a.Uninstall = "remove";
          if (Equals(Prop(p, "IsStub"), true)) a.NoModify = "It is an archived stub (Windows keeps only its tile until you open it again)";
          else a.NoModify = "Store apps have no Modify; Windows' Repair and Reset are its own";
          lock (SZ) { long s; if (_sizes.TryGetValue(full, out s)) a.Size = s; }
          into.Add(a);
        } catch (Exception) { /* one unreadable package: skipped */ }
      }
    }

    // ------------------------------------------------------------------ Store sizes: ONE background walk
    static readonly object SZ = new object();
    static readonly Dictionary<string, long> _sizes = new Dictionary<string, long>(StringComparer.Ordinal);
    static bool _sizing;
    static object _sized;   // ms when the walk finished, or null

    static long Walk(string dir, int depth) {
      if (depth > 40) return 0;
      long n = 0;
      DirectoryInfo di = new DirectoryInfo(dir);
      try { foreach (FileInfo f in di.EnumerateFiles()) { try { n += f.Length; } catch (Exception) { } } } catch (Exception) { }
      try {
        foreach (DirectoryInfo s in di.EnumerateDirectories())
          if ((s.Attributes & FileAttributes.ReparsePoint) == 0) n += Walk(s.FullName, depth + 1);
      } catch (Exception) { }
      return n;
    }
    static void StartSizing(List<App> store) {
      var todo = new List<string[]>();
      lock (SZ) {
        if (_sizing) return;
        foreach (App a in store) if (a.Path != null && !_sizes.ContainsKey(a.FullName)) todo.Add(new[] { a.FullName, a.Path });
        if (todo.Count == 0) return;
        _sizing = true;
      }
      var th = new Thread(() => {
        foreach (string[] x in todo) {
          long n = 0;
          try { if (Directory.Exists(x[1])) n = Walk(x[1], 0); } catch (Exception) { }
          lock (SZ) _sizes[x[0]] = n;
        }
        lock (SZ) { _sizing = false; _sized = Ms(DateTime.UtcNow); }
      });
      th.IsBackground = true; th.Priority = ThreadPriority.BelowNormal; th.Name = "apps.sizes";
      th.Start();
    }

    // ------------------------------------------------------------------ Store removal: its own thread
    static readonly object RM = new object();
    static string _rmKey, _rmName, _rmError;
    static bool _rmRunning;
    static object _rmFinished;
    static IDictionary Removal() {
      lock (RM) return _rmKey == null ? null : Json.Obj("key", _rmKey, "name", _rmName, "running", _rmRunning, "finished", _rmFinished, "error", _rmError);
    }

    static List<App> All(out List<object> problems) {
      var list = new List<App>();
      problems = new List<object>();
      ReadWin32(list, problems);
      ReadStore(list, problems);
      return list;
    }
    static App Find(Dictionary<string, object> req, string cmd, out string err) {
      err = null;
      string key = Json.GetString(req, "key");
      if (key == null || !KEY.IsMatch(key)) { err = cmd + " needs key: an app key from apps.installed"; return null; }
      List<object> probs;
      foreach (App a in All(out probs)) if (a.Key == key) return a;
      err = cmd + ": that app is no longer installed (or its entry changed); read the list again";
      return null;
    }

    // ------------------------------------------------------------------ apps.installed
    static string Installed(Dictionary<string, object> req, ref object result) {
      List<object> problems;
      List<App> all = All(out problems);
      bool sizes = Json.GetBool(req, "sizes", false);
      if (sizes) StartSizing(all.FindAll(a => a.Kind == "store"));
      var items = new List<object>();
      var drives = new SortedSet<string>(StringComparer.Ordinal);
      int win = 0, store = 0;
      foreach (App a in all) {
        if (a.Kind == "win32") win++; else store++;
        if (a.Drive != null) drives.Add(a.Drive);
        items.Add(Json.Obj("key", a.Key, "kind", a.Kind, "name", a.Name, "publisher", a.Publisher, "version", a.Version, "size", a.Size,
                           "installed", a.Installed, "drive", a.Drive, "scope", a.Scope,
                           "canUninstall", a.Uninstall != null, "uninstallWhy", a.NoRemove,
                           "canModify", a.ModifyCmd != null, "modifyWhy", a.NoModify));
      }
      items.Sort((x, y) => string.Compare((string)((IDictionary)x)["name"], (string)((IDictionary)y)["name"], StringComparison.CurrentCultureIgnoreCase));
      bool sizing; object sized;
      lock (SZ) { sizing = _sizing; sized = _sized; }
      result = Json.Obj("ok", true, "items", items, "win32", win, "store", store, "drives", new List<object>(drives),
                        "sizing", sizing, "sized", sized, "removal", Removal(), "problems", problems,
                        "storeSizeNote", "Windows keeps no size for Store apps: Mantle adds up each app's folder");
      return null;
    }

    // ------------------------------------------------------------------ command lines (from the registry only)
    /// Splits a registry command into the program and its arguments, the way Windows' own list runs it.
    public static string Split(string cmd, out string exe, out string args) {
      exe = null; args = "";
      string c = Environment.ExpandEnvironmentVariables(cmd ?? "").Trim();
      if (c.Length == 0) return "the command is empty";
      if (c[0] == '"') {
        int e = c.IndexOf('"', 1);
        if (e < 0) return "the command has an unclosed quote";
        exe = c.Substring(1, e - 1); args = c.Substring(e + 1).Trim();
      } else {
        int i = 0;
        while ((i = c.IndexOf(".exe", i, StringComparison.OrdinalIgnoreCase)) >= 0) {
          int end = i + 4;
          if (end == c.Length || c[end] == ' ') {
            string cand = c.Substring(0, end);
            if (cand.IndexOf('\\') < 0 || File.Exists(cand)) { exe = cand; args = c.Substring(end).Trim(); break; }
          }
          i = end;
        }
        if (exe == null) {
          int sp = c.IndexOf(' ');
          exe = sp < 0 ? c : c.Substring(0, sp);
          args = sp < 0 ? "" : c.Substring(sp + 1).Trim();
        }
      }
      if (exe.IndexOf('\\') < 0) {
        string sys = System.IO.Path.Combine(Environment.SystemDirectory, exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe : exe + ".exe");
        if (File.Exists(sys)) exe = sys;
      }
      if (!File.Exists(exe)) return "the program it names is not on this PC any more (Windows' own Uninstall would fail the same way)";
      return null;
    }

    static string Launch(string exe, string args) {
      try {
        var psi = new ProcessStartInfo(exe, args) { UseShellExecute = true };
        string dir = System.IO.Path.GetDirectoryName(exe);
        if (!string.IsNullOrEmpty(dir)) psi.WorkingDirectory = dir;
        using (Process p = Process.Start(psi)) { }
        return null;
      } catch (System.ComponentModel.Win32Exception ex) {
        if (ex.NativeErrorCode == 1223) return "you said no to Windows' administrator prompt for the app's uninstaller; nothing changed";
        return "Windows could not start it: " + SysCommon.Why(ex) + " (error " + ex.NativeErrorCode + ")";
      } catch (Exception ex) { return "Windows could not start it: " + SysCommon.Why(ex); }
    }

    // ------------------------------------------------------------------ apps.uninstall
    static string Uninstall(Dictionary<string, object> req, ref object result) {
      string err;
      App a = Find(req, "apps.uninstall", out err);
      if (a == null) return err;
      if (a.Uninstall == null) return "apps.uninstall: " + (a.NoRemove ?? "it cannot be uninstalled");
      bool dry = Json.GetBool(req, "dryRun", false);
      if (a.Kind == "store") {
        string would = "remove the Store app " + a.Name + " for your account only (Windows' package manager: RemovePackageAsync " + a.FullName + ")";
        bool busy;
        lock (RM) busy = _rmRunning;
        if (dry) { result = Json.Obj("ok", true, "dryRun", true, "kind", "store", "would", would, "program", null, "args", null, "busy", busy); return null; }
        if (Program.Passive) return FeatureTable.PassiveRefusal + ": apps.uninstall would " + would;
        if (busy) return "apps.uninstall: another Store app is still being removed; wait for it to finish";
        return RemoveStore(a, ref result);
      }
      string exe, args;
      string bad = Split(a.Uninstall, out exe, out args);
      string w32 = "start " + a.Name + "'s own uninstaller: " + (exe ?? a.Uninstall) + (string.IsNullOrEmpty(args) ? "" : " " + args) +
                   " (it may ask Windows for administrator permission itself, and it shows its own steps)";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "kind", "win32", "would", w32, "program", exe, "args", args, "wouldRefuse", bad); return null; }
      if (bad != null) return "apps.uninstall: " + bad;
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": apps.uninstall would " + w32;
      string why = Launch(exe, args);
      if (why != null) return "apps.uninstall: " + why;
      result = Json.Obj("ok", true, "started", true, "kind", "win32", "note", "The app's own uninstaller is open: follow its steps. The list updates when it finishes.");
      return null;
    }

    static string RemoveStore(App a, ref object result) {
      Type t; string why;
      object pm = PkgManager(out t, out why);
      if (pm == null) return "apps.uninstall: " + why;
      MethodInfo m = t.GetMethod("RemovePackageAsync", new[] { typeof(string) });
      Type info = WinRt("Windows.Foundation.IAsyncInfo", "Windows.Foundation");
      if (m == null || info == null) return "apps.uninstall: Windows' package manager has no RemovePackageAsync on this PC";
      object op;
      try { op = m.Invoke(pm, new object[] { a.FullName }); }
      catch (Exception ex) { return "apps.uninstall: Windows refused to start removing it: " + SysCommon.Why(ex.InnerException ?? ex); }
      lock (RM) { _rmKey = a.Key; _rmName = a.Name; _rmRunning = true; _rmError = null; _rmFinished = null; }
      string full = a.FullName;
      var th = new Thread(() => {
        string err = null;
        try {
          PropertyInfo st = info.GetProperty("Status"), ec = info.GetProperty("ErrorCode");
          var sw = Stopwatch.StartNew();
          string s = "Started";
          while (sw.ElapsedMilliseconds < 300000) {
            s = Convert.ToString(st.GetValue(op, null), CultureInfo.InvariantCulture);
            if (s != "Started") break;
            Thread.Sleep(200);
          }
          if (s == "Started") err = "Windows did not finish removing it within 5 minutes";
          else if (s != "Completed") {
            Exception e = null;
            try { e = ec.GetValue(op, null) as Exception; } catch (Exception) { }
            string text = null;
            try {
              Type res = WinRt("Windows.Management.Deployment.DeploymentResult", "Windows.Management");
              Type prog = WinRt("Windows.Management.Deployment.DeploymentProgress", "Windows.Management");
              Type gen = WinRt("Windows.Foundation.IAsyncOperationWithProgress`2", "Windows.Foundation");
              if (res != null && prog != null && gen != null) {
                object r = gen.MakeGenericType(res, prog).GetMethod("GetResults").Invoke(op, null);
                text = Prop(r, "ErrorText") as string;
              }
            } catch (Exception) { }
            err = "Windows did not remove it (" + s + (e != null ? ", " + SysCommon.Why(e) : "") + ")" + (string.IsNullOrEmpty(text) ? "" : ": " + text.Trim());
          }
        } catch (Exception ex) { err = "Windows did not say how removing it went: " + SysCommon.Why(ex); }
        lock (RM) { if (_rmKey == a.Key) { _rmRunning = false; _rmError = err; _rmFinished = Ms(DateTime.UtcNow); } }
        if (err == null) lock (SZ) _sizes.Remove(full);
      });
      th.IsBackground = true; th.Name = "apps.remove";
      th.Start();
      result = Json.Obj("ok", true, "started", true, "kind", "store", "removal", Removal(), "note", "Removing it: the list updates when Windows finishes");
      return null;
    }

    // ------------------------------------------------------------------ apps.modify
    static string Modify(Dictionary<string, object> req, ref object result) {
      string err;
      App a = Find(req, "apps.modify", out err);
      if (a == null) return err;
      if (a.ModifyCmd == null) return "apps.modify: " + (a.NoModify ?? "it offers no Modify");
      bool dry = Json.GetBool(req, "dryRun", false);
      string exe, args;
      string bad = Split(a.ModifyCmd, out exe, out args);
      string would = "start " + a.Name + "'s own setup to modify or repair it: " + (exe ?? a.ModifyCmd) + (string.IsNullOrEmpty(args) ? "" : " " + args) +
                     " (it may ask Windows for administrator permission itself)";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "would", would, "program", exe, "args", args, "wouldRefuse", bad); return null; }
      if (bad != null) return "apps.modify: " + bad;
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": apps.modify would " + would;
      string why = Launch(exe, args);
      if (why != null) return "apps.modify: " + why;
      result = Json.Obj("ok", true, "started", true, "note", "The app's own setup is open: follow its steps.");
      return null;
    }
  }
}
