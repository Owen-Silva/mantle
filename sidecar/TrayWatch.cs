// TrayWatch.cs - `traywatch`: keep Mantle's bar above the Windows taskbar when
// the taskbar comes back, WITHOUT EVER TOUCHING THE TASKBAR.
//
// THE PROBLEM. Mantle puts the real taskbar into auto-hide (an OS setting
// Explorer owns - see Taskbar.cs for why nothing else is allowed) and draws its
// own bar in the same corner of the screen. When the user pushes the mouse into
// that corner Explorer slides the taskbar back in, ON TOP, because it is
// topmost and was raised last. Mantle's bar disappears behind it and the shell
// looks broken.
//
// THE RULE THIS FILE OBEYS. The fix is NOT to hide, move, or re-order the
// taskbar. On 2026-09-21 a sidecar that did exactly that left the taskbar stuck
// hidden and cost a reboot. So this code never calls ShowWindow, never
// SetWindowPos's Shell_TrayWnd, never changes its state - it only WATCHES it,
// and raises A WINDOW THE CALLER ALREADY OWNS. Every Win32 call that can change
// anything takes barHwnd, never the tray's.
//
//   watch    SetWinEventHook, out-of-context, filtered to the tray's own thread
//            so we are not called for every window on the desktop.
//   act      SetWindowPos(bar, HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)
//            - z-order only, no move, no resize, no focus stolen.
//   tell     one {"ev":"tray","event":"tray",...} line, at most every 100 ms.
//
// WHY THE HOOK LIVES ON THE MESSAGE-LOOP THREAD: an out-of-context WinEvent
// hook is delivered by POSTING to the installing thread's queue. A thread with
// no pump never hears a thing, which is the classic silent failure here. The
// loop thread already pumps for the keyboard hook, so both live there.
//
// WHY THERE IS ALSO A TIMER: Explorer can restart. When it does, Shell_TrayWnd
// is a NEW window, our hook is bound to a thread that no longer exists, and no
// event will ever arrive again. The 2 s watchdog re-finds the tray and
// re-installs the hook - and doubles as the safety net for a visibility change
// the hook did not report.
using System;
using System.Globalization;
using System.Windows.Forms;

namespace Mantle {
  static class TrayWatch {
    const string TrayClass = "Shell_TrayWnd";
    const string SecondaryTrayClass = "Shell_SecondaryTrayWnd";
    const int MinEmitGapMs = 100;   // the protocol's "at most once per 100 ms"
    const int WatchdogMs = 2000;

    static Win32.WinEventProc _proc;   // static: the GC must never collect a live hook proc
    static IntPtr _hook = IntPtr.Zero;
    static IntPtr _bar = IntPtr.Zero;
    static IntPtr _tray = IntPtr.Zero;
    static Timer _flush;               // coalesces a burst of events into one line
    static Timer _watchdog;            // re-finds the tray, and polls as a safety net
    static int _lastEmitTick;
    static bool _everEmitted;
    static bool _lastVisible;
    static Win32.RECT _lastRect;

    public static bool Active { get { return _bar != IntPtr.Zero; } }

    /// hwnd null/0, or a window that is already gone, UNSUBSCRIBES - both are
    /// the caller saying "stop", and a dead hwnd is what a closed bar looks
    /// like. Returns null on success, or a refusal in plain words.
    public static string Subscribe(IntPtr bar, out bool watching) {
      watching = false;
      if (bar == IntPtr.Zero || !Win32.IsWindow(bar)) { Stop(); return null; }

      // THE ONE REFUSAL THAT MATTERS: never accept the taskbar as the window to
      // raise. Everything below calls SetWindowPos on it.
      string cls = Win32.GetClassName(bar);
      if (cls == TrayClass || cls == SecondaryTrayClass)
        return "traywatch: that window IS the Windows taskbar (" + cls + "), and this command " +
               "raises the window you give it - it may only ever be a window Mantle owns";

      Stop();          // re-subscribing is a replace, never two hooks at once
      _bar = bar;
      _everEmitted = false;
      _lastEmitTick = 0;

      FindTray(true);

      _watchdog = new Timer();
      _watchdog.Interval = WatchdogMs;
      _watchdog.Tick += OnWatchdog;
      _watchdog.Start();

      Flush();         // say what the tray is doing RIGHT NOW, not at the next move
      watching = true;
      return null;
    }

    /// Idempotent, and safe to call from the shutdown path: no stdout, no
    /// allocation that can throw, every step guarded on its own.
    public static void Stop() {
      try { if (_hook != IntPtr.Zero) Win32.UnhookWinEvent(_hook); } catch (Exception) { }
      _hook = IntPtr.Zero;
      _proc = null;
      try { if (_flush != null) { _flush.Stop(); _flush.Dispose(); } } catch (Exception) { }
      _flush = null;
      try { if (_watchdog != null) { _watchdog.Stop(); _watchdog.Dispose(); } } catch (Exception) { }
      _watchdog = null;
      _bar = IntPtr.Zero;
      _tray = IntPtr.Zero;
      _everEmitted = false;
    }

