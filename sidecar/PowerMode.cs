// PowerMode.cs - `powermode.*`: Windows 11's power mode (Best power efficiency / Balanced /
// Best performance) for the quick-settings panel (osd lane, wave 3, 2026-09-24).
//
// WHAT WINDOWS CALLS IT. Settings > System > Power's "Power mode" is a power-scheme OVERLAY
// laid over the Balanced plan. powrprof.dll exports the switch Settings itself uses:
// PowerGetEffectiveOverlayScheme / PowerSetActiveOverlayScheme. An overlay is kept per power
// source (HKLM ...\Power\User\PowerSchemes: ActiveOverlayAcPowerScheme / ...DcPowerScheme), and
// a set writes the overlay for the source the machine is on now - the same thing the Settings
// dropdown does, which is why the panel says "on battery" / "plugged in" beside the choice.
//
// MEASURED ON OWEN'S MACHINE (2026-09-24, Windows 11 25H2 26200.9550):
//   - the overlays registered here: 961cc777-2547-4f9d-8174-7d86181b8a7a ("Better Battery-life
//     Overlay" = Best power efficiency), ded574b5-45a0-4f42-8737-46345c09c238 ("Max Performance
//     Overlay" = Best performance), 3af9b8d9-7c97-431d-ad78-34a8bfea439f ("High Performance
//     Overlay", Windows 10's "Better performance" slider stop, which Windows 11 Settings no longer
//     offers); Balanced is no overlay at all: 00000000-0000-0000-0000-000000000000.
//   - ActiveOverlayAcPowerScheme and ActiveOverlayDcPowerScheme are both EMPTY (= Balanced), and
//     the effective overlay reads 00000000-... on AC.
//   - THE ACTIVE PLAN IS NOT BALANCED: 44444444-4444-4444-4444-444444444452 "Hone Ultimate Power
//     Plan V5" (a third-party tuning plan). Windows applies an overlay only on top of Balanced
//     (381b4222-f694-41f0-9685-ff5bb260df2e) and Settings hides the dropdown on any other plan, so
//     on this machine today the control is shown muted with that reason, and a set is refused
//     with it rather than written to a registry value Windows would ignore.
//
// LIVE UPDATES. Two powrprof callbacks, no polling: PowerRegisterForEffectivePowerModeNotifications
// (fires on any overlay or plan-driven mode change, including one made in Settings) and
// PowerSettingRegisterNotification(GUID_ACTIVE_POWERSCHEME) (a plan switch). Either one re-reads
// on a pool thread and pushes {ev:"powermode", ...state} when the state changed. Listening changes
// nothing, so it runs in --passive too.
//
// TESTS (the brief): a set in --passive is allowed only when it asks for the mode already in
// effect (a same-value write); anything else is refused with the reason, before powrprof is called.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class PowerMode {
    static class Native {
      [DllImport("powrprof.dll")] public static extern uint PowerGetEffectiveOverlayScheme(out Guid overlay);
      [DllImport("powrprof.dll")] public static extern uint PowerGetActualOverlayScheme(out Guid overlay);
      [DllImport("powrprof.dll")] public static extern uint PowerSetActiveOverlayScheme(Guid overlay);
      [DllImport("powrprof.dll")] public static extern uint PowerGetActiveScheme(IntPtr rootKey, out IntPtr scheme);
      [DllImport("powrprof.dll")] public static extern uint PowerReadFriendlyName(IntPtr rootKey, ref Guid scheme,
          IntPtr subGroup, IntPtr setting, byte[] buffer, ref uint size);
      [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
      [DllImport("powrprof.dll")] public static extern uint PowerEnumerate(IntPtr rootKey, IntPtr scheme, IntPtr subGroup,
          uint accessFlags, uint index, byte[] buffer, ref uint size);
      [DllImport("powrprof.dll")] public static extern uint PowerSetActiveScheme(IntPtr rootKey, ref Guid scheme);

      [StructLayout(LayoutKind.Sequential)]
      public struct SYSTEM_POWER_STATUS {
        public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
        public int BatteryLifeTime, BatteryFullLifeTime;
      }
      [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);

      [UnmanagedFunctionPointer(CallingConvention.StdCall)]
      public delegate void EffectiveModeCallback(int mode, IntPtr context);
      [DllImport("powrprof.dll")] public static extern int PowerRegisterForEffectivePowerModeNotifications(
          uint version, EffectiveModeCallback callback, IntPtr context, out IntPtr handle);
      [DllImport("powrprof.dll")] public static extern int PowerUnregisterFromEffectivePowerModeNotifications(IntPtr handle);

      [UnmanagedFunctionPointer(CallingConvention.StdCall)]
      public delegate uint DeviceNotifyCallback(IntPtr context, uint type, IntPtr setting);
      [StructLayout(LayoutKind.Sequential)]
      public struct DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { public DeviceNotifyCallback Callback; public IntPtr Context; }
      [DllImport("powrprof.dll")] public static extern uint PowerSettingRegisterNotification(ref Guid setting, uint flags,
          ref DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS recipient, out IntPtr handle);
      [DllImport("powrprof.dll")] public static extern uint PowerSettingUnregisterNotification(IntPtr handle);
    }

    public static readonly Guid BalancedPlan = new Guid("381b4222-f694-41f0-9685-ff5bb260df2e");
    public static readonly Guid Efficiency = new Guid("961cc777-2547-4f9d-8174-7d86181b8a7a");
    public static readonly Guid Balanced = Guid.Empty;
    public static readonly Guid Performance = new Guid("ded574b5-45a0-4f42-8737-46345c09c238");
    static readonly Guid Win10Better = new Guid("3af9b8d9-7c97-431d-ad78-34a8bfea439f");
    static readonly Guid ActivePowerSchemeSetting = new Guid("31F9F286-5084-42FE-B720-2B0264993763");
    const uint EffectivePowerModeV2 = 2, DeviceNotifyCallbackFlag = 2;

    public static void Register(FeatureTable t) {
      t.Add("powermode.get", Lanes.Qs, Get);       // the panel's lane: the first read loads powrprof (90 ms here)
      t.Add("powermode.set", Lanes.Qs, Set);
      t.Add("powermode.watch", Lanes.Qs, Watch);
      t.Add("powermode.plan", Lanes.Qs, SetPlan);    // switch the power PLAN (Owen's click only)
    }

    // ------------------------------------------------------------------ reading

    public static string ModeOf(Guid overlay) {
      if (overlay == Efficiency) return "efficiency";
      if (overlay == Balanced) return "balanced";
      if (overlay == Performance) return "performance";
      if (overlay == Win10Better) return "better";
      return "other";
    }

    static Guid OverlayFor(string mode) {
      switch (mode) {
        case "efficiency": return Efficiency;
        case "balanced": return Balanced;
        case "performance": return Performance;
      }
      throw new ArgumentException("mode");
    }

    static string PlanName(Guid plan) {
      try {
        uint size = 0;
        Native.PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, null, ref size);
        if (size == 0 || size > 4096) return null;
        var buf = new byte[size];
        if (Native.PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, buf, ref size) != 0) return null;
        return Encoding.Unicode.GetString(buf).TrimEnd('\0');
      } catch (Exception) { return null; }
    }

    // ------------------------------------------------------------------ the power PLANS
    //
    // WHY (2026-09-24): Owen's active plan is "Hone Ultimate Power Plan V5", and Windows applies a
    // power MODE only on Balanced, so the mode switch alone is a dead control on his machine. The
    // panel offers the installed plans instead (PowerEnumerate + PowerReadFriendlyName, the list
    // Control Panel > Power Options shows) and the modes once Balanced is chosen.
    const uint AccessScheme = 16;              // POWER_DATA_ACCESSOR ACCESS_SCHEME

    static bool ActivePlan(out Guid plan, out uint rc) {
      plan = Guid.Empty;
      IntPtr p;
      rc = Native.PowerGetActiveScheme(IntPtr.Zero, out p);
      if (rc != 0) return false;
      plan = (Guid)Marshal.PtrToStructure(p, typeof(Guid));
      Native.LocalFree(p);
      return true;
    }

    /// Every installed power plan, in Windows' order: [{guid, name, active, balanced}].
    public static List<object> Plans(Guid active) {
      var list = new List<object>();
      var buf = new byte[16];
      for (uint i = 0; i < 64; i++) {
        uint size = 16;
        if (Native.PowerEnumerate(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, AccessScheme, i, buf, ref size) != 0) break;   // 259 = no more
        var g = new Guid(buf);
        list.Add(Json.Obj("guid", g.ToString(), "name", PlanName(g) ?? g.ToString(), "active", g == active, "balanced", g == BalancedPlan));
      }
      return list;
    }

    /// The whole picture the panel draws: mode, plan, power source, and - when a mode cannot be
    /// chosen - why, in words the panel shows as they are.
    public static IDictionary Read() {
      var sw = Stopwatch.StartNew();
      IntPtr p;
      uint rc = Native.PowerGetActiveScheme(IntPtr.Zero, out p);
      if (rc != 0)
        return Json.Obj("ok", false, "mode", null, "available", false, "ms", sw.ElapsedMilliseconds,
                        "reason", "Windows would not say which power plan is active (error " + rc + ")");
      Guid plan = (Guid)Marshal.PtrToStructure(p, typeof(Guid));
      Native.LocalFree(p);
      string planName = PlanName(plan);
      bool onBalanced = plan == BalancedPlan;
      List<object> plans = Plans(plan);

      Guid overlay;
      uint orc = Native.PowerGetEffectiveOverlayScheme(out overlay);
      if (orc != 0)
        return Json.Obj("ok", false, "mode", null, "available", false, "ms", sw.ElapsedMilliseconds,
                        "plan", Json.Obj("guid", plan.ToString(), "name", planName, "balanced", onBalanced), "plans", plans,
                        "reason", "Windows would not say which power mode is in effect (error " + orc + ")");

      Native.SYSTEM_POWER_STATUS ps;
      string source = Native.GetSystemPowerStatus(out ps)
        ? (ps.ACLineStatus == 1 ? "ac" : ps.ACLineStatus == 0 ? "battery" : "unknown") : "unknown";
      bool saver = false;
      try { saver = (ps.SystemStatusFlag & 1) != 0; } catch (Exception) { }

      string mode = ModeOf(overlay);
      string reason = null;
      if (!onBalanced)
        reason = "Power mode works only on the Balanced power plan, and this PC is on \"" +
                 (planName ?? plan.ToString()) + "\". Choose the Balanced plan to use it";
      return Json.Obj("ok", true, "mode", mode, "overlay", overlay.ToString(), "available", onBalanced,
                      "plan", Json.Obj("guid", plan.ToString(), "name", planName, "balanced", onBalanced), "plans", plans,
                      "source", source, "saver", saver, "ms", sw.ElapsedMilliseconds, "reason", reason);
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      result = Read();
      return null;
    }

    // ------------------------------------------------------------------ the switch

    /// {mode: "efficiency"|"balanced"|"performance"} -> {ok, mode (asked), state (READ BACK), reason}.
    /// ok means the read-back shows the mode asked for, never merely that powrprof returned 0.
    static string Set(Dictionary<string, object> req, ref object result) {
      string want = Json.GetString(req, "mode");
      if (want != "efficiency" && want != "balanced" && want != "performance")
        return "powermode.set needs mode: \"efficiency\", \"balanced\" or \"performance\" (got " +
               (want == null ? "nothing" : "\"" + want + "\"") + ")";
      IDictionary before = Read();
      if (!(bool)before["ok"]) {
        result = Json.Obj("ok", false, "mode", want, "state", before, "reason", before["reason"]);
        return null;
      }
      if (!(bool)before["available"]) {
        result = Json.Obj("ok", false, "mode", want, "state", before, "reason", before["reason"]);
        return null;
      }
      bool same = (string)before["mode"] == want;
      if (Program.Passive && !same) {
        result = Json.Obj("ok", false, "mode", want, "state", before,
                          "reason", FeatureTable.PassiveRefusal + ": it would have changed the power mode from " +
                                    before["mode"] + " to " + want);
        return null;
      }
      var sw = Stopwatch.StartNew();
      uint rc = Native.PowerSetActiveOverlayScheme(OverlayFor(want));
      long ms = sw.ElapsedMilliseconds;
      IDictionary after = Read();
      bool took = rc == 0 && (bool)after["ok"] && (string)after["mode"] == want;
      string why = null;
      if (rc != 0) why = "Windows refused the power mode change (error " + rc + ")";
      else if (!took) why = "Windows accepted the change but still reports " + (after["mode"] ?? "no mode") +
                            (after["reason"] != null ? " (" + after["reason"] + ")" : "");
      result = Json.Obj("ok", took, "mode", want, "same", same, "setMs", ms, "state", after, "reason", why);
      if (took && !same) Changed("set");
      return null;
    }

    /// {plan: guid} -> {ok, plan, same, setMs, state (READ BACK), reason}: make an installed plan the
    /// active one (PowerSetActiveScheme, what Control Panel > Power Options does). ok means the
    /// read-back names the plan asked for. In --passive only the plan already active may be "set"
    /// (a same-value write: sidecar/test-osd.js does exactly that, confirmed by powercfg).
    static string SetPlan(Dictionary<string, object> req, ref object result) {
      string raw = Json.GetString(req, "plan");
      Guid want;
      try { want = new Guid(raw ?? ""); }
      catch (Exception) {
        return "powermode.plan needs plan: the GUID of an installed power plan (got " + (raw == null ? "nothing" : "\"" + raw + "\"") + ")";
      }
      Guid active; uint rc0;
      if (!ActivePlan(out active, out rc0)) {
        result = Json.Obj("ok", false, "plan", want.ToString(), "state", Read(),
                          "reason", "Windows would not say which power plan is active (error " + rc0 + ")");
        return null;
      }
      string wantName = null;
      foreach (object o in Plans(active)) {
        var d = (IDictionary)o;
        if ((string)d["guid"] == want.ToString()) { wantName = (string)d["name"]; break; }
      }
      if (wantName == null) return "powermode.plan: no installed power plan has the GUID " + want;
      bool same = want == active;
      if (Program.Passive && !same) {
        result = Json.Obj("ok", false, "plan", want.ToString(), "same", false, "state", Read(),
                          "reason", FeatureTable.PassiveRefusal + ": it would have switched the power plan from \"" +
                                    (PlanName(active) ?? active.ToString()) + "\" to \"" + wantName + "\"");
        return null;
      }
      var sw = Stopwatch.StartNew();
      uint rc = Native.PowerSetActiveScheme(IntPtr.Zero, ref want);
      long ms = sw.ElapsedMilliseconds;
      Guid after; uint rc1;
      bool read = ActivePlan(out after, out rc1);
      bool took = rc == 0 && read && after == want;
      string why = null;
      if (rc != 0) why = "Windows refused to switch to \"" + wantName + "\" (error " + rc + ")";
      else if (!read) why = "Windows accepted the switch but would not say which plan is active now (error " + rc1 + ")";
      else if (!took) why = "Windows accepted the switch but still reports \"" + (PlanName(after) ?? after.ToString()) + "\"";
      result = Json.Obj("ok", took, "plan", want.ToString(), "same", same, "setMs", ms, "state", Read(), "reason", why);
      if (took && !same) Changed("plan");
      return null;
    }

    // ------------------------------------------------------------------ live updates

    static readonly object _lock = new object();
    static IntPtr _modeHandle = IntPtr.Zero, _planHandle = IntPtr.Zero;
    static Native.EffectiveModeCallback _modeCb;      // kept alive: powrprof holds the pointer
    static Native.DeviceNotifyCallback _planCb;
    static string _lastSig;
    static int _pushes, _callbacks, _pending;

    static string Sig(IDictionary s) {
      var plan = s["plan"] as IDictionary;
      return s["ok"] + "|" + s["mode"] + "|" + s["available"] + "|" + s["source"] + "|" + s["saver"] + "|" +
             (plan != null ? plan["guid"] : null) + "|" + s["reason"];
    }

    static void Changed(string via) {
      Interlocked.Increment(ref _callbacks);
      // A burst of callbacks (a plan switch fires both) becomes one read on the pool.
      if (Interlocked.Exchange(ref _pending, 1) == 1) return;
      ThreadPool.QueueUserWorkItem(delegate (object o) {
        Thread.Sleep(30);
        Interlocked.Exchange(ref _pending, 0);
        IDictionary s;
        try { s = Read(); } catch (Exception ex) {
          s = Json.Obj("ok", false, "mode", null, "available", false, "reason", "the power mode could not be read (" + ex.Message + ")");
        }
        string sig = Sig(s);
        lock (_lock) { if (sig == _lastSig) return; _lastSig = sig; }
        Interlocked.Increment(ref _pushes);
        var ev = Json.Obj("via", (object)via);
        foreach (DictionaryEntry kv in s) ev[kv.Key] = kv.Value;
        Features.Event("powermode", ev);
      });
    }

    /// {on} -> start or stop both listeners. Idempotent; the reply says what is listening and, if a
    /// listener could not start, why (the panel then re-reads while it is open instead).
    static string Watch(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      string modeWhy = null, planWhy = null;
      lock (_lock) {
        if (!on) {
          if (_modeHandle != IntPtr.Zero) { try { Native.PowerUnregisterFromEffectivePowerModeNotifications(_modeHandle); } catch (Exception) { } }
          if (_planHandle != IntPtr.Zero) { try { Native.PowerSettingUnregisterNotification(_planHandle); } catch (Exception) { } }
          _modeHandle = _planHandle = IntPtr.Zero;
          _lastSig = null;
          result = Json.Obj("ok", true, "watching", false, "pushes", _pushes, "callbacks", _callbacks, "reason", null);
          return null;
        }
        if (_modeHandle == IntPtr.Zero) {
          if (_modeCb == null) _modeCb = delegate (int mode, IntPtr ctx) { Changed("mode"); };
          try {
            IntPtr h;
            int hr = Native.PowerRegisterForEffectivePowerModeNotifications(EffectivePowerModeV2, _modeCb, IntPtr.Zero, out h);
            if (hr == 0) _modeHandle = h;
            else modeWhy = "Windows refused the power-mode listener (HRESULT 0x" + hr.ToString("X8") + ")";
          } catch (Exception ex) { modeWhy = "the power-mode listener is not available (" + ex.GetType().Name + ")"; }
        }
        if (_planHandle == IntPtr.Zero) {
          if (_planCb == null) _planCb = delegate (IntPtr ctx, uint type, IntPtr setting) { Changed("plan"); return 0; };
          try {
            var p = new Native.DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS();
            p.Callback = _planCb;
            p.Context = IntPtr.Zero;
            Guid g = ActivePowerSchemeSetting;
            IntPtr h;
            uint rc = Native.PowerSettingRegisterNotification(ref g, DeviceNotifyCallbackFlag, ref p, out h);
            if (rc == 0) _planHandle = h;
            else planWhy = "Windows refused the power-plan listener (error " + rc + ")";
          } catch (Exception ex) { planWhy = "the power-plan listener is not available (" + ex.GetType().Name + ")"; }
        }
      }
      IDictionary now = Read();
      lock (_lock) _lastSig = Sig(now);
      bool all = _modeHandle != IntPtr.Zero && _planHandle != IntPtr.Zero;
      result = Json.Obj("ok", true, "watching", all, "mode", _modeHandle != IntPtr.Zero, "plan", _planHandle != IntPtr.Zero,
                        "state", now, "reason", all ? null : (modeWhy ?? planWhy));
      return null;
    }
  }
}
