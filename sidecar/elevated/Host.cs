// Host.cs - the registration shim + allowlist for mantle.elevated.exe (lane tm-elevate, 2026-10-28).
//
// WHY A SEPARATE EXE: Windows' Task Manager silently runs as administrator. Owen chose "Always
// admin, no prompt": a one-time UAC setup installs this helper as a scheduled task (RunLevel
// Highest), and after that the non-elevated Mantle sidecar reaches admin-only work by asking this
// helper over a named pipe. The helper is NOT the elevation broker (sidecar/Elevate.cs): that one
// keeps "one UAC prompt per action" for Settings. This one keeps "one UAC prompt per helper
// version, then silent", for Task Manager only, exactly as Windows' taskmgr.exe behaves. Owen was
// told and accepted that any program running as him can also start this helper; the pipe's auth,
// the allowlist and the per-op pid+creation-time checks are what cap that.
//
// THE SHIM: the main sidecar registers a command with t.Add("taskmgr.x", Lanes.Slow, Fn) on a
// Mantle.FeatureTable, discovered by a [MantleFeature] attribute (Features.cs). Those files
// (TaskMgr.cs, tm-data's ProcOps/Services/ProcDetails/Users) also lean on a handful of Program and
// Lanes members. The real Features.cs / Lanes.cs / Program.cs are welded to the stdin sidecar and
// its threading, so this helper does NOT compile them in. Instead this file provides the SAME
// public surface those handler files use, so they compile into the helper UNCHANGED at integration
// time (no edits to tm-data's files). The build script (build.ps1) names exactly which files are
// compiled in; that curated list is the first lock. ElevatedHost.Allow is the second.
//
// WHAT THIS FILE PROVIDES (the integration contract):
//   MantleFeatureAttribute, FeatureCommand, FeatureTable (with .Add and .PassiveRefusal), Lanes
//   (Slow etc. + Register), and ElevatedHost (discovery, allowlist, dispatch). Program.cs provides
//   OwnPid / ParentPid / Passive / IsElevated / EmitLog / Emit. Json comes from ../Json.cs. At
//   integration ../Win32.cs and ../TaskMgr.cs come too, for the handlers' Win32 and TaskMgr.* helpers.
//
// C# 5 only (build.ps1): no string interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections.Generic;
using System.Reflection;

