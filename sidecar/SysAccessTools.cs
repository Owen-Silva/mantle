// SysAccessTools.cs - the assistive tools of Settings > Accessibility for Mantle Settings (lane
// access, 2026-09-29): Magnifier, Narrator, the on-screen keyboard, voice access and live captions.
//
// WHY: see SysAccess.cs. These are Windows' own tool programs in System32; Windows' Settings
// starts them, keeps a few choices for them in HKCU, and lists the ones to start after sign-in in
// ONE per-user value (Accessibility\Configuration, a comma list of the tools registered under HKLM
// ...\Accessibility\ATs). Mantle does the same: it starts the program itself (ShellExecute: Magnifier
// and Narrator are uiAccess programs, which CreateProcess refuses from a normal process) and edits
// that one list token by token, keeping every other tool's entry.
//
//   access.start {tool, dryRun?}   magnifier | narrator | osk | voiceAccess | liveCaptions. dryRun
//                                  checks the program is there and not running, and says so.
//
// PRIVACY: nothing here logs. Program names are Windows' own fixed ones.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysAccessTools {
    public static void Register(FeatureTable t) {
      t.Add("access.start", Lanes.Slow, Start);
    }

    const string AtUser = @"Software\Microsoft\Windows NT\CurrentVersion\Accessibility";
    const string AtList = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Accessibility\ATs\";
    const string Mag = @"Software\Microsoft\ScreenMagnifier";

    // [tool, program (System32, no .exe), its name in words, its ATs name for "after sign-in" (or null)]
    static readonly string[][] TOOLS = {
      new[] { "magnifier", "Magnify", "Magnifier", "magnifierpane" },
      new[] { "narrator", "Narrator", "Narrator", "Narrator" },
      new[] { "osk", "osk", "the on-screen keyboard", "osk" },
      new[] { "voiceAccess", "voiceaccess", "voice access", "VoiceAccess" },
      new[] { "liveCaptions", "LiveCaptions", "live captions", "LiveCaptions" },
    };
    static string[] Tool(string name) { foreach (string[] t in TOOLS) if (t[0] == name) return t; return null; }
    static string Exe(string[] t) { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), t[1] + ".exe"); }

    static bool Running(string[] t, out string why) {
      why = null;
      try {
        Process[] ps = Process.GetProcessesByName(t[1]);
        bool any = ps.Length > 0;
        foreach (Process p in ps) p.Dispose();
        return any;
      } catch (Exception ex) { why = "whether it runs could not be read: " + SysCommon.Why(ex); return false; }
    }

    /// Every tool: {present, running, why}. `why` says why it cannot start (missing, unreadable).
    internal static IDictionary Tools() {
      var d = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string[] t in TOOLS) {
        bool present = File.Exists(Exe(t));
        string why = null;
        bool run = false;
        if (!present) why = "Windows on this PC does not have " + t[2] + " (" + t[1] + ".exe is not in System32)";
        else run = Running(t, out why);
        d[t[0]] = Json.Obj("present", present, "running", run, "why", why);
      }
      return d;
    }

    // ------------------------------------------------------------------ "start after sign-in"

    static List<string> ReadAts(out string why) {
      object v = SysCommon.Read("HKCU", AtUser, "Configuration", out why);
      var l = new List<string>();
      string s = v as string;
      if (s != null) foreach (string x in s.Split(',')) { string y = x.Trim(); if (y.Length > 0) l.Add(y); }
      else if (v != null) why = "the list is not text (" + v.GetType().Name + ")";
      return l;
    }
    static bool Has(List<string> l, string at) { foreach (string x in l) if (string.Equals(x, at, StringComparison.OrdinalIgnoreCase)) return true; return false; }
    static bool Registered(string at) {
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.OpenSubKey(AtList + at, false)) return k != null;
      } catch (Exception) { return false; }
    }

    static AccessEntry SignIn(string key, string at, string words) {
      var e = new AccessEntry(); e.Key = key; e.Words = words;
      e.Read = delegate {
        string why; List<string> l = ReadAts(out why);
        return SysAccess.V(Has(l, at), l.Count > 0, l.Count > 0 ? null : why);
      };
      e.Lock = delegate { return Registered(at) ? null : "Windows on this PC has no \"" + at + "\" assistive tool registered to start after sign-in"; };
      e.Preview = delegate(object to) {
        string why; List<string> l = ReadAts(out why);
        return SysCommon.List(Json.Obj("api", "registry", "hive", "HKCU", "key", AtUser, "name", "Configuration", "type", "REG_SZ",
          "value", ((bool)to ? "add " : "remove ") + at + " (every other tool in the list is kept)", "before", l.Count));
      };
      e.Write = delegate(object to) {
        bool on = (bool)to;
        string why; List<string> l = ReadAts(out why);
        l.RemoveAll(delegate(string x) { return string.Equals(x, at, StringComparison.OrdinalIgnoreCase); });
        if (on) l.Add(at);
        try {
          using (RegistryKey b = SysCommon.Hive("HKCU"))
          using (RegistryKey k = b.CreateSubKey(AtUser, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
            if (k == null) return "the accessibility key could not be opened for writing";
            k.SetValue("Configuration", string.Join(",", l.ToArray()), RegistryValueKind.String);
          }
        } catch (Exception ex) { return "Windows refused the write: " + SysCommon.Why(ex); }
        return Has(ReadAts(out why), at) == on ? null : "it was written but reads back differently";
      };
      return e;
    }

    static string MagNote(object to) {
      string why;
      return Running(Tool("magnifier"), out why) ? "Saved: Magnifier is running and uses it from the next time it starts" : null;
    }

    /// The tools' own rows, added to SysAccess's table.
    internal static void Entries(List<AccessEntry> l) {
      var zoom = SysAccess.RegNumEntry("magZoom", "the Magnifier zoom level", Mag, "Magnification", 100, 1600, null, 200);
      zoom.Note = MagNote; l.Add(zoom);
      var inc = SysAccess.RegNumEntry("magIncrement", "the Magnifier zoom increment", Mag, "ZoomIncrement", 25, 400, new long[] { 25, 50, 100, 150, 200, 400 }, 100);
      inc.Note = MagNote; l.Add(inc);
      var inv = SysAccess.RegBoolEntry("magInvert", "inverted colours in Magnifier", Mag, "Invert", 1, 0, false);
      inv.Note = MagNote; l.Add(inv);
      var sm = SysAccess.RegBoolEntry("magSmooth", "smooth edges of images and text in Magnifier", Mag, "UseBitmapSmoothing", 1, 0, true);
      sm.Note = MagNote; l.Add(sm);
      l.Add(SignIn("magSignIn", "magnifierpane", "starting Magnifier after sign-in"));
      l.Add(SysAccess.RegBoolEntry("narratorShortcut", "the Narrator keyboard shortcut (Windows logo key + Ctrl + Enter)", @"Software\Microsoft\Narrator\NoRoam", "WinEnterLaunchEnabled", 1, 0, true));
      l.Add(SignIn("narratorSignIn", "Narrator", "starting Narrator after sign-in"));
      l.Add(SignIn("oskSignIn", "osk", "starting the on-screen keyboard after sign-in"));
      var ci = new AccessEntry(); ci.Key = "cursorIndicator"; ci.Words = "the text cursor indicator";
      ci.ReadOnly = "Windows runs the text cursor indicator as one of its own assistive tools, sized and coloured inside its own Settings, with no documented call another program may make; Mantle shows whether it is on";
      ci.Read = delegate { string why; List<string> a = ReadAts(out why); return SysAccess.V(Has(a, "CursorIndicator"), a.Count > 0, a.Count > 0 ? null : why); };
      l.Add(ci);
    }

    // ------------------------------------------------------------------ access.start

    static string Start(Dictionary<string, object> req, ref object result) {
      string name = Json.GetString(req, "tool");
      if (string.IsNullOrEmpty(name)) return "access.start needs tool: magnifier, narrator, osk, voiceAccess or liveCaptions";
      string[] t = Tool(name);
      if (t == null) return "access.start: tool must be magnifier, narrator, osk, voiceAccess or liveCaptions";
      bool dry = Json.GetBool(req, "dryRun", false);
      string exe = Exe(t);
      if (!File.Exists(exe)) return "Windows on this PC does not have " + t[2] + " (" + t[1] + ".exe is not in System32)";
      string why;
      bool run = Running(t, out why);
      if (why != null) return "access.start: " + why;
      if (run) return (t[2].Substring(0, 1).ToUpperInvariant() + t[2].Substring(1)) + " is already running";
      string would = "start " + t[2] + " (" + t[1] + ".exe from Windows' System32)";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "tool", name, "would", would, "reason", null); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": access.start would " + would;
      try {
        var si = new ProcessStartInfo(exe);
        si.UseShellExecute = true;               // uiAccess programs (Magnifier, Narrator) need ShellExecute
        si.WorkingDirectory = Path.GetDirectoryName(exe);
        using (Process p = Process.Start(si)) { }
      } catch (Exception ex) { return "Windows did not start " + t[2] + ": " + SysCommon.Why(ex); }
      result = Json.Obj("ok", true, "dryRun", false, "tool", name, "started", true, "now", true);
      return null;
    }
  }
}
