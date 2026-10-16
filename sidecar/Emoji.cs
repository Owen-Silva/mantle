// Emoji.cs - the sidecar half of Mantle's emoji picker (Win+. and Win+;), lane mantle-emoji 2026-10-15,
// plan notes/mantle-replace-windows.md P11. lib/features/emoji.js is the main half, ui/emoji the page.
//
// THE APP KEEPS THE FOCUS. Windows' own panel never takes the keyboard from the app you are typing in,
// and neither does Mantle's: the panel window is WS_EX_NOACTIVATE (focusable:false), and while it is
// open THIS watch takes the keys that belong to the picker (letters, digits, punctuation, Space,
// Backspace, Delete, Tab, arrows, Home/End, PgUp/PgDn, Enter, Esc) before the app sees them and hands
// them to main as `emoji` events. A pick is typed into the app that never lost the focus, with Unicode
// SendInput (KEYEVENTF_UNICODE: one VK_PACKET pair per UTF-16 unit, every unit in ONE SendInput call so
// nothing can land between the halves of a surrogate pair or a ZWJ sequence).
//
//   emoji.arm      {}                                   what Win+. was pressed over (Ui lane, no waits)
//   emoji.caret    {hwnd, pid}                          the caret through UI Automation (Slow lane, <= 300 ms)
//   emoji.watch    {on:true, hwnd, panel, leaseMs?}     take the picker's keys while `hwnd` is in front
//   emoji.watch    {on:false} | {}                      give them back / status
//   emoji.verdict  {vk, down, ctrl, alt, win, fgOk, fgIsPanel, held}   the hook's decision, PURE (tests)
//   emoji.type     {hwnd, text, dryRun?}                type `text` into `hwnd` (Ui lane)
//   emoji.typeback {hwnd, text}                         the same after handing `hwnd` the focus back (Slow lane)
//   emoji.windows  {dryRun?}                            hand this press to Windows' own panel (admin apps)
// Events: {ev:'emoji', what:'key', key, text, shift} | {what:'click'} | {what:'lost'} | {what:'off', why}
//
// WHAT IS NEVER TAKEN: a key with Ctrl, Alt or Win held (Ctrl+V, Alt+Tab, Win+. again are the app's
// and Windows'), F-keys, media keys, every modifier, and anything injected (our own typing, the partner
// key, other automation). A key is taken ONLY while the window that was in front at Win+. still is: the
// first key after the foreground moves goes through and ends the watch ('lost'). The keyup of a taken
// key is taken with it (an app never sees half a keypress). Esc ends the watch HERE, before main hears
// of it, so the keyboard comes back even if main is wedged.
//
// THE LEASE (PopWatch's rule): main renews the watch (leaseMs, default 6 s); if main hangs or forgets,
// the hooks go by themselves when the lease runs out. A passive (test) sidecar never hooks at all.
//
// ADMIN APPS: Windows does not let a program that is not elevated type into one that is (UIPI), and
// SendInput says nothing when it is blocked. So emoji.arm says `elevated` and main hands the press to
// Windows' own panel (emoji.windows) and says why, instead of typing into nothing.
//
// The hook procs run inline with every keystroke and click on the desktop: a few reads, at most one
// PostThreadMessage. No allocation, no JSON, no locks.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
#if MANTLE_UIA
using System.Windows.Automation;
using System.Windows.Automation.Text;
#endif

namespace Mantle {
  [MantleFeature]
  static class EmojiPicker {
    public static void Register(FeatureTable t) {
      t.Add("emoji.arm", Lanes.Ui, Arm);
      t.Add("emoji.caret", Lanes.Slow, Caret);
      t.Add("emoji.watch", Lanes.Ui, Watch);
      t.Add("emoji.verdict", Lanes.Ui, VerdictCmd);
      t.Add("emoji.type", Lanes.Ui, TypeText);             // one SendInput: well under the ui lane's 5 ms
      t.Add("emoji.typeback", Lanes.Slow, TypeBack);       // the same, after giving the app the focus back (<= 0.5 s)
      t.Add("emoji.windows", Lanes.Ui, HandToWindows);
    }

    const int MaxUnits = 64;            // the longest kaomoji is ~20 units; a family ZWJ sequence 11
    const string FixtureTitle = "Mantle emoji fixture";
    const string FixtureExe = "mantle-emoji-fixture.exe";
    const uint KEYEVENTF_UNICODE = 0x0004;
    const ushort VK_LWIN = 0x5B, VK_OEM_PERIOD = 0xBE;

