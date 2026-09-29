// SysAccounts.cs - Settings > Accounts for Mantle Settings (lane appsacct, 2026-09-29).
//
// MANTLE NEVER CHANGES OWEN'S ACCOUNT, PASSWORD, PIN OR USERS. Everything here is a read, except two
// HKCU switches on the Sign-in options page (dynamic lock, restart apps), which are ordinary per-user
// values. Commands (all Lanes.Slow):
//   accounts.info       your name, user name, picture (a data: URL of Windows' own account picture),
//                       Microsoft / local / domain / work account (NetUserGetInfo level 24), administrator
//                       or standard (the token's Administrators group), password last set
//   accounts.signin     Windows Hello (the biometric sensors present; what is enrolled is not readable),
//                       dynamic lock, restart apps, "use my sign-in info" (HKLM: read-only), policies
//   accounts.signinSet {name: dynamicLock|restartApps, on, dryRun?}   HKCU Winlogon, read back
//   accounts.users      the local accounts (NetUserEnum level 20): name, full name, administrator,
//                       enabled, you. Adding / removing needs an administrator: read-only.
//   accounts.linked     Email & accounts (Microsoft accounts known to this user), Access work or school
//                       (Entra join, workplace registration, domain, MDM), Windows backup (OneDrive and
//                       which of your folders it backs up).
// PRIVACY: nothing here logs. Names and emails reach the page only in results.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysAccounts {
    public static void Register(FeatureTable t) {
      t.Add("accounts.info", Lanes.Slow, Info);
      t.Add("accounts.signin", Lanes.Slow, Signin);
      t.Add("accounts.signinSet", Lanes.Slow, SigninSet);
      t.Add("accounts.users", Lanes.Slow, Users);
      t.Add("accounts.linked", Lanes.Slow, Linked);
    }

    // ------------------------------------------------------------------ netapi32
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserGetInfo(string server, string user, int level, out IntPtr buf);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserEnum(string server, int level, int filter, out IntPtr buf, int max, out int read, out int total, ref int resume);
    [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buf);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetGetJoinInformation(string server, out IntPtr name, out int status);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct USER_INFO_24 { [MarshalAs(UnmanagedType.Bool)] public bool internet_identity; public int flags; public string provider; public string principal; public IntPtr sid; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct USER_INFO_20 { public string name; public string full_name; public string comment; public int flags; public int user_id; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct USER_INFO_1 { public string name; public string password; public int password_age; public int priv; public string home_dir; public string comment; public int flags; public string script_path; }

    static string UserName() {
      string n = Environment.UserName;
      return string.IsNullOrEmpty(n) ? null : n;
    }
    static string Sid() {
      try { using (WindowsIdentity wi = WindowsIdentity.GetCurrent()) return wi.User == null ? null : wi.User.Value; } catch (Exception) { return null; }
    }
    /// An administrator ACCOUNT: the token carries Administrators (deny-only while UAC filters it).
    static bool AdminAccount() {
      try {
        using (WindowsIdentity wi = WindowsIdentity.GetCurrent()) {
          if (new WindowsPrincipal(wi).IsInRole(WindowsBuiltInRole.Administrator)) return true;
          IntPtr tok = wi.Token;
          // deny-only groups are not in wi.Groups; read TokenGroups for S-1-5-32-544
          return HasGroup(tok, "S-1-5-32-544");
        }
      } catch (Exception) { return false; }
    }
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
    static bool HasGroup(IntPtr tok, string sid) {
      int len;
      GetTokenInformation(tok, 2 /* TokenGroups */, IntPtr.Zero, 0, out len);
      if (len <= 0) return false;
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        if (!GetTokenInformation(tok, 2, buf, len, out len)) return false;
        int n = Marshal.ReadInt32(buf);
        int size = IntPtr.Size * 2;   // SID_AND_ATTRIBUTES: PSID + DWORD, padded
        IntPtr p = new IntPtr(buf.ToInt64() + IntPtr.Size);
        for (int i = 0; i < n; i++) {
          IntPtr s = Marshal.ReadIntPtr(new IntPtr(p.ToInt64() + i * size));
          try { if (new SecurityIdentifier(s).Value == sid) return true; } catch (Exception) { }
        }
      } finally { Marshal.FreeHGlobal(buf); }
      return false;
    }

    // ------------------------------------------------------------------ accounts.info
    static string Info(Dictionary<string, object> req, ref object result) {
      string user = UserName(), sid = Sid();
      string full = null, kind = "local", email = null, why = null;
      int ageS = -1;
      IntPtr b;
      if (user != null && NetUserGetInfo(null, user, 20, out b) == 0) {
        try { var u = (USER_INFO_20)Marshal.PtrToStructure(b, typeof(USER_INFO_20)); full = string.IsNullOrWhiteSpace(u.full_name) ? null : u.full_name; }
        finally { NetApiBufferFree(b); }
      }
      if (user != null && NetUserGetInfo(null, user, 24, out b) == 0) {
        try {
          var u = (USER_INFO_24)Marshal.PtrToStructure(b, typeof(USER_INFO_24));
          if (u.internet_identity) { kind = "microsoft"; email = u.principal; }
        } finally { NetApiBufferFree(b); }
      }
      if (user != null && NetUserGetInfo(null, user, 1, out b) == 0) {
        try { ageS = ((USER_INFO_1)Marshal.PtrToStructure(b, typeof(USER_INFO_1))).password_age; } finally { NetApiBufferFree(b); }
      }
      string domain = null;
      try { using (WindowsIdentity wi = WindowsIdentity.GetCurrent()) { string n = wi.Name; int i = n.IndexOf('\\'); domain = i > 0 ? n.Substring(0, i) : null; } } catch (Exception) { }
      if (kind == "local" && domain != null && !domain.Equals(Environment.MachineName, StringComparison.OrdinalIgnoreCase)) kind = domain.Equals("AzureAD", StringComparison.OrdinalIgnoreCase) ? "work" : "domain";
      if (full == null && user == null) why = "Windows did not say who is signed in";

      string pic = null, picWhy = null;
      if (sid != null) {
        string w;
        foreach (string size in new[] { "Image192", "Image208", "Image240", "Image96" }) {
          string path = SysCommon.Read("HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\AccountPicture\Users\" + sid, size, out w) as string;
          if (path == null) continue;
          try {
            var fi = new FileInfo(path);
            if (fi.Exists && fi.Length < 400000) {
              string ext = fi.Extension.ToLowerInvariant();
              pic = "data:image/" + (ext == ".png" ? "png" : "jpeg") + ";base64," + Convert.ToBase64String(File.ReadAllBytes(path));
              break;
            }
          } catch (Exception ex) { picWhy = "Your account picture could not be read: " + SysCommon.Why(ex); }
        }
        if (pic == null && picWhy == null) picWhy = "No account picture is set; Windows shows the default";
      }
      bool admin = AdminAccount();
      result = Json.Obj("ok", true, "name", full ?? email ?? user, "user", user, "email", email, "kind", kind, "domain", kind == "domain" ? domain : null,
                        "admin", admin, "elevated", SysCommon.Elevated(), "picture", pic, "pictureWhy", picWhy,
                        "passwordSet", ageS >= 0 && kind == "local" ? (object)Math.Floor((DateTime.UtcNow.AddSeconds(-ageS) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds) : null,
                        "why", why,
                        "readOnly", "Read only: Mantle never changes your account, name, picture, password or type. Changing them goes through Windows' own sign-in checks.");
      return null;
    }

    // ------------------------------------------------------------------ accounts.signin
    const string WINLOGON = @"Software\Microsoft\Windows NT\CurrentVersion\Winlogon";
    static readonly string[][] SWITCHES = {
      new[] { "dynamicLock", "EnableGoodbye", "Dynamic lock" },
      new[] { "restartApps", "RestartApps", "Automatically save my restartable apps and restart them when I sign back in" },
    };
    const string BIO_CLASS = @"SYSTEM\CurrentControlSet\Control\Class\{53D29EF7-377C-4D14-864B-EB3A85769359}";

    static int Sensors() {
      int n = 0;
      try {
        using (RegistryKey b = SysCommon.Hive("HKLM"))
        using (RegistryKey k = b.OpenSubKey(BIO_CLASS, false)) {
          if (k == null) return 0;
          foreach (string s in k.GetSubKeyNames()) if (s.Length == 4 && char.IsDigit(s[0])) n++;
        }
      } catch (Exception) { return -1; }
      return n;
    }
    static IDictionary SwitchState() {
      var o = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string[] s in SWITCHES) {
        string w;
        long? v = SysCommon.ReadNumber("HKCU", WINLOGON, s[1], out w);
        o[s[0]] = Json.Obj("on", v != null && v.Value != 0, "set", v != null, "label", s[2]);
      }
      return o;
    }
    static string Signin(Dictionary<string, object> req, ref object result) {
      string sid = Sid(), w;
      int sensors = Sensors();
      long? arso = sid == null ? null : SysCommon.ReadNumber("HKLM", @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO\" + sid, "OptOut", out w);
      long? arsoPol = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "DisableAutomaticRestartSignOn", out w);
      long? helloPol = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\PassportForWork", "Enabled", out w);
      result = Json.Obj("ok", true,
        "hello", Json.Obj("sensors", sensors, "policyOff", helloPol == 0,
          "readOnly", "Read only: a PIN, face or fingerprint is set up and removed only through Windows Hello's own secure flow, which checks it is you first. Windows keeps them under the system account, so no other program can even read which ones you have."),
        "switches", SwitchState(),
        "signinInfo", Json.Obj("on", arsoPol == 1 ? false : arso == null || arso.Value == 0, "policy", arsoPol == 1,
          "readOnly", arsoPol == 1 ? "Read only: a policy on this PC turns it off (DisableAutomaticRestartSignOn)"
            : "Read only: Windows keeps it for your account in the machine-wide Winlogon key (HKLM), which needs an administrator"),
        "password", "Read only: Mantle never changes your password or PIN. Change them from the Ctrl+Alt+Delete screen, which Windows protects.");
      return null;
    }
    static string SigninSet(Dictionary<string, object> req, ref object result) {
      string name = Json.GetString(req, "name");
      string[] row = null;
      foreach (string[] s in SWITCHES) if (s[0] == name) row = s;
      if (row == null) return "accounts.signinSet needs name: dynamicLock or restartApps";
      bool on;
      string e = SysCommon.Bool(req, "on", "accounts.signinSet", out on);
      if (e != null) return e;
      string w;
      object before = SysCommon.Read("HKCU", WINLOGON, row[1], out w);
      string would = "turn \"" + row[2] + "\" " + (on ? "on" : "off") + " (HKCU Winlogon " + row[1] + " = " + (on ? 1 : 0) + ")";
      if (Json.GetBool(req, "dryRun", false)) {
        IDictionary d = SysCommon.Dry(SysCommon.List(SysCommon.RegWrite("HKCU", WINLOGON, row[1], on ? 1 : 0, false, before)), before, null, false);
        d["would"] = would;
        result = d;
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would.Replace("turn ", "turned "));
      string bad = SysCommon.WriteNumber("HKCU", WINLOGON, row[1], on ? 1 : 0, false);
      if (bad != null) return "accounts.signinSet: " + bad;
      result = Json.Obj("ok", true, "now", on, "switches", SwitchState());
      return null;
    }

    // ------------------------------------------------------------------ accounts.users
    static string Users(Dictionary<string, object> req, ref object result) {
      var items = new List<object>();
      string me = UserName();
      IntPtr buf; int read, total, resume = 0;
      int rc = NetUserEnum(null, 20, 2 /* FILTER_NORMAL_ACCOUNT */, out buf, -1, out read, out total, ref resume);
      if (rc != 0 && rc != 234) return "The local accounts could not be read (NetUserEnum error " + rc + ")";
      try {
        int sz = Marshal.SizeOf(typeof(USER_INFO_20));
        for (int i = 0; i < read; i++) {
          var u = (USER_INFO_20)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + i * sz), typeof(USER_INFO_20));
          if (u.user_id < 1000) continue;   // Administrator, Guest, DefaultAccount, WDAGUtilityAccount
          bool admin = false;
          IntPtr b1;
          if (NetUserGetInfo(null, u.name, 1, out b1) == 0) {
            try { admin = ((USER_INFO_1)Marshal.PtrToStructure(b1, typeof(USER_INFO_1))).priv == 2; } finally { NetApiBufferFree(b1); }
          }
          items.Add(Json.Obj("name", u.name, "fullName", string.IsNullOrWhiteSpace(u.full_name) ? null : u.full_name, "admin", admin,
                             "enabled", (u.flags & 0x2) == 0, "you", me != null && u.name.Equals(me, StringComparison.OrdinalIgnoreCase)));
        }
      } finally { if (buf != IntPtr.Zero) NetApiBufferFree(buf); }
      result = Json.Obj("ok", true, "items", items,
        "readOnly", "Read only: adding, removing or changing an account needs an administrator, and Mantle never changes accounts.");
      return null;
    }

    // ------------------------------------------------------------------ accounts.linked
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, int flags, IntPtr token, out IntPtr path);
    static string Known(string guid) {
      IntPtr p;
      if (SHGetKnownFolderPath(new Guid(guid), 0, IntPtr.Zero, out p) != 0) return null;
      try { return Marshal.PtrToStringUni(p); } finally { Marshal.FreeCoTaskMem(p); }
    }
    static List<string> SubKeys(string hive, string key) {
      var o = new List<string>();
      try { using (RegistryKey b = SysCommon.Hive(hive)) using (RegistryKey k = b.OpenSubKey(key, false)) if (k != null) o.AddRange(k.GetSubKeyNames()); } catch (Exception) { }
      return o;
    }
    static string Linked(Dictionary<string, object> req, ref object result) {
      string w;
      // Email & accounts: the Microsoft accounts Windows' identity store knows for this user
      var msa = new List<object>();
      foreach (string s in SubKeys("HKCU", @"Software\Microsoft\IdentityCRL\UserExtendedProperties")) if (s.IndexOf('@') > 0 && s.Length < 200) msa.Add(s);
      // Access work or school
      var work = new List<object>();
      foreach (string s in SubKeys("HKLM", @"SYSTEM\CurrentControlSet\Control\CloudDomainJoin\JoinInfo")) {
        string upn = SysCommon.Read("HKLM", @"SYSTEM\CurrentControlSet\Control\CloudDomainJoin\JoinInfo\" + s, "UserEmail", out w) as string;
        work.Add(Json.Obj("kind", "Joined to Microsoft Entra ID", "account", upn));
      }
      foreach (string s in SubKeys("HKCU", @"Software\Microsoft\Windows NT\CurrentVersion\WorkplaceJoin\JoinInfo")) {
        string upn = SysCommon.Read("HKCU", @"Software\Microsoft\Windows NT\CurrentVersion\WorkplaceJoin\JoinInfo\" + s, "UserEmail", out w) as string;
        work.Add(Json.Obj("kind", "Work or school account", "account", upn));
      }
      foreach (string s in SubKeys("HKLM", @"SOFTWARE\Microsoft\Enrollments")) {
        string upn = SysCommon.Read("HKLM", @"SOFTWARE\Microsoft\Enrollments\" + s, "UPN", out w) as string;
        if (upn != null) work.Add(Json.Obj("kind", "Managed by an organization (MDM)", "account", upn));
      }
      IntPtr nm; int st;
      if (NetGetJoinInformation(null, out nm, out st) == 0) {
        try { if (st == 3) work.Add(Json.Obj("kind", "Joined to a domain", "account", Marshal.PtrToStringUni(nm))); } finally { NetApiBufferFree(nm); }
      }
      // Windows backup: OneDrive and your folders
      string odEmail = SysCommon.Read("HKCU", @"Software\Microsoft\OneDrive\Accounts\Personal", "UserEmail", out w) as string;
      string odFolder = SysCommon.Read("HKCU", @"Software\Microsoft\OneDrive\Accounts\Personal", "UserFolder", out w) as string;
      if (odFolder == null) odFolder = Environment.GetEnvironmentVariable("OneDriveConsumer") ?? Environment.GetEnvironmentVariable("OneDrive");
      bool odInstalled = File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\OneDrive\OneDrive.exe")) ||
                         File.Exists(@"C:\Program Files\Microsoft OneDrive\OneDrive.exe");
      var folders = new List<object>();
      string[][] KF = { new[] { "Desktop", "B4BFCC3A-DB2C-424C-B029-7FE99A87C641" }, new[] { "Documents", "FDD39AD0-238F-46AF-ADB4-6C85480369C7" }, new[] { "Pictures", "33E28130-4E1E-4676-835A-98395C3BC3BB" },
                        new[] { "Music", "4BD8D571-6D19-48D3-BE97-422220080E43" }, new[] { "Videos", "18989B1D-99B5-455B-841C-AB7C74E4DDFC" } };
      foreach (string[] k in KF) {
        string p = Known(k[1]);
        bool inOd = p != null && !string.IsNullOrEmpty(odFolder) && p.StartsWith(odFolder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        folders.Add(Json.Obj("name", k[0], "backedUp", inOd));
      }
      result = Json.Obj("ok", true, "microsoftAccounts", msa, "work", work,
        "backup", Json.Obj("oneDrive", odInstalled, "signedIn", odEmail != null, "account", odEmail, "folders", folders,
          "readOnly", "Read only: OneDrive's folder backup is switched in OneDrive itself, and Windows' app and preference backup is kept by your Microsoft account online"),
        "emailReadOnly", "Read only: adding or removing an account goes through Microsoft's sign-in (Web Account Manager), which only Windows' own Settings opens",
        "workReadOnly", "Read only: connecting or disconnecting goes through your organization's sign-in, which only Windows' own Settings opens, and Mantle never changes accounts",
        "familyReadOnly", "Read only: Microsoft Family Safety lives in your Microsoft account online; Windows' own Settings only links to it");
      return null;
    }
  }
}
