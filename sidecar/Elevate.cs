// Elevate.cs - the ONE way Mantle asks Windows for administrator rights (lane elevate, 2026-09-28).
//
// WHY: Mantle Settings replaces Windows Settings, and some settings need an administrator,
// exactly as they do in Windows' own Settings: rename the PC, switch an adapter, DNS servers,
// Remote Desktop, developer mode, pausing Windows Update. Mantle runs NOT elevated and must stay
// that way, so each of those goes through a UAC prompt Owen approves - one action per prompt,
// like Windows' own shield buttons. How a category lane adds one, and the security rules this
// file keeps: sidecar/ELEVATE.md.
//
//   this sidecar (not elevated)                  a second copy of this exe, elevated
//   elevate.run {action, args}
//     whitelist + validator: refuse early
//     <nonce>.req.json, this user only
//     ShellExecuteEx "runas" --elevated <path> --> UAC --> RunElevated: refuses a missing,
//     answers AT ONCE with a ticket                    stale, foreign-writable or reused
//     (a thread waits for the exit)                     request, re-validates, runs exactly
//                                                       ONE [Elevated] method, writes
//     reads <nonce>.res.json  <----------------------   <nonce>.res.json next to it, exits
//     pushes {"ev":"elevate", ticket, ok, result | reason, kind}
//
// WHY A TICKET and not a reply that waits: a UAC prompt waits for Owen, which can be a minute,
// and a lane blocked that long starves every other command on it (Lanes.cs). So elevate.run
// answers at once, the outcome is the `elevate` event, and `elevate.status` answers for a
// caller that missed it. lib/elevate.js hides all of this behind one awaited call.
//
// NEVER, on either side: a shell, a command line, a path or code taken from a request. The
// elevated side runs a method THIS exe registered, with arguments ITS validator accepted.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Mantle {
  /// Marks a static method as an administrator action. `name` is "area.action" (the page asks for
  /// it by that name); `validator` names a static method IN THE SAME CLASS that checks the args;
  /// `does` finishes "Windows will ask for administrator permission to ..." ("rename this PC").
  ///
  ///   [Elevated("system.renamePc", "CheckRename", "rename this PC")]
  ///   static string RenamePc(Dictionary<string, object> args, ref object result) { ... }
  ///   static string CheckRename(Dictionary<string, object> args) { ... }
  ///
  /// The action has Program.Run's contract: null with `result` filled, or plain-words failure.
  /// The validator returns null when the args are fine, else plain words saying why not. Both run
  /// in the elevated copy too, so neither may depend on state from the non-elevated side.
  [AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
  public sealed class ElevatedAttribute : Attribute {
    public readonly string Name;
    public readonly string Validator;
    public readonly string Does;
    /// Registered ONLY in test mode (Elevate.TestMode), and a "test." name must set it.
    public bool TestOnly;
    public ElevatedAttribute(string name, string validator, string does) {
      Name = name; Validator = validator; Does = does;
    }
  }

  public delegate string ElevatedAction(Dictionary<string, object> args, ref object result);
  public delegate string ElevatedValidator(Dictionary<string, object> args);

  [MantleFeature]
  public static class Elevate {
    /// The elevated step refuses a request older than this: a prompt answered later than this
    /// runs nothing. The broker's timeout is longer, so a late "yes" can never act after Mantle
    /// has told Owen it gave up.
    public const int StaleMs = 60000;
    /// How long elevate.run waits for the prompt AND the action together.
    public const int TimeoutMs = 90000;
    const int FutureSlackMs = 5000;
    const int LedgerKeepMs = 10 * 60000;   // > StaleMs: a nonce outlives every request that could use it
    const int LeftoverMs = 10 * 60000;
    const int MaxArgsChars = 16384;
    const int MaxRequestBytes = 65536;
    const int ErrorCancelled = 1223;       // ERROR_CANCELLED: "No" on the UAC prompt
    const int AfterTimeoutMs = 120000;     // how long the waiter stays for a late answer, to log it

    /// Exit codes of the --elevated step. BadPath writes no answer (there is nowhere trusted to).
    public const int ExitRan = 0, ExitRefused = 1, ExitBadPath = 2, ExitCrashed = 3;

    static readonly Regex NameRx = new Regex(@"^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$", RegexOptions.CultureInvariant);
    static readonly Regex RequestRx = new Regex(@"^[0-9a-f]{32}\.req\.json$", RegexOptions.CultureInvariant);

    sealed class Entry {
      public string Name, Does, Owner;
      public bool TestOnly;
      public ElevatedAction Run;
      public ElevatedValidator Validate;
    }

    sealed class Flight {
      public int Ticket;
      public string Action, Does, Nonce, ReqPath, ResPath;
      public int TimeoutMs;
      public long DeadlineMs;
      public int Done;             // 0 until Finish wins (Interlocked)
      public Timer Timer;          // held here so the GC keeps it
    }

    static readonly object _gate = new object();
    static Dictionary<string, Entry> _actions;
    static readonly List<string> _problems = new List<string>();
    static int _nextTicket;
    static Flight _inflight;
    static readonly Dictionary<int, IDictionary> _outcomes = new Dictionary<int, IDictionary>();
    static readonly Queue<int> _outcomeOrder = new Queue<int>();

    // ------------------------------------------------------------------ mode

    static int _elevated = -1;
    /// True in an elevated process. When unsure, true: that turns test mode OFF, never on.
    public static bool IsElevatedProcess() {
      if (_elevated < 0) {
        bool yes;
        try {
          using (WindowsIdentity me = WindowsIdentity.GetCurrent())
            yes = new WindowsPrincipal(me).IsInRole(WindowsBuiltInRole.Administrator);
        } catch (Exception) { yes = true; }
        _elevated = yes ? 1 : 0;
      }
      return _elevated == 1;
    }

    /// THE TEST SEAM. MANTLE_ELEVATE_TEST=1 in a process that is NOT elevated: test.* actions
    /// exist, MANTLE_ELEVATE_DIR moves the request folder, the elevated step refuses every real
    /// action after validating it, and a PASSIVE sidecar launches the step with ShellExecuteEx
    /// "open" instead of "runas" - no UAC prompt, ever. A real UAC launch does not inherit the
    /// caller's environment, and an elevated process ignores the variable anyway.
    public static bool TestMode {
      get { return Environment.GetEnvironmentVariable("MANTLE_ELEVATE_TEST") == "1" && !IsElevatedProcess(); }
    }

    /// %LOCALAPPDATA%\Mantle\elevate: per user, ACL'd to that user only (PrepareDir).
    public static string ElevateDir() {
      if (TestMode) {
        string t = Environment.GetEnvironmentVariable("MANTLE_ELEVATE_DIR");
        if (!string.IsNullOrEmpty(t)) return Path.GetFullPath(t).TrimEnd('\\', '/');
      }
      return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mantle", "elevate");
    }

    // ------------------------------------------------------------------ the whitelist

    static Dictionary<string, Entry> Actions {
      get {
        lock (_gate) {
          if (_actions != null) return _actions;
          var found = new Dictionary<string, Entry>(StringComparer.Ordinal);
          var twice = new HashSet<string>(StringComparer.Ordinal);
          bool test = TestMode;
          const BindingFlags Statics = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
          foreach (Type type in typeof(Elevate).Assembly.GetTypes()) {
            foreach (MethodInfo m in type.GetMethods(Statics | BindingFlags.DeclaredOnly)) {
              var attr = (ElevatedAttribute)Attribute.GetCustomAttribute(m, typeof(ElevatedAttribute));
              if (attr == null) continue;
              string where = type.Name + "." + m.Name;
              string bad = AttributeProblem(attr, where);
              if (bad != null) { _problems.Add(bad); continue; }
              if (attr.TestOnly && !test) continue;
              var run = (ElevatedAction)Delegate.CreateDelegate(typeof(ElevatedAction), m, false);
              if (run == null) {
                _problems.Add(where + " (" + attr.Name + ") must be: static string " + m.Name +
                              "(Dictionary<string, object> args, ref object result)");
                continue;
              }
              MethodInfo vm = type.GetMethod(attr.Validator, Statics, null, new Type[] { typeof(Dictionary<string, object>) }, null);
              ElevatedValidator check = vm == null ? null
                : (ElevatedValidator)Delegate.CreateDelegate(typeof(ElevatedValidator), vm, false);
              if (check == null) {
                _problems.Add(attr.Name + " has no validator: " + type.Name + " needs static string " + attr.Validator +
                              "(Dictionary<string, object> args), so the action is left out");
                continue;
              }
              if (twice.Contains(attr.Name) || found.ContainsKey(attr.Name)) {
                // Ambiguous is refused outright: neither copy may run.
                twice.Add(attr.Name);
                found.Remove(attr.Name);
                _problems.Add(attr.Name + " is registered twice (again by " + where + "), so neither copy runs");
                continue;
              }
              var e = new Entry();
              e.Name = attr.Name; e.Does = attr.Does; e.Owner = where; e.TestOnly = attr.TestOnly;
              e.Run = run; e.Validate = check;
              found[attr.Name] = e;
            }
          }
          _actions = found;
          return _actions;
        }
      }
    }

    static string AttributeProblem(ElevatedAttribute a, string where) {
      if (a.Name == null || !NameRx.IsMatch(a.Name))
        return where + ": \"" + a.Name + "\" is not an \"area.action\" name, so it is left out";
      if (a.Name.StartsWith("test.", StringComparison.Ordinal) != a.TestOnly)
        return where + ": " + a.Name + ": a test action must be named test.* AND marked TestOnly (both or neither)";
      if (string.IsNullOrEmpty(a.Validator)) return where + ": " + a.Name + " names no validator, so it is left out";
      if (string.IsNullOrEmpty(a.Does) || a.Does.Length > 80)
        return where + ": " + a.Name + " needs `does` words (up to 80 characters), so it is left out";
      return null;
    }

    /// The SAME gate on both sides of the prompt: a known action, args that are a JSON object of
    /// sane size, and the action's own validator. Null when admitted, else the plain words.
    static string Admit(object action, object rawArgs, out Entry entry, out Dictionary<string, object> args) {
      entry = null; args = null;
      string name = action as string;
      if (string.IsNullOrEmpty(name)) return "no administrator action was named";
      if (!Actions.TryGetValue(name, out entry))
        return "\"" + name + "\" is not an administrator action Mantle knows, so nothing was asked or run";
      if (rawArgs == null) args = new Dictionary<string, object>(StringComparer.Ordinal);
      else {
        args = rawArgs as Dictionary<string, object>;
        if (args == null) return name + ": its args must be a JSON object";
      }
      string json = Json.Write(args);
      if (json.Length > MaxArgsChars)
        return name + ": its args are too big (" + json.Length + " characters; the limit is " + MaxArgsChars + ")";
      string why;
      try { why = entry.Validate(args); }
      catch (Exception ex) { why = name + ": its check failed (" + ex.GetType().Name + ": " + ex.Message + ")"; }
      return why;
    }

    /// For validators: refuse any key not listed (a typo'd or smuggled key is a refusal, never ignored).
    public static string OnlyKeys(Dictionary<string, object> args, params string[] keys) {
      foreach (string k in args.Keys)
        if (Array.IndexOf(keys, k) < 0) return "\"" + k + "\" is not something this action takes";
      return null;
    }

    // ------------------------------------------------------------------ sidecar commands

    public static void Register(FeatureTable t) {
      t.Add("elevate.run", Lanes.Slow, Run);
      t.Add("elevate.status", Lanes.Ui, Status);
      t.Add("elevate.list", Lanes.Slow, List);
    }

    /// elevate.list -> {actions:[{action, does}], problems, test}: what a page may ask for, and
    /// every [Elevated] method that was left out, with why.
    static string List(Dictionary<string, object> req, ref object result) {
      var rows = new List<object>();
      foreach (Entry e in Actions.Values) rows.Add(Json.Obj("action", e.Name, "does", e.Does));
      var probs = new List<object>();
      lock (_gate) foreach (string p in _problems) probs.Add(p);
      result = Json.Obj("actions", rows, "problems", probs, "test", TestMode);
      return null;
    }

    /// elevate.run {action, args, owner?} -> {ticket, action, does, timeoutMs} at once; the outcome
    /// is the `elevate` event. `owner` is the asking window's HWND (decimal string), the parent
    /// Windows gives the prompt. Test seam only: testSimulate "cancel" | "hang", testTimeoutMs.
    static string Run(Dictionary<string, object> req, ref object result) {
      object action, rawArgs;
      req.TryGetValue("action", out action);
      req.TryGetValue("args", out rawArgs);
      Entry entry;
      Dictionary<string, object> args;
      string refusal = Admit(action, rawArgs, out entry, out args);
      if (refusal != null) return refusal;

      bool seam = TestMode && Program.Passive;
      if (Program.Passive && !seam) return FeatureTable.PassiveRefusal;
      string simulate = null;
      int timeoutMs = TimeoutMs;
      if (req.ContainsKey("testSimulate") || req.ContainsKey("testTimeoutMs")) {
        // Refused outside the seam, never silently ignored.
        if (!seam) return "testSimulate and testTimeoutMs are test-only (a passive sidecar with MANTLE_ELEVATE_TEST=1)";
        simulate = Json.GetString(req, "testSimulate");
        if (simulate != null && simulate != "cancel" && simulate != "hang") return "testSimulate must be \"cancel\" or \"hang\"";
        timeoutMs = Math.Max(200, Json.GetInt(req, "testTimeoutMs", TimeoutMs));
      }
      IntPtr owner = Json.GetHwnd(req, "owner");

      var f = new Flight();
      lock (_gate) {
        if (_inflight != null)
          return "another administrator prompt is already open (to " + _inflight.Does + "); answer that one first";
        f.Ticket = ++_nextTicket;
        _inflight = f;
      }
      f.Action = entry.Name; f.Does = entry.Does; f.TimeoutMs = timeoutMs;
      try {
        string dir = PrepareDir();
        f.Nonce = NewNonce();
        f.ReqPath = Path.Combine(dir, f.Nonce + ".req.json");
        f.ResPath = Path.Combine(dir, f.Nonce + ".res.json");
        WriteRequest(f.ReqPath, entry.Name, args, f.Nonce);
      } catch (Exception ex) {
        lock (_gate) { if (_inflight == f) _inflight = null; }
        TryDelete(f.ReqPath);
        return "could not prepare the administrator step (" + ex.Message + "), so nothing was asked";
      }
      f.DeadlineMs = NowMs() + timeoutMs;
      f.Timer = new Timer(delegate (object s) { OnTimeout(f); }, null, timeoutMs, Timeout.Infinite);
      var th = new Thread(delegate () { Launch(f, owner, seam, simulate); });
      th.IsBackground = true;
      th.Name = "elevate " + f.Ticket;
      th.SetApartmentState(ApartmentState.STA);   // ShellExecuteEx wants COM, apartment-threaded
      th.Start();
      Program.EmitLog("info", "elevate: asking for administrator permission for " + f.Action + " (ticket " + f.Ticket +
                      (seam ? ", TEST: launched without runas" : "") + ")");
      result = Json.Obj("ticket", f.Ticket, "action", f.Action, "does", f.Does, "timeoutMs", timeoutMs, "test", seam);
      return null;
    }

    /// elevate.status {ticket} -> {ticket, state:"waiting"} or the finished outcome with state "done".
    static string Status(Dictionary<string, object> req, ref object result) {
      int ticket = Json.GetInt(req, "ticket", 0);
      lock (_gate) {
        if (_inflight != null && _inflight.Ticket == ticket) {
          result = Json.Obj("ticket", ticket, "state", "waiting", "action", _inflight.Action);
          return null;
        }
        IDictionary o;
        if (_outcomes.TryGetValue(ticket, out o)) {
          var copy = new Dictionary<string, object>(StringComparer.Ordinal);
          foreach (DictionaryEntry kv in o) copy[(string)kv.Key] = kv.Value;
          copy["state"] = "done";
          result = copy;
          return null;
        }
      }
      return "no administrator step has ticket " + ticket + " (the sidecar may have restarted since), so whether it happened is unknown";
    }

    // ------------------------------------------------------------------ the broker's waiter

    static void Launch(Flight f, IntPtr owner, bool seam, string simulate) {
      IntPtr proc = IntPtr.Zero;
      try {
        if (simulate == "hang") return;          // nothing launches; the timer answers
        int err = 0;
        if (simulate == "cancel") err = ErrorCancelled;
        else {
          var sei = new SHELLEXECUTEINFO();
          sei.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
          sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
          sei.hwnd = owner;
          // "open" is the test seam: this exe's manifest is asInvoker, so "open" never asks for
          // elevation and a test can never put a UAC prompt on Owen's screen.
          sei.lpVerb = seam ? "open" : "runas";
          sei.lpFile = ExePath();
          sei.lpParameters = "--elevated \"" + f.ReqPath + "\"";
          sei.lpDirectory = Environment.SystemDirectory;   // no DLLs from wherever Mantle was started
          sei.nShow = 0;
          if (!ShellExecuteExW(ref sei)) err = Marshal.GetLastWin32Error();
          else proc = sei.hProcess;
        }
        if (err != 0) {
          if (err == ErrorCancelled) Finish(f, Outcome(f, false, "cancelled", "you said no to the administrator prompt, so Mantle did not " + f.Does, null));
          else Finish(f, Outcome(f, false, "failed", "Windows could not start the administrator step (" + new Win32Exception(err).Message + ", error " + err + "), so Mantle did not " + f.Does, null));
          return;
        }
        int exitCode = -1;
        if (proc != IntPtr.Zero) {
          long left = Math.Max(0, f.DeadlineMs - NowMs());
          WaitForSingleObject(proc, (uint)(left + AfterTimeoutMs));
          uint code;
          if (GetExitCodeProcess(proc, out code) && code != STILL_ACTIVE) exitCode = (int)code;
        } else {
          // No process handle (Windows handed the launch elsewhere): watch for the answer instead.
          long until = f.DeadlineMs + AfterTimeoutMs;
          while (!File.Exists(f.ResPath) && NowMs() < until) Thread.Sleep(200);
          exitCode = File.Exists(f.ResPath) ? ExitRan : -1;
        }
        IDictionary outcome = ReadAnswer(f, exitCode);
        if (!Finish(f, outcome)) {
          // The timer already told the caller. Say what really happened, never silently.
          bool ok = true.Equals(outcome["ok"]);
          Program.EmitLog("warn", "elevate: " + f.Action + " (ticket " + f.Ticket + ") answered after Mantle had given up: " +
                          (ok ? "it DID " + f.Does : "it did not run (" + outcome["kind"] + ")"));
        }
      } catch (Exception ex) {
        Finish(f, Outcome(f, false, "failed", "the administrator step failed (" + ex.Message + "), so it is unknown whether Mantle could " + f.Does, null));
      } finally {
        if (proc != IntPtr.Zero) CloseHandle(proc);
        TryDelete(f.ResPath);
      }
    }

    static void OnTimeout(Flight f) {
      if (Volatile.Read(ref f.Done) != 0) return;
      // The request still on disk = the step never started: remove it, and a late "yes" finds
      // nothing to run. Gone or held open = the step has it, and may still act.
      bool neverStarted = false;
      try {
        if (File.Exists(f.ReqPath)) { File.Delete(f.ReqPath); neverStarted = !File.Exists(f.ReqPath); }
      } catch (Exception) { /* held open by the elevated step */ }
      string secs = (f.TimeoutMs / 1000.0).ToString("0.#", CultureInfo.InvariantCulture);
      Finish(f, neverStarted
        ? Outcome(f, false, "timeout", "the administrator step did not answer in " + secs + " s, so nothing was changed (saying yes to that prompt now does nothing)", null)
        : Outcome(f, false, "timeout", "the administrator step did not finish in " + secs + " s. It had already started, so it may still " + f.Does + "; check before trying again", null));
    }

    /// The first outcome wins (the waiter or the timer); returns whether this one did.
    static bool Finish(Flight f, IDictionary outcome) {
      if (Interlocked.CompareExchange(ref f.Done, 1, 0) != 0) return false;
      if (f.Timer != null) f.Timer.Dispose();
      TryDelete(f.ReqPath);
      lock (_gate) {
        if (_inflight == f) _inflight = null;
        _outcomes[f.Ticket] = outcome;
        _outcomeOrder.Enqueue(f.Ticket);
        while (_outcomeOrder.Count > 16) _outcomes.Remove(_outcomeOrder.Dequeue());
      }
      // Action names and kinds only, NEVER args (a PC name, a DNS server) and never the reason,
      // which may quote them.
      Program.EmitLog(true.Equals(outcome["ok"]) ? "info" : "warn",
                      "elevate: " + f.Action + " (ticket " + f.Ticket + ") -> " + outcome["kind"]);
      Features.Event("elevate", outcome);
      return true;
    }

    static IDictionary Outcome(Flight f, bool ok, string kind, string reason, object result) {
      return ok
        ? Json.Obj("ticket", f.Ticket, "action", f.Action, "ok", true, "kind", kind, "result", result ?? Json.Obj())
        : Json.Obj("ticket", f.Ticket, "action", f.Action, "ok", false, "kind", kind, "reason", reason);
    }

    static IDictionary ReadAnswer(Flight f, int exitCode) {
      if (!File.Exists(f.ResPath)) {
        if (exitCode == ExitBadPath)
          return Outcome(f, false, "failed", "the administrator step refused where its request was (exit code 2, a Mantle bug), so Mantle did not " + f.Does, null);
        return Outcome(f, false, "failed", "the administrator step ended without an answer (exit code " + exitCode + "), so it is unknown whether Mantle could " + f.Does, null);
      }
      Dictionary<string, object> a;
      try { a = Json.Parse(File.ReadAllText(f.ResPath, Encoding.UTF8)) as Dictionary<string, object>; }
      catch (Exception ex) { return Outcome(f, false, "failed", "the administrator step's answer was not readable (" + ex.Message + ")", null); }
      finally { TryDelete(f.ResPath); }   // gone BEFORE the event goes out
      if (a == null) return Outcome(f, false, "failed", "the administrator step's answer was not readable", null);
      if (Json.GetString(a, "nonce") != f.Nonce)
        return Outcome(f, false, "failed", "the administrator step's answer belongs to another request, so it was ignored", null);
      object res;
      a.TryGetValue("result", out res);
      if (Json.GetBool(a, "ok", false)) return Outcome(f, true, "ok", null, res);
      return Outcome(f, false, Json.GetString(a, "kind") ?? "failed",
                     Json.GetString(a, "reason") ?? "the administrator step said no without saying why", null);
    }

    // ------------------------------------------------------------------ the request folder

    static string PrepareDir() {
      string dir = ElevateDir();
      DirectorySecurity mine = OwnerOnlyDir();
      if (!Directory.Exists(dir)) Directory.CreateDirectory(dir, mine);
      if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0)
        throw new IOException("the request folder " + dir + " is a link to somewhere else");
      if (FolderProblem(dir) != null || !Directory.GetAccessControl(dir, AccessControlSections.Access).AreAccessRulesProtected) {
        Directory.SetAccessControl(dir, mine);
        string still = FolderProblem(dir);
        if (still != null) throw new IOException(still + ", and Mantle could not make it private");
      }
      // Leftovers from a sidecar that died mid-prompt: nothing can run them (stale), so tidy.
      foreach (string p in Directory.GetFiles(dir, "*.json")) {
        try { if (NowMs() - ToMs(File.GetLastWriteTimeUtc(p)) > LeftoverMs) File.Delete(p); } catch (Exception) { }
      }
      return dir;
    }

    static DirectorySecurity OwnerOnlyDir() {
      var sec = new DirectorySecurity();
      sec.SetAccessRuleProtection(true, false);
      sec.AddAccessRule(new FileSystemAccessRule(Me(), FileSystemRights.FullControl,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      return sec;
    }

    static void WriteRequest(string path, string action, Dictionary<string, object> args, string nonce) {
      var sec = new FileSecurity();
      sec.SetAccessRuleProtection(true, false);
      sec.AddAccessRule(new FileSystemAccessRule(Me(), FileSystemRights.FullControl, AccessControlType.Allow));
      byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Write(Json.Obj(
        "v", 1, "action", action, "args", args, "nonce", nonce, "createdAt", NowMs(), "by", Program.OwnPid)));
      // CreateNew: a file already there (a guessed name) is an error, never overwritten.
      using (var fs = new FileStream(path, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, sec))
        fs.Write(bytes, 0, bytes.Length);
    }

    const int WriteMask = 0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
    // WriteData/AddFile, AppendData/AddSubdirectory, WriteEA, WriteAttributes, DELETE, WRITE_DAC,
    // WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE; plus DeleteChild (0x40) for a folder.

    /// Null when only you, SYSTEM or Administrators can change it and one of them owns it; else why not.
    static string ForeignWriter(byte[] sdBytes, bool isDir, string what) {
      var sd = new RawSecurityDescriptor(sdBytes, 0);
      if (sd.Owner == null || !Trusted(sd.Owner)) return what + " is owned by " + Who(sd.Owner) + ", not by you";
      if (sd.DiscretionaryAcl == null) return what + " has no access list, so anyone can change it";
      int mask = WriteMask | (isDir ? 0x40 : 0);
      foreach (GenericAce ace in sd.DiscretionaryAcl) {
        if ((ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
        bool allow = ace.AceType == AceType.AccessAllowed || ace.AceType == AceType.AccessAllowedObject ||
                     ace.AceType == AceType.AccessAllowedCallback || ace.AceType == AceType.AccessAllowedCallbackObject ||
                     ace.AceType == AceType.AccessAllowedCompound;
        if (!allow) continue;
        var known = ace as KnownAce;
        if (known == null) return what + " has an access entry Mantle cannot read";
        if ((known.AccessMask & mask) != 0 && !Trusted(known.SecurityIdentifier))
          return what + " can be changed by " + Who(known.SecurityIdentifier);
      }
      return null;
    }

    static string FolderProblem(string dir) {
      return ForeignWriter(Directory.GetAccessControl(dir, AccessControlSections.Owner | AccessControlSections.Access)
                             .GetSecurityDescriptorBinaryForm(), true, "the request folder");
    }

    static SecurityIdentifier _me;
    static SecurityIdentifier Me() {
      if (_me == null) using (WindowsIdentity id = WindowsIdentity.GetCurrent()) _me = id.User;
      return _me;
    }

    static bool Trusted(SecurityIdentifier sid) {
      return sid == Me() || sid.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
             sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid);
    }

    static string Who(SecurityIdentifier sid) {
      if (sid == null) return "nobody";
      try { return sid.Translate(typeof(NTAccount)).Value; } catch (Exception) { return sid.Value; }
    }

    // ------------------------------------------------------------------ the elevated step

    /// Program.Main's `--elevated <request path>`. Runs at most ONE whitelisted action, writes
    /// <nonce>.res.json next to the request, and returns the exit code. Reads nothing but that
    /// file; never starts anything.
    public static int RunElevated(string[] argv) {
      string path = null;
      for (int i = 0; i + 1 < argv.Length; i++) if (argv[i] == "--elevated") { path = argv[i + 1]; break; }
      string dir, nonce;
      try {
        dir = ElevateDir();
        string why = RequestPathProblem(path, dir, out nonce);
        if (why != null) { Complain(why); return ExitBadPath; }
      } catch (Exception ex) { Complain("the request path could not be checked: " + ex.Message); return ExitBadPath; }
      string resPath = Path.Combine(dir, nonce + ".res.json");
      try {
        IDictionary answer = RunRequest(Path.GetFullPath(path), dir, nonce);
        WriteAnswer(resPath, answer);
        return true.Equals(answer["ok"]) ? ExitRan : ExitRefused;
      } catch (Exception ex) {
        try { WriteAnswer(resPath, Answer(nonce, false, "failed", "the administrator step failed (" + ex.GetType().Name + ": " + ex.Message + ")", null)); }
        catch (Exception) { }
        return ExitCrashed;
      }
    }

    static string RequestPathProblem(string path, string dir, out string nonce) {
      nonce = null;
      if (string.IsNullOrEmpty(path)) return "--elevated needs the request file's path";
      string full = Path.GetFullPath(path);
      string parent = (Path.GetDirectoryName(full) ?? "").TrimEnd('\\', '/');
      if (!string.Equals(parent, dir.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
        return "the request file is not in Mantle's request folder (" + dir + "), so it was not read";
      string name = Path.GetFileName(full);
      if (!RequestRx.IsMatch(name)) return "\"" + name + "\" is not a request file name, so it was not read";
      nonce = name.Substring(0, 32);
      return null;
    }

    static IDictionary RunRequest(string path, string dir, string nonce) {
      if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0)
        return Answer(nonce, false, "refused", "the request folder is a link to somewhere else, so nothing was run", null);
      string why = FolderProblem(dir);
      if (why != null) return Answer(nonce, false, "refused", why + ", so nothing was run", null);
      if (!File.Exists(path))
        return Answer(nonce, false, "refused", "the request is gone (already used, or Mantle stopped waiting), so nothing was run", null);
      if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        return Answer(nonce, false, "refused", "the request file is a link to somewhere else, so nothing was run", null);

      Dictionary<string, object> req;
      try {
        // Share READ only: nobody can write, rename or delete it while it is checked and read, and
        // DeleteOnClose uses it up whatever the verdict.
        using (var fs = new FileStream(path, FileMode.Open, FileSystemRights.Read | FileSystemRights.Delete,
                                       FileShare.Read, 4096, FileOptions.DeleteOnClose)) {
          why = ForeignWriter(fs.GetAccessControl().GetSecurityDescriptorBinaryForm(), false, "the request file");
          if (why != null) return Answer(nonce, false, "refused", why + ", so nothing was run", null);
          if (fs.Length > MaxRequestBytes) return Answer(nonce, false, "refused", "the request is too big, so nothing was run", null);
          var bytes = new byte[(int)fs.Length];
          int got = 0;
          while (got < bytes.Length) { int n = fs.Read(bytes, got, bytes.Length - got); if (n <= 0) break; got += n; }
          req = Json.Parse(new UTF8Encoding(false).GetString(bytes, 0, got)) as Dictionary<string, object>;
          if (req == null || Json.GetInt(req, "v", 0) != 1)
            return Answer(nonce, false, "refused", "the request is not one Mantle wrote, so nothing was run", null);
          if (Json.GetString(req, "nonce") != nonce)
            return Answer(nonce, false, "refused", "the request's nonce does not match its file name, so nothing was run", null);
          object created;
          if (!req.TryGetValue("createdAt", out created) || !(created is double))
            return Answer(nonce, false, "refused", "the request has no time on it, so nothing was run", null);
          long now = NowMs();
          long age = Math.Max(now - (long)(double)created, now - ToMs(File.GetLastWriteTimeUtc(path)));
          if (age > StaleMs)
            return Answer(nonce, false, "refused", "the request is " + (age / 1000) + " s old (the limit is " + (StaleMs / 1000) + " s), so nothing was run", null);
          if ((long)(double)created - now > FutureSlackMs)
            return Answer(nonce, false, "refused", "the request is dated in the future, so nothing was run", null);
          why = SpendNonce(dir, nonce);
          if (why != null) return Answer(nonce, false, "refused", why, null);
        }
      } catch (FileNotFoundException) {
        return Answer(nonce, false, "refused", "the request is gone (already used, or Mantle stopped waiting), so nothing was run", null);
      } catch (UnauthorizedAccessException) {
        return Answer(nonce, false, "refused", "the administrator step could not open the request (the administrator account is not the one that asked?), so nothing was run", null);
      } catch (IOException ex) {
        return Answer(nonce, false, "refused", "the request file is in use by another program (" + ex.Message + "), so nothing was run", null);
      }

      // Never trust the side that asked: the whitelist and the validator run again, here.
      object action, rawArgs;
      req.TryGetValue("action", out action);
      req.TryGetValue("args", out rawArgs);
      Entry entry;
      Dictionary<string, object> args;
      why = Admit(action, rawArgs, out entry, out args);
      if (why != null) return Answer(nonce, false, "refused", why, null);
      if (TestMode && !entry.TestOnly)
        return Answer(nonce, false, "refused", "test mode (MANTLE_ELEVATE_TEST) runs test actions only: " + entry.Name + " was checked and NOT run", null);

      object result = null;
      string err;
      try { err = entry.Run(args, ref result); }
      catch (Exception ex) { err = entry.Name + " failed: " + ex.GetType().Name + ": " + ex.Message; }
      return err == null ? Answer(nonce, true, "ok", null, result) : Answer(nonce, false, "failed", err, null);
    }

    /// Each nonce runs once. The ledger keeps them longer than any request stays fresh.
    static string SpendNonce(string dir, string nonce) {
      string ledger = Path.Combine(dir, "used-nonces.txt");
      long now = NowMs();
      for (int attempt = 0; attempt < 40; attempt++) {
        try {
          using (var fs = new FileStream(ledger, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
            string text;
            using (var r = new StreamReader(fs, new UTF8Encoding(false), false, 4096, true)) text = r.ReadToEnd();
            var keep = new StringBuilder();
            foreach (string line in text.Split('\n')) {
              string[] parts = line.Trim().Split(' ');
              if (parts.Length != 2) continue;
              if (parts[0] == nonce) return "this request was already used once, so it was not run again";
              long at;
              if (long.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out at) && now - at < LedgerKeepMs)
                keep.Append(parts[0]).Append(' ').Append(parts[1]).Append('\n');
            }
            keep.Append(nonce).Append(' ').Append(now.ToString(CultureInfo.InvariantCulture)).Append('\n');
            byte[] b = new UTF8Encoding(false).GetBytes(keep.ToString());
            fs.SetLength(0);
            fs.Position = 0;
            fs.Write(b, 0, b.Length);
          }
          return null;
        } catch (IOException) { Thread.Sleep(50); }
      }
      return "the administrator step could not record the request as used (its ledger stayed locked), so nothing was run";
    }

    static IDictionary Answer(string nonce, bool ok, string kind, string reason, object result) {
      return ok
        ? Json.Obj("v", 1, "nonce", nonce, "ok", true, "kind", kind, "result", result ?? Json.Obj())
        : Json.Obj("v", 1, "nonce", nonce, "ok", false, "kind", kind, "reason", reason);
    }

    static void WriteAnswer(string resPath, IDictionary answer) {
      string tmp = resPath + ".tmp";
      File.WriteAllText(tmp, Json.Write(answer), new UTF8Encoding(false));
      if (File.Exists(resPath)) File.Delete(resPath);
      File.Move(tmp, resPath);
    }

    static void Complain(string why) {
      try { Console.Error.WriteLine("mantle-sidecar --elevated: " + why); Console.Error.Flush(); } catch (Exception) { }
    }

    // ------------------------------------------------------------------ the test action

    /// Harmless: returns its args. Registered only in test mode (TestOnly).
    [Elevated("test.echo", "CheckEcho", "run Mantle's test action", TestOnly = true)]
    static string Echo(Dictionary<string, object> args, ref object result) {
      int ms = Json.GetInt(args, "sleepMs", 0);
      if (ms > 0) Thread.Sleep(ms);
      result = Json.Obj("args", args, "elevated", IsElevatedProcess(), "pid", Process.GetCurrentProcess().Id);
      return null;
    }

    static string CheckEcho(Dictionary<string, object> args) {
      string why = OnlyKeys(args, "text", "sleepMs");
      if (why != null) return why;
      object t;
      if (!args.TryGetValue("text", out t) || !(t is string)) return "test.echo needs text";
      if (((string)t).Length > 200) return "test.echo text is limited to 200 characters";
      if ((string)t == "refuse-me") return "test.echo refuses \"refuse-me\"";
      object s;
      if (args.TryGetValue("sleepMs", out s) && (!(s is double) || (double)s < 0 || (double)s > 10000))
        return "test.echo sleepMs must be 0 to 10000";
      return null;
    }

    // ------------------------------------------------------------------ plumbing

    static string ExePath() { return Assembly.GetExecutingAssembly().Location; }

    static string NewNonce() {
      var b = new byte[16];
      using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(b);
      var sb = new StringBuilder(32);
      foreach (byte x in b) sb.Append(x.ToString("x2", CultureInfo.InvariantCulture));
      return sb.ToString();
    }

    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    static long NowMs() { return ToMs(DateTime.UtcNow); }
    static long ToMs(DateTime utc) { return (long)(utc - Epoch).TotalMilliseconds; }

    static void TryDelete(string p) {
      if (string.IsNullOrEmpty(p)) return;
      try { if (File.Exists(p)) File.Delete(p); } catch (Exception) { }
    }

    const uint SEE_MASK_NOCLOSEPROCESS = 0x40, SEE_MASK_NOASYNC = 0x100, SEE_MASK_FLAG_NO_UI = 0x400;
    const uint STILL_ACTIVE = 259;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHELLEXECUTEINFO {
      public int cbSize;
      public uint fMask;
      public IntPtr hwnd;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;
      public int nShow;
      public IntPtr hInstApp;
      public IntPtr lpIDList;
      [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;
      public IntPtr hkeyClass;
      public uint dwHotKey;
      public IntPtr hIcon;
      public IntPtr hProcess;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
  }

  /// THE WORKED EXAMPLE (ELEVATE.md): Settings > System > About > "Rename this PC", exactly what
  /// Windows does - SetComputerNameEx(ComputerNamePhysicalDnsHostname), which sets the NetBIOS
  /// and DNS host names together, effective after a restart. The system lane's page asks for
  /// system.renamePc; nobody re-implements it.
  static class ElevatePcName {
    const int ComputerNamePhysicalDnsHostname = 5;

    [Elevated("system.renamePc", "CheckRename", "rename this PC")]
    static string Rename(Dictionary<string, object> args, ref object result) {
      string name = (string)args["name"];
      string before = Environment.MachineName;
      if (!SetComputerNameExW(ComputerNamePhysicalDnsHostname, name)) {
        int err = Marshal.GetLastWin32Error();
        return "Windows did not rename this PC (" + new Win32Exception(err).Message + ", error " + err + ")";
      }
      result = Json.Obj("name", name, "before", before, "restartNeeded", true,
                        "note", "The new name takes effect after a restart.");
      return null;
    }

    static string CheckRename(Dictionary<string, object> args) {
      string why = Elevate.OnlyKeys(args, "name");
      if (why != null) return why;
      object v;
      if (!args.TryGetValue("name", out v) || !(v is string)) return "a new PC name is needed";
      return NameProblem((string)v);
    }

    /// Windows' own rules for "Rename this PC": letters, numbers and hyphens, at most 15 (the
    /// NetBIOS limit), not only numbers. Plus DNS's: no hyphen first or last.
    public static string NameProblem(string name) {
      if (name.Length == 0) return "a PC name cannot be empty";
      if (name.Length > 15) return "a PC name can be at most 15 characters (this one has " + name.Length + ")";
      bool allDigits = true;
      foreach (char c in name) {
        if (c == ' ') return "a PC name cannot contain spaces";
        bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        bool digit = c >= '0' && c <= '9';
        if (!letter && !digit && c != '-')
          return "a PC name can only use letters (A-Z), numbers and hyphens, not \"" + c + "\"";
        if (!digit) allDigits = false;
      }
      if (allDigits) return "a PC name cannot be only numbers";
      if (name[0] == '-' || name[name.Length - 1] == '-') return "a PC name cannot start or end with a hyphen";
      return null;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetComputerNameExW(int type, string name);
  }
}