    // ================================================================ arm

    /// What Win+. was pressed over: the foreground window, its app (file name only, for the picker's
    /// "used here" row, kept on this PC), where its caret is when it has a system caret, the pointer,
    /// and whether it runs as administrator. Physical pixels; main converts to DIP.
    static string Arm(Dictionary<string, object> req, ref object result) {
      IntPtr fg = Win32.GetForegroundWindow();
      int pid = 0;
      int tid = fg != IntPtr.Zero ? Win32.GetWindowThreadProcessId(fg, out pid) : 0;
      object caret = null;
      if (tid != 0) {
        var gti = new N.GUITHREADINFO();
        gti.cbSize = Marshal.SizeOf(typeof(N.GUITHREADINFO));
        if (N.GetGUIThreadInfo(tid, ref gti) && gti.hwndCaret != IntPtr.Zero && gti.rcCaret.bottom > gti.rcCaret.top) {
          Win32.POINT p;
          p.x = gti.rcCaret.left;
          p.y = gti.rcCaret.bottom;
          if (N.ClientToScreen(gti.hwndCaret, ref p))
            caret = Json.Obj("x", p.x, "y", p.y, "h", gti.rcCaret.bottom - gti.rcCaret.top, "via", "system caret");
        }
      }
      Win32.POINT cur;
      object cursor = N.GetCursorPos(out cur) ? Json.Obj("x", cur.x, "y", cur.y) : null;
      string exe = pid != 0 ? (Win32.GetProcessPath(pid) ?? "") : "";
      var cls = new StringBuilder(128);
      if (fg != IntPtr.Zero) N.GetClassNameW(fg, cls, cls.Capacity);
      bool elevated = fg != IntPtr.Zero && pid != 0 && IsElevated(pid);
      result = Json.Obj("ok", true,
                        "hwnd", fg.ToInt64().ToString(CultureInfo.InvariantCulture),
                        "pid", pid,
                        "app", exe.Length > 0 ? Path.GetFileName(exe).ToLowerInvariant() : null,
                        "cls", cls.ToString(),
                        "caret", caret,
                        "cursor", cursor,
                        "elevated", elevated,
                        "selfElevated", SelfElevated());
      return null;
    }

    // ================================================================ caret (UI Automation)

    /// The caret of the focused text control through UI Automation, for apps with no system caret
    /// (WPF, WinUI, UWP). Never for Chromium windows (Chrome_WidgetWin_*: Edge, Chrome, Discord, VS Code,
    /// Helm): a UIA client asking makes Chromium switch its accessibility tree on, which costs that app
    /// CPU and memory for as long as it stays on; those get the pointer, as before. Bounded at 300 ms
    /// (a busy app can hang a UIA call): later is "too slow", and main keeps the pointer.
    static string Caret(Dictionary<string, object> req, ref object result) {
#if MANTLE_UIA
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      int want = Json.GetInt(req, "pid", 0);
      var cls = new StringBuilder(128);
      if (hwnd != IntPtr.Zero) N.GetClassNameW(hwnd, cls, cls.Capacity);
      if (cls.ToString().StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) {
        result = Json.Obj("caret", null, "why", "a Chromium window: UI Automation would switch its accessibility on");
        return null;
      }
      object caret = null;
      string why = null;
      var done = new ManualResetEvent(false);
      ThreadPool.QueueUserWorkItem(delegate {
        try {
          AutomationElement el = AutomationElement.FocusedElement;
          if (el == null) { why = "nothing has the focus"; return; }
          if (want != 0 && el.Current.ProcessId != want) { why = "the focus is in another app"; return; }
          object pat;
          if (!el.TryGetCurrentPattern(TextPattern.Pattern, out pat)) { why = "the focused control has no text pattern"; return; }
          TextPatternRange[] sel = ((TextPattern)pat).GetSelection();
          if (sel == null || sel.Length == 0) { why = "no selection in the focused control"; return; }
          System.Windows.Rect[] rects = sel[0].GetBoundingRectangles();
          if (rects == null || rects.Length == 0) {
            TextPatternRange c = sel[0].Clone();
            c.ExpandToEnclosingUnit(TextUnit.Character);
            rects = c.GetBoundingRectangles();
          }
          if (rects == null || rects.Length == 0) { why = "the caret has no rectangle"; return; }
          System.Windows.Rect r = rects[0];
          caret = Json.Obj("x", (int)Math.Round(r.Left), "y", (int)Math.Round(r.Bottom), "h", (int)Math.Round(r.Height), "via", "UI Automation");
        } catch (Exception e) {
          why = "UI Automation: " + e.Message;
        } finally {
          try { done.Set(); } catch (ObjectDisposedException) { }
        }
      });
      bool inTime = done.WaitOne(300);
      result = inTime ? Json.Obj("caret", caret, "why", why) : Json.Obj("caret", null, "why", "UI Automation was too slow (300 ms)");
      return null;
#else
      result = Json.Obj("caret", null, "why", "this sidecar was built without UI Automation");
      return null;
#endif
    }

