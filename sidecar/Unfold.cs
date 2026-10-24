// Unfold.cs - what the unfold animation needs to hear from Windows that Electron cannot tell it
// (lane unfold-unlock, 2026-10-23).
//
// WHY: the Unfold feature (lib/features/unfold.js) plays a full-screen unfold when the screen
// comes back: on unlock, on wake and on lid open. It also puts up a screen cover that any key or
// mouse input must reveal at once. Electron's powerMonitor already gives main lock / unlock /
// suspend / resume. What it does not give, and this file does:
//   1. the display going off / on / dim (GUID_CONSOLE_DISPLAY_STATE),
//   2. the lid closing and opening (GUID_LIDSWITCH_STATE_CHANGE),
//   3. "some key or mouse input happened" while the cover is up (GetLastInputInfo), which needs
//      no hook: the cover is click-through and the keyboard is never captured.
// Suspend / resume are heard here too, so the feature has one ordered stream for all of it.
//
// WHAT: feature `unfold`, four commands, all on the ui lane:
//   unfold.watch {on}       a hidden top-level window on the message-loop thread (the ui lane IS
//                           that thread, the same as Battery's and TopbarStats' watch windows),
//                           registered for the display and lid settings. It pushes
//                           {ev:'unfold', what:'display', state:'off'|'on'|'dim', initial} and
//                           {ev:'unfold', what:'lid', open, initial}; `initial` marks the CURRENT
//                           state Windows sends right after registering (not a change), and a
//                           repeat of the same state is never pushed again. It also pushes
//                           {what:'suspend'} and {what:'resume'} (Windows sends two resume
//                           messages on a resume a person caused: they become ONE resume).
//                           A registration Windows refuses is not an error: it is named in
//                           `reason` and the rest keeps working (a desktop PC has no lid).
//   unfold.input {on, token, maxMs, pollMs}
//                           baseline = GetLastInputInfo's tick, then a thread-pool timer every
//                           pollMs; the first time the tick moves it pushes {what:'input', token,
//                           afterMs} and stops; if maxMs passes first, {what:'inputEnd', token,
//                           why:'timeout'}. A new watch replaces the running one (the old one ends
//                           silently). Nothing ticks while no input watch is on.
//   unfold.state            {watching, display, lid, registered, reason, input:{on, token, sinceMs}}
//   unfold.simulate {what, state?, open?, token?}
//                           TEST ONLY, passive sidecar only: pushes exactly what the real path
//                           would, plus simulated:true.
// The ui lane, for all four: the window must be created, pumped and destroyed on the
// message-loop thread, and every handler here is a few field writes (no I/O, no waits), so it
// never holds up the bar's latency-critical work. Keeping input/state/simulate on the same lane
// also keeps their order with the watch: a simulated input and a new input watch never race.
//
// PASSIVE: every command here is read-only - registering for a notification and reading the
// last-input tick change nothing in Windows - so watch / input / state all run in a passive
// (test) sidecar. Nothing needs putting back at the next start for the same reason.
//
// SHUTDOWN: the sidecar has no per-feature shutdown hook (Program.RequestShutdown restores the
// shell and exits the process). Nothing here needs one: the process exit frees the power
// notification handles and the window, and the input timer runs on the thread pool, which dies
// with the process.
//
// PRIVACY: nothing here logs or pushes an app name, a window title or any input content - only
// states, times and the caller's own token.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Mantle {
  [MantleFeature]
  static class Unfold {
    public static void Register(FeatureTable t) {
      t.Add("unfold.watch", Lanes.Ui, Watch);
      t.Add("unfold.input", Lanes.Ui, Input);
      t.Add("unfold.state", Lanes.Ui, State);
      t.Add("unfold.simulate", Lanes.Ui, Simulate);
    }

    static class Native {
      [DllImport("user32.dll", SetLastError = true)]
      public static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid setting, int flags);
      [DllImport("user32.dll", SetLastError = true)]
      public static extern bool UnregisterPowerSettingNotification(IntPtr handle);

      [StructLayout(LayoutKind.Sequential)]
      public struct LASTINPUTINFO { public uint Size; public uint Time; }
      [DllImport("user32.dll", SetLastError = true)]
      public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

      public const int DEVICE_NOTIFY_WINDOW_HANDLE = 0;
      public const int WM_POWERBROADCAST = 0x0218;
      public const int PBT_APMSUSPEND = 0x0004;
      public const int PBT_APMRESUMESUSPEND = 0x0007;
      public const int PBT_APMRESUMEAUTOMATIC = 0x0012;
      public const int PBT_POWERSETTINGCHANGE = 0x8013;

      // Data: 0 off, 1 on, 2 dimmed.
      public static readonly Guid GUID_CONSOLE_DISPLAY_STATE = new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");
      // Data: 0 closed, 1 open.
      public static readonly Guid GUID_LIDSWITCH_STATE_CHANGE = new Guid("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
    }

    static void Emit(IDictionary fields) { Features.Event("unfold", fields); }

    // ------------------------------------------------------------ the watch window
    // Everything in this section runs on the message-loop thread: the commands are ui-lane, and
    // the window's WndProc runs there too, so these fields need no lock.

    sealed class WatchWindow : NativeWindow {
      public WatchWindow() {
        CreateParams cp = new CreateParams();
        cp.Caption = "Mantle unfold watch";
        cp.Style = unchecked((int)0x80000000);        // WS_POPUP: no frame, and it is never shown
        cp.ExStyle = 0x00000080 | 0x08000000;         // WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        // Top-level, NOT message-only: suspend/resume are broadcasts, and Windows does not send
        // broadcasts to message-only windows.
        CreateHandle(cp);
      }

      protected override void WndProc(ref Message m) {
        if (m.Msg == Native.WM_POWERBROADCAST) {
          // Never let a throw out of a WndProc: it would go to the thread-exception path.
          try { OnBroadcast(m.WParam.ToInt64(), m.LParam); }
          catch (Exception ex) { Program.EmitLog("warn", "unfold: a power notification could not be handled (" + ex.Message + ")"); }
          m.Result = new IntPtr(1);
          return;
        }
        base.WndProc(ref m);
      }
    }

    static WatchWindow _win;
    static readonly List<IntPtr> _regs = new List<IntPtr>();
    static readonly List<string> _registered = new List<string>();
    static string _reason;
    static string _display;            // "on" | "off" | "dim" | null (not heard yet)
    static bool _displaySeen;          // the first display message after registering is the initial one
    static object _lid;                // boxed bool: true open, false closed; null = not heard yet
    static bool _lidSeen;
    static string _lastPower;          // "suspend" | "resume" | null: turns Windows' two resumes into one

    static string Watch(Dictionary<string, object> req, ref object result) {
      if (!Json.HasKey(req, "on")) return "unfold.watch needs on: true or false";
      if (!Json.GetBool(req, "on", false)) {
        StopWatch();
        result = StateObj();
        return null;
      }
      if (_win == null) {
        WatchWindow w;
        try { w = new WatchWindow(); }
        catch (Exception ex) { return "unfold.watch could not start: the hidden watch window could not be made (" + ex.Message + ")"; }
        _win = w;
        _regs.Clear();
        _registered.Clear();
        _display = null; _displaySeen = false;
        _lid = null; _lidSeen = false;
        _lastPower = null;
        // Suspend and resume reach every top-level window: nothing to register.
        _registered.Add("power");
        var reasons = new List<string>();
        RegisterSetting(Native.GUID_CONSOLE_DISPLAY_STATE, "display", "screen on, off and dim events", reasons);
        RegisterSetting(Native.GUID_LIDSWITCH_STATE_CHANGE, "lid", "lid events", reasons);
        _reason = reasons.Count == 0 ? null : string.Join("; ", reasons.ToArray());
        if (_reason != null) Program.EmitLog("warn", "unfold: " + _reason);
      }
      result = StateObj();
      return null;
    }

    static void RegisterSetting(Guid setting, string name, string words, List<string> reasons) {
      Guid g = setting;
      IntPtr h = Native.RegisterPowerSettingNotification(_win.Handle, ref g, Native.DEVICE_NOTIFY_WINDOW_HANDLE);
      if (h == IntPtr.Zero) {
        reasons.Add(words + " are not available: Windows refused the notification (Win32 error " + Marshal.GetLastWin32Error() + ")");
        return;
      }
      _regs.Add(h);
      _registered.Add(name);
    }

    static void StopWatch() {
      foreach (IntPtr h in _regs) {
        try { Native.UnregisterPowerSettingNotification(h); } catch (Exception) { }
      }
      _regs.Clear();
      _registered.Clear();
      if (_win != null) {
        try { _win.DestroyHandle(); } catch (Exception) { }
        _win = null;
      }
      _reason = null;
      _display = null; _displaySeen = false;
      _lid = null; _lidSeen = false;
      _lastPower = null;
    }

    static void OnBroadcast(long what, IntPtr data) {
      if (_win == null) return;
      if (what == Native.PBT_APMSUSPEND) {
        _lastPower = "suspend";
        Emit(Json.Obj("what", "suspend"));
      } else if (what == Native.PBT_APMRESUMEAUTOMATIC || what == Native.PBT_APMRESUMESUSPEND) {
        // A resume a person caused sends RESUMEAUTOMATIC and then RESUMESUSPEND: push one.
        if (_lastPower == "resume") return;
        _lastPower = "resume";
        Emit(Json.Obj("what", "resume"));
      } else if (what == Native.PBT_POWERSETTINGCHANGE && data != IntPtr.Zero) {
        // POWERBROADCAST_SETTING: Guid (16 bytes), DataLength (4), Data (a DWORD for both of ours).
        Guid g = (Guid)Marshal.PtrToStructure(data, typeof(Guid));
        if (Marshal.ReadInt32(data, 16) < 4) return;
        int v = Marshal.ReadInt32(data, 20);
        if (g == Native.GUID_CONSOLE_DISPLAY_STATE) {
          string st = v == 0 ? "off" : v == 1 ? "on" : v == 2 ? "dim" : null;
          if (st == null) { Program.EmitLog("warn", "unfold: Windows sent a display state this does not know (" + v + "); ignored"); return; }
          bool initial = !_displaySeen;
          _displaySeen = true;
          // Windows sends the CURRENT state on registration: that one is `initial`, not a change.
          if (!initial && st == _display) return;
          _display = st;
          Emit(Json.Obj("what", "display", "state", st, "initial", initial));
        } else if (g == Native.GUID_LIDSWITCH_STATE_CHANGE) {
          bool open = v != 0;
          bool initial = !_lidSeen;
          _lidSeen = true;
          if (!initial && _lid != null && (bool)_lid == open) return;
          _lid = open;
          Emit(Json.Obj("what", "lid", "open", open, "initial", initial));
        }
      }
    }

    // ------------------------------------------------------------ the input watch
    // The timer callback runs on the thread pool; everything about the running watch is behind
    // _inGate. A watch that is replaced or stopped is simply no longer _in, and its timer ends
    // without a word.

    sealed class InputWatch {
      public int Token, StartTick, MaxMs, PollMs;
      public uint Baseline;
      public System.Threading.Timer Timer;
    }

    static readonly object _inGate = new object();
    static InputWatch _in;

    static bool LastInput(out uint tick, out int err) {
      var li = new Native.LASTINPUTINFO();
      li.Size = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO));
      if (Native.GetLastInputInfo(ref li)) { tick = li.Time; err = 0; return true; }
      tick = 0;
      err = Marshal.GetLastWin32Error();
      return false;
    }

    static int Clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

    static string Input(Dictionary<string, object> req, ref object result) {
      if (!Json.HasKey(req, "on")) return "unfold.input needs on: true or false";
      if (!Json.GetBool(req, "on", false)) {
        InputWatch old;
        lock (_inGate) { old = _in; _in = null; }
        if (old != null && old.Timer != null) old.Timer.Dispose();
        result = Json.Obj("watching", false, "token", null, "pollMs", null, "maxMs", null);
        return null;
      }
      var w = new InputWatch();
      w.Token = Json.GetInt(req, "token", 0);
      w.MaxMs = Clamp(Json.GetInt(req, "maxMs", 5000), 50, 1800000);
      w.PollMs = Clamp(Json.GetInt(req, "pollMs", 16), 8, 250);
      w.StartTick = Environment.TickCount;     // GetLastInputInfo's clock (GetTickCount)
      int err;
      if (!LastInput(out w.Baseline, out err))
        return "unfold.input could not start: Windows would not say when the last key or mouse input was (GetLastInputInfo failed, Win32 error " + err + ")";
      InputWatch prev;
      lock (_inGate) {
        prev = _in;
        _in = w;
        // Made inside the lock, so a first tick waits for the lock and always sees w.Timer set.
        w.Timer = new System.Threading.Timer(InputTick, w, w.PollMs, w.PollMs);
      }
      if (prev != null && prev.Timer != null) prev.Timer.Dispose();
      result = Json.Obj("watching", true, "token", w.Token, "baseline", (long)w.Baseline,
                        "pollMs", w.PollMs, "maxMs", w.MaxMs);
      return null;
    }

    static void InputTick(object state) {
      var w = (InputWatch)state;
      IDictionary ev = null;
      try {
        lock (_inGate) {
          if (_in != w) return;               // replaced or stopped: end silently
          uint now; int err;
          int elapsed = unchecked(Environment.TickCount - w.StartTick);
          if (!LastInput(out now, out err)) {
            ev = Json.Obj("what", "inputEnd", "token", w.Token, "why", "error",
                          "reason", "Windows stopped saying when the last key or mouse input was (GetLastInputInfo failed, Win32 error " + err + ")");
          } else if (now != w.Baseline) {
            int after = unchecked((int)now - w.StartTick);
            ev = Json.Obj("what", "input", "token", w.Token, "afterMs", after < 0 ? 0 : after);
          } else if (elapsed >= w.MaxMs) {
            ev = Json.Obj("what", "inputEnd", "token", w.Token, "why", "timeout");
          }
          if (ev == null) return;
          _in = null;
        }
        w.Timer.Dispose();
        Emit(ev);
      } catch (Exception ex) {
        // A thread-pool exception would end the process: report it instead.
        Program.EmitLog("warn", "unfold: the input watch failed (" + ex.GetType().Name + ": " + ex.Message + ")");
      }
    }

    static IDictionary InputObj() {
      lock (_inGate) {
        if (_in == null) return Json.Obj("on", false, "token", null, "sinceMs", null);
        int since = unchecked(Environment.TickCount - _in.StartTick);
        return Json.Obj("on", true, "token", _in.Token, "sinceMs", since < 0 ? 0 : since);
      }
    }

    // ------------------------------------------------------------ state + simulate

    static IDictionary StateObj() {
      return Json.Obj("watching", _win != null,
                      "display", _display,
                      "lid", _lid == null ? null : ((bool)_lid ? "open" : "closed"),
                      "registered", new List<string>(_registered),
                      "reason", _reason,
                      "input", InputObj());
    }

    static string State(Dictionary<string, object> req, ref object result) {
      result = StateObj();
      return null;
    }

    static string Simulate(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return "unfold.simulate is for tests: only a passive (test) sidecar takes it";
      string what = Json.GetString(req, "what");
      bool endedWatch = false;
      switch (what) {
        case "display": {
          string st = Json.GetString(req, "state");
          if (st != "on" && st != "off" && st != "dim") return "unfold.simulate display needs state: on, off or dim";
          _display = st;
          _displaySeen = true;
          Emit(Json.Obj("what", "display", "state", st, "initial", false, "simulated", true));
          break;
        }
        case "lid": {
          if (!Json.HasKey(req, "open")) return "unfold.simulate lid needs open: true or false";
          bool open = Json.GetBool(req, "open", true);
          _lid = open;
          _lidSeen = true;
          Emit(Json.Obj("what", "lid", "open", open, "initial", false, "simulated", true));
          break;
        }
        case "input": {
          InputWatch ended = null;
          int token;
          int after = 0;
          lock (_inGate) {
            if (Json.HasKey(req, "token")) token = Json.GetInt(req, "token", 0);
            else if (_in != null) token = _in.Token;
            else return "unfold.simulate input needs a token (no input watch is running)";
            // A real input ends the running watch for that token: so does this one.
            if (_in != null && _in.Token == token) {
              ended = _in;
              _in = null;
              after = unchecked(Environment.TickCount - ended.StartTick);
              if (after < 0) after = 0;
            }
          }
          if (ended != null) { ended.Timer.Dispose(); endedWatch = true; }
          Emit(Json.Obj("what", "input", "token", token, "afterMs", after, "simulated", true));
          break;
        }
        case "suspend":
          _lastPower = "suspend";
          Emit(Json.Obj("what", "suspend", "simulated", true));
          break;
        case "resume":
          _lastPower = "resume";
          Emit(Json.Obj("what", "resume", "simulated", true));
          break;
        default:
          return "unfold.simulate needs what: display, lid, input, suspend or resume";
      }
      result = Json.Obj("simulated", what, "endedInputWatch", endedWatch);
      return null;
    }
  }
}
