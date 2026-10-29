// Users.cs - the Users tab's sessions and its Disconnect / Sign off / Connect (lane tm-users, 2026-10-28).
//
//   taskmgr.users {}  -> { rows: [{session, user, domain, fullName|null, status|null, state, logon|null, self}],
//                          why?: {fullName}, ms }
//   taskmgr.userop {session, user, logon?, op:'disconnect'|'connect'|'signoff', dryRun?, confirmed?}
//                     -> { ok, op, session, user, dryRun, reason|null, state|null,
//                          needsConfirm?, title?, text?, button?, needsAdmin? }
//   taskmgr.userdisconnect / taskmgr.usersignoff {session, user, logon?, dryRun?, confirmed?}
//                     -> taskmgr.userop with op fixed (the names the elevated helper's allowlist carries).
//
// THE LIST: WTSEnumerateSessions on this machine, then WTSUserName / WTSDomainName / WTSConnectState /
// WTSSessionInfo per session; one row per session that has a signed-in user (session 0 and the
// listener/console-without-user sessions have none and are left out, as Windows' Users tab does).
//   status   the word Windows' Users tab shows in its Status column: Windows 11 shows NOTHING for an
//            active session (null here) and "Disconnected" for a disconnected one. Any other WTS state
//            (connected, idle, shadow...) also shows nothing there (null). Written from how Windows 11's
//            Users tab behaves; not checked against taskmgr.exe in this lane.
//   state    the raw WTS state word (active / connected / disconnected / idle / ...) for the page's
//            button logic (Connect is only offered for a disconnected session).
//   logon    the session's logon time as a decimal FILETIME string (WTSINFOW.LogonTime), the session-id
//            analogue of a process's creation time; null when Windows did not give one.
//   fullName NetUserGetInfo level 10 for a local account (a Microsoft account signed in on this PC is a
//            local account whose full name Windows sets to the account's display name). For a domain or
//            Azure AD account, only this sidecar's own session can be read (GetUserNameEx NameDisplay);
//            otherwise null and why.fullName says why.
//   self     the session this sidecar runs in.
//
// THE OPS: Windows' confirm comes first: disconnect and signoff without confirmed:true answer
// {ok:false, needsConfirm:true, title, text, button} with Windows' dialog words and touch nothing (also
// for a dry run, and also on a passive sidecar). Then dryRun answers from the current state. Then a
// passive (test) sidecar refuses every real op before any WTS write. Every op names the session's user
// (and may name its logon time, from taskmgr.users); a session whose user (or logon) changed is refused,
// checked again right before the real call, because Windows reuses session numbers.
// Default Windows permissions let a standard (non-elevated) user disconnect or sign out only their own
// session; another user's session needs administrator -> ok:false, needsAdmin:true (a dry run predicts it
// from the token's elevation; a real call reports Windows' access denied).
// Connect to another user's session needs that user's password: always ok:false with a plain reason;
// this file never asks for or takes a password.
//
// OUTSIDE DEPENDENCIES: MantleFeature, FeatureTable.Add / PassiveRefusal, Lanes.Slow, Program.Passive,
// Program.EmitLog, Json.Obj / GetBool / GetInt / GetString. Everything else is wtsapi32 / netapi32 /
// secur32 / kernel32 / advapi32 P/Invoke declared below. Compiles into the elevated helper unchanged.
// Logs session numbers and Win32 codes only, never user names.
//
// C# 5 only (build.ps1): no interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  [MantleFeature]
  static class Users {
    static class N {
      [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSEnumerateSessionsW(IntPtr server, int reserved, int version, out IntPtr info, out int count);
      [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int cls, out IntPtr buf, out int bytes);
      [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
      [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSDisconnectSession(IntPtr server, int session, bool wait);
      [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSLogoffSession(IntPtr server, int session, bool wait);
      [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool WTSConnectSessionW(int logonId, int targetLogonId, string password, bool wait);
      [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] public static extern int NetUserGetInfo(string server, string user, int level, out IntPtr buf);
      [DllImport("netapi32.dll")] public static extern int NetApiBufferFree(IntPtr buf);
      [DllImport("secur32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserNameExW(int format, StringBuilder buf, ref int size);
      [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out int session);
      [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buf, int len, out int ret);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WTS_SESSION_INFOW { public int SessionId; public IntPtr WinStationName; public int State; }

    const int WTSUserName = 5, WTSDomainName = 7, WTSConnectState = 8, WTSSessionInfo = 24;
    const int WTSActive = 0, WTSDisconnected = 4;
    const int LOGON_TIME_OFFSET = 200;   // WTSINFOW: 8 DWORDs, WCHAR[32] + [17] + [21] = 172, 8-aligned 176, then 4 LARGE_INTEGERs before LogonTime
    const string NEEDS_ADMIN_OTHER = "needs administrator: only an administrator can do that to another user's session";

    static readonly string[] StateWords = { "active", "connected", "connectquery", "shadow", "disconnected", "idle", "listen", "reset", "down", "init" };

    // ------------------------------------------------------------------ host accessors (the elevated helper supplies its own Program/FeatureTable)
    static bool HostPassive() { return Program.Passive; }
    static string HostPassiveRefusal() { return FeatureTable.PassiveRefusal; }
    static void HostLog(string level, string message) { Program.EmitLog(level, message); }

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.users", Lanes.Slow, List);                // {} -> one row per signed-in session
      t.Add("taskmgr.userop", Lanes.Slow, UserOp);             // {session, user, logon?, op, dryRun?, confirmed?}
      t.Add("taskmgr.userdisconnect", Lanes.Slow, Disconnect); // = userop op:'disconnect' (elevated helper's name)
      t.Add("taskmgr.usersignoff", Lanes.Slow, SignOff);       // = userop op:'signoff'    (elevated helper's name)
    }

    // ------------------------------------------------------------------ reads

    sealed class Sess { public int Id; public string User, Domain, State; public int StateCode; public long Logon; }

    static string QueryString(int session, int cls) {
      IntPtr b; int n;
      if (!N.WTSQuerySessionInformationW(IntPtr.Zero, session, cls, out b, out n) || b == IntPtr.Zero) return null;
      try { string s = Marshal.PtrToStringUni(b); return string.IsNullOrEmpty(s) ? null : s; }
      finally { N.WTSFreeMemory(b); }
    }

    static int QueryState(int session) {
      IntPtr b; int n;
      if (!N.WTSQuerySessionInformationW(IntPtr.Zero, session, WTSConnectState, out b, out n) || b == IntPtr.Zero) return -1;
      try { return n >= 4 ? Marshal.ReadInt32(b) : -1; } finally { N.WTSFreeMemory(b); }
    }

    static long QueryLogon(int session) {
      IntPtr b; int n;
      if (!N.WTSQuerySessionInformationW(IntPtr.Zero, session, WTSSessionInfo, out b, out n) || b == IntPtr.Zero) return 0;
      try {
        if (n < LOGON_TIME_OFFSET + 16) return 0;
        long logon = Marshal.ReadInt64(b, LOGON_TIME_OFFSET), now = Marshal.ReadInt64(b, LOGON_TIME_OFFSET + 8);
        // sanity: a FILETIME after 2000-01-01 and not after the "current time" field next to it
        return logon > 125911584000000000L && (now == 0 || logon <= now) ? logon : 0;
      } finally { N.WTSFreeMemory(b); }
    }

    /// The session's user right now (null when nobody is signed in there).
    static Sess Read(int id) {
      string user = QueryString(id, WTSUserName);
      if (user == null) return null;
      var s = new Sess();
      s.Id = id; s.User = user; s.Domain = QueryString(id, WTSDomainName);
      s.StateCode = QueryState(id);
      s.State = s.StateCode >= 0 && s.StateCode < StateWords.Length ? StateWords[s.StateCode] : null;
      s.Logon = QueryLogon(id);
      return s;
    }

    static int OwnSession() {
      int s;
      return N.ProcessIdToSessionId(N.GetCurrentProcessId(), out s) ? s : -1;
    }

    static int _elevated = -1;
    static bool Elevated() {
      if (_elevated >= 0) return _elevated == 1;
      int v = 0;
      IntPtr tok;
      if (N.OpenProcessToken(N.GetCurrentProcess(), 0x0008, out tok)) {   // TOKEN_QUERY
        IntPtr b = Marshal.AllocHGlobal(4);
        try { int ret; if (N.GetTokenInformation(tok, 20, b, 4, out ret)) v = Marshal.ReadInt32(b) != 0 ? 1 : 0; }   // TokenElevation
        finally { Marshal.FreeHGlobal(b); N.CloseHandle(tok); }
      }
      _elevated = v;
      return v == 1;
    }

    static bool IsLocal(string domain) {
      return string.IsNullOrEmpty(domain) || string.Equals(domain, Environment.MachineName, StringComparison.OrdinalIgnoreCase);
    }

    /// The account's full name, or null with `why`.
    static string FullName(Sess s, bool self, out string why) {
      why = null;
      if (IsLocal(s.Domain)) {
        IntPtr b;
        int rc = N.NetUserGetInfo(null, s.User, 10, out b);
        if (rc == 0 && b != IntPtr.Zero) {
          try {
            IntPtr p = Marshal.ReadIntPtr(b, 3 * IntPtr.Size);   // USER_INFO_10.usri10_full_name
            string f = p == IntPtr.Zero ? null : Marshal.PtrToStringUni(p);
            if (!string.IsNullOrEmpty(f) && f.Trim().Length > 0) return f.Trim();
            why = "the account has no full name set";
          } finally { N.NetApiBufferFree(b); }
        } else {
          if (b != IntPtr.Zero) N.NetApiBufferFree(b);
          why = "Windows did not give the account's details (error " + rc + ")";
        }
      } else if (!self) {
        why = "a domain or Azure AD account's full name is only readable for this session's own user";
      }
      if (self) {
        var sb = new StringBuilder(256);
        int size = sb.Capacity;
        if (N.GetUserNameExW(3, sb, ref size) && sb.Length > 0) { why = null; return sb.ToString(); }   // NameDisplay
        if (why == null) why = "Windows did not give this account's display name (error " + Marshal.GetLastWin32Error() + ")";
      }
      return null;
    }

    static string List(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      IntPtr info; int count;
      if (!N.WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, out info, out count))
        return "Windows did not list the sessions (error " + Marshal.GetLastWin32Error() + ")";
      var ids = new List<int>();
      try {
        int stride = Marshal.SizeOf(typeof(WTS_SESSION_INFOW));
        for (int i = 0; i < count; i++) {
          var si = (WTS_SESSION_INFOW)Marshal.PtrToStructure(new IntPtr(info.ToInt64() + (long)i * stride), typeof(WTS_SESSION_INFOW));
          ids.Add(si.SessionId);
        }
      } finally { N.WTSFreeMemory(info); }
      int own = OwnSession();
      var rows = new List<object>();
      var whys = new List<string>();
      foreach (int id in ids) {
        Sess s = Read(id);
        if (s == null) continue;
        bool self = id == own;
        string why;
        string full = FullName(s, self, out why);
        if (full == null && why != null && !whys.Contains(why)) whys.Add(why);
        var d = new Dictionary<string, object>();
        d["session"] = id; d["user"] = s.User; d["domain"] = s.Domain; d["fullName"] = full;
        d["status"] = s.StateCode == WTSDisconnected ? "Disconnected" : null;   // Windows shows nothing for active
        d["state"] = s.State;
        d["logon"] = s.Logon > 0 ? (object)s.Logon.ToString(CultureInfo.InvariantCulture) : null;
        d["self"] = self;
        rows.Add(d);
      }
      var r = new Dictionary<string, object>();
      r["rows"] = rows;
      if (whys.Count > 0) r["why"] = Json.Obj("fullName", string.Join("; ", whys.ToArray()));
      r["ms"] = (int)sw.ElapsedMilliseconds;
      result = r;
      return null;
    }

    // ------------------------------------------------------------------ ops

    static Dictionary<string, object> Answer(bool ok, string op, int session, string user, bool dry, string reason, string state) {
      var d = new Dictionary<string, object>();
      d["ok"] = ok; d["op"] = op; d["session"] = session; d["user"] = user; d["dryRun"] = dry; d["reason"] = reason; d["state"] = state;
      return d;
    }

    static string Disconnect(Dictionary<string, object> req, ref object result) { return Run(req, "disconnect", ref result); }
    static string SignOff(Dictionary<string, object> req, ref object result) { return Run(req, "signoff", ref result); }
    static string UserOp(Dictionary<string, object> req, ref object result) { return Run(req, Json.GetString(req, "op"), ref result); }

    /// null when `s` is still the session the caller saw; else the refusal words.
    static string Changed(Sess s, int session, string user, string logon) {
      if (s == null) return "nobody is signed in to session " + session + " any more";
      if (!string.Equals(s.User, user, StringComparison.OrdinalIgnoreCase))
        return "refused: session " + session + " now belongs to a different user (Windows reused the number)";
      if (!string.IsNullOrEmpty(logon) && s.Logon > 0 && logon != s.Logon.ToString(CultureInfo.InvariantCulture))
        return "refused: session " + session + " was signed in again since the list was read";
      return null;
    }

    static string Run(Dictionary<string, object> req, string op, ref object result) {
      if (op != "disconnect" && op != "connect" && op != "signoff") return "op must be disconnect, connect or signoff";
      int session = Json.GetInt(req, "session", -1);
      if (session < 1) return "needs session (a session number from taskmgr.users; session 0 has no user)";
      string user = Json.GetString(req, "user"), logon = Json.GetString(req, "logon");
      if (string.IsNullOrEmpty(user)) return "needs user (the session's user from taskmgr.users, so a reused session number is never acted on)";
      if (user.Length > 256) return "a user name is at most 256 characters";
      bool dry = Json.GetBool(req, "dryRun", false), confirmed = Json.GetBool(req, "confirmed", false);

      Sess s = Read(session);
      string changed = Changed(s, session, user, logon);
      if (changed != null) { result = Answer(false, op, session, user, dry, changed, s == null ? null : s.State); return null; }
      int own = OwnSession();
      bool self = session == own;

      // 1. Windows' own confirm, before anything else (dry runs and passive sidecars included).
      if (!confirmed && (op == "disconnect" || op == "signoff")) {
        var c = Answer(false, op, session, s.User, dry, "needs confirmation", s.State);
        c["needsConfirm"] = true;
        if (op == "signoff") {
          c["title"] = "Sign out user";
          c["text"] = "Do you want to sign out " + s.User + "? Any unsaved data for the user may be lost.";
          c["button"] = "Sign out user";
        } else {
          c["title"] = "Disconnect user";
          c["text"] = "Do you want to disconnect " + s.User + "?";
          c["button"] = "Disconnect user";
        }
        result = c; return null;
      }

      // 2. What the state already decides (same answer dry or real).
      if (op == "connect") {
        if (self) { result = Answer(false, op, session, s.User, dry, "that is already your session", s.State); return null; }
        string mine = own >= 0 ? QueryString(own, WTSUserName) : null, myDomain = own >= 0 ? QueryString(own, WTSDomainName) : null;
        bool sameUser = mine != null && string.Equals(mine, s.User, StringComparison.OrdinalIgnoreCase) && string.Equals(myDomain ?? "", s.Domain ?? "", StringComparison.OrdinalIgnoreCase);
        if (!sameUser) {
          result = Answer(false, op, session, s.User, dry, "connecting to " + s.User + "'s session needs their password: use Switch user on Start or the sign-in screen", s.State);
          return null;
        }
        if (s.StateCode != WTSDisconnected) { result = Answer(false, op, session, s.User, dry, "that session is not disconnected", s.State); return null; }
      }
      if (op == "disconnect" && s.StateCode == WTSDisconnected) { result = Answer(false, op, session, s.User, dry, "it is already disconnected", s.State); return null; }

      // 3. Dry run: what would happen, nothing touched.
      if (dry) {
        if (!self && op != "connect" && !Elevated()) {
          var na = Answer(false, op, session, s.User, true, NEEDS_ADMIN_OTHER, s.State);
          na["needsAdmin"] = true;
          result = na; return null;
        }
        string what = op == "signoff" ? "sign out " + s.User + " (their apps close)" : op == "disconnect" ? "disconnect " + s.User + " (their apps keep running)" : "connect this screen to session " + session;
        result = Answer(true, op, session, s.User, true, "dry run: would " + what, s.State);
        return null;
      }

      // 4. A passive (test) sidecar never acts.
      if (HostPassive()) return HostPassiveRefusal();

      // 5. Real: verify the session's user once more right before the call.
      s = Read(session);
      changed = Changed(s, session, user, logon);
      if (changed != null) { result = Answer(false, op, session, user, false, changed, s == null ? null : s.State); return null; }
      bool ok;
      if (op == "signoff") ok = N.WTSLogoffSession(IntPtr.Zero, session, false);
      else if (op == "disconnect") ok = N.WTSDisconnectSession(IntPtr.Zero, session, false);
      else ok = N.WTSConnectSessionW(session, own, "", false);
      if (ok) {
        HostLog("info", "taskmgr.userop: " + op + " session " + session + " done");
        result = Answer(true, op, session, s.User, false, null, s.State);
        return null;
      }
      int e = Marshal.GetLastWin32Error();
      HostLog("warn", "taskmgr.userop: " + op + " session " + session + " failed (error " + e + ")");
      var f = Answer(false, op, session, s.User, false, e == 5 ? (self ? "Windows refused (access denied)" : NEEDS_ADMIN_OTHER)
        : e == 1326 || e == 1385 ? "Windows needs that user's password to connect to their session"
        : "Windows answered error " + e, s.State);
      if (e == 5) f["needsAdmin"] = true;
      result = f;
      return null;
    }
  }
}
