// SysNotify.cs - Mantle Settings > System > Notifications, natively (lane sysset, 2026-09-28).
//
// WHY: the Notifications page of Windows' Settings, done in Mantle: the global switch, Do not
// disturb, Focus sessions, and every app's notification switches. (Notifications.cs is the other
// half: it READS the notifications themselves for Mantle's centre; this file changes the settings.)
//
//   sysnotify.get {}                                   everything below, each with writable + why
//   sysnotify.set {key:'toasts'|'sound'|'lockScreen'|'criticalLock', on, dryRun?}   a global switch
//   sysnotify.dnd {on, dryRun?}                        Do not disturb on/off
//   sysnotify.focus {on, minutes?, dryRun?}            start (1..240 min) or end a focus session
//   sysnotify.app {app, key:'enabled'|'banner'|'center'|'priority', value, dryRun?}   one app's switch
//
// WHERE WINDOWS KEEPS EACH ONE (measured on this PC, 25H2 build 26200, 2026-09-28):
//   - the notification platform's database (wpndatabase.db, HandlerSettings: s:toast, s:banner,
//     s:audio, s:lock:toast per app) is the platform's own record, written only by its service;
//   - the REGISTRY mirrors the switches the shell reads: HKCU ...\PushNotifications ToastEnabled
//     (the global switch; wpncore.dll holds that name), and HKCU ...\Notifications\Settings with the
//     NOC_GLOBAL_SETTING_* globals and, per app, Enabled / ShowBanner / ShowInActionCenter / Rank:
//     every one of those names is in NotificationController.dll (the shell's notification UI).
//     On this PC the 3 apps whose registry Enabled is 0 are exactly the 3 whose database s:toast is 0,
//     so Windows keeps the two in step. Mantle writes the registry values (read back and verified);
//     whether the platform picks a registry-only change up without a sign-out is NOT PROVEN LIVE.
//   - per-app SOUND and LOCK SCREEN exist only in the database (no registry value Windows reads),
//     so they are shown read-only with that reason: writing another service's live SQLite file is
//     how you corrupt it, and there is no API.
//
// DO NOT DISTURB is the quiet-hours profile of the shell's CLSID_QuietHoursSettings object
// ({f53321fa-...}, out of process, registered on this PC): get/put_UserSelectedProfile, the first two
// methods of IQuietHoursSettings {6bff4732-...}. UNDOCUMENTED but the one object the shell itself
// uses; the read is measured here ("Microsoft.QuietHoursProfile.Unrestricted" = off). On = the
// PriorityOnly profile (Windows 11's Do not disturb lets priority notifications through). The write
// is verified by reading the profile back. Its automatic RULES live in an unparsed CloudStore blob,
// so they are read-only "not yet".
//
// FOCUS SESSIONS: Windows.UI.Shell.FocusSessionManager (WinRT, in Windows.UI.winmd): IsSupported and
// GetDefault answer on this PC without any unlock token (measured from PowerShell).
//
// PASSIVE: reads and every dryRun answer; a real write answers FeatureTable.PassiveRefusal.
// PRIVACY: app ids and names go to the page only (it lists them); errors never carry them.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysNotify {
    const string PushKey = @"Software\Microsoft\Windows\CurrentVersion\PushNotifications";
    const string SettingsKey = @"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";
    const string Unrestricted = "Microsoft.QuietHoursProfile.Unrestricted";
    const string PriorityOnly = "Microsoft.QuietHoursProfile.PriorityOnly";

    /// The global switches: page key -> (registry key, value name). Missing = on (Windows' default).
    static readonly string[][] Globals = {
      new[] { "toasts", PushKey, "ToastEnabled" },
      new[] { "sound", SettingsKey, "NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_SOUND" },
      new[] { "lockScreen", SettingsKey, "NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK" },
      new[] { "criticalLock", SettingsKey, "NOC_GLOBAL_SETTING_ALLOW_CRITICAL_TOASTS_ABOVE_LOCK" },
    };

    /// Per-app switches Windows reads from the registry: page key -> value name, default.
    static readonly string[][] AppValues = {
      new[] { "enabled", "Enabled", "1" },
      new[] { "banner", "ShowBanner", "1" },
      new[] { "center", "ShowInActionCenter", "1" },
      new[] { "priority", "Rank", "0" },   // 0 normal, 1 high, 99 top ("Priority of notifications")
    };

    public static void Register(FeatureTable t) {
      t.Add("sysnotify.get", Lanes.Slow, Get);
      t.Add("sysnotify.set", Lanes.Slow, SetGlobal);
      t.Add("sysnotify.dnd", Lanes.Slow, Dnd);
      t.Add("sysnotify.focus", Lanes.Slow, Focus);
      t.Add("sysnotify.app", Lanes.Slow, SetApp);
    }

    // ------------------------------------------------------------------ Do not disturb (COM)

    [ComImport, Guid("6bff4732-81ec-4ffb-ae67-b6c1bc29631f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IQuietHoursSettings {
      [PreserveSig] int get_UserSelectedProfile([MarshalAs(UnmanagedType.LPWStr)] out string profile);
      [PreserveSig] int put_UserSelectedProfile([MarshalAs(UnmanagedType.LPWStr)] string profile);
    }

    static string ReadProfile(out string profile) {
      profile = null;
      object o = null;
      try {
        Type t = Type.GetTypeFromCLSID(new Guid("f53321fa-34f8-4b7f-b9a3-361877cb94cf"), true);
        o = Activator.CreateInstance(t);
        int hr = ((IQuietHoursSettings)o).get_UserSelectedProfile(out profile);
        return hr == 0 ? null : "Windows' quiet-hours object did not answer (0x" + hr.ToString("X8") + ")";
      } catch (Exception ex) {
        return "Windows' quiet-hours object is not available: " + SysCommon.Why(ex);
      } finally { if (o != null) try { Marshal.ReleaseComObject(o); } catch (Exception) { } }
    }

    static string WriteProfile(string profile) {
      object o = null;
      try {
        Type t = Type.GetTypeFromCLSID(new Guid("f53321fa-34f8-4b7f-b9a3-361877cb94cf"), true);
        o = Activator.CreateInstance(t);
        int hr = ((IQuietHoursSettings)o).put_UserSelectedProfile(profile);
        return hr == 0 ? null : "Windows refused the change (0x" + hr.ToString("X8") + ")";
      } catch (Exception ex) {
        return "Windows' quiet-hours object is not available: " + SysCommon.Why(ex);
      } finally { if (o != null) try { Marshal.ReleaseComObject(o); } catch (Exception) { } }
    }

    // ------------------------------------------------------------------ the platform database (read-only)

    static class Sql {
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_close_v2(IntPtr db);
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_busy_timeout(IntPtr db, int ms);
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_prepare16_v2(IntPtr db, [MarshalAs(UnmanagedType.LPWStr)] string sql, int n, out IntPtr st, IntPtr tail);
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_step(IntPtr st);
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern int sqlite3_finalize(IntPtr st);
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern long sqlite3_column_int64(IntPtr st, int i);
      [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] public static extern IntPtr sqlite3_column_text16(IntPtr st, int i);
    }

    /// app id (lower case) -> {s:toast, s:banner, s:audio, s:lock:toast} from the platform's own
    /// record. READ-ONLY open (SQLITE_OPEN_READONLY), one statement, closed at once.
    static Dictionary<string, Dictionary<string, long>> PlatformSettings(out string why) {
      why = null;
      var map = new Dictionary<string, Dictionary<string, long>>(StringComparer.OrdinalIgnoreCase);
      string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                 @"Microsoft\Windows\Notifications\wpndatabase.db");
      if (!File.Exists(path)) { why = "Windows' notification database is not there"; return map; }
      IntPtr db = IntPtr.Zero, st = IntPtr.Zero;
      try {
        byte[] p = Encoding.UTF8.GetBytes(path + "\0");
        int rc = Sql.sqlite3_open_v2(p, out db, 0x1 /* READONLY */, IntPtr.Zero);
        if (rc != 0) { why = "Windows' notification database could not be opened (sqlite " + rc + ")"; return map; }
        Sql.sqlite3_busy_timeout(db, 500);
        rc = Sql.sqlite3_prepare16_v2(db, "select h.PrimaryId, s.SettingKey, s.Value from NotificationHandler h " +
                                          "join HandlerSettings s on s.HandlerId = h.RecordId " +
                                          "where s.SettingKey in ('s:toast','s:banner','s:audio','s:lock:toast')", -1, out st, IntPtr.Zero);
        if (rc != 0) { why = "Windows' notification database has a layout Mantle does not know (sqlite " + rc + ")"; return map; }
        while ((rc = Sql.sqlite3_step(st)) == 100 /* ROW */) {
          string app = Marshal.PtrToStringUni(Sql.sqlite3_column_text16(st, 0)) ?? "";
          string key = Marshal.PtrToStringUni(Sql.sqlite3_column_text16(st, 1)) ?? "";
          Dictionary<string, long> d;
          if (!map.TryGetValue(app, out d)) map[app] = d = new Dictionary<string, long>(StringComparer.Ordinal);
          d[key] = Sql.sqlite3_column_int64(st, 2);
        }
        if (rc != 101 /* DONE */) why = "Windows' notification database stopped mid-read (sqlite " + rc + ")";
      } catch (Exception ex) {
        why = "Windows' notification database could not be read: " + SysCommon.Why(ex);
      } finally {
        if (st != IntPtr.Zero) Sql.sqlite3_finalize(st);
        if (db != IntPtr.Zero) Sql.sqlite3_close_v2(db);
      }
      return map;
    }

    // ------------------------------------------------------------------ reads

    static readonly Dictionary<string, string[]> _names = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);

    static void NameOf(string app, out string name, out string icon) {
      string[] c;
      lock (_names) if (_names.TryGetValue(app, out c)) { name = c[0]; icon = c[1]; return; }
      name = null; icon = null;
      try { if (Apps.Info(app, out name, out icon) != null) { name = null; icon = null; } } catch (Exception) { }
      lock (_names) _names[app] = new[] { name, icon };
    }

    static bool On(long? v, string dflt) { return v.HasValue ? v.Value != 0 : dflt != "0"; }

    static IDictionary FocusState() {
#if MANTLE_WINMD
      try {
        if (!Windows.UI.Shell.FocusSessionManager.IsSupported)
          return Json.Obj("supported", false, "active", false, "writable", false, "why", "Windows says focus sessions are not supported on this PC");
        var m = Windows.UI.Shell.FocusSessionManager.GetDefault();
        return Json.Obj("supported", true, "active", m.IsFocusActive, "writable", true, "why", null);
      } catch (Exception ex) {
        return Json.Obj("supported", false, "active", null, "writable", false, "why", "Windows' focus sessions did not answer: " + SysCommon.Why(ex));
      }
#else
      return Json.Obj("supported", false, "active", null, "writable", false, "why", "this sidecar was built without WinRT (see build.ps1), so focus sessions cannot be reached");
#endif
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      try {
        var globals = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (string[] g in Globals) {
          string why;
          long? v = SysCommon.ReadNumber("HKCU", g[1], g[2], out why);
          globals[g[0]] = Json.Obj("on", On(v, "1"), "set", v.HasValue, "writable", true, "why", null);
        }

        string profile;
        string dwhy = ReadProfile(out profile);
        IDictionary dnd = Json.Obj("on", profile == null ? null : (object)(profile != Unrestricted), "profile", profile,
                                   "writable", dwhy == null, "why", dwhy);

        string dbWhy;
        var platform = PlatformSettings(out dbWhy);
        var apps = new List<object>();
        string appsWhy = null;
        try {
          using (RegistryKey b = SysCommon.Hive("HKCU"))
          using (RegistryKey k = b.OpenSubKey(SettingsKey, false)) {
            if (k != null) foreach (string app in k.GetSubKeyNames()) {
              using (RegistryKey ak = k.OpenSubKey(app, false)) {
                if (ak == null) continue;
                // A sender is an app Windows has seen send a notification (the platform stamps it).
                if (ak.GetValue("LastNotificationAddedTime") == null && ak.GetValue("Enabled") == null) continue;
                var row = new Dictionary<string, object>(StringComparer.Ordinal);
                row["app"] = app;
                string name, icon;
                NameOf(app, out name, out icon);
                row["name"] = name;
                row["icon"] = icon;
                foreach (string[] av in AppValues) {
                  object raw = ak.GetValue(av[1]);
                  long? n = raw is int ? (long?)(long)(uint)(int)raw : null;
                  row[av[0]] = av[0] == "priority" ? (object)(n ?? 0) : (object)On(n, av[2]);
                }
                Dictionary<string, long> d;
                platform.TryGetValue(app, out d);
                long x;
                row["sound"] = d != null && d.TryGetValue("s:audio", out x) ? (object)(x != 0) : null;
                row["lock"] = d != null && d.TryGetValue("s:lock:toast", out x) ? (object)(x != 0) : null;
                row["platformEnabled"] = d != null && d.TryGetValue("s:toast", out x) ? (object)(x != 0) : null;
                apps.Add(row);
              }
            }
          }
        } catch (Exception ex) { appsWhy = "the app list could not be read: " + SysCommon.Why(ex); }

        result = Json.Obj(
          "ok", true,
          "globals", globals,
          "dnd", dnd,
          "rules", Json.Obj("writable", false, "why", "Windows keeps the automatic Do not disturb rules in a settings blob Mantle does not parse yet"),
          "focus", FocusState(),
          "apps", apps, "appsWhy", appsWhy,
          "appWritable", Json.Obj("enabled", true, "banner", true, "center", true, "priority", true, "sound", false, "lock", false),
          "appWhy", Json.Obj("sound", SoundWhy, "lock", SoundWhy),
          "platformWhy", dbWhy);
        return null;
      } catch (Exception ex) {
        return "sysnotify.get failed: " + SysCommon.Why(ex);
      }
    }

    const string SoundWhy = "Windows keeps this only in its notification service's own database, which no other program can safely write and which has no API";

    // ------------------------------------------------------------------ writes

    static string SetGlobal(Dictionary<string, object> req, ref object result) {
      try {
        string key = Json.GetString(req, "key");
        string[] g = null;
        foreach (string[] x in Globals) if (x[0] == key) g = x;
        if (g == null) return "sysnotify.set needs key: toasts, sound, lockScreen or criticalLock";
        bool on;
        string aerr = SysCommon.Bool(req, "on", "sysnotify.set", out on);
        if (aerr != null) return aerr;
        string why;
        long? before = SysCommon.ReadNumber("HKCU", g[1], g[2], out why);
        var writes = SysCommon.List(SysCommon.RegWrite("HKCU", g[1], g[2], on ? 1 : 0, false, before));
        if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, before, null, false); return null; }
        if (Program.Passive) return SysCommon.Passive("turned the " + key + " notification switch " + (on ? "on" : "off"));
        string err = SysCommon.WriteNumber("HKCU", g[1], g[2], on ? 1 : 0, false);
        if (err != null) return err;
        result = Json.Obj("ok", true, "key", key, "on", on);
        return null;
      } catch (Exception ex) { return "sysnotify.set failed: " + SysCommon.Why(ex); }
    }

    static string Dnd(Dictionary<string, object> req, ref object result) {
      bool on;
      string aerr = SysCommon.Bool(req, "on", "sysnotify.dnd", out on);
      if (aerr != null) return aerr;
      string before;
      string rerr = ReadProfile(out before);
      string want = on ? PriorityOnly : Unrestricted;
      var writes = SysCommon.List(Json.Obj("api", "IQuietHoursSettings.put_UserSelectedProfile", "value", want, "before", before));
      if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, before, rerr, false); return null; }
      if (rerr != null) return rerr + "; nothing was changed";
      if (Program.Passive) return SysCommon.Passive("turned Do not disturb " + (on ? "on" : "off"));
      string werr = WriteProfile(want);
      if (werr != null) return werr;
      string after;
      string berr = ReadProfile(out after);
      if (berr != null) return "the change was sent but could not be read back: " + berr;
      if ((after != Unrestricted) != on) return "Windows still reports Do not disturb " + (after != Unrestricted ? "on" : "off");
      result = Json.Obj("ok", true, "on", on, "profile", after);
      return null;
    }

    static string Focus(Dictionary<string, object> req, ref object result) {
      bool on;
      string aerr = SysCommon.Bool(req, "on", "sysnotify.focus", out on);
      if (aerr != null) return aerr;
      long minutes = 0;
      if (on) { aerr = SysCommon.Number(req, "minutes", "sysnotify.focus", 1, 240, out minutes); if (aerr != null) return aerr; }
      IDictionary now = FocusState();
      var writes = SysCommon.List(on ? Json.Obj("api", "FocusSessionManager.TryStartFocusSession", "minutes", minutes)
                                     : Json.Obj("api", "FocusSessionManager.DeactivateFocus"));
      string refuse = (bool)now["supported"] ? null : (string)now["why"];
      if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, now["active"], refuse, false); return null; }
      if (refuse != null) return refuse;
      if (Program.Passive) return SysCommon.Passive((on ? "started" : "ended") + " a focus session");