    // ------------------------------------------------------------- the watch

    /// (Re)find Shell_TrayWnd and bind the hook to the thread that owns it.
    static void FindTray(bool speakIfMissing) {
      IntPtr tray = IntPtr.Zero;
      try { tray = Win32.FindWindowW(TrayClass, null); } catch (Exception) { }
      if (tray == _tray && _hook != IntPtr.Zero) return;

      try { if (_hook != IntPtr.Zero) Win32.UnhookWinEvent(_hook); } catch (Exception) { }
      _hook = IntPtr.Zero;
      _tray = tray;

      if (tray == IntPtr.Zero) {
        if (speakIfMissing)
          Program.EmitLog("warn", "traywatch: no Shell_TrayWnd on this desktop yet, so the bar will only be " +
                                  "raised when one appears (the watchdog keeps looking every 2s)");
        return;
      }

      int pid;
      int tid = Win32.GetWindowThreadProcessId(tray, out pid);
      _proc = OnWinEvent;
      // SHOW..LOCATIONCHANGE covers shown, hidden, re-ordered and moved, which
      // is every way an auto-hidden taskbar can come back. Filtered to the
      // tray's own process AND thread: without that filter this proc would be
      // called for every object event on the desktop, which is a lot of
      // cross-process traffic for a bar.
      _hook = Win32.SetWinEventHook(Win32.EVENT_OBJECT_SHOW, Win32.EVENT_OBJECT_LOCATIONCHANGE,
                                    IntPtr.Zero, _proc, (uint)pid, (uint)tid, Win32.WINEVENT_OUTOFCONTEXT);
      if (_hook == IntPtr.Zero)
        Program.EmitLog("warn", "traywatch: the WinEvent hook could not be installed, so the bar is only " +
                                "raised by the 2s poll and may sit under the taskbar for a moment");
    }

    /// Runs on the message-loop thread. Must return fast: no I/O, no JSON.
    static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (idObject != Win32.OBJID_WINDOW) return;   // ignore buttons/caret inside the tray
      if (hwnd != _tray || _bar == IntPtr.Zero) return;
      Schedule();
    }

    static void OnWatchdog(object sender, EventArgs e) {
      if (_bar == IntPtr.Zero) return;
      if (!Win32.IsWindow(_bar)) { Stop(); return; }   // the bar went away: stop on our own
      if (_tray == IntPtr.Zero || !Win32.IsWindow(_tray) || _hook == IntPtr.Zero) FindTray(false);
      Schedule();   // a change the hook did not report still gets noticed within 2 s
    }

    /// Emit now if the last line was more than 100 ms ago, otherwise arm a
    /// one-shot timer for the remainder. Flush re-reads the tray, so the
    /// delayed line always carries the CURRENT state, never a stale one.
    static void Schedule() {
      int now = Environment.TickCount;
      if (!_everEmitted || unchecked(now - _lastEmitTick) >= MinEmitGapMs) { Flush(); return; }
      if (_flush == null) {
        _flush = new Timer();
        _flush.Interval = MinEmitGapMs;
        _flush.Tick += OnFlushTick;
      }
      if (!_flush.Enabled) _flush.Start();
    }

    static void OnFlushTick(object sender, EventArgs e) {
      try { if (_flush != null) _flush.Stop(); } catch (Exception) { }
      Flush();
    }

    static void Flush() {
      if (_bar == IntPtr.Zero) return;
      if (!Win32.IsWindow(_bar)) { Stop(); return; }

      bool visible = false;
      var r = new Win32.RECT();
      if (_tray != IntPtr.Zero && Win32.IsWindow(_tray)) {
        visible = Win32.IsWindowVisible(_tray);
        Win32.GetWindowRect(_tray, out r);
      }

      // THE ONE ACTION. Only when the taskbar is actually on screen, and only
      // ever on the caller's own window: z-order, nothing else.
      if (visible)
        Win32.SetWindowPos(_bar, Win32.HWND_TOPMOST, 0, 0, 0, 0,
                           Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);

      bool same = _everEmitted && visible == _lastVisible &&
                  r.left == _lastRect.left && r.top == _lastRect.top &&
                  r.right == _lastRect.right && r.bottom == _lastRect.bottom;
      if (same) return;   // the taskbar was merely re-ordered: raise, stay quiet

      _lastVisible = visible;
      _lastRect = r;
      _everEmitted = true;
      _lastEmitTick = Environment.TickCount;
      // "ev" is how every other event on this stream is tagged (the Electron
      // side dispatches on it); "event" is the field name the protocol spells
      // out for this one. Both, so neither reader has to special-case it.
      Program.Emit(Json.Obj("ev", "tray", "event", "tray", "visible", visible,
                            "rect", new object[] { r.left, r.top, r.right, r.bottom },
                            "tray", _tray.ToInt64().ToString(CultureInfo.InvariantCulture)));
    }
  }
}
