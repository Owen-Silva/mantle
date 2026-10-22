// HotCorners.cs - `hotcorners.desktop`: Show desktop for the hot corners (lane corners, 2026-09-27).
//
// WHY: Mantle hides the Windows taskbar, and with it the sliver at its right end that shows the
// desktop. The bottom-right hot corner (lib/features/corners.js) gives that back. It asks the shell
// for EXACTLY what the sliver and Win+D do - IShellDispatch4.ToggleDesktop on Shell.Application -
// so it minimises every window and, asked again, restores them, with Windows' own bookkeeping.
// No key is sent (never SendInput Win+D) and no window is touched by Mantle itself.
//
// The shell object is created and invoked late-bound (IDispatch), so no interop assembly or
// `dynamic` is needed; it is released before the reply.
//
//   {dryRun:true}  creates Shell.Application (which changes nothing) and answers what it would call
//   {}             calls ToggleDesktop. Refused in --passive: a test sidecar never minimises the user's windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Mantle {
  [MantleFeature]
  static class HotCorners {
    public static void Register(FeatureTable t) {
      t.Add("hotcorners.desktop", Lanes.Ui, Desktop);   // one in-process shell call: quick, and the ui thread is STA
    }

    static string Desktop(Dictionary<string, object> req, ref object result) {
      bool dry = Json.GetBool(req, "dryRun", false);
      var sw = Stopwatch.StartNew();
      Type type = Type.GetTypeFromProgID("Shell.Application", false);
      if (type == null) return "Shell.Application is not registered on this machine, so Show desktop cannot run";
      object shell = null;
      try {
        try { shell = Activator.CreateInstance(type); }
        catch (Exception e) { return "could not create Shell.Application (" + e.Message + "), so Show desktop cannot run"; }
        if (dry) {
          result = Json.Obj("ok", true, "dryRun", true, "wouldCall", "Shell.Application ToggleDesktop (IShellDispatch4)", "ms", sw.ElapsedMilliseconds);
          return null;
        }
        if (Program.Passive) return FeatureTable.PassiveRefusal + ": would have toggled Show desktop (minimise or restore every window)";
        try { type.InvokeMember("ToggleDesktop", BindingFlags.InvokeMethod, null, shell, null); }
        catch (TargetInvocationException e) { return "Shell.Application ToggleDesktop failed (" + (e.InnerException ?? e).Message + ")"; }
        catch (Exception e) { return "Shell.Application ToggleDesktop failed (" + e.Message + ")"; }
        result = Json.Obj("ok", true, "called", "Shell.Application ToggleDesktop (IShellDispatch4)", "ms", sw.ElapsedMilliseconds);
        return null;
      } finally {
        if (shell != null && Marshal.IsComObject(shell)) { try { Marshal.ReleaseComObject(shell); } catch (Exception) { /* gone */ } }
      }
    }
  }
}
