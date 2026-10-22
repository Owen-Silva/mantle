// SysCommon.cs - the small pieces every Mantle Settings "System" backend shares (lane sysset,
// 2026-09-28): SysPower.cs, SysNotify.cs, SysAbout.cs, SysMulti.cs, SysStorage.cs.
//
// WHY one file: each of those answers the same three questions for every row the page draws -
// what is the value, can Mantle change it (and if not, the exact reason), and what EXACTLY would a
// change write - and they must answer them the same way, so the page can show one kind of reason
// line and one kind of "would write" preview whatever the area.
//
// THE REGISTRY RULES here are the house rules for settings Windows keeps as plain values:
//   - reads never throw: a missing key or value is `null` with the reason beside it;
//   - a write names ONE value in a FIXED key (the callers' tables, never a request argument), is
//     read back, and a mismatch is an error in plain words, never ok:true;
//   - HKLM writes need an elevated process. Mantle runs with the user's filtered (UAC) token, so those
//     answer {needsAdmin:true, elevate:"<action>"}: the page then runs that [Elevated] action
//     through the elevation broker (sidecar/ELEVATE.md), one UAC prompt per change.
//
// PRIVACY: nothing here logs. Reasons carry codes and states, never a path or a name.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using Microsoft.Win32;

namespace Mantle {
  static class SysCommon {
    static int _elevated = -1;

    /// True only for a FULL administrator token (a filtered UAC token says false).
    public static bool Elevated() {
      if (_elevated < 0) {
        bool e = false;
        try {
          using (WindowsIdentity wi = WindowsIdentity.GetCurrent())
            e = new WindowsPrincipal(wi).IsInRole(WindowsBuiltInRole.Administrator);
        } catch (Exception) { e = false; }
        _elevated = e ? 1 : 0;
      }
      return _elevated == 1;
    }

    /// An exception in words that can never carry a path (only its type and HRESULT).
    public static string Why(Exception ex) {
      if (ex is SecurityException || ex is UnauthorizedAccessException) return "access denied (5)";
      int hr = System.Runtime.InteropServices.Marshal.GetHRForException(ex);
      return ex.GetType().Name + " (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")";
    }

    public static RegistryKey Hive(string hive) {
      return RegistryKey.OpenBaseKey(hive == "HKLM" ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64);
    }

    /// One value, read-only. `why` says why it is null (no key, no value, denied).
    public static object Read(string hive, string key, string name, out string why) {
      why = null;
      try {
        using (RegistryKey b = Hive(hive))
        using (RegistryKey k = b.OpenSubKey(key, false)) {
          if (k == null) { why = "not set (the key does not exist)"; return null; }
          object v = k.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
          if (v == null) why = "not set (Windows' default applies)";
          return v;
        }
      } catch (Exception ex) { why = "could not be read: " + Why(ex); return null; }
    }

    /// A DWORD as a long, or null (why says why). A string holding a number reads as that number,
    /// because Control Panel\Desktop keeps its switches as REG_SZ "1"/"0".
    public static long? ReadNumber(string hive, string key, string name, out string why) {
      object v = Read(hive, key, name, out why);
      if (v == null) return null;
      if (v is int) return (long)(uint)(int)v;
      if (v is long) return (long)v;
      string s = v as string;
      long n;
      if (s != null && long.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) return n;
      why = "not a number (" + (v.GetType().Name) + ")";
      return null;
    }