    // ================================================================ type

    /// Types `text` into `hwnd`, which must still be the window in front (the picker never took the
    /// focus). In a passive (test) sidecar, only into the test fixture.
    static string TypeText(Dictionary<string, object> req, ref object result) {
      var sw = Stopwatch.StartNew();
      IntPtr target = Json.GetHwnd(req, "hwnd");
      string text = Json.GetString(req, "text") ?? "";
      bool dry = Json.GetBool(req, "dryRun", false);
      if (text.Length == 0) return "nothing to type";
      if (text.Length > MaxUnits) return "too long to type (" + text.Length + " characters, at most " + MaxUnits + ")";
      foreach (char ch in text) if (ch < 0x20 || ch == 0x7F) return "a control character cannot be typed";
      if (target == IntPtr.Zero || !Win32.IsWindow(target)) return "the window to type into is gone";
      int tpid;
      Win32.GetWindowThreadProcessId(target, out tpid);
      bool elevated = tpid != 0 && IsElevated(tpid) && !SelfElevated();
      bool inFront = SameRoot(Win32.GetForegroundWindow(), target);
      var units = new List<object>();
      foreach (char ch in text) units.Add(((int)ch).ToString("X4", CultureInfo.InvariantCulture));
      if (dry) {
        result = Json.Obj("dryRun", true, "units", units, "inputs", text.Length * 2, "inFront", inFront, "elevated", elevated,
                          "wouldSay", elevated ? UipiWords : (!inFront ? FrontWords : null), "ms", sw.ElapsedMilliseconds);
        return null;
      }
      if (Program.Passive && !IsFixture(target))
        return FeatureTable.PassiveRefusal + ": types only into the test fixture (\"" + FixtureTitle + "\", " + FixtureExe + " under %TEMP%)";
      if (elevated) return UipiWords;
      if (!inFront && req.ContainsKey(RestoreKey)) {
        // the picker had the keyboard itself (no watch): the app it came from goes back in front first
        string ferr = WindowList.Focus(target);
        var wait = Stopwatch.StartNew();
        while (ferr == null && wait.ElapsedMilliseconds < 300 && !SameRoot(Win32.GetForegroundWindow(), target)) Thread.Sleep(10);
        inFront = SameRoot(Win32.GetForegroundWindow(), target);
        if (!inFront) return ferr != null ? "the window could not be brought back (" + ferr + ")" : FrontWords;
      }
      if (!inFront) return FrontWords;
      var inputs = new Win32.INPUT[text.Length * 2];
      for (int i = 0; i < text.Length; i++) {
        inputs[2 * i].type = Win32.INPUT_KEYBOARD;
        inputs[2 * i].u.ki.wScan = text[i];
        inputs[2 * i].u.ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[2 * i + 1].type = Win32.INPUT_KEYBOARD;
        inputs[2 * i + 1].u.ki.wScan = text[i];
        inputs[2 * i + 1].u.ki.dwFlags = KEYEVENTF_UNICODE | Win32.KEYEVENTF_KEYUP;
      }
      uint sent = Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
      if (sent != inputs.Length) {
        Program.EmitLog("warn", "emoji: SendInput sent " + sent + " of " + inputs.Length + " (error " + Marshal.GetLastWin32Error() + ")");
        return "Windows blocked the typing (" + sent + " of " + inputs.Length + " key events went through)";
      }
      result = Json.Obj("typed", true, "units", units.Count, "inputs", sent, "ms", sw.ElapsedMilliseconds);
      return null;
    }

    const string RestoreKey = "restore";   // set only by TypeBack: a request cannot ask for it

