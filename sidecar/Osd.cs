// Osd.cs - `osd.*`: what Mantle's volume/brightness pop-up needs from the sidecar (osd lane,
// wave 3, 2026-09-24).
//
//   osd.watch {on}   brightness changes pushed as {ev:"osd", kind:"brightness", level, qsOpen, own}
//                    - from the brightness keys, adaptive brightness or Windows' slider. Its OWN
//                    WmiMonitorBrightnessEvent watcher: Display.ListenBrightness is a singleton the
//                    quick-settings watch starts and stops with the panel, and the pop-up needs
//                    changes while the panel is CLOSED.
//   osd.qs           {qsOpen, ownMsAgo}: is the quick-settings panel open (its watch lease is held),
//                    and how long since Mantle's own brightness set. The pop-up stays down for both:
//                    the open panel already shows the level, and a change Mantle made is not news.
//   osd.flyout       {found, host, reason}: READ-ONLY search for Windows' own volume/brightness
//                    flyout host. Mantle's pop-up is allowed on screen for a key press ONLY while
//                    that flyout is suppressed; nothing here hides it yet (see WHY NOT YET).
//
// WHY NOT YET (measured 2026-09-24, Windows 11 25H2 26200.9550): the Windows 10 host
// (NativeHWNDHost + DirectUIHWND in explorer.exe, what HideVolumeOSD minimised) does not exist on
// this build, and no top-level window of explorer.exe or ShellHost.exe looks like a flyout host at
// rest. A two-hour WinEvent watch of every process's windows (scratchpad watch-all.ps1) saw no
// flyout that could be tied to a volume key (none was pressed that we know of - and a test may not
// press one). THE ONE LEAD: explorer.exe creates a full-screen (1536x864) XamlExplorerHostIslandWindow
// on demand and shows it for 0.4-19 s at a time (5 times in 15 min, 14:06-14:20); it may be the flyout
// host or a light-dismiss layer for a taskbar menu - one volume-key press while the watch runs tells. Without the
// host there is nothing to hide, restore or prove, so the feature reports itself unhealthy for
// key presses rather than draw a second pop-up over Windows' own (the brief's rule).
//
// QS STATE IS READ BY REFLECTION from QuickSettings' private statics (_leaseEndTs, _brightnessSetTs):
// that file belongs to another lane, and these two numbers are exactly the facts wanted. If they
// are ever renamed the reply says "unknown" with the reason, and main treats the panel as closed.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class Osd {
    static class Native {
      [DllImport("user32.dll", CharSet = CharSet.Unicode)]
      public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    }

    public static void Register(FeatureTable t) {
      t.Add("osd.watch", Lanes.Slow, Watch);    // starting a WMI event watcher can take a while
      t.Add("osd.qs", Lanes.Ui, Qs);            // two field reads: fast
      t.Add("osd.flyout", Lanes.Ui, Flyout);    // FindWindowEx only
    }

    // ------------------------------------------------------------------ is the panel open

    static readonly FieldInfo _lease = typeof(QuickSettings).GetField("_leaseEndTs", BindingFlags.NonPublic | BindingFlags.Static);
    static readonly FieldInfo _bset = typeof(QuickSettings).GetField("_brightnessSetTs", BindingFlags.NonPublic | BindingFlags.Static);

    static IDictionary QsNow() {
      if (_lease == null)
        return Json.Obj("qsOpen", null, "ownMsAgo", null,
                        "reason", "QuickSettings no longer has _leaseEndTs, so the panel's state is unknown (treated as closed)");
      long lease = (long)_lease.GetValue(null);
      long now = Stopwatch.GetTimestamp();
      object own = null;
      if (_bset != null) {
        long ts = (long)_bset.GetValue(null);
        if (ts > 0) own = (now - ts) * 1000 / Stopwatch.Frequency;
      }
      return Json.Obj("qsOpen", lease > now, "ownMsAgo", own, "reason", null);
    }

    static string Qs(Dictionary<string, object> req, ref object result) {
      var r = QsNow();
      r["ok"] = true;
      result = r;
      return null;
    }

    // ------------------------------------------------------------------ brightness changes

    static readonly object _lock = new object();
    static ManagementEventWatcher _w;
    static int _events;

    static string Watch(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      string why = null;
      lock (_lock) {
        if (_w != null) {
          try { _w.Stop(); } catch (Exception) { }
          try { _w.Dispose(); } catch (Exception) { }
          _w = null;
        }
        if (on) {
          try {
            var w = new ManagementEventWatcher(new ManagementScope("root\\wmi"),
                                               new WqlEventQuery("SELECT * FROM WmiMonitorBrightnessEvent"));
            w.EventArrived += OnBrightness;
            w.Start();
            _w = w;
          } catch (Exception ex) {
            why = "brightness changes cannot be watched: WMI refused the event query (" + ex.GetType().Name + ": " + ex.Message.Trim() + ")";
          }
        }
      }
      result = Json.Obj("ok", why == null, "watching", on && why == null, "events", _events, "reason", why);
      return null;
    }

    static void OnBrightness(object sender, EventArrivedEventArgs e) {
      object level = null;
      try { level = Convert.ToInt32(e.NewEvent["Brightness"]); } catch (Exception) { }
      Interlocked.Increment(ref _events);
      var q = QsNow();
      var ev = Json.Obj("kind", "brightness", "level", level, "qsOpen", q["qsOpen"], "ownMsAgo", q["ownMsAgo"]);
      Features.Event("osd", ev);
    }

    // ------------------------------------------------------------------ Windows' own flyout

    static string Flyout(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op") ?? "find";
      if (op != "find") {
        if (Program.Passive) return FeatureTable.PassiveRefusal + ": it would have hidden or restored Windows' volume flyout";
        return "osd.flyout " + op + ": not built - Windows' flyout host was not found on this build, so there is nothing to hide or restore";
      }
      // The Windows 10 / 11 21H2 host: NativeHWNDHost with a DirectUIHWND child, in explorer.
      IntPtr h = IntPtr.Zero;
      while ((h = Native.FindWindowEx(IntPtr.Zero, h, "NativeHWNDHost", null)) != IntPtr.Zero) {
        if (Native.FindWindowEx(h, IntPtr.Zero, "DirectUIHWND", null) == IntPtr.Zero) continue;
        uint pid; Native.GetWindowThreadProcessId(h, out pid);
        string exe = null;
        try { exe = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
        if (exe != null && !exe.Equals("explorer", StringComparison.OrdinalIgnoreCase)) continue;
        result = Json.Obj("ok", true, "found", true, "host", "NativeHWNDHost", "hwnd", h.ToInt64().ToString(),
                          "visible", Native.IsWindowVisible(h), "suppressible", false,
                          "reason", "the Windows 10 flyout host is here, but hiding it is not built yet");
        return null;
      }
      result = Json.Obj("ok", true, "found", false, "host", null, "suppressible", false,
                        "reason", "Windows' own volume and brightness pop-up could not be found on this build of Windows " +
                                  "(no NativeHWNDHost flyout window in explorer), so it cannot be hidden and Mantle's " +
                                  "pop-up would appear on top of it");
      return null;
    }
  }
}
