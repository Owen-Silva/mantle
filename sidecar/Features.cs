// Features.cs - the seam feature files plug their sidecar commands into (wave 3, 2026-09-24).
//
// WHY: Owen asked for a round of Windows replacements at once (pop-up, power mode, search,
// clipboard, snapping, Task View, screenshots, a top menu bar). Each used to mean a new `case`
// in Program.Run plus an entry in Lanes._laneOf, so every lane edited the same two files. Now a
// feature is ONE new file:
//
//   [MantleFeature]
//   static class ClipHistory {
//     public static void Register(FeatureTable t) {
//       t.Add("clip.list", Lanes.Ui, List);
//     }
//     static string List(Dictionary<string, object> req, ref object result) { ... }
//   }
//
// Program.Run falls through to Features.TryRun for any name it does not know, and the lane
// comes from here (Lanes.Register). A handler has exactly Program.Run's contract: return null
// with `result` filled, or a plain-words error. Writes must refuse in passive themselves
// (FeatureTable.PassiveRefusal), because one command is often a read without arguments and a
// write with them, like "nightlight".
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;

namespace Mantle {
  [AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
  public sealed class MantleFeatureAttribute : Attribute { }

  public delegate string FeatureCommand(Dictionary<string, object> req, ref object result);

  public sealed class FeatureTable {
    /// The same words Program uses, so a test can match either.
    public const string PassiveRefusal = "refused: sidecar is passive (test mode)";

    readonly Dictionary<string, FeatureCommand> _cmds = new Dictionary<string, FeatureCommand>(StringComparer.Ordinal);
    string _owner = "";

    internal void BeginOwner(string owner) { _owner = owner; }

    /// `name` is "feature.verb" (a dot keeps feature commands apart from the built-in ones);
    /// `lane` is one of Lanes.Ui / Capture / Slow / Audio / Qs.
    public void Add(string name, string lane, FeatureCommand fn) {
      if (string.IsNullOrEmpty(name) || name.IndexOf('.') <= 0)
        throw new ArgumentException(_owner + ": feature command \"" + name + "\" must be named feature.verb");
      if (lane != Lanes.Ui && lane != Lanes.Capture && lane != Lanes.Slow && lane != Lanes.Audio && lane != Lanes.Qs)
        throw new ArgumentException(_owner + ": feature command \"" + name + "\" names an unknown lane \"" + lane + "\"");
      if (fn == null) throw new ArgumentException(_owner + ": feature command \"" + name + "\" has no handler");
      if (_cmds.ContainsKey(name))
        throw new ArgumentException(_owner + ": feature command \"" + name + "\" is registered twice");
      _cmds[name] = fn;
      Lanes.Register(name, lane);
    }

    internal bool TryGet(string name, out FeatureCommand fn) { return _cmds.TryGetValue(name, out fn); }
    internal ICollection<string> Names { get { return _cmds.Keys; } }
  }

  public static class Features {
    static readonly object _gate = new object();
    static FeatureTable _table;
    static List<string> _problems = new List<string>();

    /// Finds every [MantleFeature] class and lets it register, once. A feature that throws is
    /// left out with its reason (Problems), never allowed to take the sidecar down.
    public static FeatureTable Table {
      get {
        lock (_gate) {
          if (_table != null) return _table;
          var t = new FeatureTable();
          foreach (Type type in typeof(Features).Assembly.GetTypes()) {
            if (type.GetCustomAttributes(typeof(MantleFeatureAttribute), false).Length == 0) continue;
            MethodInfo reg = type.GetMethod("Register", BindingFlags.Public | BindingFlags.Static, null,
                                            new Type[] { typeof(FeatureTable) }, null);
            if (reg == null) { _problems.Add(type.Name + " has no public static Register(FeatureTable)"); continue; }
            t.BeginOwner(type.Name);
            try { reg.Invoke(null, new object[] { t }); }
            catch (TargetInvocationException ex) {
              _problems.Add(type.Name + " did not register: " + (ex.InnerException != null ? ex.InnerException.Message : ex.Message));
            }
          }
          _table = t;
          return _table;
        }
      }
    }

    /// Program.Run's fallback: false when no feature owns `cmd`.
    public static bool TryRun(string cmd, Dictionary<string, object> req, ref object result, out string error) {
      error = null;
      FeatureCommand fn;
      if (!Table.TryGet(cmd, out fn)) return false;
      try { error = fn(req, ref result); }
      catch (Exception ex) { error = cmd + " failed: " + ex.GetType().Name + ": " + ex.Message; }
      return true;
    }

    /// For ping: which feature commands exist and which features failed to register, and why.
    public static IDictionary Describe() {
      FeatureTable t = Table;
      var names = new List<object>();
      foreach (string n in t.Names) names.Add(n);
      var probs = new List<object>();
      lock (_gate) foreach (string p in _problems) probs.Add(p);
      return Json.Obj("commands", names, "problems", probs);
    }

    /// A pushed event: {"ev": ev, ...fields}. Use it for anything a feature reports unasked.
    public static void Event(string ev, IDictionary fields) {
      var o = new Dictionary<string, object>(StringComparer.Ordinal);
      o["ev"] = ev;
      if (fields != null) foreach (DictionaryEntry kv in fields) o[(string)kv.Key] = kv.Value;
      Program.Emit(o);
    }
  }
}