    /// emoji.typeback: the picker had the keyboard itself (no watch), so the app goes back in front first.
    static string TypeBack(Dictionary<string, object> req, ref object result) {
      req[RestoreKey] = true;
      return TypeText(req, ref result);
    }

    const string UipiWords = "that window runs as administrator, and Windows does not let Mantle type into it";
    const string FrontWords = "the window you were typing in is no longer in front";

    /// Hands this press to Windows' own emoji panel: Win+. again, INJECTED, which Mantle's own hook
    /// lets through (Hotkey.cs ignores injected keys), so Windows opens its panel. If Win is still held
    /// from the press, only the period is sent (Windows sees the real Win with it).
    static string HandToWindows(Dictionary<string, object> req, ref object result) {
      bool dry = Json.GetBool(req, "dryRun", false);
      bool winHeld = (N.GetAsyncKeyState(0x5B) & 0x8000) != 0 || (N.GetAsyncKeyState(0x5C) & 0x8000) != 0;
      ushort[] vk = winHeld ? new ushort[] { VK_OEM_PERIOD, VK_OEM_PERIOD } : new ushort[] { VK_LWIN, VK_OEM_PERIOD, VK_OEM_PERIOD, VK_LWIN };
      bool[] up = winHeld ? new bool[] { false, true } : new bool[] { false, false, true, true };
      if (dry) { result = Json.Obj("dryRun", true, "winHeld", winHeld, "keys", vk.Length); return null; }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": would have pressed Win+. for Windows' own panel";
      var inputs = new Win32.INPUT[vk.Length];
      for (int i = 0; i < vk.Length; i++) {
        inputs[i].type = Win32.INPUT_KEYBOARD;
        inputs[i].u.ki.wVk = vk[i];
        inputs[i].u.ki.dwFlags = up[i] ? Win32.KEYEVENTF_KEYUP : 0;
      }
      uint sent = Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
      if (sent != inputs.Length) return "Windows did not take the Win+. press (" + sent + " of " + inputs.Length + ")";
      result = Json.Obj("sent", (int)sent, "winHeld", winHeld);
      return null;
    }

    // ================================================================ the key watch

    public const int Pass = 0, Swallow = 1, Report = 2, Lost = 4, EndWatch = 8;

