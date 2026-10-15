// ToastBanners.cs - the Windows half of Mantle's own notification banners (lane mantle-toasts, 2026-10-15).
//
// WHY: Owen, with a screenshot of Helm's stock Windows toast: "these notifications need to be in mantles
// theme not the old windows". Mantle draws its own banner (lib/features/toasts.js, ui/toasts/) from the
// toasts Notifications.cs already reads, so Windows' own banner has to stop for the apps Mantle covers,
// or every toast pops up twice. The one per-app switch Windows has for that is the one its Settings page
// flips: "Show notification banners" = HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\
// Settings\<app id> ShowBanner (DWORD; absent = on). The toast itself is untouched: it still lands in
// Windows' notification centre (ShowInActionCenter is never written) and Mantle's list.
//
//   toasts.banners {op:"read", record}                   every app in Windows' list: {aumid, banner, enabled, odd}
//   toasts.banners {op:"write", record, set:[{aumid, value}]}  value 0 / 1 / null (null = delete the value,
//                                                        i.e. Windows' default). Read back; per app {ok, now, reason}
//   toasts.quiet {}                                      {dnd, quns}: Do not disturb's ACTIVE profile and
//                                                        SHQueryUserNotificationState, read now
//
// THE RECORD (`record`, <userData>\notif-banners.json) is written by main ONLY (lib/features/_toasts-owner.js),
// BEFORE it changes a value: {"v":1,"owned":{"<aumid>": <original ShowBanner or null>}, ...}. This file
// only remembers its path, and on EVERY exit (Program.SafetyRestore: clean quit, stdin EOF = main died,
// Ctrl+C, an unhandled exception) puts each owned app's original back - but ONLY where the value is
// still the 0 Mantle wrote. A value Owen changed himself in Windows' Settings is never overwritten.
// Main re-applies on the next sidecar start (ctx.sidecar.onReady), so a sidecar restart costs at most a
// moment of Windows' own banner, never a lost one. tools/restore-banners.ps1 does the same with no Mantle
// at all (tools/restore-windows.ps1, the supervisor's crash-loop give-up, `npm run autostart:remove`).
//
// DO NOT DISTURB: the ACTIVE quiet-hours profile is the WNF state WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED
// (0x0D83063EA3BF1C75): 0 = off, 1 = priority only, 2 = alarms only. It includes the automatic rules (a
// game, full screen, duplicating a display, scheduled hours), which the user-selected profile SysNotify
// reads does not. UNDOCUMENTED, read-only, 4 bytes: measured on this PC (build 26300) as 0 with DND off.
// A read that fails is said (dndWhy) and main treats it as "not quiet" with the reason logged.
//
// PASSIVE (--test): reads always; a write only for an app id starting with TestPrefix, which only a test
// registers - the live Windows settings of every real app are refused here, not just in main.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class ToastBanners {
    public const string SettingsKey = @"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";
    /// The app ids a test registers (lib/features/toasts.e2e.test.js); the only ones a passive sidecar writes.
    public const string TestPrefix = "Mantle.ToastTest";
    const int MaxWrites = 400;

    static readonly object _gate = new object();
    static string _record;   // main's record file, from the last call that named it

    public static void Register(FeatureTable t) {
      // the notification lane: registry reads and writes take well under a millisecond each, and the
      // slow lane (icons, pins, launches) never waits behind them
      t.Add("toasts.banners", Lanes.Notif, Banners);
      t.Add("toasts.quiet", Lanes.Notif, Quiet);
    }

    static bool IsTest(string aumid) {
      return aumid != null && aumid.StartsWith(TestPrefix, StringComparison.OrdinalIgnoreCase);
    }

    static string Banners(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op");
      string record = Json.GetString(req, "record");
      if (record != null) {
        if (record.Length > 400 || !Path.IsPathRooted(record) || !record.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
          return "toasts.banners: record must be the full path of main's .json record";
        lock (_gate) _record = record;
      }
      if (op == "read") { result = Read(); return null; }
      if (op != "write") return "toasts.banners: op must be read or write";
      object raw;
      var list = Json.TryGet(req, "set", out raw) ? raw as IList : null;
      if (list == null || list.Count == 0) return "toasts.banners: write needs set, a list of {aumid, value}";
      if (list.Count > MaxWrites) return "toasts.banners: at most " + MaxWrites + " apps in one write";
      var wants = new List<KeyValuePair<string, int?>>();
      foreach (object o in list) {
        var d = o as Dictionary<string, object>;
        string aumid = d == null ? null : Json.GetString(d, "aumid");
        if (string.IsNullOrEmpty(aumid) || aumid.Length > 512 || aumid.IndexOf('\\') >= 0)
          return "toasts.banners: every write needs aumid, an app id exactly as read listed it";
        object v;
        int? value = null;
        if (Json.TryGet(d, "value", out v) && v != null) {
          if (!(v is double) || ((double)v != 0 && (double)v != 1)) return "toasts.banners: value is 0, 1 or null";
          value = (int)(double)v;
        }
        wants.Add(new KeyValuePair<string, int?>(aumid, value));
      }
      var done = new List<object>();
      using (RegistryKey root = Registry.CurrentUser.OpenSubKey(SettingsKey, true)) {
        if (root == null) { result = Json.Obj("ok", false, "reason", "Windows has no notification settings for this account yet", "results", done); return null; }
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string n in root.GetSubKeyNames()) names[n] = n;
        foreach (var w in wants) {
          string found;
          if (!names.TryGetValue(w.Key, out found)) { done.Add(Json.Obj("aumid", w.Key, "ok", false, "reason", "that app is not in Windows' notification list any more")); continue; }
          if (Program.Passive && !IsTest(found)) { done.Add(Json.Obj("aumid", found, "ok", false, "reason", FeatureTable.PassiveRefusal + ": it would change a real app's Windows setting")); continue; }
          done.Add(WriteOne(root, found, w.Value));
        }
      }
      bool all = true;
      foreach (IDictionary r in done) if (!(bool)r["ok"]) all = false;
      result = Json.Obj("ok", all, "reason", all ? null : "Windows did not take every change (see results)", "results", done);
      return null;
    }

    static IDictionary WriteOne(RegistryKey root, string name, int? value) {
      try {
        using (RegistryKey k = root.OpenSubKey(name, true)) {
          if (k == null) return Json.Obj("aumid", name, "ok", false, "reason", "that app's notification settings could not be opened");
          if (value.HasValue) k.SetValue("ShowBanner", value.Value, RegistryValueKind.DWord);
          else k.DeleteValue("ShowBanner", false);
          bool odd;
          int? now = ReadDword(k, "ShowBanner", out odd);
          bool ok = !odd && now == value;
          return Json.Obj("aumid", name, "ok", ok, "now", now.HasValue ? (object)now.Value : null,
                          "reason", ok ? null : "Windows kept a different value after the write");
        }
      } catch (Exception ex) {
        return Json.Obj("aumid", name, "ok", false, "reason", "Windows refused the change (" + ex.GetType().Name + ": " + ex.Message + ")");
      }
    }

    static int? ReadDword(RegistryKey k, string value, out bool odd) {
      odd = false;
      object v = k.GetValue(value, null);
      if (v == null) return null;
      if (v is int) return (int)v;
      odd = true;   // a string or binary ShowBanner: never Mantle's to touch
      return null;
    }

    static IDictionary Read() {
      var apps = new List<object>();
      try {
        using (RegistryKey root = Registry.CurrentUser.OpenSubKey(SettingsKey, false)) {
          if (root == null) return Json.Obj("ok", true, "reason", null, "apps", apps);
          foreach (string n in root.GetSubKeyNames()) {
            try {
              using (RegistryKey k = root.OpenSubKey(n, false)) {
                if (k == null) continue;
                bool oddB, oddE;
                int? b = ReadDword(k, "ShowBanner", out oddB);
                int? e = ReadDword(k, "Enabled", out oddE);
                apps.Add(Json.Obj("aumid", n, "banner", b.HasValue ? (object)b.Value : null,
                                  "enabled", e.HasValue ? (object)e.Value : null, "odd", oddB));
              }
            } catch (Exception) { /* one unreadable app key: it is simply not listed */ }
          }
        }
        return Json.Obj("ok", true, "reason", null, "apps", apps);
      } catch (Exception ex) {
        return Json.Obj("ok", false, "reason", "Windows' notification settings could not be read (" + ex.GetType().Name + ": " + ex.Message + ")", "apps", apps);
      }
    }

    // ------------------------------------------------------------------ quiet: DND + full screen

    [DllImport("ntdll.dll")]
    static extern int NtQueryWnfStateData(ref ulong stateName, IntPtr typeId, IntPtr explicitScope, out uint changeStamp, byte[] buffer, ref uint bufferSize);
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    const ulong WnfQuietHoursActive = 0x0D83063EA3BF1C75UL;

    static string Quiet(Dictionary<string, object> req, ref object result) {
      object dnd = null, quns = null;
      string dndWhy = null, qunsWhy = null;
      try {
        ulong name = WnfQuietHoursActive;
        uint stamp, size = 16;
        var buf = new byte[16];
        int st = NtQueryWnfStateData(ref name, IntPtr.Zero, IntPtr.Zero, out stamp, buf, ref size);
        if (st != 0) dndWhy = "Windows did not say whether Do not disturb is on (NTSTATUS 0x" + st.ToString("X8", CultureInfo.InvariantCulture) + ")";
        else if (size < 4) dndWhy = "Windows has not set Do not disturb's state since it started";
        else dnd = BitConverter.ToInt32(buf, 0);
      } catch (Exception ex) { dndWhy = "Windows did not say whether Do not disturb is on (" + ex.GetType().Name + ")"; }
      try {
        int s;
        int hr = SHQueryUserNotificationState(out s);
        if (hr == 0) quns = s; else qunsWhy = "Windows did not say whether a full-screen app is up (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")";
      } catch (Exception ex) { qunsWhy = "Windows did not say whether a full-screen app is up (" + ex.GetType().Name + ")"; }
      result = Json.Obj("ok", true, "dnd", dnd, "dndWhy", dndWhy, "quns", quns, "qunsWhy", qunsWhy);
      return null;
    }

    // ------------------------------------------------------------------ every exit (Program.SafetyRestore)

    /// Puts each owned app's original value back where it is still Mantle's 0. Never throws; one line.
    public static string RestoreForExit() {
      string record;
      lock (_gate) record = _record;
      if (record == null) return "notification banners: Mantle never took any in this run";
      Dictionary<string, object> owned;
      try {
        if (!File.Exists(record)) return "notification banners: no record, nothing to put back";
        var top = Json.Parse(File.ReadAllText(record)) as Dictionary<string, object>;
        object o;
        owned = top != null && top.TryGetValue("owned", out o) ? o as Dictionary<string, object> : null;
      } catch (Exception ex) {
        return "notification banners: the record could not be read (" + ex.GetType().Name + "), so Windows' banners stay as they are; tools\\restore-banners.ps1 puts them back";
      }
      if (owned == null || owned.Count == 0) return "notification banners: none owned";
      int back = 0, left = 0, failed = 0;
      try {
        using (RegistryKey root = Registry.CurrentUser.OpenSubKey(SettingsKey, true)) {
          if (root == null) return "notification banners: Windows' notification settings are gone; nothing to put back";
          var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
          foreach (string n in root.GetSubKeyNames()) names[n] = n;
          foreach (var kv in owned) {
            string found;
            if (!names.TryGetValue(kv.Key, out found)) { left++; continue; }
            if (Program.Passive && !IsTest(found)) { left++; continue; }
            int? original = kv.Value is double ? (int?)(int)(double)kv.Value : null;
            try {
              using (RegistryKey k = root.OpenSubKey(found, true)) {
                bool odd;
                int? now = k == null ? null : ReadDword(k, "ShowBanner", out odd);
                if (k == null || now != 0) { left++; continue; }   // not Mantle's 0 any more: Owen's own value
                if (original.HasValue) k.SetValue("ShowBanner", original.Value, RegistryValueKind.DWord);
                else k.DeleteValue("ShowBanner", false);
                back++;
              }
            } catch (Exception) { failed++; }
          }
        }
      } catch (Exception ex) {
        return "notification banners: put back failed (" + ex.GetType().Name + "); tools\\restore-banners.ps1 finishes it";
      }
      return "notification banners: " + back + " put back to Windows" + (left > 0 ? ", " + left + " left as they were" : "") +
             (failed > 0 ? ", " + failed + " FAILED (tools\\restore-banners.ps1 finishes it)" : "");
    }
  }
}
