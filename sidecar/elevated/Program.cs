// Program.cs - the entry point of mantle.elevated.exe (lane tm-elevate, 2026-10-28).
//
// This is Mantle's "Always admin, no prompt" Task Manager helper. It is installed ONCE behind a
// single UAC prompt (tools/mantle-elevated-setup.ps1 registers a scheduled task, RunLevel Highest,
// on-demand, no triggers, interactive token). After that the non-elevated Mantle sidecar reaches
// admin-only Task Manager work by running that task and talking to THIS process over a named pipe.
// No more prompts until the helper version changes. Owen was told, and accepted, that any program
// running as him can also start this helper; the pipe auth, the allowlist and the per-op
// pid+creation-time checks in the handlers are what cap that (see the security notes below).
//
// WHAT IT IS NOT: not a generic exec, not a shell, not the Settings elevation broker. It runs ONLY
// the closed allowlist in Host.cs (Task Manager admin ops). "Run new task with administrative
// privileges" never comes here: that stays on the runas verb (its own UAC prompt).
//
// SECURITY MODEL (what a program running as Owen could and could not do):
//   - It can START this helper (run the task) and connect, IF it is a Mantle sidecar/Electron image
//     under the live or dev tree, in the same session, holding the one-shot handshake token the real
//     client wrote. The pipe's DACL is this user's SID only; its mandatory label is Medium so the
//     non-elevated client can talk to it but a lower-integrity process cannot.
//   - Even connected, it can only ask for an allowlisted Task Manager op, and every destructive op
//     verifies pid + creation time itself (never a PPID walk or taskkill /T; see
//     feedback_guard-pid-reuse-killed-everything) and honors dryRun. It cannot run an arbitrary
//     command, launch a program, or name a path to execute.
//   - It cannot keep the helper alive: one client, exits on disconnect or after 2 min idle.
//   - It CANNOT be made more trustworthy than its binary: the exe lives in an admin-only-writable
//     folder (Program Files) so user-level code cannot swap the binary that runs elevated. That is
//     the one real gain over the Settings broker, whose exe is user-writable.
//
// C# 5 only (build.ps1): no string interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace Mantle {
  static class Program {
    // Bumped whenever the helper's behavior or contract changes. The setup writes it next to the
    // installed exe; the client compares to tell "stale" and re-prompt. Source of truth is the file
    // sidecar/elevated/VERSION; keep this in sync (build.ps1 checks they match).
    public const string Version = "2";   // 2 (tm-data 10-28): the main sidecar envelope + the integrated Task Manager handlers

    public const string PipeName = "Mantle.Elevated";   // \\.\pipe\Mantle.Elevated (DACL = this user)

    // Integration surface the handler files lean on (TaskMgr.cs, tm-data's ProcOps/Services/...).
    public static int OwnPid;
    public static int ParentPid;
    public static bool Passive;        // true in the un-elevated test seam: integrated writes refuse
    public static bool IsElevated;

    static TextWriter _log;
    static Stream _pipe;               // the live client stream, for Emit (if an integrated handler pushes)
    static string _dirOverride;        // MANTLE_ELEVATED_DIR: test seam only, moves the handshake/log dir

    static int Main(string[] args) {
      OwnPid = GetCurrentPid();
      IsElevated = ComputeElevated();
      // The test seam is honored ONLY when NOT elevated, exactly like the Settings broker. A real
      // runas/scheduled-task launch is elevated and ignores it; it cannot relax the real helper.
      bool testEnv = Environment.GetEnvironmentVariable("MANTLE_ELEVATED_TEST") == "1";
      bool testMode = testEnv && !IsElevated;
      Passive = testMode;              // an integrated write refuses in the test seam
      // The handshake/log folder moves ONLY in the test seam, so a test does not touch the real one.
      if (testMode) {
        string d = Environment.GetEnvironmentVariable("MANTLE_ELEVATED_DIR");
        if (!string.IsNullOrEmpty(d)) _dirOverride = d;
      }

      bool pipe = false, printVersion = false;
      foreach (string a in args) {
        if (a == "--pipe") pipe = true;
        else if (a == "--version") printVersion = true;
        else if (a.StartsWith("--parent-pid=", StringComparison.Ordinal)) {
          int pp; if (int.TryParse(a.Substring("--parent-pid=".Length), NumberStyles.Integer, CultureInfo.InvariantCulture, out pp)) ParentPid = pp;
        }
      }

      if (printVersion) { Console.Out.WriteLine(Version); return 0; }

      OpenLog(testMode);
      Log("start", "pid " + OwnPid + " elevated=" + IsElevated + " test=" + testMode + " version=" + Version);

      if (!pipe) {
        Log("usage", "no --pipe; nothing to do");
        Console.Error.WriteLine("mantle.elevated.exe --pipe   (run via the Mantle Elevated Helper scheduled task)");
        return 2;
      }

      try { return RunPipeServer(testMode); }
      catch (Exception ex) { Log("fatal", ex.GetType().Name + ": " + ex.Message); return 1; }
      finally { try { NetTrace.Shutdown(); } catch { } }
    }

    // ------------------------------------------------------------------ the pipe server

    const int FirstConnectMs = 30000;  // if no client connects after launch, give up and exit
    const int IdleMs = 120000;         // 2 minutes with no request -> exit
    const int HelloMs = 5000;          // the handshake line must arrive this fast

    static int RunPipeServer(bool testMode) {
      PipeSecurity sec = BuildPipeSecurity();
      NamedPipeServerStream server = new NamedPipeServerStream(
        PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous, 4096, 4096, sec);
      try {
        SetMediumLabel(server.SafePipeHandle);   // let the non-elevated (medium) client talk to us
      } catch (Exception ex) { Log("label", "could not set the pipe's medium label: " + ex.Message); }

      // Wait for the single client, bounded, so a launch nobody connects to does not linger.
      IAsyncResult ar = server.BeginWaitForConnection(null, null);
      if (!ar.AsyncWaitHandle.WaitOne(FirstConnectMs)) {
        Log("idle", "no client connected within " + FirstConnectMs + " ms; exiting");
        try { server.Close(); } catch { }
        return 0;
      }
      server.EndWaitForConnection(ar);
      _pipe = server;

      string why = Authenticate(server, testMode);
      if (why != null) {
        Log("auth", "refused: " + why);
        TryWriteLine(server, Json.Write(Json.Obj("id", (object)null, "ok", false, "error", "the elevated helper refused this client", "reason", why)));
        try { server.Close(); } catch { }
        return 0;
      }
      Log("auth", "client accepted");

      Serve(server, testMode);
      Log("done", "client disconnected; exiting");
      return 0;
    }

    // The DACL: this user's SID, FullControl, and nothing else (no Everyone, no Authenticated Users).
    static PipeSecurity BuildPipeSecurity() {
      PipeSecurity ps = new PipeSecurity();
      SecurityIdentifier me = WindowsIdentity.GetCurrent().User;
      ps.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
      ps.SetOwner(me);
      return ps;
    }

    // Read one line, verify the connecting process, match the one-shot handshake token.
    static string Authenticate(NamedPipeServerStream server, bool testMode) {
      // 1. same session.
      uint clientPid;
      if (!GetNamedPipeClientProcessId(server.SafePipeHandle.DangerousGetHandle(), out clientPid))
        return "the helper could not identify the connecting process";
      int clientSession, ownSession;
      if (!ProcessIdToSessionId((uint)OwnPid, out ownSession)) ownSession = -1;
      if (!ProcessIdToSessionId(clientPid, out clientSession)) clientSession = -2;
      if (clientSession != ownSession)
        return "the connecting process is in a different session";

      // 2. image path allowlist (bypassed in the test seam, but the pure check is unit-tested).
      string image = ImagePathOf(clientPid);
      if (!testMode) {
        string bad = CheckClientImage(image, AllowedClientRoots());
        if (bad != null) return bad;
      } else {
        Log("auth", "test seam: skipping client-image check for " + (image == null ? "<unknown>" : Path.GetFileName(image)));
      }

      // 3. handshake token: the real client wrote {pid, token} to a user-only file before it ran us.
      string wantToken; int wantPid;
      string hs = ReadHandshake(out wantToken, out wantPid);
      if (hs != null) return hs;
      if (wantPid != 0 && wantPid != (int)clientPid)
        return "the handshake names a different process than the one that connected";
      string hello = ReadLine(server, HelloMs);
      if (hello == null) return "the client sent no handshake line in time";
      string got = null;
      try {
        object o = Json.Parse(hello);
        Dictionary<string, object> d = o as Dictionary<string, object>;
        if (d != null) got = Json.GetString(d, "hello");
      } catch { }
      if (string.IsNullOrEmpty(got)) return "the client's first line was not a handshake";
      if (!TokenEquals(got, wantToken)) return "the handshake token did not match";
      return null;
    }

    static void Serve(NamedPipeServerStream server, bool testMode) {
      while (server.IsConnected) {
        string line = ReadLine(server, IdleMs);
        if (line == null) {               // EOF or 2-minute idle
          Log("idle", "no request; closing");
          break;
        }
        object id = null; string cmd = null;
        Dictionary<string, object> req = null;
        try {
          object o = Json.Parse(line);
          req = o as Dictionary<string, object>;
          if (req != null) { req.TryGetValue("id", out id); cmd = Json.GetString(req, "cmd"); }
        } catch { }
        if (req == null || cmd == null) {
          TryWriteLine(server, Json.Write(Json.Obj("id", id, "ok", false, "error", "bad request", "reason", "the request was not a JSON object with a cmd")));
          continue;
        }
        Log("cmd", cmd + (ElevatedHost.Allowed(cmd) ? "" : " (not allowed)"));
        object body;
        if (testMode && cmd.StartsWith("test.", StringComparison.Ordinal)) body = TestDispatch(cmd, req);
        else body = ElevatedHost.Dispatch(cmd, req);
        TryWriteLine(server, Json.Write(WithId(id, body)));
      }
    }

    // test.* commands exist ONLY in the un-elevated test seam, never on the production allowlist, so a
    // real (elevated) helper has no idea they exist. They let the un-elevated test exercise the real
    // production decisions (the client-image allowlist) through the real binary.
    static object TestDispatch(string cmd, Dictionary<string, object> req) {
      if (cmd == "test.echo") return Json.Obj("ok", true, "echo", Json.GetString(req, "text"));
      if (cmd == "test.checkimage") {
        object rawRoots;
        List<string> roots = new List<string>();
        if (Json.TryGet(req, "roots", out rawRoots)) {
          List<object> rl = rawRoots as List<object>;
          if (rl != null) foreach (object o in rl) { string s = o as string; if (s != null) roots.Add(s); }
        }
        string verdict = CheckClientImage(Json.GetString(req, "path"), roots.ToArray());
        return Json.Obj("ok", verdict == null, "verdict", (object)verdict);
      }
      return Json.Obj("ok", false, "reason", "unknown test command");
    }

    // Put id first, then the handler's flat {ok, ...} fields. The client strips id and returns the rest.
    static IDictionary WithId(object id, object body) {
      IDictionary src = body as IDictionary;
      IDictionary outd = (IDictionary)Json.Obj("id", id);
      if (src != null) foreach (object k in src.Keys) { if (!"id".Equals(k)) outd[k] = src[k]; }
      else outd["ok"] = false;
      return outd;
    }

    // Integration hook: an elevated handler that wants to push an event uses Program.Emit, like the
    // main sidecar. Here it writes a JSON line to the live client, if any.
    public static void Emit(object obj) { Stream p = _pipe; if (p != null) TryWriteLine(p, Json.Write(obj)); }
    public static void EmitLog(string level, string msg) { Log(level, msg); }

    // ------------------------------------------------------------------ client image allowlist (pure, tested)

    // Returns null if `image` is an allowed Mantle client, else a plain-words reason. Allowed:
    // electron.exe or Mantle.Sidecar.exe, living under one of `roots` (the live tree, the dev tree,
    // or a worktree). Pure so the un-elevated test can cover the real decision with synthetic paths.
    public static string CheckClientImage(string image, string[] roots) {
      if (string.IsNullOrEmpty(image)) return "the helper could not read the connecting process's image path";
      string full;
      try { full = Path.GetFullPath(image); } catch { return "the connecting process's image path is malformed"; }
      string lower = full.Replace('/', '\\').ToLowerInvariant();
      string leaf = Path.GetFileName(lower);
      if (leaf != "electron.exe" && leaf != "mantle.sidecar.exe")
        return "the connecting process is not a Mantle sidecar or Electron (" + leaf + ")";
      if (roots != null) {
        foreach (string r in roots) {
          if (string.IsNullOrEmpty(r)) continue;
          string root = r.Replace('/', '\\').ToLowerInvariant().TrimEnd('\\') + "\\";
          if (lower.StartsWith(root, StringComparison.Ordinal)) return null;
        }
      }
      return "the connecting process is not under a known Mantle folder";
    }

    static string[] AllowedClientRoots() {
      string prof = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      return new string[] {
        Path.Combine(prof, "mantle-live"),
        Path.Combine(prof, "mantle"),
        Path.Combine(prof, "mantle-wt")
      };
    }

    // Constant-time-ish compare so a near-miss token does not leak length/prefix by timing.
    static bool TokenEquals(string a, string b) {
      if (a == null || b == null) return false;
      if (a.Length != b.Length) return false;
      int diff = 0;
      for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
      return diff == 0;
    }

    // ------------------------------------------------------------------ handshake file

    static string HandshakeDir() {
      if (!string.IsNullOrEmpty(_dirOverride)) return _dirOverride;
      string b = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
      return Path.Combine(Path.Combine(b, "Mantle"), "elevated");
    }

    // Reads {pid, token} from handshake.json in the user's LocalAppData, then DELETES it (single use).
    // Returns null on success (token+pid out), else a plain-words reason. Link-aware: refuses a
    // reparse point. The file is user-ACL'd by the client that wrote it.
    static string ReadHandshake(out string token, out int pid) {
      token = null; pid = 0;
      string path = Path.Combine(HandshakeDir(), "handshake.json");
      try {
        if (!File.Exists(path)) return "no handshake file was written for this helper run";
        FileInfo fi = new FileInfo(path);
        if ((fi.Attributes & FileAttributes.ReparsePoint) != 0) return "the handshake file is a link";
        if (fi.Length > 4096) return "the handshake file is too large";
        string text;
        using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (StreamReader sr = new StreamReader(fs, Encoding.UTF8)) { text = sr.ReadToEnd(); }
        try { File.Delete(path); } catch { }
        object o = Json.Parse(text);
        Dictionary<string, object> d = o as Dictionary<string, object>;
        if (d == null) return "the handshake file was not JSON";
        token = Json.GetString(d, "token");
        pid = Json.GetInt(d, "pid", 0);
        if (string.IsNullOrEmpty(token)) return "the handshake file had no token";
        return null;
      } catch (Exception ex) { return "the handshake file could not be read (" + ex.GetType().Name + ")"; }
    }

    // ------------------------------------------------------------------ line IO over the pipe

    static readonly object _writeGate = new object();

    static void TryWriteLine(Stream s, string line) {
      try {
        byte[] b = Encoding.UTF8.GetBytes(line + "\n");
        lock (_writeGate) { s.Write(b, 0, b.Length); s.Flush(); }
      } catch (Exception ex) { Log("write", "could not write to the client: " + ex.Message); }
    }

    // Read one UTF-8 line (up to '\n'), or null on EOF / timeout. A dedicated read with a bounded
    // wait gives us the idle timeout without a watchdog thread. Caps a line at 1 MB.
    static string ReadLine(Stream s, int timeoutMs) {
      MemoryStream buf = new MemoryStream();
      byte[] one = new byte[1];
      DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
      while (true) {
        int remain = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
        if (remain <= 0) return null;
        IAsyncResult ar = s.BeginRead(one, 0, 1, null, null);
        if (!ar.AsyncWaitHandle.WaitOne(remain)) return null;    // idle timeout
        int n;
        try { n = s.EndRead(ar); } catch { return null; }
        if (n <= 0) return buf.Length > 0 ? Encoding.UTF8.GetString(buf.ToArray()) : null;  // EOF
        if (one[0] == (byte)'\n') return Encoding.UTF8.GetString(buf.ToArray());
        if (one[0] != (byte)'\r') { buf.WriteByte(one[0]); if (buf.Length > 1024 * 1024) return null; }
      }
    }

    // ------------------------------------------------------------------ log (names/args never logged)

    static void OpenLog(bool testMode) {
      try {
        string dir = testMode ? HandshakeDir() : HandshakeDir();
        Directory.CreateDirectory(dir);
        _log = new StreamWriter(new FileStream(Path.Combine(dir, "helper.log"),
          FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
        ((StreamWriter)_log).AutoFlush = true;
      } catch { _log = null; }
    }

    // Only command names, kinds and outcomes - never a process name, path, title or argument.
    static void Log(string kind, string msg) {
      try {
        if (_log != null) _log.WriteLine(DateTime.UtcNow.ToString("o") + " [" + kind + "] " + msg);
      } catch { }
      try { Console.Error.WriteLine("[" + kind + "] " + msg); } catch { }
    }

    // ------------------------------------------------------------------ elevation + medium label

    static bool ComputeElevated() {
      IntPtr tok;
      if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /*TOKEN_QUERY*/, out tok)) return false;
      try {
        uint size;
        int elev = 0;
        GCHandle gh = GCHandle.Alloc(elev, GCHandleType.Pinned);
        try {
          if (GetTokenInformation(tok, 20 /*TokenElevation*/, gh.AddrOfPinnedObject(), 4, out size))
            elev = (int)Marshal.ReadInt32(gh.AddrOfPinnedObject());
        } finally { gh.Free(); }
        return elev != 0;
      } finally { CloseHandle(tok); }
    }

    // Give the pipe object a Medium integrity label with no-write-up, so the non-elevated (medium)
    // client can open and write to this high-integrity helper's pipe. Without it, a medium process
    // is blocked from writing "up" to a high-IL object. Built from the SDDL SACL "S:(ML;;NW;;;ME)".
    static void SetMediumLabel(Microsoft.Win32.SafeHandles.SafePipeHandle handle) {
      IntPtr sd = IntPtr.Zero;
      try {
        uint sdSize;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NW;;;ME)", 1 /*SDDL_REVISION_1*/, out sd, out sdSize))
          throw new InvalidOperationException("SDDL parse failed (" + Marshal.GetLastWin32Error() + ")");
        IntPtr sacl; bool present, defaulted;
        if (!GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted) || !present)
          throw new InvalidOperationException("no SACL in the label descriptor");
        uint rc = SetSecurityInfo(handle.DangerousGetHandle(), 6 /*SE_KERNEL_OBJECT*/,
          0x10 /*LABEL_SECURITY_INFORMATION*/, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        if (rc != 0) throw new InvalidOperationException("SetSecurityInfo returned " + rc);
      } finally { if (sd != IntPtr.Zero) LocalFree(sd); }
    }

    static string ImagePathOf(uint pid) {
      IntPtr h = OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, pid);
      if (h == IntPtr.Zero) return null;
      try {
        StringBuilder sb = new StringBuilder(1024);
        int cap = sb.Capacity;
        if (QueryFullProcessImageNameW(h, 0, sb, ref cap)) return sb.ToString();
        return null;
      } finally { CloseHandle(h); }
    }

    static int GetCurrentPid() { return GetCurrentProcessId(); }

    // ------------------------------------------------------------------ P/Invoke
    [DllImport("kernel32.dll", SetLastError = true)] static extern int GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ProcessIdToSessionId(uint pid, out int session);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint len, out uint ret);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint rev, out IntPtr sd, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint secInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LocalFree(IntPtr p);
  }
}
