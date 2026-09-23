// Session.cs - `session`: the launcher's Sleep, plus the read-only facts behind it.
//
// WHY SLEEP IS THE ONLY POWER ACTION IN THE SIDECAR. Lock, Restart, Shut down, Sign out and
// Hibernate each have a Windows exe that does exactly that one thing (rundll32 LockWorkStation,
// shutdown /r /s /l /h), so main runs those itself and they work even while the sidecar is down.
// Sleep has no such exe. The folk remedy, `rundll32 powrprof.dll,SetSuspendState 0,1,0`, is a
// trap: rundll32 calls its target as (HWND, HINSTANCE, LPSTR, int), so SetSuspendState's first
// argument - bHibernate - receives rundll32's window handle, which is non-zero, and the machine
// HIBERNATES whenever hibernation is enabled. It is enabled on Owen's machine (powercfg /a,
// 2026-09-22). So Sleep is a real P/Invoke with bHibernate = FALSE, and that needs code.
//
// ACTIONS
//   {action:"caps"}                 read-only: GetPwrCapabilities, as named booleans
//   {action:"sleep", dryRun:true}   everything except the call: reads the capabilities, enables
//                                   SeShutdownPrivilege on THIS process's own token (which by itself
//                                   changes nothing on the machine) and answers what it would call
//   {action:"sleep"}                the same, then SetSuspendState(FALSE, FALSE, FALSE) on its own
//                                   thread after `delayMs` (default 400)
//
// WHY THE REPLY COMES BEFORE THE SLEEP. SetSuspendState is synchronous: it returns after the
// machine WAKES. Replying afterwards would leave the launcher on screen through the whole sleep
// and hand main an answer to a request it timed out on hours ago. So every check that can fail
// runs first and fails in the reply; then the reply goes out, main hides the launcher, and the
// call is made delayMs later. A failure of the call itself (rare once the checks passed) cannot
// reach the launcher any more, so it is emitted as an `ev:"session"` event and a log line.
//
// MODERN STANDBY. Owen's machine has no S3: its only standby is S0 low power idle (powercfg /a,
// 2026-09-22). SetSuspendState(FALSE) is the documented sleep request and is what the power
// button's "sleep" action maps to, but whether it enters Modern Standby or falls through to
// hibernate on an S0 machine has NOT been observed here - by rule, no power action has ever been
// run on this machine to find out. `caps` reports aoac so the answer is at least visible.
//
// --passive refuses a real sleep (a test sidecar must never suspend the box it runs on); caps and
// dry runs are allowed, because neither changes anything.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  static class Session {
    public const int DefaultDelayMs = 400;
    public const string SleepCall = "SetSuspendState(FALSE, FALSE, FALSE)";

    [DllImport("powrprof.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    static extern bool SetSuspendState([MarshalAs(UnmanagedType.U1)] bool hibernate,
                                       [MarshalAs(UnmanagedType.U1)] bool forceCritical,
                                       [MarshalAs(UnmanagedType.U1)] bool disableWakeEvent);

    // SYSTEM_POWER_CAPABILITIES is 76 bytes of BOOLEANs, bytes and a few ULONGs. Read from a raw
    // buffer by offset rather than declared as a struct: the header's own layout changed across
    // SDKs (spare2/spare3 became Hiberboot, AoAc, HiberFileType), and offsets are what did not.
    [DllImport("powrprof.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    static extern bool GetPwrCapabilities(IntPtr caps);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValue(string system, string name, out long luid);

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct TOKEN_PRIVILEGES_1 {
      public uint Count;
      public long Luid;
      public uint Attributes;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES_1 state,
                                             uint len, IntPtr prev, IntPtr prevLen);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    const uint TOKEN_ADJUST_PRIVILEGES = 0x20, TOKEN_QUERY = 0x8, SE_PRIVILEGE_ENABLED = 0x2;
    const int ERROR_NOT_ALL_ASSIGNED = 1300;

    /// Returns null with `result` filled, or a plain-words error for a malformed request.
    public static string Run(Dictionary<string, object> req, bool passive, out IDictionary result) {
      result = null;
      string action = Json.GetString(req, "action");
      if (action == "caps") {
        result = Caps();
        return null;
      }
      if (action != "sleep") return "session: action must be caps or sleep (got \"" + (action ?? "") + "\")";

      bool dry = Json.GetBool(req, "dryRun", false);
      int delay = Json.GetInt(req, "delayMs", DefaultDelayMs);
      if (delay < 0 || delay > 5000) return "session: delayMs must be 0..5000";

      IDictionary caps = Caps();
      if (!Equals(caps["ok"], true)) {
        result = Json.Obj("ok", false, "action", action, "reason", caps["reason"]);
        return null;
      }
      if (!Equals(caps["canSleep"], true)) {
        result = Json.Obj("ok", false, "action", action,
                          "reason", "this machine reports no sleep state at all (no S1-S3 and no Modern Standby), so Windows cannot sleep it");
        return null;
      }
      string mode = Equals(caps["aoac"], true) ? "Modern Standby (S0 low power idle)" : "S3 standby";

      if (passive && !dry) {
        result = Json.Obj("ok", false, "action", action,
                          "reason", "refused: sidecar is passive (test mode), and a test sidecar never suspends the machine it runs on");
        return null;
      }

      // Enabling a privilege this account already HOLDS only flips a bit on our own token. It is
      // done in the dry run too, because "the privilege is not held" is one of the ways a real
      // sleep would fail, and the dry run is the only place that failure can be seen in advance.
      string perr = EnableShutdownPrivilege();
      if (perr != null) {
        result = Json.Obj("ok", false, "action", action, "reason", perr);
        return null;
      }

      if (dry) {
        Program.EmitLog("info", "session dry run: would call " + SleepCall + " after " + delay + " ms (" + mode + ")");
        result = Json.Obj("ok", true, "action", action, "dryRun", true, "wouldCall", SleepCall,
                          "afterMs", delay, "mode", mode, "privilege", "SeShutdownPrivilege enabled on the sidecar's own token",
                          "reason", null);
        return null;
      }

      var t = new Thread(delegate () {
        Thread.Sleep(delay);
        bool ok = SetSuspendState(false, false, false);
        if (!ok) {
          int e = Marshal.GetLastWin32Error();
          string why = "sleep failed: " + SleepCall + " returned FALSE (Win32 error " + e + ": " + new Win32Exception(e).Message + ")";
          Program.EmitLog("error", why);
          Program.Emit(Json.Obj("ev", "session", "action", "sleep", "ok", false, "reason", why));
        }
      });
      t.IsBackground = true;
      t.Name = "mantle-session-sleep";
      t.Start();
      result = Json.Obj("ok", true, "action", action, "dryRun", false, "call", SleepCall,
                        "afterMs", delay, "mode", mode, "reason", null);
      return null;
    }

    /// Read-only. What the power manager says this machine can do.
    public static IDictionary Caps() {
      IntPtr buf = Marshal.AllocHGlobal(128);
      try {
        for (int i = 0; i < 128; i++) Marshal.WriteByte(buf, i, 0);
        if (!GetPwrCapabilities(buf)) {
          int e = Marshal.GetLastWin32Error();
          return Json.Obj("ok", false, "reason", "Windows would not report the power capabilities (GetPwrCapabilities, Win32 error " + e + ")");
        }
        bool s1 = B(buf, 3), s2 = B(buf, 4), s3 = B(buf, 5), s4 = B(buf, 6), s5 = B(buf, 7);
        bool hiberFile = B(buf, 8), aoac = B(buf, 20);
        int hiberType = Marshal.ReadByte(buf, 22);       // 0 unknown, 1 reduced, 2 full
        bool canSleep = s1 || s2 || s3 || aoac;
        // A REDUCED hiberfile exists only for Fast Startup and cannot hold a full hibernate.
        bool canHibernate = s4 && hiberFile && hiberType != 1;
        return Json.Obj("ok", true, "s1", s1, "s2", s2, "s3", s3, "s4", s4, "s5", s5,
                        "aoac", aoac, "hiberFilePresent", hiberFile,
                        "hiberFileType", hiberType == 1 ? "reduced" : hiberType == 2 ? "full" : (object)hiberType,
                        "hiberboot", B(buf, 18), "lid", B(buf, 2), "batteries", B(buf, 30),
                        "canSleep", canSleep, "canHibernate", canHibernate,
                        "sleepMode", aoac ? "Modern Standby (S0 low power idle)" : s3 ? "S3" : s2 ? "S2" : s1 ? "S1" : null,
                        "reason", null);
      } finally {
        Marshal.FreeHGlobal(buf);
      }
    }

    static bool B(IntPtr buf, int offset) {
      return Marshal.ReadByte(buf, offset) != 0;
    }

    static string EnableShutdownPrivilege() {
      IntPtr token;
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token)) {
        int e = Marshal.GetLastWin32Error();
        return "could not open the sidecar's own token to enable SeShutdownPrivilege (Win32 error " + e + ")";
      }
      try {
        long luid;
        if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out luid)) {
          int e = Marshal.GetLastWin32Error();
          return "Windows does not know SeShutdownPrivilege (Win32 error " + e + ")";
        }
        var tp = new TOKEN_PRIVILEGES_1();
        tp.Count = 1;
        tp.Luid = luid;
        tp.Attributes = SE_PRIVILEGE_ENABLED;
        bool ok = AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
        int err = Marshal.GetLastWin32Error();
        if (!ok) return "could not enable SeShutdownPrivilege (Win32 error " + err + ")";
        // AdjustTokenPrivileges "succeeds" without granting anything the account does not hold;
        // only GetLastError tells the two apart.
        if (err == ERROR_NOT_ALL_ASSIGNED)
          return "this account does not hold SeShutdownPrivilege, so Windows will not let it sleep the machine";
        return null;
      } finally {
        CloseHandle(token);
      }
    }
  }
}