namespace Mantle {
  [AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
  public sealed class MantleFeatureAttribute : Attribute { }

  public delegate string FeatureCommand(Dictionary<string, object> req, ref object result);

  // The lane constants the handler files name. In the helper a command runs inline on the pipe
  // thread (one client, one request at a time), so the lane is only recorded, never scheduled.
  static class Lanes {
    public const string Ui = "ui", Capture = "capture", Slow = "slow", Audio = "audio",
                        Qs = "qs", Focus = "focus", Scan = "scan", Notif = "notif";
    public static void Register(string name, string lane) { /* recorded by FeatureTable; no scheduler here */ }
  }

  public sealed class FeatureTable {
    // Identical words to the real sidecar's, so a handler's passive refusal reads the same.
    public const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    readonly Dictionary<string, FeatureCommand> _cmds = new Dictionary<string, FeatureCommand>(StringComparer.Ordinal);
    readonly Dictionary<string, string> _lanes = new Dictionary<string, string>(StringComparer.Ordinal);
    string _owner = "";

    internal void BeginOwner(string owner) { _owner = owner; }

    public void Add(string name, string lane, FeatureCommand fn) {
      if (string.IsNullOrEmpty(name) || name.IndexOf('.') <= 0)
        throw new ArgumentException(_owner + ": feature command \"" + name + "\" must be named feature.verb");
      if (lane != Lanes.Ui && lane != Lanes.Capture && lane != Lanes.Slow && lane != Lanes.Audio &&
          lane != Lanes.Qs && lane != Lanes.Scan && lane != Lanes.Notif && lane != Lanes.Focus)
        throw new ArgumentException(_owner + ": feature command \"" + name + "\" names an unknown lane \"" + lane + "\"");
      if (fn == null) throw new ArgumentException(_owner + ": feature command \"" + name + "\" has no handler");
      if (_cmds.ContainsKey(name))
        throw new ArgumentException(_owner + ": feature command \"" + name + "\" is registered twice");
      _cmds[name] = fn;
      _lanes[name] = lane;
      Lanes.Register(name, lane);
    }

    internal bool TryGet(string name, out FeatureCommand fn) { return _cmds.TryGetValue(name, out fn); }
    internal ICollection<string> Names { get { return _cmds.Keys; } }
  }

  // The helper's registry: discovery (reflection over this assembly), the allowlist, and dispatch.
  static class ElevatedHost {
    // THE ALLOWLIST. The helper runs ONLY these commands, whatever is registered or asked. It is a
    // closed set of Task Manager admin ops, never a generic exec. "Run new task with administrative
    // privileges" is NOT here: that stays on the runas verb (its own UAC prompt), never this helper.
    //
    // Names match the main sidecar's command names so the client forwards the SAME command it would
    // have sent un-elevated. tm-data's elevated handlers (ProcOps/Services/ProcDetails/Users) must
    // register under these names; see TM-SPEC.md "## Proposals: tm-elevate". A name here with no
    // handler compiled in answers a clean "not integrated" reason, never silence.
    static readonly HashSet<string> Allow = new HashSet<string>(StringComparer.Ordinal) {
      // writes / actions (tm-data owns the handlers; pid+creation-time verified inside them)
      "taskmgr.endpid",          // endPid incl. verified tree
      "taskmgr.priority",        // Set priority incl. Realtime
      "taskmgr.affinity",        // Set affinity
      "taskmgr.efficiency",      // Efficiency mode
      "taskmgr.uacvirt",         // UAC virtualization
      "taskmgr.dump",            // Create dump (refuses protected/PPL)
      "taskmgr.service",         // service start/stop/restart
      "taskmgr.userdisconnect",  // Users: Disconnect
      "taskmgr.usersignoff",     // Users: Sign off
      // elevated reads
      "taskmgr.details",         // Details fields of other users' / system processes
      "taskmgr.netsample",       // per-process network (ETW Kernel-Network)  [this lane]
      "taskmgr.apphistory",      // SRUM app history                          [this lane]
      "taskmgr.startupimpact",   // Startup impact / CPU / Disk at startup    [this lane]
    };

    static FeatureTable _table;
    static readonly List<string> _problems = new List<string>();
    static readonly object _gate = new object();

    public static bool Allowed(string cmd) { return cmd != null && Allow.Contains(cmd); }
    public static IEnumerable<string> AllowList { get { return Allow; } }
    public static IEnumerable<string> Problems { get { return _problems; } }

    static FeatureTable Table() {
      lock (_gate) {
        if (_table != null) return _table;
        FeatureTable t = new FeatureTable();
        foreach (Type type in typeof(ElevatedHost).Assembly.GetTypes()) {
          if (type.GetCustomAttributes(typeof(MantleFeatureAttribute), false).Length == 0) continue;
          MethodInfo reg = type.GetMethod("Register", BindingFlags.Public | BindingFlags.Static, null,
                                          new Type[] { typeof(FeatureTable) }, null);
          if (reg == null) { _problems.Add(type.Name + " has no public static Register(FeatureTable)"); continue; }
          t.BeginOwner(type.Name);
          try { reg.Invoke(null, new object[] { t }); }
          catch (TargetInvocationException ex) {
            _problems.Add(type.Name + " did not register: " + (ex.InnerException != null ? ex.InnerException.Message : ex.Message));
          } catch (Exception ex) {
            _problems.Add(type.Name + " did not register: " + ex.Message);
          }
        }
        _table = t;
        return _table;
      }
    }

    // Dispatch ONE request. `cmd` must be on the allowlist AND have a handler, else a clean reason.
    // Returns the handler's own {ok, reason?, needsAdmin?, ...} via (error == null ? result : error).
    // Mirrors Program.Run's contract: a handler returns null + fills result, or returns plain words.
    public static object Dispatch(string cmd, Dictionary<string, object> req) {
      if (!Allowed(cmd))
        return Json.Obj("ok", false, "reason", "refused: \"" + cmd + "\" is not an elevated Task Manager command", "error", "not allowed");
      FeatureCommand fn;
      if (!Table().TryGet(cmd, out fn))
        return Json.Obj("ok", false, "reason", "\"" + cmd + "\" is allowed but no handler is compiled into this helper build (integration pending)", "error", "not integrated");
      object result = null;
      string err;
      try { err = fn(req, ref result); }
      catch (Exception ex) { return Json.Obj("ok", false, "reason", "the elevated helper hit an error running \"" + cmd + "\" (" + ex.GetType().Name + ")", "error", ex.Message); }
      if (err != null) return Json.Obj("ok", false, "reason", err, "error", err);
      // A handler may hand back a ready-made object (its own ok/needsAdmin/fields) or just a payload.
      if (result is System.Collections.IDictionary) return result;
      return Json.Obj("ok", true, "result", result == null ? Json.Obj() : result);
    }
  }
}