    /// Writes ONE value and reads it back. null = done and verified, else the reason.
    /// `asString` writes REG_SZ (Control Panel\Desktop's style), else REG_DWORD.
    public static string WriteNumber(string hive, string key, string name, long value, bool asString) {
      if (hive == "HKLM" && !Elevated()) return "needs administrator: Windows keeps this for the whole PC (HKLM)";
      try {
        using (RegistryKey b = Hive(hive))
        using (RegistryKey k = b.CreateSubKey(key, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
          if (k == null) return "the settings key could not be opened for writing";
          if (asString) k.SetValue(name, value.ToString(CultureInfo.InvariantCulture), RegistryValueKind.String);
          else k.SetValue(name, unchecked((int)(uint)value), RegistryValueKind.DWord);
        }
      } catch (Exception ex) { return "Windows refused the write: " + Why(ex); }
      string why;
      long? back = ReadNumber(hive, key, name, out why);
      if (back == null) return "the value was written but could not be read back (" + why + ")";
      if (back.Value != value) return "the value was written but reads back as " + back.Value + " (another program may have put it back)";
      return null;
    }

    /// What a write WOULD do, for dryRun and for the page's "would write" preview.
    public static IDictionary RegWrite(string hive, string key, string name, long value, bool asString, object before) {
      return Json.Obj("api", "registry", "hive", hive, "key", key, "name", name,
                      "type", asString ? "REG_SZ" : "REG_DWORD",
                      "value", asString ? (object)value.ToString(CultureInfo.InvariantCulture) : (object)value,
                      "before", before);
    }

    /// The standard dryRun answer: {ok, dryRun, writes, before, wouldRefuse, needsAdmin}.
    public static IDictionary Dry(IList writes, object before, string wouldRefuse, bool needsAdmin) {
      return Json.Obj("ok", true, "dryRun", true, "writes", writes, "before", before,
                      "wouldRefuse", wouldRefuse, "needsAdmin", needsAdmin);
    }

    /// The standard "this goes through the administrator prompt" answer: `action` is the
    /// [Elevated] name the page hands to env.elevate, `does` its words.
    public static IDictionary NeedsAdmin(string action, string does, IList writes) {
      return Json.Obj("ok", false, "needsAdmin", true, "elevate", action, "writes", writes,
                      "reason", "Windows will ask for administrator permission to " + does);
    }

    public static string Passive(string wouldHave) {
      return FeatureTable.PassiveRefusal + ": it would have " + wouldHave;
    }

    /// Strict bool argument: null = fine (value in `v`), else the error in words.
    public static string Bool(Dictionary<string, object> req, string key, string cmd, out bool v) {
      v = false;
      object o;
      if (!Json.TryGet(req, key, out o) || !(o is bool)) return cmd + " needs " + key + ": true or false";
      v = (bool)o;
      return null;
    }

    /// Strict whole-number argument.
    public static string Number(Dictionary<string, object> req, string key, string cmd, long min, long max, out long v) {
      v = 0;
      object o;
      if (!Json.TryGet(req, key, out o) || !(o is double)) return cmd + " needs " + key + ": a number from " + min + " to " + max;
      double d = (double)o;
      if (d != Math.Floor(d) || d < min || d > max) return cmd + " needs " + key + ": a whole number from " + min + " to " + max;
      v = (long)d;
      return null;
    }

    public static List<object> List(params object[] items) { return new List<object>(items); }

    /// The elevated actions' common validator shape: exactly {on: bool}.
    public static string CheckOn(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "on");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("on", out v) || !(v is bool)) return "on must be true or false";
      return null;
    }

    // ------------------------------------------------------------------ token privileges
    // An elevated token HOLDS privileges like SeCreatePagefilePrivilege but has them disabled until
    // asked (the documented AdjustTokenPrivileges dance, what powercfg.exe itself does).
    [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public int Count; public LUID Luid; public int Attributes; }
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES state, int len, IntPtr prev, IntPtr retLen);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    /// Enables `name` (e.g. "SeCreatePagefilePrivilege") in this process's token. null = enabled.
    public static string EnablePrivilege(string name) {
      IntPtr tok;
      if (!OpenProcessToken(GetCurrentProcess(), 0x28 /* ADJUST_PRIVILEGES | QUERY */, out tok))
        return "the process token could not be opened (error " + Marshal.GetLastWin32Error() + ")";
      try {
        LUID l;
        if (!LookupPrivilegeValue(null, name, out l)) return "Windows does not know that privilege (error " + Marshal.GetLastWin32Error() + ")";
        var tp = new TOKEN_PRIVILEGES { Count = 1, Luid = l, Attributes = 2 /* SE_PRIVILEGE_ENABLED */ };
        if (!AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero))
          return "the privilege could not be enabled (error " + Marshal.GetLastWin32Error() + ")";
        int err = Marshal.GetLastWin32Error();
        if (err == 1300) return "this account does not hold that privilege (error 1300)";   // ERROR_NOT_ALL_ASSIGNED
        return null;
      } finally { CloseHandle(tok); }
    }
  }
}