#if MANTLE_WINMD
      try {
        var m = Windows.UI.Shell.FocusSessionManager.GetDefault();
        if (on) {
          var s = m.TryStartFocusSession(DateTimeOffset.Now.AddMinutes(minutes));
          if (s == null) return "Windows did not start a focus session (another may be running)";
        } else m.DeactivateFocus();
        bool active = m.IsFocusActive;
        if (active != on) return "Windows still reports a focus session " + (active ? "running" : "not running");
        result = Json.Obj("ok", true, "active", active, "minutes", on ? (object)minutes : null);
        return null;
      } catch (Exception ex) { return "Windows' focus sessions refused: " + SysCommon.Why(ex); }
#else
      return (string)now["why"];
#endif
    }

    static string SetApp(Dictionary<string, object> req, ref object result) {
      try {
        string app = Json.GetString(req, "app");
        if (string.IsNullOrEmpty(app) || app.Length > 512 || app.IndexOf('\\') >= 0)
          return "sysnotify.app needs app: an app id exactly as sysnotify.get listed it";
        string key = Json.GetString(req, "key");
        string[] av = null;
        foreach (string[] x in AppValues) if (x[0] == key) av = x;
        if (av == null) {
          if (key == "sound" || key == "lock") return SoundWhy;
          return "sysnotify.app needs key: enabled, banner, center or priority";
        }
        long value;
        if (key == "priority") {
          string nerr = SysCommon.Number(req, "value", "sysnotify.app", 0, 99, out value);
          if (nerr != null) return nerr;
          if (value != 0 && value != 1 && value != 99) return "sysnotify.app priority is 0 (normal), 1 (high) or 99 (top)";
        } else {
          bool on;
          string berr = SysCommon.Bool(req, "value", "sysnotify.app", out on);
          if (berr != null) return berr;
          value = on ? 1 : 0;
        }
        // The key path is built only from a subkey that EXISTS right now (exact name), never from
        // the argument as given.
        string found = null;
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.OpenSubKey(SettingsKey, false)) {
          if (k != null) foreach (string n in k.GetSubKeyNames()) if (string.Equals(n, app, StringComparison.OrdinalIgnoreCase)) { found = n; break; }
        }
        if (found == null) return "that app is not in Windows' notification list any more; refresh the page";
        string path = SettingsKey + "\\" + found;
        string why;
        long? before = SysCommon.ReadNumber("HKCU", path, av[1], out why);
        var writes = SysCommon.List(SysCommon.RegWrite("HKCU", path, av[1], value, false, before));
        if (Json.GetBool(req, "dryRun", false)) { result = SysCommon.Dry(writes, before, null, false); return null; }
        if (Program.Passive) return SysCommon.Passive("changed an app's notification " + key);
        string err = SysCommon.WriteNumber("HKCU", path, av[1], value, false);
        if (err != null) return err;
        result = Json.Obj("ok", true, "key", key, "value", key == "priority" ? (object)value : (object)(value != 0));
        return null;
      } catch (Exception ex) { return "sysnotify.app failed: " + SysCommon.Why(ex); }
    }
  }
}