    /// The keys the picker takes (Shift allowed; Ctrl, Alt and Win never).
    public static bool Captured(int vk) {
      if (vk == 0x08 || vk == 0x09 || vk == 0x0D || vk == 0x1B || vk == 0x20 || vk == 0x2E) return true;
      if (vk >= 0x21 && vk <= 0x28) return true;                    // PgUp PgDn End Home arrows
      if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A)) return true;
      if (vk >= 0x60 && vk <= 0x6F && vk != 0x6C) return true;      // the number pad's digits and signs
      if ((vk >= 0xBA && vk <= 0xC0) || (vk >= 0xDB && vk <= 0xDF) || vk == 0xE2) return true;   // punctuation
      return false;
    }

    /// PURE: what the keyboard proc does with one real key while the watch is on.
    public static int Verdict(int vk, bool down, bool ctrl, bool alt, bool win, bool fgOk, bool fgIsPanel, bool held) {
      if (!down) return held ? Swallow : Pass;          // a taken key's keyup is taken with it, nothing else's
      if (fgIsPanel) return Pass;                       // the panel has the keyboard itself: its page reads it
      if (!fgOk) return Pass | Lost | EndWatch;         // the foreground moved: the key is the new window's
      if (ctrl || alt || win) return Pass;
      if (!Captured(vk)) return Pass;
      if (vk == 0x1B) return Swallow | Report | EndWatch;
      return Swallow | Report;
    }

    static string VerdictCmd(Dictionary<string, object> req, ref object result) {
      int v = Verdict(Json.GetInt(req, "vk", 0), Json.GetBool(req, "down", true), Json.GetBool(req, "ctrl", false),
                      Json.GetBool(req, "alt", false), Json.GetBool(req, "win", false), Json.GetBool(req, "fgOk", true),
                      Json.GetBool(req, "fgIsPanel", false), Json.GetBool(req, "held", false));
      result = Json.Obj("swallow", (v & Swallow) != 0, "report", (v & Report) != 0, "lost", (v & Lost) != 0, "end", (v & EndWatch) != 0,
                        "key", KeyName(Json.GetInt(req, "vk", 0)));
      return null;
    }

    /// The page's key names (KeyboardEvent.key) for the keys that are not text.
    public static string KeyName(int vk) {
      switch (vk) {
        case 0x08: return "Backspace";
        case 0x09: return "Tab";
        case 0x0D: return "Enter";
        case 0x1B: return "Escape";
        case 0x21: return "PageUp";
        case 0x22: return "PageDown";
        case 0x23: return "End";
        case 0x24: return "Home";
        case 0x25: return "ArrowLeft";
        case 0x26: return "ArrowUp";
        case 0x27: return "ArrowRight";
        case 0x28: return "ArrowDown";
        case 0x2E: return "Delete";
      }
      return null;
    }

    static string Watch(Dictionary<string, object> req, ref object result) {
      if (req.ContainsKey("on")) {
        bool on = Json.GetBool(req, "on", false);
        if (on) {
          if (Program.Passive) return FeatureTable.PassiveRefusal + ": the emoji watch takes keys, so a test sidecar never arms it";
          IntPtr target = Json.GetHwnd(req, "hwnd");
          IntPtr panel = Json.GetHwnd(req, "panel");
          if (target == IntPtr.Zero || !Win32.IsWindow(target)) return "the window to watch is gone";
          int lease = Math.Max(1000, Math.Min(30000, Json.GetInt(req, "leaseMs", 6000)));
          string err = W.Arm(target, panel, lease);
          if (err != null) return err;
        } else {
          W.Disarm("main");
        }
      }
      result = W.Status();
      return null;
    }

    /// The watch thread: hooks only while armed, a message loop, a lease timer.
    static class W {
      const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
      const uint WM_TIMER = 0x0113, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
      const uint WM_LBUTTONDOWN = 0x201, WM_RBUTTONDOWN = 0x204, WM_MBUTTONDOWN = 0x207, WM_XBUTTONDOWN = 0x20B;
      const uint LLKHF_INJECTED = 0x10, LLKHF_LOWER_IL_INJECTED = 0x02, LLKHF_ALTDOWN = 0x20, LLMHF_INJECTED = 0x1, LLMHF_LOWER_IL_INJECTED = 0x2;
      const uint EVENT_SYSTEM_FOREGROUND = 0x0003, WINEVENT_OUTOFCONTEXT = 0;
      const uint MSG_ARM = 0x8000 + 61, MSG_DISARM = 0x8000 + 62, MSG_KEY = 0x8000 + 63, MSG_CLICK = 0x8000 + 64, MSG_LOST = 0x8000 + 65;

      static readonly object _gate = new object();
      static Thread _thread;
      static volatile uint _tid;
      static volatile bool _armed;
      static volatile IntPtr _target, _targetRoot, _panel;
      static long _deadline;                       // Stopwatch ticks, under _gate
      static int _leaseMs;
      static IntPtr _kb = IntPtr.Zero, _mouse = IntPtr.Zero, _fgHook = IntPtr.Zero;   // watch thread only
      static readonly bool[] _held = new bool[256];   // hook proc only
      static volatile bool _anyHeld;
      static long _drainUntil;                    // watch thread only
      static int _keys, _clicks, _arms;
      static string _lastOff;
      static Win32.LowLevelKeyboardProc _kbProc, _mouseProc;   // static: the GC must not collect live hooks
      static N.WinEventProc _fgProc;
      static readonly ManualResetEvent _started = new ManualResetEvent(false);

      public static string Arm(IntPtr target, IntPtr panel, int leaseMs) {
        lock (_gate) {
          if (_thread == null || !_thread.IsAlive) {
            _started.Reset();
            _thread = new Thread(Loop) { IsBackground = true, Name = "emoji-watch" };
            _thread.Start();
            if (!_started.WaitOne(1000)) return "the emoji key watch did not start";
          }
          _target = target;
          _targetRoot = Win32.GetAncestor(target, Win32.GA_ROOT);
          _panel = panel;
          _leaseMs = leaseMs;
          _deadline = Stopwatch.GetTimestamp() + (long)leaseMs * Stopwatch.Frequency / 1000;
          bool renew = _armed;
          _armed = true;
          if (!renew) _arms++;
        }
        N.PostThreadMessageW(_tid, MSG_ARM, IntPtr.Zero, IntPtr.Zero);
        return null;
      }

      public static void Disarm(string why) {
        bool was;
        lock (_gate) { was = _armed; _armed = false; if (was) _lastOff = why; }
        if (was && _tid != 0) N.PostThreadMessageW(_tid, MSG_DISARM, IntPtr.Zero, IntPtr.Zero);
      }

      public static IDictionary Status() {
        lock (_gate) {
          return Json.Obj("armed", _armed, "hooked", _kb != IntPtr.Zero, "leaseMs", _leaseMs, "keys", _keys, "clicks", _clicks,
                          "arms", _arms, "lastOff", _lastOff);
        }
      }

      static void Loop() {
        _tid = N.GetCurrentThreadId();
        N.MSG m;
        N.PeekMessageW(out m, IntPtr.Zero, 0, 0, 0);   // make the queue before anyone posts to it
        N.SetTimer(IntPtr.Zero, UIntPtr.Zero, 250, IntPtr.Zero);
        _started.Set();
        while (N.GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) {
          try {
            switch (m.message) {
              case MSG_ARM: Hook(); break;
              case MSG_DISARM: Unhook(false); break;
              case MSG_KEY: OnKey((int)m.wParam.ToInt64(), (int)m.lParam.ToInt64()); break;
              case MSG_CLICK: OnClick((int)m.wParam.ToInt64(), (int)m.lParam.ToInt64()); break;
              case MSG_LOST: Off("lost"); break;
              case WM_TIMER: Tick(); break;
              default: N.TranslateMessage(ref m); N.DispatchMessageW(ref m); break;
            }
          } catch (Exception e) {
            Program.EmitLog("warn", "emoji watch: " + e.Message);
          }
        }
      }

      static void Hook() {
        if (!_armed || _kb != IntPtr.Zero) return;
        IntPtr mod = Win32.GetModuleHandleW(null);
        if (_kbProc == null) { _kbProc = KeyProc; _mouseProc = MouseProc; _fgProc = FgProc; }
        _kb = Win32.SetWindowsHookExW(WH_KEYBOARD_LL, _kbProc, mod, 0);
        if (_kb == IntPtr.Zero) { Off("the keyboard hook could not be installed (error " + Marshal.GetLastWin32Error() + ")"); return; }
        _mouse = Win32.SetWindowsHookExW(WH_MOUSE_LL, _mouseProc, mod, 0);
        _fgHook = N.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _fgProc, 0, 0, WINEVENT_OUTOFCONTEXT);
      }

      /// Hooks off. A key we took and whose keyup has not come yet keeps the keyboard hook for up to
      /// 800 ms (drain), so that keyup is taken too.
      static void Unhook(bool force) {
        if (_mouse != IntPtr.Zero) { Win32.UnhookWindowsHookEx(_mouse); _mouse = IntPtr.Zero; }
        if (_fgHook != IntPtr.Zero) { N.UnhookWinEvent(_fgHook); _fgHook = IntPtr.Zero; }
        if (_kb == IntPtr.Zero) return;
        if (_anyHeld && !force) { if (_drainUntil == 0) _drainUntil = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 8 / 10; return; }
        Win32.UnhookWindowsHookEx(_kb);
        _kb = IntPtr.Zero;
        _drainUntil = 0;
        Array.Clear(_held, 0, _held.Length);
        _anyHeld = false;
      }

      static void Tick() {
        if (_armed) {
          bool expired;
          lock (_gate) expired = Stopwatch.GetTimestamp() > _deadline;
          if (expired) Off("lease");
        } else if (_kb != IntPtr.Zero) {
          if (!_anyHeld || (_drainUntil != 0 && Stopwatch.GetTimestamp() > _drainUntil)) Unhook(true);
        }
      }

      /// The watch ends from this side (Esc, the foreground moved, a click outside, the lease): hooks
      /// off and main told.
      static void Off(string why) {
        bool was;
        lock (_gate) { was = _armed; _armed = false; if (was) _lastOff = why; }
        Unhook(false);
        if (was) Features.Event("emoji", Json.Obj("what", why == "lost" ? "lost" : "off", "why", why));
      }

      static void OnKey(int w, int l) {
        int vk = w & 0xFF;
        bool shift = (w & 0x100) != 0, caps = (w & 0x200) != 0, end = (w & 0x400) != 0;
        _keys++;
        string name = KeyName(vk);
        string text = null;
        if (name == null) {
          if (vk == 0x20) text = " ";
          else text = Translate(vk, l & 0xFFFF, shift, caps);
        }
        if (name != null || !string.IsNullOrEmpty(text))
          Features.Event("emoji", Json.Obj("what", "key", "key", name ?? (text ?? ""), "text", text, "shift", shift));
        if (end) Off("esc");
      }

      /// The character the key makes in the target's keyboard layout, without touching any dead-key
      /// state (ToUnicodeEx flag 4, Windows 10 1607+).
      static string Translate(int vk, int scan, bool shift, bool caps) {
        var state = new byte[256];
        if (shift) { state[0x10] = 0x80; state[0xA0] = 0x80; }
        if (caps) state[0x14] = 0x01;
        int pid;
        IntPtr t = _target;
        uint tid = t != IntPtr.Zero ? (uint)Win32.GetWindowThreadProcessId(t, out pid) : 0;
        IntPtr hkl = N.GetKeyboardLayout(tid);
        var sb = new StringBuilder(8);
        int n = N.ToUnicodeEx((uint)vk, (uint)scan, state, sb, sb.Capacity, 4, hkl);
        if (n <= 0) return null;
        string s = sb.ToString(0, Math.Min(n, sb.Length));
        foreach (char c in s) if (c < 0x20) return null;
        return s;
      }

      static void OnClick(int x, int y) {
        _clicks++;
        Win32.POINT p; p.x = x; p.y = y;
        IntPtr at = N.WindowFromPoint(p);
        IntPtr root = at != IntPtr.Zero ? Win32.GetAncestor(at, Win32.GA_ROOT) : IntPtr.Zero;
        if (root != IntPtr.Zero && root == _panel) return;        // a click on the picker is the page's
        lock (_gate) { if (!_armed) return; }
        Features.Event("emoji", Json.Obj("what", "click"));
        Off("click");
      }

      static void FgProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
        if (!_armed || hwnd == IntPtr.Zero) return;
        IntPtr root = Win32.GetAncestor(hwnd, Win32.GA_ROOT);
        if (root == _targetRoot || root == _panel || hwnd == _panel) return;
        Off("lost");
      }

      static IntPtr KeyProc(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode == 0) {
          try {
            uint flags = (uint)Marshal.ReadInt32(lParam, 8);
            if ((flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) == 0) {
              int vk = Marshal.ReadInt32(lParam, 0) & 0xFF;
              uint msg = (uint)wParam.ToInt64();
              bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
              if (down || msg == WM_KEYUP || msg == WM_SYSKEYUP) {
                int v;
                if (!down) v = Verdict(vk, false, false, false, false, true, false, _held[vk]);
                else if (!_armed || !Captured(vk)) v = Pass;
                else {
                  IntPtr fg = Win32.GetForegroundWindow();
                  bool isPanel = fg != IntPtr.Zero && fg == _panel;
                  bool fgOk = fg == _target || (fg != IntPtr.Zero && Win32.GetAncestor(fg, Win32.GA_ROOT) == _targetRoot);
                  bool ctrl = (N.GetAsyncKeyState(0x11) & 0x8000) != 0;
                  bool win = (N.GetAsyncKeyState(0x5B) & 0x8000) != 0 || (N.GetAsyncKeyState(0x5C) & 0x8000) != 0;
                  bool alt = (flags & LLKHF_ALTDOWN) != 0;
                  v = Verdict(vk, true, ctrl, alt, win, fgOk, isPanel, _held[vk]);
                  if ((v & Lost) != 0) N.PostThreadMessageW(_tid, MSG_LOST, IntPtr.Zero, IntPtr.Zero);
                  if ((v & Report) != 0) {
                    bool shift = (N.GetAsyncKeyState(0x10) & 0x8000) != 0;
                    bool caps = (N.GetKeyState(0x14) & 1) != 0;
                    int w = vk | (shift ? 0x100 : 0) | (caps ? 0x200 : 0) | ((v & EndWatch) != 0 ? 0x400 : 0);
                    N.PostThreadMessageW(_tid, MSG_KEY, new IntPtr(w), new IntPtr(Marshal.ReadInt32(lParam, 4) & 0xFFFF));
                  }
                }
                if ((v & Swallow) != 0) {
                  if (down) { _held[vk] = true; _anyHeld = true; }
                  else { _held[vk] = false; _anyHeld = AnyHeld(); }
                  return new IntPtr(1);
                }
              }
            }
          } catch (Exception) {
            // a throw out of a hook proc would take down every app's input
          }
        }
        return Win32.CallNextHookEx(_kb, nCode, wParam, lParam);
      }

      static bool AnyHeld() { for (int i = 0; i < 256; i++) if (_held[i]) return true; return false; }

      static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam) {
        // CLICKS ARE NEVER SWALLOWED: the click that closes the picker also does what it would have done.
        if (nCode == 0 && _armed) {
          uint msg = (uint)wParam.ToInt64();
          if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN || msg == WM_XBUTTONDOWN) {
            uint flags = (uint)Marshal.ReadInt32(lParam, 12);
            if ((flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) == 0)
              N.PostThreadMessageW(_tid, MSG_CLICK, new IntPtr(Marshal.ReadInt32(lParam, 0)), new IntPtr(Marshal.ReadInt32(lParam, 4)));
          }
        }
        return Win32.CallNextHookEx(_mouse, nCode, wParam, lParam);
      }
    }

    // ================================================================ helpers

    static bool SameRoot(IntPtr a, IntPtr b) {
      if (a == IntPtr.Zero || b == IntPtr.Zero) return false;
      return a == b || Win32.GetAncestor(a, Win32.GA_ROOT) == Win32.GetAncestor(b, Win32.GA_ROOT);
    }

    static bool IsFixture(IntPtr hwnd) {
      var sb = new StringBuilder(256);
      N.GetWindowTextW(hwnd, sb, sb.Capacity);
      if (!sb.ToString().StartsWith(FixtureTitle, StringComparison.Ordinal)) return false;
      int pid;
      Win32.GetWindowThreadProcessId(hwnd, out pid);
      string exe = Win32.GetProcessPath(pid) ?? "";
      string temp;
      try { temp = Path.GetFullPath(Path.GetTempPath()); } catch (Exception) { return false; }
      return string.Equals(Path.GetFileName(exe), FixtureExe, StringComparison.OrdinalIgnoreCase) &&
             exe.StartsWith(temp, StringComparison.OrdinalIgnoreCase);
    }

    static bool IsElevated(int pid) {
      IntPtr proc = N.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
      if (proc == IntPtr.Zero) return false;   // cannot even ask: treat as ordinary; typing will say if it fails
      try { return TokenElevated(proc); } finally { N.CloseHandle(proc); }
    }

    static bool _selfKnown, _self;
    static bool SelfElevated() {
      if (!_selfKnown) { _self = TokenElevated(N.GetCurrentProcess()); _selfKnown = true; }
      return _self;
    }

    static bool TokenElevated(IntPtr proc) {
      IntPtr tok;
      if (!N.OpenProcessToken(proc, 0x0008 /* TOKEN_QUERY */, out tok)) return false;
      try {
        int elevation = 0, len;
        return N.GetTokenInformation(tok, 20 /* TokenElevation */, out elevation, 4, out len) && elevation != 0;
      } finally { N.CloseHandle(tok); }
    }

    static class N {
      [StructLayout(LayoutKind.Sequential)]
      public struct RECT { public int left, top, right, bottom; }
      [StructLayout(LayoutKind.Sequential)]
      public struct GUITHREADINFO {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
      }
      [StructLayout(LayoutKind.Sequential)]
      public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public Win32.POINT pt; }
      public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

      [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(int tid, ref GUITHREADINFO gti);
      [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Win32.POINT p);
      [DllImport("user32.dll")] public static extern bool GetCursorPos(out Win32.POINT p);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder sb, int n);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder sb, int n);
      [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
      [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
      [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint tid);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)]
      public static extern int ToUnicodeEx(uint vk, uint scan, byte[] state, StringBuilder buf, int cch, uint flags, IntPtr hkl);
      [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Win32.POINT p);
      [DllImport("user32.dll")] public static extern bool PostThreadMessageW(uint tid, uint msg, IntPtr w, IntPtr l);
      [DllImport("user32.dll")] public static extern int GetMessageW(out MSG m, IntPtr hwnd, uint min, uint max);
      [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG m, IntPtr hwnd, uint min, uint max, uint remove);
      [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
      [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG m);
      [DllImport("user32.dll")] public static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, IntPtr proc);
      [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
      [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
      [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
      [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
      [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
      [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
      [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr tok);
      [DllImport("advapi32.dll", SetLastError = true)]
      public static extern bool GetTokenInformation(IntPtr tok, int cls, out int info, int len, out int retLen);
    }
  }
}
