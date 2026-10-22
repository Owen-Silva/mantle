// Startup.cs - "Startup apps" for Mantle Settings: list what runs at sign-in, and turn an entry on or
// off the way Task Manager's Startup tab does (lane settings-startup, 2026-09-28).
//
// WHY: Mantle Settings replaces the Windows Settings app, and its Startup apps page needs the same
// list Task Manager shows. Windows keeps it in five places, and each entry's on/off state is NOT in
// the entry itself: it is a 12-byte REG_BINARY under Explorer\StartupApproved, keyed by the entry's
// name. Task Manager and Settings both only ever write that one value, and so does this file.
//
//   startup.list {}                              every entry from the five sources, with its state
//   startup.set  {item:"<source>|<name>", on, dryRun?}   write ONE StartupApproved value, VERIFIED
//
// THE BYTES: byte 0 even (02, 06) = enabled, odd (03, 07) = disabled; a disabled value carries the
// moment it was disabled in bytes 4..11 (a little-endian FILETIME, UTC). No value at all = enabled
// by default. Enable writes 02 + eleven zeros; disable writes 03 00 00 00 + FILETIME.UtcNow, exactly
// what Task Manager writes.
//
// HARD RULE - NOTHING IS EVER DELETED: a 2026-09-02 session deleted 8 of the user's Run values while
// "cleaning up startup". So this file is built so that cannot happen: the Run keys are only ever
// opened read-only (OpenSubKey(path, false)), the Startup folders are only ever listed
// (Directory.GetFiles), and the ONE write site (WriteApproved) takes its key path from the fixed
// Sources table below, never from an argument, and can only reach a StartupApproved key. There is
// no DeleteValue, DeleteSubKey or file call anywhere in this file; keep it that way.
//
// MACHINE-WIDE entries (HKLM Run, Run32, the all-users Startup folder) record their state under HKLM,
// which only an elevated process may write. Elevation is read from the token up front and such an
// entry says "Needs administrator" in words, instead of a write that fails.
//
// PRIVACY: an entry's name, command and path are returned to the page (it shows them), but never
// appear in a log, a stderr line, an error or a `reason`: those carry counts, codes and states only.
// Every handler catches its own exceptions for the same reason (Features.TryRun would otherwise put
// the exception's message, which can carry a path, into the reply).
//
// PASSIVE (every test sidecar): startup.list and startup.set {dryRun:true} are reads and always
// answer; a real startup.set answers FeatureTable.PassiveRefusal.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class Startup {
    public static void Register(FeatureTable t) {
      t.Add("startup.list", Lanes.Slow, List);
      t.Add("startup.set", Lanes.Slow, Set);
    }

    const string ApprovedRoot = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\";
    const string NeedsAdmin = "Needs administrator: this entry is machine-wide, and Mantle is not running as administrator";

    sealed class Source {
      public string Key, Label, Words;   // "hkcu-run", "Registry, this user", "the this-user Run key"
      public bool Machine;
      public RegistryHive Hive;
      public string RunPath;             // a Run key (read-only, ever), or null for a Startup folder
      public Environment.SpecialFolder Folder;
      public string ApprovedSub;         // Run | Run32 | StartupFolder
      public string ApprovedPath { get { return ApprovedRoot + ApprovedSub; } }
      public string ApprovedDisplay {
        get { return (Hive == RegistryHive.LocalMachine ? "HKLM\\" : "HKCU\\") + ApprovedPath; }
      }
    }

    static Source Src(string key, string label, string words, bool machine, string runPath,
                      Environment.SpecialFolder folder, string sub) {
      var s = new Source();
      s.Key = key; s.Label = label; s.Words = words; s.Machine = machine;
      s.Hive = machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser;
      s.RunPath = runPath; s.Folder = folder; s.ApprovedSub = sub;
      return s;
    }

    // The fixed table: the ONLY place a key path or folder comes from. Registry64 is used for every
    // open, so a 32-bit sidecar could never be redirected into WOW6432Node by accident.
    static readonly Source[] Sources = {
      Src("hkcu-run", "Registry, this user", "the this-user Run key", false,
          @"Software\Microsoft\Windows\CurrentVersion\Run", Environment.SpecialFolder.Startup, "Run"),
      Src("hklm-run", "Registry, all users", "the all-users Run key", true,
          @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", Environment.SpecialFolder.Startup, "Run"),
      Src("hklm-run32", "Registry, all users (32-bit)", "the all-users 32-bit Run key", true,
          @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", Environment.SpecialFolder.Startup, "Run32"),
      Src("user-folder", "Startup folder, this user", "the this-user Startup folder", false,
          null, Environment.SpecialFolder.Startup, "StartupFolder"),
      Src("common-folder", "Startup folder, all users", "the all-users Startup folder", true,
          null, Environment.SpecialFolder.CommonStartup, "StartupFolder"),
    };

    static Source FindSource(string key) {
      foreach (Source s in Sources) if (string.Equals(s.Key, key, StringComparison.Ordinal)) return s;
      return null;
    }

    static string SourceKeys() {
      var sb = new StringBuilder();
      foreach (Source s in Sources) { if (sb.Length > 0) sb.Append(", "); sb.Append(s.Key); }
      return sb.ToString();
    }

    // ------------------------------------------------------------------ elevation

    static int _elevated = -1;
    static bool Elevated() {
      if (_elevated < 0) {
        bool e = false;
        try {
          using (WindowsIdentity id = WindowsIdentity.GetCurrent())
            e = new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);   // false for a filtered (UAC) token
        } catch (Exception) { e = false; }
        _elevated = e ? 1 : 0;
      }
      return _elevated == 1;
    }

    // ------------------------------------------------------------------ reading

    sealed class Entry {
      public Source Src;
      public string Name, Command;
      public bool Enabled;
      public string State;          // enabled | disabled | default
      public string DisabledAt;     // ISO-8601 UTC or null
      public string Note;           // plain words about an odd StartupApproved value, or null
    }

    /// Plain words for why a read failed: codes and kinds only, never a path (an exception's own
    /// message can carry one).
    static string Why(Exception ex) {
      if (ex is SecurityException || ex is UnauthorizedAccessException) return "access denied (5)";
      int hr = System.Runtime.InteropServices.Marshal.GetHRForException(ex);
      return ex.GetType().Name + " (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")";
    }

    static RegistryKey Base(RegistryHive hive) {
      return RegistryKey.OpenBaseKey(hive, RegistryView.Registry64);
    }

    /// Every entry of one source, or null with `problem` in plain words. A missing key or folder is
    /// zero entries and no problem.
    static List<Entry> ReadSource(Source src, out string problem) {
      problem = null;
      var names = new List<KeyValuePair<string, string>>();   // name, command
      int unnamed = 0;
      try {
        if (src.RunPath != null) {
          using (RegistryKey hk = Base(src.Hive))
          using (RegistryKey run = hk.OpenSubKey(src.RunPath, false)) {     // READ-ONLY, always
            if (run != null) {
              foreach (string n in run.GetValueNames()) {
                if (string.IsNullOrEmpty(n)) { unnamed++; continue; }
                object v = run.GetValue(n, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                string cmd = v as string;
                if (cmd == null && v is string[]) cmd = string.Join(" ", (string[])v);
                names.Add(new KeyValuePair<string, string>(n, cmd));
              }
            }
          }
        } else {
          string dir = Environment.GetFolderPath(src.Folder);
          if (string.IsNullOrEmpty(dir)) { problem = "Windows did not say where " + src.Words + " is"; return null; }
          if (Directory.Exists(dir)) {
            foreach (string f in Directory.GetFiles(dir)) {                 // listed, never touched
              string n = Path.GetFileName(f);
              if (string.Equals(n, "desktop.ini", StringComparison.OrdinalIgnoreCase)) continue;
              names.Add(new KeyValuePair<string, string>(n, f));
            }
          }
        }
      } catch (Exception ex) {
        problem = src.Words + " could not be read (" + Why(ex) + ")";
        return null;
      }
      if (unnamed > 0)
        problem = src.Words + " has " + unnamed + " unnamed (default) value; it is not listed, because it has no name to turn on or off by";

      // The on/off state, from StartupApproved (read-only here too).
      RegistryKey approved = null;
      string approvedProblem = null;
      try {
        using (RegistryKey hk = Base(src.Hive)) approved = hk.OpenSubKey(src.ApprovedPath, false);
      } catch (Exception ex) {
        approvedProblem = "the on/off states for " + src.Words + " could not be read (" + Why(ex) +
                          "); its entries show as enabled by default";
      }
      var list = new List<Entry>();
      try {
        foreach (KeyValuePair<string, string> kv in names) {
          var e = new Entry();
          e.Src = src; e.Name = kv.Key; e.Command = kv.Value;
          ReadState(approved, e);
          list.Add(e);
        }
      } finally {
        if (approved != null) approved.Close();
      }
      if (approvedProblem != null) problem = problem == null ? approvedProblem : problem + "; " + approvedProblem;
      return list;
    }

    static void ReadState(RegistryKey approved, Entry e) {
      e.Enabled = true; e.State = "default"; e.DisabledAt = null; e.Note = null;
      if (approved == null) return;
      object v;
      RegistryValueKind kind;
      try {
        v = approved.GetValue(e.Name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
        if (v == null) return;                       // no value: enabled by default
        kind = approved.GetValueKind(e.Name);
      } catch (Exception ex) {
        e.State = "enabled";
        e.Note = "its on/off state could not be read (" + Why(ex) + "), so it is treated as enabled";
        return;
      }
      byte[] b = v as byte[];
      if (kind != RegistryValueKind.Binary || b == null || b.Length < 1) {
        e.State = "enabled";
        e.Note = "its StartupApproved value is " + KindWords(kind) + (b != null ? " of " + b.Length + " bytes" : "") +
                 ", not the 12-byte binary Windows writes, so it is treated as enabled; turning it on or off rewrites it";
        return;
      }
      if ((b[0] & 1) == 0) { e.Enabled = true; e.State = "enabled"; return; }
      e.Enabled = false; e.State = "disabled";
      if (b.Length >= 12) {
        long ft = BitConverter.ToInt64(b, 4);        // little-endian on every Windows machine
        if (ft > 0) {
          try {
            e.DisabledAt = DateTime.FromFileTimeUtc(ft).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
          } catch (ArgumentOutOfRangeException) { e.DisabledAt = null; }
        }
      }
    }

    static string KindWords(RegistryValueKind k) {
      switch (k) {
        case RegistryValueKind.String: return "REG_SZ";
        case RegistryValueKind.ExpandString: return "REG_EXPAND_SZ";
        case RegistryValueKind.DWord: return "REG_DWORD";
        case RegistryValueKind.QWord: return "REG_QWORD";
        case RegistryValueKind.MultiString: return "REG_MULTI_SZ";
        case RegistryValueKind.Binary: return "REG_BINARY";
        default: return "an unknown type";
      }
    }

    static IDictionary Item(Entry e) {
      bool elevated = Elevated();
      bool canToggle = !e.Src.Machine || elevated;
      string reason = canToggle ? e.Note : (e.Note == null ? NeedsAdmin : NeedsAdmin + "; " + e.Note);
      return Json.Obj("item", e.Src.Key + "|" + e.Name,
                      "name", e.Name,
                      "source", e.Src.Key,
                      "sourceLabel", e.Src.Label,
                      "scope", e.Src.Machine ? "machine" : "user",
                      "command", e.Command,
                      "enabled", e.Enabled,
                      "state", e.State,
                      "disabledAt", e.DisabledAt,
                      "canToggle", canToggle,
                      "reason", reason);
    }

    // ------------------------------------------------------------------ startup.list

    static string List(Dictionary<string, object> req, ref object result) {
      try {
        var items = new List<object>();
        var problems = new List<object>();
        foreach (Source src in Sources) {
          string problem;
          List<Entry> entries = ReadSource(src, out problem);
          if (problem != null) problems.Add(problem);
          if (entries == null) continue;
          foreach (Entry e in entries) items.Add(Item(e));
        }
        result = Json.Obj("ok", true, "elevated", Elevated(), "items", items, "problems", problems);
        return null;
      } catch (Exception ex) {
        return "startup.list failed: " + Why(ex);
      }
    }

    // ------------------------------------------------------------------ startup.set

    static string Hex(byte[] b) {
      var sb = new StringBuilder(b.Length * 3);
      for (int i = 0; i < b.Length; i++) {
        if (i > 0) sb.Append(' ');
        sb.Append(b[i].ToString("X2", CultureInfo.InvariantCulture));
      }
      return sb.ToString();
    }

    /// Exactly what Task Manager writes.
    static byte[] Bytes(bool on) {
      var b = new byte[12];
      if (on) { b[0] = 0x02; return b; }
      b[0] = 0x03;
      byte[] ft = BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc());
      Array.Copy(ft, 0, b, 4, 8);
      return b;
    }

    /// Finds `name` in a fresh read of `src`: null with `error` when it cannot.
    static Entry Fresh(Source src, string name, out string error) {
      error = null;
      string problem;
      List<Entry> entries = ReadSource(src, out problem);
      if (entries == null) { error = problem + "; nothing was changed"; return null; }
      Entry exact = null, loose = null;
      foreach (Entry e in entries) {
        if (string.Equals(e.Name, name, StringComparison.Ordinal)) { exact = e; break; }
        if (loose == null && string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase)) loose = e;
      }
      Entry hit = exact ?? loose;   // registry value and file names are case-insensitive
      if (hit == null) error = "that startup entry is no longer there; refresh the list";
      return hit;
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      try {
        string item = Json.GetString(req, "item");
        if (string.IsNullOrEmpty(item)) return "startup.set needs item: \"<source>|<name>\" from startup.list";
        if (!Json.HasKey(req, "on")) return "startup.set needs on: true (run at sign-in) or false (do not)";
        bool on = Json.GetBool(req, "on", false);
        bool dry = Json.GetBool(req, "dryRun", false);

        int bar = item.IndexOf('|');
        if (bar <= 0 || bar == item.Length - 1)
          return "that is not a startup item; expected \"<source>|<name>\" exactly as startup.list gave it";
        Source src = FindSource(item.Substring(0, bar));
        if (src == null) return "that startup item names an unknown source; the sources are " + SourceKeys();

        string error;
        Entry e = Fresh(src, item.Substring(bar + 1), out error);
        if (e == null) return error;

        byte[] bytes = Bytes(on);
        string refuse = src.Machine && !Elevated() ? NeedsAdmin : null;
        if (dry) {
          result = Json.Obj("ok", true, "dryRun", true,
                            "key", src.ApprovedDisplay,
                            "valueName", e.Name,
                            "bytes", Hex(bytes),
                            "wouldBe", on ? "enabled" : "disabled",
                            "wouldRefuse", refuse,
                            "item", Item(e));
          return null;
        }
        if (Program.Passive)
          return FeatureTable.PassiveRefusal + ": it would have " + (on ? "enabled" : "disabled") + " a startup entry";
        if (refuse != null) return refuse;

        string werr = WriteApproved(src, e.Name, bytes);
        if (werr != null) return werr;

        Entry after = Fresh(src, e.Name, out error);
        if (after == null) return "the change was written, but the entry could not be read back: " + error;
        if (after.Enabled != on)
          return "the change was written, but reading it back shows the entry still " + after.State +
                 " (another program may have put it back)";
        result = Json.Obj("ok", true, "item", Item(after));
        return null;
      } catch (Exception ex) {
        return "startup.set failed: " + Why(ex);
      }
    }

    /// THE ONLY WRITE IN THIS FILE. The key path comes from the fixed Sources table (always a
    /// StartupApproved key), never from a request; the Run keys and the Startup folders are never
    /// opened for writing anywhere. See the HARD RULE at the top of the file.
    static string WriteApproved(Source src, string valueName, byte[] bytes) {
      string path = src.ApprovedPath;
      if (path.IndexOf(@"\StartupApproved\", StringComparison.OrdinalIgnoreCase) < 0)
        return "refused: the on/off key is not a StartupApproved key";   // belt and braces
      try {
        using (RegistryKey hk = Base(src.Hive)) {
          // HKCU: the StartupApproved subkey is created when it is missing (a fresh profile has
          // none until something is first turned off). HKLM: never created, only opened.
          using (RegistryKey k = src.Hive == RegistryHive.CurrentUser ? hk.CreateSubKey(path) : hk.OpenSubKey(path, true)) {
            if (k == null) return "the all-users on/off key (StartupApproved) is missing, so there is nowhere to record this; nothing was changed";
            k.SetValue(valueName, bytes, RegistryValueKind.Binary);
          }
        }
        return null;
      } catch (Exception ex) {
        return "Windows refused the change (" + Why(ex) + "); nothing was changed";
      }
    }
  }
}
